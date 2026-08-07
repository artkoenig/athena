import test from 'node:test';
import assert from 'node:assert/strict';

import { TelemetryStore } from '../src/store.mjs';

const SESSION = 'sess-1';
const base = { resource: { 'service.name': 'agent' } };

const metric = (name, value, attributes = {}, extra = {}) => ({
  ...base,
  name,
  unit: '',
  kind: 'sum',
  temporality: 'delta',
  monotonic: true,
  value,
  timeMs: Date.now(),
  startMs: Date.now(),
  attrs: { 'session.id': SESSION, ...attributes },
  ...extra,
});

const log = (eventName, attributes = {}, timeMs = Date.now()) => ({
  ...base,
  eventName,
  severity: 'INFO',
  timeMs,
  observedMs: timeMs,
  body: null,
  traceId: '',
  spanId: '',
  attrs: { 'session.id': SESSION, ...attributes },
});

// Spans carry absolute wall-clock timestamps; anything older than the retention
// window is evicted on ingest, so fixtures have to sit near "now".
const NOW = Date.now();

const span = (name, attributes = {}, extra = {}) => {
  const startMs = NOW + (extra.startMs ?? 0);
  const endMs = NOW + (extra.endMs ?? 100);
  return {
    ...base,
    traceId: 'trace-1',
    spanId: extra.spanId ?? 'span-1',
    parentSpanId: extra.parentSpanId ?? '',
    name,
    kind: 'internal',
    startMs,
    endMs,
    durationMs: endMs - startMs,
    status: { code: 'ok', message: '' },
    events: [],
    links: [],
    attrs: { 'session.id': SESSION, ...attributes },
  };
};

// A subagent-shaped span: carries the per-instance identity (agent_id), its
// parent (parent_agent_id) and its type (query_source) — the three attributes
// the previous increment reported on llm_request and tool spans. `extraAttrs`
// lets a case override any of them (e.g. a second instance, a different
// session) instead of repeating the attribute literals inline.
const subagentSpan = (name, agentId, extraAttrs = {}, extra = {}) =>
  span(
    name,
    {
      agent_id: agentId,
      parent_agent_id: 'agt-main',
      query_source: 'agent:builtin:researcher',
      ...extraAttrs,
    },
    extra,
  );

test('token and cost metrics roll up per session and per model', () => {
  const store = new TelemetryStore();
  store.ingest('metrics', [
    metric('claude_code.token.usage', 100, { type: 'input', model: 'claude-opus-5' }),
    metric('claude_code.token.usage', 40, { type: 'output', model: 'claude-opus-5' }),
    metric('claude_code.token.usage', 900, { type: 'cacheRead', model: 'claude-opus-5' }),
    metric('claude_code.token.usage', 5, { type: 'input', model: 'claude-haiku-4-5-20251001' }),
    metric('claude_code.cost.usage', 0.5, { model: 'claude-opus-5' }),
  ]);

  const session = store.getSession(SESSION);
  assert.deepEqual(session.tokens, { input: 105, output: 40, cacheRead: 900, cacheCreation: 0 });
  assert.equal(session.tokensTotal, 1045);
  assert.equal(session.costUsd, 0.5);
  assert.equal(session.tokenSource, 'metrics');
  const opus = session.models.find((model) => model.name === 'claude-opus-5');
  assert.equal(opus.tokens.input, 100);
  assert.equal(opus.costUsd, 0.5);
});

test('cumulative counters are differenced instead of summed', () => {
  const store = new TelemetryStore();
  const cumulative = (value) =>
    metric('claude_code.token.usage', value, { type: 'input' }, { temporality: 'cumulative' });
  store.ingest('metrics', [cumulative(100), cumulative(250), cumulative(400)]);
  assert.equal(store.getSession(SESSION).tokens.input, 400);
});

test('a cumulative counter reset restarts from the new value', () => {
  const store = new TelemetryStore();
  const cumulative = (value) =>
    metric('claude_code.token.usage', value, { type: 'input' }, { temporality: 'cumulative' });
  store.ingest('metrics', [cumulative(100), cumulative(250), cumulative(30)]);
  assert.equal(store.getSession(SESSION).tokens.input, 280);
});

test('gauges contribute their change, not their absolute value', () => {
  const store = new TelemetryStore();
  const gauge = (value) =>
    metric('claude_code.cost.usage', value, {}, { kind: 'gauge', temporality: 'unspecified' });
  store.ingest('metrics', [gauge(0.1), gauge(0.4), gauge(0.9)]);
  assert.equal(store.getSession(SESSION).costUsd.toFixed(4), '0.9000');
});

test('usage falls back to api_request events when no metrics arrive', () => {
  const store = new TelemetryStore();
  store.ingest('logs', [
    log('claude_code.api_request', {
      model: 'claude-sonnet-5',
      input_tokens: 200,
      output_tokens: 50,
      cache_read_tokens: 1000,
      cost_usd_micros: 12_500,
    }),
  ]);
  const session = store.getSession(SESSION);
  assert.equal(session.tokensTotal, 1250);
  assert.equal(session.costUsd, 0.0125);
  assert.equal(session.tokenSource, 'events');
  assert.equal(session.costSource, 'events');
});

test('metrics win over events so both exporters together do not double count', () => {
  const store = new TelemetryStore();
  store.ingest('logs', [log('claude_code.api_request', { model: 'm', input_tokens: 200, cost_usd: 1 })]);
  store.ingest('metrics', [
    metric('claude_code.token.usage', 200, { type: 'input', model: 'm' }),
    metric('claude_code.cost.usage', 1, { model: 'm' }),
  ]);
  const session = store.getSession(SESSION);
  assert.equal(session.tokensTotal, 200);
  assert.equal(session.costUsd, 1);
  assert.equal(session.tokenSource, 'metrics');
});

test('spans populate interaction, tool and llm counters', () => {
  const store = new TelemetryStore();
  store.ingest('traces', [
    span('claude_code.interaction', { user_prompt: 'hi' }, { spanId: 'root' }),
    span(
      'claude_code.llm_request',
      { model: 'claude-opus-5', duration_ms: 800, ttft_ms: 200, success: true },
      { spanId: 'llm', parentSpanId: 'root' },
    ),
    span('claude_code.tool', { tool_name: 'Bash', duration_ms: 120 }, { spanId: 'tool', parentSpanId: 'root' }),
    span(
      'claude_code.tool.execution',
      { success: false, error: 'Error:ENOENT' },
      { spanId: 'exec', parentSpanId: 'tool' },
    ),
  ]);
  const session = store.getSession(SESSION);
  assert.equal(session.counts.interactions, 1);
  assert.equal(session.counts.llmRequests, 1);
  assert.equal(session.counts.toolCalls, 1);
  assert.equal(session.counts.toolFailures, 1);
  assert.equal(session.lastError.kind, 'tool');
  assert.equal(session.models[0].avgTtftMs, 200);
  assert.equal(session.tools[0].name, 'Bash');
});

