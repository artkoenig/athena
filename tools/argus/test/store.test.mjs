import test from 'node:test';
import assert from 'node:assert/strict';

import { TelemetryStore } from '../src/store.mjs';
import { agentOf } from '../src/claude.mjs';

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

// A content record as measured against a real capture: string attributes for
// body_length/body_truncated, session.id kept in attrs like the other helpers.
const bodyLog = (attributes = {}, timeMs = Date.now()) =>
  log(
    'claude_code.api_request_body',
    {
      'event.sequence': '5',
      'prompt.id': 'prompt-1',
      model: 'claude-sonnet-5',
      query_source: 'sdk',
      body: '{"messages":[{"role":"user","content":"hi"}]}',
      body_length: '106251',
      body_truncated: 'true',
      ...attributes,
    },
    timeMs,
  );

// A response body as measured: same shape as a request body, plus request_id.
const responseBodyLog = (attributes = {}, timeMs = Date.now()) => ({
  ...bodyLog({ request_id: 'req_011Cdm', ...attributes }, timeMs),
  eventName: 'claude_code.api_response_body',
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

// A backlog-shaped state literal, as `skills/agent-brief/assets/backlog.mjs`
// writes it — never read from that file, just shaped like its output.
const backlogState = (overrides = {}) => ({
  version: 1,
  issue: 'docs/issues/2026-08-08-x',
  workflow: 'agile-loop',
  codemap: '',
  increments: [{ id: 'one', title: 'First', status: 'todo', note: '', branch: '', steps: [] }],
  run: { steps: [] },
  ...overrides,
});

test("a run's state is held under its id and served whole", () => {
  const store = new TelemetryStore();
  const state = backlogState();
  store.putRunState('run-a', state);
  const run = store.getRun('run-a');
  assert.deepEqual(run.state, state);
  assert.equal(run.issue, state.issue);
  assert.equal(run.workflow, state.workflow);
  assert.equal(run.increments, state.increments.length);
  assert.equal(typeof run.updatedAtMs, 'number');
});

test('a second write for the same run replaces the first, keeping no history', () => {
  const store = new TelemetryStore();
  store.putRunState('run-a', backlogState({ issue: 'docs/issues/2026-08-08-a' }));
  const second = backlogState({ issue: 'docs/issues/2026-08-08-b' });
  store.putRunState('run-a', second);
  assert.deepEqual(store.getRun('run-a').state, second);
  assert.equal(store.listRuns().total, 1);
});

test('listRuns names each run with what a reader picks by, latest write first, and never the state', () => {
  const store = new TelemetryStore();
  store.putRunState('run-old', backlogState(), { updatedAtMs: 1_000 });
  store.putRunState('run-new', backlogState(), { updatedAtMs: 2_000 });
  const { items } = store.listRuns();
  assert.deepEqual(items.map((item) => item.id), ['run-new', 'run-old']);
  for (const item of items) {
    assert.equal(typeof item.id, 'string');
    assert.equal(typeof item.issue, 'string');
    assert.equal(typeof item.workflow, 'string');
    assert.equal(typeof item.increments, 'number');
    assert.equal(typeof item.updatedAtMs, 'number');
    assert.ok(!('state' in item), 'listRuns must never carry the state');
  }
});

test('getRun for a run nobody wrote is null', () => {
  const store = new TelemetryStore();
  assert.equal(store.getRun('nope'), null);
  assert.equal(store.listRuns().total, 0);
});

test('past maxRuns the least recently written run is dropped', () => {
  const store = new TelemetryStore({ maxRuns: 2 });
  store.putRunState('a', backlogState());
  store.putRunState('b', backlogState());
  store.putRunState('a', backlogState());
  store.putRunState('c', backlogState());
  assert.ok(store.getRun('a'), 're-writing "a" must count it as the most recent, not the oldest');
  assert.ok(store.getRun('c'));
  assert.equal(store.getRun('b'), null);
  assert.equal(store.listRuns().total, 2);
});

test('clear() drops the run states along with everything else, keeping subscribers attached', () => {
  const store = new TelemetryStore();
  let notified = 0;
  store.subscribe(() => notified++);
  store.putRunState('run-a', backlogState());
  store.clear();
  assert.equal(store.listRuns().total, 0);
  assert.equal(store.getRun('run-a'), null);
  store.putRunState('run-b', backlogState());
  assert.equal(notified, 2, 'a subscriber attached before clear() must still receive a later run change');
});

test('a run-state change is announced to subscribers, and a replayed one is marked as replayed', () => {
  const store = new TelemetryStore();
  const changes = [];
  store.subscribe((change) => changes.push(change));
  store.putRunState('run-a', backlogState());
  store.putRunState('run-a', backlogState(), { replay: true });
  assert.equal(changes.length, 2);
  assert.equal(changes[0].kind, 'runState');
  assert.equal(changes[0].runId, 'run-a');
  assert.ok(changes[0].run.state, 'the change must carry the run state, not just its id');
  assert.equal(changes[0].replay, false);
  assert.equal(changes[1].replay, true);
});

test('an ingested api_request_body event is listed with parsed metadata and never with its body', () => {
  const store = new TelemetryStore();
  store.ingest('logs', [bodyLog()]);
  const items = store.listContent({ sessionId: SESSION });
  assert.equal(items.length, 1);
  const item = items[0];
  assert.equal(item.querySource, 'sdk');
  assert.equal(item.agent, null);
  assert.equal(item.isSubagent, false);
  assert.equal(item.model, 'claude-sonnet-5');
  assert.equal(item.bodyLength, 106251);
  assert.equal(typeof item.bodyLength, 'number', 'body_length arrives as a string on the wire and must be parsed');
  assert.equal(item.truncated, true);
  assert.equal(typeof item.truncated, 'boolean', 'body_truncated arrives as a string on the wire and must be parsed');
  assert.ok(!('body' in item), 'listContent must never carry the full body');
});

test('contentAt returns the exact body for a record whose time matches the boundary exactly', () => {
  const store = new TelemetryStore();
  const t = Date.now();
  const record = bodyLog({}, t);
  store.ingest('logs', [record]);
  const item = store.contentAt({ sessionId: SESSION, atMs: t });
  assert.equal(item.body, record.attrs.body);
});

test('contentAt returns the newest record at or before the requested time, and null before the first record', () => {
  const store = new TelemetryStore();
  const t = Date.now();
  store.ingest('logs', [
    bodyLog({ 'prompt.id': 'p-early' }, t),
    bodyLog({ 'prompt.id': 'p-later' }, t + 1000),
  ]);
  const mid = store.contentAt({ sessionId: SESSION, atMs: t + 500 });
  assert.equal(mid.promptId, 'p-early');
  assert.equal(store.contentAt({ sessionId: SESSION, atMs: t - 1 }), null);
});

test('main and subagent content records are told apart by query_source, and a redacted name still resolves to something', () => {
  const store = new TelemetryStore();
  store.ingest('logs', [
    bodyLog({ query_source: 'sdk', 'prompt.id': 'p-main' }),
    bodyLog({ query_source: 'agent:custom:probe-bot', 'prompt.id': 'p-sub' }),
  ]);

  const byAgent = store.listContent({ sessionId: SESSION, agent: 'probe-bot' });
  assert.equal(byAgent.length, 1);
  assert.equal(byAgent[0].promptId, 'p-sub');

  const mainOnly = store.listContent({ sessionId: SESSION, mainOnly: true });
  assert.equal(mainOnly.length, 1);
  assert.equal(mainOnly[0].promptId, 'p-main');

  assert.equal(agentOf({ query_source: 'agent:custom' }), 'custom');
});

test('two concurrent subagents of the same type are distinguished by spanId, not by query_source alone', () => {
  const store = new TelemetryStore();
  store.ingest('logs', [
    { ...bodyLog({ query_source: 'agent:custom:probe-bot', 'prompt.id': 'p-a' }), spanId: 'span-a' },
    { ...bodyLog({ query_source: 'agent:custom:probe-bot', 'prompt.id': 'p-b' }), spanId: 'span-b' },
  ]);
  const items = store.listContent({ sessionId: SESSION, spanId: 'span-a' });
  assert.equal(items.length, 1);
  assert.equal(items[0].promptId, 'p-a');
});

test('content records are evicted oldest-first once the total exceeds maxContentChars, whole from both indexes', () => {
  const store = new TelemetryStore({ maxContentChars: 120 });
  const t = Date.now();
  const bodies = ['a'.repeat(50), 'b'.repeat(50), 'c'.repeat(50)];
  const records = bodies.map((body, i) =>
    bodyLog({ 'prompt.id': `p-${i}`, body, body_length: String(body.length), body_truncated: 'false' }, t + i),
  );
  const other = log('claude_code.user_prompt', { prompt: 'unrelated' }, t + 10);
  store.ingest('logs', [...records, other]);

  const ids = store.listContent({ sessionId: SESSION }).map((item) => item.promptId);
  assert.ok(!ids.includes('p-0'), 'the oldest content record must be evicted once the budget is exceeded');
  assert.ok(ids.includes('p-2'), 'the newest content record must survive');

  const rawIds = store
    .queryEvents({ sessionId: SESSION, eventName: 'claude_code.api_request_body' })
    .map((event) => event.attrs['prompt.id']);
  assert.ok(!rawIds.includes('p-0'), 'eviction removes the whole record from the raw log too, not just the index');

  assert.equal(
    store.queryEvents({ sessionId: SESSION, eventName: 'claude_code.user_prompt' }).length,
    1,
    'a non-content log ingested alongside must be untouched by content eviction',
  );
});

test('a single body larger than the whole content budget is still kept, never dropped', () => {
  const store = new TelemetryStore({ maxContentChars: 10 });
  const bigBody = 'x'.repeat(500);
  const t = Date.now();
  store.ingest('logs', [bodyLog({ body: bigBody, body_length: String(bigBody.length), body_truncated: 'false' }, t)]);
  const item = store.contentAt({ sessionId: SESSION, atMs: t });
  assert.equal(item.body, bigBody);
});

test('clear() resets content bookkeeping along with everything else', () => {
  const store = new TelemetryStore();
  store.ingest('logs', [bodyLog({ 'prompt.id': 'p-before' })]);
  store.clear();
  store.ingest('logs', [bodyLog({ 'prompt.id': 'p-after' })]);
  const items = store.listContent({ sessionId: SESSION });
  assert.equal(items.length, 1);
  assert.equal(items[0].promptId, 'p-after');
});

test('dropping the oldest session under maxSessions removes its content records too', () => {
  const store = new TelemetryStore({ maxSessions: 1 });
  const t = Date.now();
  store.ingest('logs', [bodyLog({ 'session.id': 'sess-a', 'prompt.id': 'p-a' }, t)]);
  store.ingest('logs', [bodyLog({ 'session.id': 'sess-b', 'prompt.id': 'p-b' }, t + 1000)]);
  assert.equal(store.listContent({ sessionId: 'sess-a' }).length, 0);
  assert.equal(store.listContent({ sessionId: 'sess-b' }).length, 1);
});

test('an api_response_body record is indexed alongside a request body, and the eventName filter discriminates between them', () => {
  const store = new TelemetryStore();
  store.ingest('logs', [bodyLog(), responseBodyLog({ 'prompt.id': 'p-resp' })]);

  const responses = store.listContent({ sessionId: SESSION, eventName: 'claude_code.api_response_body' });
  assert.equal(responses.length, 1);
  assert.equal(responses[0].eventName, 'claude_code.api_response_body');
  assert.equal(responses[0].requestId, 'req_011Cdm');
  assert.ok(!('body' in responses[0]), 'listContent must never carry the full body for a response record either');

  const requests = store.listContent({ sessionId: SESSION, eventName: 'claude_code.api_request_body' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].eventName, 'claude_code.api_request_body');
});

test('contentAt with an eventName filter returns the matching body, and the default filter still means api_request_body', () => {
  const store = new TelemetryStore();
  const t = Date.now();
  store.ingest('logs', [
    bodyLog({ body: 'request text' }, t),
    responseBodyLog({ body: 'response text' }, t + 10),
  ]);

  const response = store.contentAt({ sessionId: SESSION, atMs: t + 100, eventName: 'claude_code.api_response_body' });
  assert.equal(response.body, 'response text');

  const request = store.contentAt({ sessionId: SESSION, atMs: t + 100 });
  assert.equal(request.body, 'request text', 'the newer response record must not bleed into the documented default filter');
});
