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