test('getTrace nests spans and reports depth in render order', () => {
  const store = new TelemetryStore();
  store.ingest('traces', [
    span('claude_code.interaction', {}, { spanId: 'root', startMs: 100, endMs: 900 }),
    span('claude_code.tool', { tool_name: 'Bash' }, { spanId: 'tool', parentSpanId: 'root', startMs: 200, endMs: 500 }),
    span(
      'claude_code.tool.execution',
      {},
      { spanId: 'exec', parentSpanId: 'tool', startMs: 250, endMs: 480 },
    ),
    span('claude_code.llm_request', {}, { spanId: 'llm', parentSpanId: 'root', startMs: 600, endMs: 880 }),
  ]);
  const trace = store.getTrace('trace-1');
  assert.deepEqual(
    trace.spans.map((s) => [s.spanId, s.depth]),
    [
      ['root', 0],
      ['tool', 1],
      ['exec', 2],
      ['llm', 1],
    ],
  );
  assert.equal(trace.durationMs, 800);
  assert.equal(trace.orphanCount, 0);
  // The flattened list must stay JSON-serialisable (no child cycles).
  assert.doesNotThrow(() => JSON.stringify(trace));
});

test('a span whose parent is missing is reported as an orphan root', () => {
  const store = new TelemetryStore();
  store.ingest('traces', [span('claude_code.tool', {}, { spanId: 'child', parentSpanId: 'gone' })]);
  const trace = store.getTrace('trace-1');
  assert.equal(trace.orphanCount, 1);
  assert.equal(trace.spans[0].depth, 0);
});

test('tool_result events record failures against the tool', () => {
  const store = new TelemetryStore();
  store.ingest('logs', [
    log('claude_code.tool_result', { tool_name: 'Read', success: 'true', duration_ms: 5 }),
    log('claude_code.tool_result', { tool_name: 'Read', success: 'false', error_type: 'ENOENT' }),
    log('claude_code.tool_decision', { tool_name: 'Write', decision: 'reject', source: 'user_reject' }),
  ]);
  const session = store.getSession(SESSION);
  const read = session.tools.find((tool) => tool.name === 'Read');
  const write = session.tools.find((tool) => tool.name === 'Write');
  assert.equal(read.failures, 1);
  assert.equal(write.rejected, 1);
  assert.equal(session.lastError.message, 'ENOENT');
});

test('tool span result_tokens fallback: span arrives before the tool_result event', () => {
  const store = new TelemetryStore();
  store.ingest('traces', [span('claude_code.tool', { tool_name: 'Read', tool_use_id: 'tu-1' })]);
  store.ingest('logs', [
    log('claude_code.tool_result', {
      tool_name: 'Read',
      tool_use_id: 'tu-1',
      success: 'true',
      tool_result_size_bytes: 400,
    }),
  ]);
  const read = store.getSession(SESSION).tools.find((tool) => tool.name === 'Read');
  assert.equal(read.resultTokens, 100);
  assert.equal(read.resultTokensEstimated, 100);
});

test('tool span result_tokens fallback: tool_result event arrives before the span', () => {
  const store = new TelemetryStore();
  store.ingest('logs', [
    log('claude_code.tool_result', {
      tool_name: 'Bash',
      tool_use_id: 'tu-2',
      success: 'true',
      tool_result_size_bytes: 800,
    }),
  ]);
  store.ingest('traces', [span('claude_code.tool', { tool_name: 'Bash', tool_use_id: 'tu-2' })]);
  const bash = store.getSession(SESSION).tools.find((tool) => tool.name === 'Bash');
  assert.equal(bash.resultTokens, 200);
  assert.equal(bash.resultTokensEstimated, 200);
});

test('a real result_tokens attribute wins and is never treated as an estimate', () => {
  const store = new TelemetryStore();
  store.ingest('traces', [
    span('claude_code.tool', { tool_name: 'Read', tool_use_id: 'tu-3', result_tokens: 42 }),
  ]);
  store.ingest('logs', [
    log('claude_code.tool_result', {
      tool_name: 'Read',
      tool_use_id: 'tu-3',
      success: 'true',
      tool_result_size_bytes: 999_999,
    }),
  ]);
  const read = store.getSession(SESSION).tools.find((tool) => tool.name === 'Read');
  assert.equal(read.resultTokens, 42);
  assert.equal(read.resultTokensEstimated, 0);
});

test('event queries filter by name, errors and free text', () => {
  const store = new TelemetryStore();
  store.ingest('logs', [
    log('claude_code.user_prompt', { prompt: 'find the flaky test' }),
    log('claude_code.api_error', { error: 'overloaded_error' }),
    log('claude_code.tool_result', { tool_name: 'Bash', success: 'true' }),
  ]);
  assert.equal(store.queryEvents({ eventName: 'claude_code.api_error' }).length, 1);
  assert.equal(store.queryEvents({ errorsOnly: true }).length, 1);
  assert.equal(store.queryEvents({ search: 'flaky' }).length, 1);
  assert.equal(store.queryEvents({ sessionId: 'nope' }).length, 0);
  assert.equal(store.queryEvents({ limit: 2 }).length, 2);
});

test('sessions are keyed by session.id from attributes or resource', () => {
  const store = new TelemetryStore();
  store.ingest('logs', [
    { ...log('claude_code.user_prompt'), attrs: {}, resource: { 'session.id': 'from-resource' } },
  ]);
  assert.ok(store.getSession('from-resource'));
});

test('raw records are evicted by count while aggregates survive', () => {
  const store = new TelemetryStore({ maxLogs: 5 });
  for (let i = 0; i < 20; i++) {
    store.ingest('logs', [log('claude_code.api_request', { input_tokens: 10 })]);
  }
  assert.equal(store.logs.length, 5);
  assert.equal(store.getSession(SESSION).tokens.input, 200);
});

test('sessions older than the retention window are dropped entirely', () => {
  const store = new TelemetryStore({ retentionMs: 1000 });
  const old = Date.now() - 60_000;
  store.ingest('logs', [log('claude_code.user_prompt', {}, old)]);
  assert.equal(store.sessions.size, 0);
  assert.equal(store.logs.length, 0);
});

test('stats aggregate across sessions', () => {
  const store = new TelemetryStore();
  store.ingest('metrics', [
    metric('claude_code.cost.usage', 1.5),
    { ...metric('claude_code.cost.usage', 2.5), attrs: { 'session.id': 'other' } },
  ]);
  const stats = store.stats();
  assert.equal(stats.totals.sessions, 2);
  assert.equal(stats.totals.costUsd, 4);
  assert.equal(stats.received.metrics, 2);
});

test('TodoWrite snapshots the full todo list on every call', () => {
  const store = new TelemetryStore();
  const todos = (list) => JSON.stringify({ todos: list });
  store.ingest('logs', [
    log('claude_code.tool_result', {
      tool_name: 'TodoWrite',
      success: 'true',
      tool_parameters: todos([{ content: 'write tests', status: 'in_progress', activeForm: 'Writing tests' }]),
    }),
  ]);
  let session = store.getSession(SESSION);
  assert.deepEqual(session.todos.legacy, [
    { content: 'write tests', status: 'in_progress', activeForm: 'Writing tests' },
  ]);

  store.ingest('logs', [
    log('claude_code.tool_result', {
      tool_name: 'TodoWrite',
      success: 'true',
      tool_parameters: todos([{ content: 'write tests', status: 'completed', activeForm: 'Writing tests' }]),
    }),
  ]);
  session = store.getSession(SESSION);
  assert.equal(session.todos.legacy.length, 1);
  assert.equal(session.todos.legacy[0].status, 'completed');
});

test('TaskCreate and TaskUpdate reconstruct task state, keyed by id where known', () => {
  const store = new TelemetryStore();
  store.ingest('logs', [
    log('claude_code.tool_result', {
      tool_name: 'TaskCreate',
      tool_use_id: 'call-1',
      success: 'true',
      tool_parameters: JSON.stringify({ subject: 'Fix flaky test', description: 'CI flakes on retry' }),
    }),
    log('claude_code.tool_result', {
      tool_name: 'TaskUpdate',
      tool_use_id: 'call-2',
      success: 'true',
      tool_parameters: JSON.stringify({ taskId: 'task-1', status: 'in_progress' }),
    }),
    log('claude_code.tool_result', {
      tool_name: 'TaskUpdate',
      tool_use_id: 'call-3',
      success: 'true',
      tool_parameters: JSON.stringify({ taskId: 'task-1', status: 'completed', subject: 'Fix flaky test' }),
    }),
  ]);
  const session = store.getSession(SESSION);
  assert.equal(session.todos.unlinkedCreates.length, 1);
  assert.equal(session.todos.unlinkedCreates[0].subject, 'Fix flaky test');
  assert.equal(session.todos.tasks.length, 1);
  assert.equal(session.todos.tasks[0].taskId, 'task-1');
  assert.equal(session.todos.tasks[0].status, 'completed');
  assert.equal(session.todos.tasks[0].subject, 'Fix flaky test');
  assert.equal(session.todos.tasks[0].history.length, 2);
});

test('TaskCreate reconstructs task state from tool_input (current CLI attribute name)', () => {
  const store = new TelemetryStore();
  store.ingest('logs', [
    log('claude_code.tool_result', {
      tool_name: 'TaskCreate',
      tool_use_id: 'call-1',
      success: 'true',
      tool_input: JSON.stringify({ subject: 'Fix flaky test', description: 'CI flakes on retry' }),
    }),
  ]);
  const session = store.getSession(SESSION);
  assert.equal(session.todos.unlinkedCreates.length, 1);
  assert.equal(session.todos.unlinkedCreates[0].subject, 'Fix flaky test');
});

test('TaskUpdate reads id from repaired key names defensively', () => {
  const store = new TelemetryStore();
  store.ingest('logs', [
    log('claude_code.tool_result', {
      tool_name: 'TaskUpdate',
      success: 'true',
      tool_parameters: JSON.stringify({ id: 'task-9', status: 'completed' }),
    }),
  ]);
  assert.equal(store.getSession(SESSION).todos.tasks[0].taskId, 'task-9');
});

test('todo state is not populated without OTEL_LOG_TOOL_DETAILS, but calls are still counted', () => {
  const store = new TelemetryStore();
  store.ingest('logs', [log('claude_code.tool_result', { tool_name: 'TaskCreate', success: 'true' })]);
  const session = store.getSession(SESSION);
  assert.equal(session.todos.callsSeen, 1);
  assert.equal(session.todos.legacy, null);
  assert.equal(session.todos.tasks.length, 0);
  assert.equal(session.todos.unlinkedCreates.length, 0);
});

test('a failed TaskUpdate call does not mutate todo state', () => {
  const store = new TelemetryStore();
  store.ingest('logs', [
    log('claude_code.tool_result', {
      tool_name: 'TaskUpdate',
      success: 'false',
      error_type: 'PermissionDenied',
      tool_parameters: JSON.stringify({ taskId: 'task-1', status: 'completed' }),
    }),
  ]);
  assert.equal(store.getSession(SESSION).todos.tasks.length, 0);
});

test('a session.name from OTEL_RESOURCE_ATTRIBUTES becomes the session name', () => {
  const store = new TelemetryStore();
  store.ingest('logs', [
    { ...log('claude_code.user_prompt'), resource: { 'service.name': 'agent', 'session.name': 'nightly run' } },
  ]);
  const session = store.getSession(SESSION);
  assert.equal(session.name, 'nightly run');
  assert.equal(session.id, SESSION);
  // The name is searchable, so the list can be filtered by it like by an id.
  assert.equal(store.listSessions({ search: 'nightly' }).items.length, 1);
  assert.equal(store.listSessions({ search: 'daily' }).items.length, 0);
});

test('a session.name arriving only on metric attributes sticks to the session', () => {
  const store = new TelemetryStore();
  store.ingest('metrics', [
    metric('claude_code.token.usage', 10, { type: 'input', 'session.name': 'labelled' }),
    metric('claude_code.token.usage', 10, { type: 'output' }),
  ]);
  assert.equal(store.getSession(SESSION).name, 'labelled');
});

test('sessions without a name report null, leaving the id as the only label', () => {
  const store = new TelemetryStore();
  store.ingest('logs', [log('claude_code.user_prompt')]);
  assert.equal(store.getSession(SESSION).name, null);
  assert.equal(store.listSessions().items[0].name, null);
});

/* ----------------------- queryContent(...) -------------------------- */

const T = Date.now();

test('content records come back oldest-first, only for the session asked for', () => {
  const store = new TelemetryStore();
  store.ingest('logs', [
    log('claude_code.api_request_body', { body: '{"a":1}', body_length: '7' }, T),
    log(
      'claude_code.api_request_body',
      { 'session.id': 'other-session', body: '{"b":2}', body_length: '7' },
      T + 1000,
    ),
    log('claude_code.user_prompt', { prompt: 'hello', prompt_length: '5' }, T + 2000),
    log('claude_code.api_request', { model: 'claude-opus-5' }, T + 3000),
  ]);
  const results = store.queryContent({ sessionId: SESSION });
  assert.equal(results.length, 2);
  assert.equal(results[0].content.kind, 'request_body');
  assert.equal(results[1].content.kind, 'user_prompt');
  assert.ok(
    results.every((result) => result.log.attrs['session.id'] === SESSION),
    'the other session\'s body must not come back for this session',
  );
});

test('the kind filter narrows to one kind', () => {
  const store = new TelemetryStore();
  store.ingest('logs', [
    log('claude_code.api_request_body', { body: '{"a":1}', body_length: '7' }, T),
    log(
      'claude_code.api_request_body',
      { 'session.id': 'other-session', body: '{"b":2}', body_length: '7' },
      T + 1000,
    ),
    log('claude_code.user_prompt', { prompt: 'hello', prompt_length: '5' }, T + 2000),
    log('claude_code.api_request', { model: 'claude-opus-5' }, T + 3000),
  ]);
  const results = store.queryContent({ sessionId: SESSION, kinds: ['request_body'] });
  assert.equal(results.length, 1);
  assert.equal(results[0].content.kind, 'request_body');
  assert.equal(results[0].log.timeMs, T);
});

test('atMs is an inclusive upper bound', () => {
  const store = new TelemetryStore();
  store.ingest('logs', [
    log('claude_code.api_request_body', { body: '{"a":1}', body_length: '7' }, T),
    log('claude_code.api_request_body', { body: '{"b":2}', body_length: '7' }, T + 1000),
    log('claude_code.api_request_body', { body: '{"c":3}', body_length: '7' }, T + 2000),
  ]);
  const results = store.queryContent({ sessionId: SESSION, atMs: T + 1000 });
  assert.equal(results.length, 2);
  assert.ok(
    results.every((result) => result.log.timeMs <= T + 1000),
    'the record after the bound must not come back',
  );
});

test('the nearest content at or before a time is atMs with limit: 1', () => {
  // This is the query the later increments build the context view on, so it is
  // pinned here: the limit keeps the newest match, not the oldest.
  const store = new TelemetryStore();
  store.ingest('logs', [
    log('claude_code.api_request_body', { body: '{"a":1}', body_length: '7' }, T),
    log('claude_code.api_request_body', { body: '{"b":2}', body_length: '7' }, T + 1000),
    log('claude_code.api_request_body', { body: '{"c":3}', body_length: '7' }, T + 2000),
  ]);
  const results = store.queryContent({
    sessionId: SESSION,
    kinds: ['request_body'],
    atMs: T + 1500,
    limit: 1,
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].log.timeMs, T + 1000);
});

test('a session with nothing content-bearing answers with an empty list', () => {
  const store = new TelemetryStore();
  store.ingest('logs', [log('claude_code.api_request', { model: 'claude-opus-5' })]);
  const results = store.queryContent({ sessionId: SESSION });
  assert.deepEqual(results, []);
});

test('clear() empties the store but keeps subscribers attached', () => {
  const store = new TelemetryStore();
  let notified = 0;
  store.subscribe(() => notified++);
  store.ingest('logs', [log('claude_code.user_prompt')]);
  store.clear();
  assert.equal(store.sessions.size, 0);
  store.ingest('logs', [log('claude_code.user_prompt')]);
  assert.equal(notified, 2);
});

/* ----------------------------- getAgents(sessionId) ----------------------------- *
 * The timeline draws one lane for the main session and one per subagent
 * instance. `query_source` names only the agent type, so instance identity
 * has to come from `agent_id`/`parent_agent_id` — never from the type alone.
 */

test('a session with only a main interaction span reports one main lane', () => {
  const store = new TelemetryStore();
  store.ingest('traces', [
    span('claude_code.interaction', {}, { spanId: 'root' }),
    span('claude_code.llm_request', {}, { spanId: 'llm', parentSpanId: 'root' }),
  ]);
  const { items } = store.getAgents(SESSION);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'main');
  assert.equal(items[0].id, 'main');
  assert.equal(items[0].spanCount, 2);
});

test('two concurrent subagents of the same type get two separate lanes', () => {
  const store = new TelemetryStore();
  store.ingest('traces', [
    span('claude_code.interaction', {}, { spanId: 'root' }),
    subagentSpan('claude_code.tool', 'agt-a', {}, { spanId: 'tool-a', parentSpanId: 'root', startMs: 100, endMs: 400 }),
    subagentSpan('claude_code.tool', 'agt-b', {}, { spanId: 'tool-b', parentSpanId: 'root', startMs: 150, endMs: 500 }),
  ]);
  const { items } = store.getAgents(SESSION);
  assert.equal(items.length, 3);
  const subs = items.filter((item) => item.kind === 'subagent');
  assert.equal(subs.length, 2);
  assert.deepEqual(subs.map((item) => item.id).sort(), ['agent:agt-a', 'agent:agt-b']);
  for (const sub of subs) {
    assert.equal(sub.agentType, 'agent:builtin:researcher');
    assert.equal(sub.parentAgentId, 'agt-main');
  }
});

test('query_source alone never collapses two agent instances into one lane', () => {
  // Pins the headline case a second time, from a different angle: even with
  // both subagents sharing one type, the item count and the id set must stay
  // per-instance.
  const store = new TelemetryStore();
  store.ingest('traces', [
    span('claude_code.interaction', {}, { spanId: 'root' }),
    subagentSpan('claude_code.tool', 'agt-a', {}, { spanId: 'tool-a', parentSpanId: 'root', startMs: 100, endMs: 400 }),
    subagentSpan('claude_code.tool', 'agt-b', {}, { spanId: 'tool-b', parentSpanId: 'root', startMs: 150, endMs: 500 }),
  ]);
  const { items } = store.getAgents(SESSION);
  assert.equal(items.filter((item) => item.kind === 'subagent').length, 2);
  const [a, b] = items.filter((item) => item.kind === 'subagent');
  assert.notEqual(a.id, b.id);
});

test('lanes come back with main first and subagents ordered by when they started', () => {
  const store = new TelemetryStore();
  store.ingest('traces', [
    span('claude_code.interaction', {}, { spanId: 'root' }),
    subagentSpan('claude_code.tool', 'agt-a', {}, { spanId: 'tool-a', parentSpanId: 'root', startMs: 100, endMs: 400 }),
    subagentSpan('claude_code.tool', 'agt-b', {}, { spanId: 'tool-b', parentSpanId: 'root', startMs: 150, endMs: 500 }),
  ]);
  const { items } = store.getAgents(SESSION);
  assert.equal(items[0].kind, 'main');
  const subs = items.filter((item) => item.kind === 'subagent');
  assert.equal(subs[0].id, 'agent:agt-a');
  assert.equal(subs[1].id, 'agent:agt-b');
  assert.ok(subs[0].firstMs < subs[1].firstMs);
});

test('a subagent span for a different session does not leak into this session\'s lanes', () => {
  const store = new TelemetryStore();
  store.ingest('traces', [
    span('claude_code.interaction', {}, { spanId: 'root' }),
    subagentSpan('claude_code.tool', 'agt-a', {}, { spanId: 'tool-a', parentSpanId: 'root' }),
    subagentSpan('claude_code.tool', 'agt-other', { 'session.id': 'other-session' }, { spanId: 'tool-other' }),
  ]);
  const { items } = store.getAgents(SESSION);
  assert.ok(!items.some((item) => item.id === 'agent:agt-other'));
});

test('getAgents for an unknown session returns null', () => {
  const store = new TelemetryStore();
  assert.equal(store.getAgents('nope'), null);
});

test('a session with records but no spans reports no items and firstMs 0', () => {
  const store = new TelemetryStore();
  store.ingest('logs', [log('claude_code.user_prompt', { prompt: 'hi' })]);
  const result = store.getAgents(SESSION);
  assert.deepEqual(result.items, []);
  assert.equal(result.firstMs, 0);
});

/* ------------------------- getAgents: lane lifetime ------------------------- */

test('an agent lane spans from its earliest span start to its latest span end', () => {
  const store = new TelemetryStore();
  store.ingest('traces', [
    span('claude_code.interaction', {}, { spanId: 'root' }),
    subagentSpan('claude_code.tool', 'agt-a', {}, { spanId: 's1', parentSpanId: 'root', startMs: 100, endMs: 400 }),
    subagentSpan('claude_code.tool', 'agt-a', {}, { spanId: 's2', parentSpanId: 'root', startMs: 200, endMs: 900 }),
    subagentSpan('claude_code.tool', 'agt-a', {}, { spanId: 's3', parentSpanId: 'root', startMs: 300, endMs: 500 }),
  ]);
  const { items } = store.getAgents(SESSION);
  const lane = items.find((item) => item.id === 'agent:agt-a');
  assert.equal(lane.firstMs, NOW + 100);
  assert.equal(lane.lastMs, NOW + 900);
  assert.equal(lane.durationMs, 800);
});

test('an open span (endMs: 0) contributes only its start, never the epoch, to the lane', () => {
  const store = new TelemetryStore();
  const open = { ...subagentSpan('claude_code.tool', 'agt-a', {}, { spanId: 'open', parentSpanId: 'root', startMs: 200 }), endMs: 0 };
  store.ingest('traces', [span('claude_code.interaction', {}, { spanId: 'root' }), open]);
  const { items } = store.getAgents(SESSION);
  const lane = items.find((item) => item.id === 'agent:agt-a');
  assert.ok(lane, 'the lane must exist despite the open span');
  assert.equal(lane.lastMs, NOW + 200);
  assert.ok(Number.isFinite(lane.lastMs) && lane.lastMs > 0, 'lastMs must not be NaN or the epoch');
});

test('a span with startMs: 0 does not drag the lane firstMs to the epoch', () => {
  const store = new TelemetryStore();
  const undecoded = {
    ...subagentSpan('claude_code.tool', 'agt-a', {}, { spanId: 'undecoded', parentSpanId: 'root', startMs: 300, endMs: 600 }),
    startMs: 0,
  };
  store.ingest('traces', [
    span('claude_code.interaction', {}, { spanId: 'root' }),
    subagentSpan('claude_code.tool', 'agt-a', {}, { spanId: 'normal', parentSpanId: 'root', startMs: 300, endMs: 500 }),
    undecoded,
  ]);
  const { items } = store.getAgents(SESSION);
  const lane = items.find((item) => item.id === 'agent:agt-a');
  assert.equal(lane.firstMs, NOW + 300);
});

/* ------------------------- getAgents: unattributed activity ------------------------- */

test('a span with no agent attributes inherits its lane from its subagent parent', () => {
  const store = new TelemetryStore();
  store.ingest('traces', [
    span('claude_code.interaction', {}, { spanId: 'root' }),
    subagentSpan('claude_code.tool', 'agt-a', {}, { spanId: 'tool-a', parentSpanId: 'root', startMs: 100, endMs: 500 }),
    span('claude_code.tool.execution', {}, { spanId: 'exec-a', parentSpanId: 'tool-a', startMs: 150, endMs: 400 }),
  ]);
  const { items } = store.getAgents(SESSION);
  const lane = items.find((item) => item.id === 'agent:agt-a');
  const main = items.find((item) => item.id === 'main');
  assert.equal(lane.spanCount, 2, 'the execution span must count on the subagent lane');
  assert.equal(main.spanCount, 1, 'the execution span must not count on main');
});

test('a span whose parent chain resolves to nothing lands on an unattributed lane', () => {
  const store = new TelemetryStore();
  store.ingest('traces', [
    span('claude_code.interaction', {}, { spanId: 'root' }),
    span('claude_code.tool.execution', {}, { spanId: 'orphan', parentSpanId: 'ghost', startMs: 100, endMs: 200 }),
  ]);
  const { items } = store.getAgents(SESSION);
  const unattributed = items.find((item) => item.kind === 'unattributed');
  const main = items.find((item) => item.kind === 'main');
  assert.ok(unattributed, 'a broken parent chain must produce an unattributed lane, never a drop');
  assert.equal(unattributed.spanCount, 1);
  assert.equal(main.spanCount, 1, 'the orphan must not be folded into main');
});

test('the unattributed lane, when present, sorts last', () => {
  const store = new TelemetryStore();
  store.ingest('traces', [
    span('claude_code.interaction', {}, { spanId: 'root' }),
    subagentSpan('claude_code.tool', 'agt-a', {}, { spanId: 'tool-a', parentSpanId: 'root' }),
    span('claude_code.tool.execution', {}, { spanId: 'orphan', parentSpanId: 'ghost' }),
  ]);
  const { items } = store.getAgents(SESSION);
  assert.equal(items.at(-1).kind, 'unattributed');
});

test('with every parent resolvable, no unattributed lane appears', () => {
  const store = new TelemetryStore();
  store.ingest('traces', [
    span('claude_code.interaction', {}, { spanId: 'root' }),
    subagentSpan('claude_code.tool', 'agt-a', {}, { spanId: 'tool-a', parentSpanId: 'root' }),
    span('claude_code.tool.execution', {}, { spanId: 'exec', parentSpanId: 'tool-a' }),
  ]);
  const { items } = store.getAgents(SESSION);
  assert.ok(!items.some((item) => item.kind === 'unattributed'));
});

/* --------------- getAgents: activity and context per lane --------------- */

test('activity is placed on the lane of the agent instance it belongs to, at the time it occurred', () => {
  const store = new TelemetryStore();
  store.ingest('traces', [
    span('claude_code.interaction', {}, { spanId: 'root' }),
    subagentSpan(
      'claude_code.tool',
      'agt-a',
      { tool_name: 'Read' },
      { spanId: 'tool-a', parentSpanId: 'root', startMs: 100 },
    ),
    subagentSpan(
      'claude_code.llm_request',
      'agt-a',
      { model: 'claude-opus-5' },
      { spanId: 'llm-a', parentSpanId: 'root', startMs: 300 },
    ),
  ]);
  const { items } = store.getAgents(SESSION);
  const lane = items.find((item) => item.id === 'agent:agt-a');
  const main = items.find((item) => item.id === 'main');
  assert.deepEqual(lane.activity, [
    { atMs: NOW + 100, kind: 'tool', name: 'Read', params: null, paramsTruncated: false },
    { atMs: NOW + 300, kind: 'llm_request', name: 'claude-opus-5', params: null, paramsTruncated: false },
  ]);
  assert.equal(lane.activityTotal, 2);
  assert.deepEqual(main.activity, [], 'an interaction span is not activity');
});

test('activity that resolves to no agent instance stays on the unattributed lane', () => {
  const store = new TelemetryStore();
  store.ingest('traces', [
    span('claude_code.interaction', {}, { spanId: 'root' }),
    span('claude_code.tool', {}, { spanId: 'orphan-tool', parentSpanId: 'ghost', startMs: 50 }),
  ]);
  const { items } = store.getAgents(SESSION);
  const unattributed = items.find((item) => item.kind === 'unattributed');
  const main = items.find((item) => item.kind === 'main');
  assert.ok(unattributed);
  assert.equal(unattributed.activity.length, 1);
  assert.equal(unattributed.activity[0].kind, 'tool');
  assert.deepEqual(main.activity, []);
});

test("the context curve is per lane, joined through the record's span because the record carries no agent_id", () => {
  const store = new TelemetryStore();
  store.ingest('traces', [
    span('claude_code.interaction', {}, { spanId: 'root' }),
    subagentSpan('claude_code.llm_request', 'agt-a', {}, { spanId: 'llm-a', parentSpanId: 'root' }),
  ]);
  store.ingest('logs', [
    { ...log('claude_code.api_request_body', { body: '{"m":1}', body_length: '4096' }, NOW + 50), spanId: 'llm-a' },
  ]);
  const { items } = store.getAgents(SESSION);
  const lane = items.find((item) => item.id === 'agent:agt-a');
  const main = items.find((item) => item.id === 'main');
  assert.deepEqual(lane.context, [{ atMs: NOW + 50, length: 4096 }]);
  assert.equal(lane.contextPeak, 4096);
  assert.deepEqual(main.context, []);
});

test('the reported untruncated length survives truncation', () => {
  const store = new TelemetryStore();
  store.ingest('traces', [
    span('claude_code.interaction', {}, { spanId: 'root' }),
    subagentSpan('claude_code.llm_request', 'agt-a', {}, { spanId: 'llm-a', parentSpanId: 'root' }),
  ]);
  store.ingest('logs', [
    {
      ...log(
        'claude_code.api_request_body',
        { body: '{"m":1}', body_truncated: 'true', body_length: '120000' },
        NOW + 50,
      ),
      spanId: 'llm-a',
    },
  ]);
  const { items } = store.getAgents(SESSION);
  const lane = items.find((item) => item.id === 'agent:agt-a');
  assert.equal(lane.context[0].length, 120000, 'the reported body_length must win, not the truncated body string');
  assert.equal(lane.contextPeak, 120000);
});

test('a context record that resolves to no agent instance stays visible on the unattributed lane', () => {
  // Repeated for spanId 'gone' (no such span exists) and '' (no span context at all,
  // the fixture default) — both must land on unattributed, never dropped.
  for (const spanId of ['gone', '']) {
    const store = new TelemetryStore();
    store.ingest('traces', [span('claude_code.interaction', {}, { spanId: 'root' })]);
    store.ingest('logs', [
      { ...log('claude_code.api_request_body', { body_length: '900' }, NOW + 400), spanId },
    ]);
    const { items } = store.getAgents(SESSION);
    const unattributed = items.find((item) => item.kind === 'unattributed');
    const main = items.find((item) => item.id === 'main');
    assert.ok(unattributed, `an unattributed lane must exist for spanId ${JSON.stringify(spanId)}`);
    assert.equal(unattributed.context.length, 1);
    assert.equal(unattributed.context[0].length, 900);
    assert.deepEqual(main.context, []);
    assert.ok(unattributed.firstMs <= NOW + 400, 'firstMs must include the content sample so its bar is drawable');
    assert.ok(unattributed.lastMs >= NOW + 400, 'lastMs must include the content sample so its bar is drawable');
  }
});

test('only request bodies feed the curve', () => {
  const store = new TelemetryStore();
  store.ingest('traces', [
    span('claude_code.interaction', {}, { spanId: 'root' }),
    span('claude_code.llm_request', {}, { spanId: 'llm-a', parentSpanId: 'root' }),
  ]);
  store.ingest('logs', [
    { ...log('claude_code.api_response_body', { body_length: '5000' }, NOW + 10), spanId: 'llm-a' },
    { ...log('claude_code.user_prompt', { prompt: 'hi', prompt_length: '2' }, NOW + 20), spanId: 'llm-a' },
    { ...log('claude_code.api_request_body', { body_length: '1000' }, NOW + 30), spanId: 'llm-a' },
  ]);
  const { items } = store.getAgents(SESSION);
  const main = items.find((item) => item.id === 'main');
  assert.equal(main.context.length, 1);
  assert.equal(main.context[0].length, 1000);
  assert.equal(main.contextPeak, 1000);
});

test('a lane with no tool/llm spans and no bodies still carries the four keys', () => {
  const store = new TelemetryStore();
  store.ingest('traces', [span('claude_code.interaction', {}, { spanId: 'root' })]);
  const { items } = store.getAgents(SESSION);
  const main = items.find((item) => item.id === 'main');
  assert.deepEqual(
    {
      activity: main.activity,
      activityTotal: main.activityTotal,
      context: main.context,
      contextPeak: main.contextPeak,
    },
    { activity: [], activityTotal: 0, context: [], contextPeak: 0 },
  );
});

test('activity is bounded without losing the ends', () => {
  const store = new TelemetryStore();
  const spans = [span('claude_code.interaction', {}, { spanId: 'root' })];
  for (let i = 1; i <= 3000; i++) {
    spans.push(
      subagentSpan(
        'claude_code.tool',
        'agt-a',
        { tool_name: 'Read' },
        { spanId: `tool-${i}`, parentSpanId: 'root', startMs: i },
      ),
    );
  }
  store.ingest('traces', spans);
  const { items } = store.getAgents(SESSION);
  const lane = items.find((item) => item.id === 'agent:agt-a');
  assert.equal(lane.activityTotal, 3000);
  assert.ok(lane.activity.length < 3000, 'the drawn marks must be thinned below the raw count');
  assert.equal(lane.activity[0].atMs, NOW + 1);
  assert.equal(lane.activity.at(-1).atMs, NOW + 3000);
});

test('the context peak survives thinning', () => {
  const store = new TelemetryStore();
  store.ingest('traces', [
    span('claude_code.interaction', {}, { spanId: 'root' }),
    subagentSpan('claude_code.llm_request', 'agt-a', {}, { spanId: 'llm-a', parentSpanId: 'root' }),
  ]);
  const logs = [];
  for (let i = 0; i < 1500; i++) {
    const length = i === 750 ? 999999 : 1000;
    logs.push({
      ...log('claude_code.api_request_body', { body_length: String(length) }, NOW + i),
      spanId: 'llm-a',
    });
  }
  store.ingest('logs', logs);
  const { items } = store.getAgents(SESSION);
  const lane = items.find((item) => item.id === 'agent:agt-a');
  assert.equal(lane.contextPeak, 999999, 'the peak must survive even though the drawn samples are thinned');
  assert.ok(lane.context.length < 1500, 'the drawn samples must be thinned below the raw count');
  assert.ok(lane.context.some((sample) => sample.length === 999999));
});

/* --------------- getAgents: tool call parameters --------------- */

test('the parameters are read through the attribution already in place: a subagent tool call carries its params on the agent lane, not on main', () => {
  const store = new TelemetryStore();
  store.ingest('traces', [
    span('claude_code.interaction', {}, { spanId: 'root' }),
    subagentSpan(
      'claude_code.tool',
      'agt-a',
      { tool_name: 'Read', tool_use_id: 'tu-1' },
      { spanId: 'tool-a', parentSpanId: 'root', startMs: 100 },
    ),
  ]);
  store.ingest('logs', [
    log(
      'claude_code.tool_result',
      { tool_name: 'Read', tool_use_id: 'tu-1', tool_input: JSON.stringify({ file_path: '/a.md' }) },
      NOW + 150,
    ),
  ]);
  const { items } = store.getAgents(SESSION);
  const lane = items.find((item) => item.id === 'agent:agt-a');
  const main = items.find((item) => item.id === 'main');
  assert.deepEqual(lane.activity, [
    { atMs: NOW + 100, kind: 'tool', name: 'Read', params: '{"file_path":"/a.md"}', paramsTruncated: false },
  ]);
  assert.deepEqual(main.activity, [], 'the parameters must land on the agent lane and nowhere else');
});

test('the older CLI attribute name tool_parameters is read the same as tool_input', () => {
  const store = new TelemetryStore();
  store.ingest('traces', [
    span('claude_code.interaction', {}, { spanId: 'root' }),
    subagentSpan(
      'claude_code.tool',
      'agt-a',
      { tool_name: 'Read', tool_use_id: 'tu-1' },
      { spanId: 'tool-a', parentSpanId: 'root', startMs: 100 },
    ),
  ]);
  store.ingest('logs', [
    log(
      'claude_code.tool_result',
      { tool_name: 'Read', tool_use_id: 'tu-1', tool_parameters: JSON.stringify({ file_path: '/a.md' }) },
      NOW + 150,
    ),
  ]);
  const { items } = store.getAgents(SESSION);
  const lane = items.find((item) => item.id === 'agent:agt-a');
  assert.equal(lane.activity[0].params, '{"file_path":"/a.md"}');
});

test('a tool call whose result never arrived still leaves its activity mark, with params null', () => {
  const store = new TelemetryStore();
  store.ingest('traces', [
    span('claude_code.interaction', {}, { spanId: 'root' }),
    subagentSpan(
      'claude_code.tool',
      'agt-a',
      { tool_name: 'Read', tool_use_id: 'tu-1' },
      { spanId: 'tool-a', parentSpanId: 'root', startMs: 100 },
    ),
  ]);
  const { items } = store.getAgents(SESSION);
  const lane = items.find((item) => item.id === 'agent:agt-a');
  assert.deepEqual(lane.activity, [
    { atMs: NOW + 100, kind: 'tool', name: 'Read', params: null, paramsTruncated: false },
  ]);
});

test('parameters longer than 1000 characters are truncated to the cap', () => {
  const store = new TelemetryStore();
  store.ingest('traces', [
    span('claude_code.interaction', {}, { spanId: 'root' }),
    subagentSpan(
      'claude_code.tool',
      'agt-a',
      { tool_name: 'Bash', tool_use_id: 'tu-1' },
      { spanId: 'tool-a', parentSpanId: 'root', startMs: 100 },
    ),
  ]);
  store.ingest('logs', [
    log(
      'claude_code.tool_result',
      { tool_name: 'Bash', tool_use_id: 'tu-1', tool_input: JSON.stringify({ command: 'x'.repeat(5000) }) },
      NOW + 150,
    ),
  ]);
  const { items } = store.getAgents(SESSION);
  const lane = items.find((item) => item.id === 'agent:agt-a');
  assert.equal(lane.activity[0].paramsTruncated, true);
  assert.equal(lane.activity[0].params.length, 1000);
});

test('the unattributed lane answers too: an orphan tool call carries its params', () => {
  const store = new TelemetryStore();
  store.ingest('traces', [
    span('claude_code.interaction', {}, { spanId: 'root' }),
    span(
      'claude_code.tool',
      { tool_name: 'Bash', tool_use_id: 'tu-9' },
      { spanId: 'orphan-tool', parentSpanId: 'ghost', startMs: 50 },
    ),
  ]);
  store.ingest('logs', [
    log(
      'claude_code.tool_result',
      { tool_name: 'Bash', tool_use_id: 'tu-9', tool_input: JSON.stringify({ command: 'ls -la' }) },
      NOW + 100,
    ),
  ]);
  const { items } = store.getAgents(SESSION);
  const unattributed = items.find((item) => item.kind === 'unattributed');
  const main = items.find((item) => item.id === 'main');
  assert.equal(unattributed.activity[0].params, '{"command":"ls -la"}');
  assert.deepEqual(main.activity, []);
});

test('a tool_result with no matching tool span invents no activity entry: no second attribution path', () => {
  const store = new TelemetryStore();
  store.ingest('traces', [span('claude_code.interaction', {}, { spanId: 'root' })]);
  store.ingest('logs', [
    log(
      'claude_code.tool_result',
      { tool_name: 'Bash', tool_use_id: 'tu-nothing', tool_input: JSON.stringify({ command: 'ls' }) },
      NOW + 100,
    ),
  ]);
  const { items } = store.getAgents(SESSION);
  assert.deepEqual(items.map((item) => item.id), ['main'], 'the spans alone produce only the main lane');
  assert.equal(items[0].activity.length, 0, 'the orphan tool_result must not invent an activity entry');
});

/* --------------- getLaneContext --------------- */

test('the nearest request body at or before the chosen time, on the selected lane', () => {
  const store = new TelemetryStore();
  store.ingest('traces', [
    span('claude_code.interaction', {}, { spanId: 'root' }),
    subagentSpan('claude_code.llm_request', 'agt-a', {}, { spanId: 'llm-a', parentSpanId: 'root' }),
  ]);
  store.ingest('logs', [
    { ...log('claude_code.api_request_body', { body: '{"a":10}', body_length: '8' }, NOW + 10), spanId: 'llm-a' },
    { ...log('claude_code.api_request_body', { body: '{"a":20}', body_length: '8' }, NOW + 20), spanId: 'llm-a' },
    { ...log('claude_code.api_request_body', { body: '{"a":30}', body_length: '8' }, NOW + 30), spanId: 'llm-a' },
    { ...log('claude_code.api_request_body', { body: '{"a":25}', body_length: '8' }, NOW + 25), spanId: 'root' },
  ]);
  const answer = store.getLaneContext(SESSION, 'agent:agt-a', NOW + 25);
  assert.equal(answer.record.timeMs, NOW + 20, 'the later record at +30 and the main-lane record at +25 must both lose');
  assert.equal(answer.record.text, '{"a":20}');
});

test('a bound before every record on the lane answers with a null record, echoing the query', () => {
  const store = new TelemetryStore();
  store.ingest('traces', [
    span('claude_code.interaction', {}, { spanId: 'root' }),
    subagentSpan('claude_code.llm_request', 'agt-a', {}, { spanId: 'llm-a', parentSpanId: 'root' }),
  ]);
  store.ingest('logs', [
    { ...log('claude_code.api_request_body', { body: '{"a":10}', body_length: '8' }, NOW + 10), spanId: 'llm-a' },
    { ...log('claude_code.api_request_body', { body: '{"a":20}', body_length: '8' }, NOW + 20), spanId: 'llm-a' },
    { ...log('claude_code.api_request_body', { body: '{"a":30}', body_length: '8' }, NOW + 30), spanId: 'llm-a' },
  ]);
  const answer = store.getLaneContext(SESSION, 'agent:agt-a', NOW + 5);
  assert.equal(answer.record, null);
  assert.equal(answer.sessionId, SESSION);
  assert.equal(answer.laneId, 'agent:agt-a');
  assert.equal(answer.atMs, NOW + 5);
});

test('an unknown session answers null outright', () => {
  const store = new TelemetryStore();
  assert.equal(store.getLaneContext('nope', 'main', NOW), null);
});

test("a body under a span with no agent attributes and no parent resolves to the main lane", () => {
  const store = new TelemetryStore();
  store.ingest('traces', [
    span('claude_code.interaction', {}, { spanId: 'root' }),
    subagentSpan('claude_code.llm_request', 'agt-a', {}, { spanId: 'llm-a', parentSpanId: 'root' }),
  ]);
  store.ingest('logs', [
    { ...log('claude_code.api_request_body', { body: '{"main":1}', body_length: '10' }, NOW + 25), spanId: 'root' },
  ]);
  const main = store.getLaneContext(SESSION, 'main', NOW + 25);
  assert.equal(main.record.text, '{"main":1}');
  assert.equal(main.record.timeMs, NOW + 25);
  const agent = store.getLaneContext(SESSION, 'agent:agt-a', NOW + 25);
  assert.equal(agent.record, null, 'the main-lane body must not answer the agent lane');
});

test('a body naming no span, or a span whose parent chain resolves to nothing, resolves to unattributed', () => {
  // Repeated for spanId 'gone' (no such span exists) and '' (no span context at all, the
  // fixture default) — both must land on unattributed, never on main.
  for (const spanId of ['gone', '']) {
    const store = new TelemetryStore();
    store.ingest('traces', [span('claude_code.interaction', {}, { spanId: 'root' })]);
    store.ingest('logs', [
      { ...log('claude_code.api_request_body', { body: '{"o":1}', body_length: '7' }, NOW + 400), spanId },
    ]);
    const unattributed = store.getLaneContext(SESSION, 'unattributed', NOW + 400);
    assert.equal(unattributed.record.text, '{"o":1}', `spanId ${JSON.stringify(spanId)} must resolve to unattributed`);
    const main = store.getLaneContext(SESSION, 'main', NOW + 400);
    assert.equal(main.record, null, `spanId ${JSON.stringify(spanId)} must not resolve to main`);
  }
});

test('a truncated body reports the untruncated length, not the delivered text\'s', () => {
  const store = new TelemetryStore();
  store.ingest('traces', [
    span('claude_code.interaction', {}, { spanId: 'root' }),
    subagentSpan('claude_code.llm_request', 'agt-a', {}, { spanId: 'llm-a', parentSpanId: 'root' }),
  ]);
  store.ingest('logs', [
    {
      ...log(
        'claude_code.api_request_body',
        { body: '{"m":1}', body_truncated: 'true', body_length: '120000' },
        NOW + 50,
      ),
      spanId: 'llm-a',
    },
  ]);
  const answer = store.getLaneContext(SESSION, 'agent:agt-a', NOW + 50);
  assert.equal(answer.record.length, 120000);
  assert.equal(answer.record.truncated, true);
  assert.equal(answer.record.text, '{"m":1}');
});

test('a reported length with no body text at all answers with text null and ref null', () => {
  const store = new TelemetryStore();
  store.ingest('traces', [
    span('claude_code.interaction', {}, { spanId: 'root' }),
    subagentSpan('claude_code.llm_request', 'agt-a', {}, { spanId: 'llm-a', parentSpanId: 'root' }),
  ]);
  store.ingest('logs', [
    { ...log('claude_code.api_request_body', { body_length: '900' }, NOW + 50), spanId: 'llm-a' },
  ]);
  const answer = store.getLaneContext(SESSION, 'agent:agt-a', NOW + 50);
  assert.equal(answer.record.length, 900);
  assert.equal(answer.record.text, null);
  assert.equal(answer.record.ref, null);
  // queryContent's predicate is what the content list is built on, and a length-only record
  // (no body, no body_ref) does not count as "content" there — while it does still count
  // toward the curve on getAgents. So getLaneContext cannot be built on queryContent's
  // predicate; it has to read the raw request_body records itself.
  assert.deepEqual(store.queryContent({ sessionId: SESSION, kinds: ['request_body'] }), []);
});

test('a body recorded as a file reference is answered with the ref, no inline text', () => {
  const store = new TelemetryStore();
  store.ingest('traces', [
    span('claude_code.interaction', {}, { spanId: 'root' }),
    subagentSpan('claude_code.llm_request', 'agt-a', {}, { spanId: 'llm-a', parentSpanId: 'root' }),
  ]);
  store.ingest('logs', [
    {
      ...log('claude_code.api_request_body', { body_ref: '/tmp/body.json', body_length: '5000' }, NOW + 50),
      spanId: 'llm-a',
    },
  ]);
  const answer = store.getLaneContext(SESSION, 'agent:agt-a', NOW + 50);
  assert.equal(answer.record.ref, '/tmp/body.json');
  assert.equal(answer.record.text, null);
  assert.equal(answer.record.length, 5000);
});

test('records arriving out of order still resolve to the nearest at-or-before, not the first backwards hit', () => {
  const store = new TelemetryStore();
  store.ingest('traces', [
    span('claude_code.interaction', {}, { spanId: 'root' }),
    subagentSpan('claude_code.llm_request', 'agt-a', {}, { spanId: 'llm-a', parentSpanId: 'root' }),
  ]);
  store.ingest('logs', [
    { ...log('claude_code.api_request_body', { body: '{"a":30}', body_length: '8' }, NOW + 30), spanId: 'llm-a' },
    { ...log('claude_code.api_request_body', { body: '{"a":10}', body_length: '8' }, NOW + 10), spanId: 'llm-a' },
    { ...log('claude_code.api_request_body', { body: '{"a":20}', body_length: '8' }, NOW + 20), spanId: 'llm-a' },
  ]);
  const answer = store.getLaneContext(SESSION, 'agent:agt-a', NOW + 25);
  assert.equal(answer.record.timeMs, NOW + 20);
  assert.equal(answer.record.text, '{"a":20}');
});

test('only request bodies answer the query, not response bodies or prompts under the same span', () => {
  const store = new TelemetryStore();
  store.ingest('traces', [
    span('claude_code.interaction', {}, { spanId: 'root' }),
    subagentSpan('claude_code.llm_request', 'agt-a', {}, { spanId: 'llm-a', parentSpanId: 'root' }),
  ]);
  store.ingest('logs', [
    { ...log('claude_code.api_request_body', { body: '{"a":1}', body_length: '7' }, NOW + 10), spanId: 'llm-a' },
    { ...log('claude_code.user_prompt', { prompt: 'hi', prompt_length: '2' }, NOW + 20), spanId: 'llm-a' },
    { ...log('claude_code.api_response_body', { body: '{"b":2}', body_length: '7' }, NOW + 30), spanId: 'llm-a' },
  ]);
  const answer = store.getLaneContext(SESSION, 'agent:agt-a', NOW + 40);
  assert.equal(answer.record.timeMs, NOW + 10);
  assert.equal(answer.record.text, '{"a":1}');
});
