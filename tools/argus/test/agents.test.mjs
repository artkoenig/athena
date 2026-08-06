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
    events: extra.events ?? [],
    links: [],
    attrs: { 'session.id': SESSION, ...attributes },
  };
};

// `claude_code.api_request_body` carries the whole request payload as a JSON
// string in `body`, with `body_length` and `body_truncated` beside it.
const requestBody = (attributes = {}, timeMs = Date.now()) => log('claude_code.api_request_body', attributes, timeMs);

test('a session splits into the main session and the subagents that ran in it', () => {
  const store = new TelemetryStore();
  store.ingest('logs', [
    log('claude_code.api_request', { model: 'claude-opus-5', input_tokens: 100 }),
    log('claude_code.api_request', { model: 'claude-opus-5', input_tokens: 100 }),
    log('claude_code.api_request', {
      model: 'claude-opus-5',
      input_tokens: 50,
      'agent.name': 'Explore',
      query_source: 'agent:builtin:Explore',
    }),
    log('claude_code.api_request', {
      model: 'claude-opus-5',
      input_tokens: 50,
      'agent.name': 'Explore',
      query_source: 'agent:builtin:Explore',
    }),
  ]);
  const { agents } = store.getSessionAgents(SESSION);
  assert.equal(agents.length, 2);
  const main = agents.find((agent) => agent.key === 'main');
  const explore = agents.find((agent) => agent.key === 'Explore');
  assert.equal(main.kind, 'main');
  assert.equal(explore.kind, 'subagent');
  assert.equal(main.counts.apiRequests, 2);
  assert.equal(explore.counts.apiRequests, 2);
  assert.equal(main.label, 'main session');
  assert.equal(explore.label, 'Explore');
});

test('records naming no agent are the main session, never an unknown one', () => {
  const store = new TelemetryStore();
  store.ingest('logs', [
    log('claude_code.user_prompt', { prompt: 'hi' }),
    log('claude_code.tool_result', { tool_name: 'Bash', success: 'true' }),
  ]);
  const { agents } = store.getSessionAgents(SESSION);
  assert.equal(agents.length, 1);
  assert.equal(agents[0].key, 'main');
  assert.equal(agents[0].counts.userPrompts, 1);
});

test('the session total is the sum of its agents', () => {
  const store = new TelemetryStore();
  store.ingest('logs', [
    log('claude_code.api_request', { model: 'claude-opus-5', input_tokens: 100, cost_usd: 0.1 }),
    log('claude_code.api_request', {
      model: 'claude-opus-5',
      input_tokens: 200,
      cost_usd: 0.2,
      'agent.name': 'Explore',
      query_source: 'agent:builtin:Explore',
    }),
  ]);
  const { agents } = store.getSessionAgents(SESSION);
  const session = store.getSession(SESSION);
  const tokensTotal = agents.reduce((sum, agent) => sum + agent.tokensTotal, 0);
  const costTotal = agents.reduce((sum, agent) => sum + agent.costUsd, 0);
  const requestsTotal = agents.reduce((sum, agent) => sum + agent.counts.apiRequests, 0);
  assert.equal(tokensTotal, session.tokensTotal);
  assert.equal(costTotal, session.costUsd);
  assert.equal(requestsTotal, session.counts.apiRequests);
});

test('per-agent tokens prefer metrics over events, like the session total', () => {
  const store = new TelemetryStore();
  store.ingest('logs', [
    log('claude_code.api_request', {
      model: 'claude-opus-5',
      input_tokens: 200,
      cost_usd: 1,
      'agent.name': 'Explore',
      query_source: 'agent:builtin:Explore',
    }),
  ]);
  store.ingest('metrics', [
    metric('claude_code.token.usage', 200, { type: 'input', model: 'claude-opus-5', 'agent.name': 'Explore' }),
    metric('claude_code.cost.usage', 1, { model: 'claude-opus-5', 'agent.name': 'Explore' }),
  ]);
  const { agents } = store.getSessionAgents(SESSION);
  const explore = agents.find((agent) => agent.key === 'Explore');
  assert.equal(explore.tokenSource, 'metrics');
  assert.equal(explore.tokensTotal, 200);
  assert.equal(explore.costUsd, 1);
});

test('an agent_id is joined onto the name as soon as one record carries both', () => {
  const store = new TelemetryStore();
  store.ingest('traces', [span('claude_code.tool', { tool_name: 'Read', agent_id: 'a1' }, { spanId: 'tool-1' })]);
  store.ingest('traces', [
    span(
      'claude_code.llm_request',
      { agent_id: 'a1', query_source: 'agent:builtin:Explore' },
      { spanId: 'llm-1' },
    ),
  ]);
  const { agents } = store.getSessionAgents(SESSION);
  assert.equal(agents.length, 1);
  const explore = agents[0];
  assert.equal(explore.key, 'Explore');
  assert.equal(explore.counts.toolCalls, 1);
  assert.equal(explore.counts.llmRequests, 1);
  assert.equal(agents.find((agent) => agent.key === 'id:a1'), undefined);
});

test('an agent_id that is never named stays an agent of its own, labelled by its id', () => {
  const store = new TelemetryStore();
  store.ingest('traces', [span('claude_code.tool', { tool_name: 'Read', agent_id: 'a10f6aaeff1f24fa1' })]);
  const { agents } = store.getSessionAgents(SESSION);
  assert.equal(agents.length, 1);
  assert.equal(agents[0].key, 'id:a10f6aaeff1f24fa1');
  assert.equal(agents[0].label, 'subagent a10f6aae');
});

test('occupancy is one entry per model call and sums input, cache read and cache creation', () => {
  const store = new TelemetryStore();
  store.ingest('logs', [
    log('claude_code.api_request', {
      model: 'claude-opus-5',
      input_tokens: 38412,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    }),
    log('claude_code.api_request', {
      model: 'claude-opus-5',
      input_tokens: 38765,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    }),
    log('claude_code.api_request', {
      model: 'claude-opus-5',
      input_tokens: 16534,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      'agent.name': 'Explore',
      query_source: 'agent:builtin:Explore',
    }),
    log('claude_code.api_request', {
      model: 'claude-opus-5',
      input_tokens: 16668,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      'agent.name': 'Explore',
      query_source: 'agent:builtin:Explore',
    }),
  ]);
  const { agents } = store.getSessionAgents(SESSION);
  const main = agents.find((agent) => agent.key === 'main');
  const explore = agents.find((agent) => agent.key === 'Explore');
  assert.equal(main.context.series.length, 2);
  assert.equal(explore.context.series.length, 2);
  assert.deepEqual(
    main.context.series.map((entry) => entry.occupancy),
    [38412, 38765],
  );
  assert.deepEqual(
    explore.context.series.map((entry) => entry.occupancy),
    [16534, 16668],
  );
});

test('peak and last occupancy, and the cached prefix of the last prompt, are reported', () => {
  const store = new TelemetryStore();
  store.ingest('logs', [
    log(
      'claude_code.api_request',
      { model: 'claude-opus-5', input_tokens: 2000, cache_read_tokens: 0, cache_creation_tokens: 0 },
      NOW,
    ),
    log(
      'claude_code.api_request',
      { model: 'claude-opus-5', input_tokens: 100, cache_read_tokens: 900, cache_creation_tokens: 0 },
      NOW + 1000,
    ),
  ]);
  const main = store.getSessionAgents(SESSION).agents.find((agent) => agent.key === 'main');
  assert.equal(main.context.peakOccupancy, 2000);
  assert.equal(main.context.lastOccupancy, 1000);
  assert.equal(main.context.lastCachedPrefixTokens, 900);
  assert.equal(main.context.lastFreshTokens, 100);
  assert.equal(main.context.lastCachedPrefixRatio, 0.9);
});

test('an agent that made no model call reports no series and no ratio', () => {
  const store = new TelemetryStore();
  store.ingest('traces', [span('claude_code.tool', { tool_name: 'Read', agent_id: 'a2' })]);
  const agent = store.getSessionAgents(SESSION).agents.find((entry) => entry.key === 'id:a2');
  assert.deepEqual(agent.context.series, []);
  assert.equal(agent.context.peakOccupancy, 0);
  assert.equal(agent.context.lastOccupancy, 0);
  assert.equal(agent.context.lastCachedPrefixRatio, null);
});

test('peak occupancy survives the series rolling over', () => {
  const store = new TelemetryStore({ maxAgentCalls: 3 });
  const calls = [5000, 100, 200, 300, 400];
  store.ingest(
    'logs',
    calls.map((inputTokens, i) =>
      log(
        'claude_code.api_request',
        { model: 'claude-opus-5', input_tokens: inputTokens, cache_read_tokens: 0, cache_creation_tokens: 0 },
        NOW + i * 1000,
      ),
    ),
  );
  const main = store.getSessionAgents(SESSION).agents.find((agent) => agent.key === 'main');
  assert.equal(main.context.series.length, 3);
  assert.equal(main.context.peakOccupancy, 5000);
  assert.equal(main.context.lastOccupancy, 400);
});

test('a request body is indexed per agent and served from the raw window', () => {
  const store = new TelemetryStore();
  const payload = JSON.stringify({ system: [{ type: 'text', text: 'hi' }], tools: [], messages: [] });
  store.ingest('logs', [
    requestBody({
      model: 'claude-opus-5',
      body: payload,
      body_length: Buffer.byteLength(payload),
      body_truncated: false,
    }),
  ]);
  const agent = store.getSessionAgents(SESSION).agents.find((entry) => entry.key === 'main');
  assert.equal(agent.bodies.length, 1);
  assert.equal(agent.bodies[0].bodyLength, Buffer.byteLength(payload));
  assert.equal(agent.bodies[0].truncated, false);
  const body = store.getAgentBody(SESSION, 'main', agent.bodies[0].seq);
  assert.equal(body.available, true);
  assert.equal(body.body, payload);
  assert.deepEqual(body.parsed, JSON.parse(payload));
});

test('a truncated payload is served as truncated with its real length and is never parsed', () => {
  const store = new TelemetryStore();
  const cut = '{"system":[{"type":"text","text":"this got cut off half way thro';
  store.ingest('logs', [
    requestBody({ model: 'claude-opus-5', body: cut, body_length: 110141, body_truncated: true }),
  ]);
  const agent = store.getSessionAgents(SESSION).agents.find((entry) => entry.key === 'main');
  const body = store.getAgentBody(SESSION, 'main', agent.bodies[0].seq);
  assert.equal(body.truncated, true);
  assert.equal(body.bodyLength, 110141);
  assert.equal(body.deliveredBytes, Buffer.byteLength(cut));
  assert.equal(body.parsed, null);
});

test('a payload shorter than its stated length counts as truncated without the flag', () => {
  const store = new TelemetryStore();
  const cut = '{"system":[{"type":"text","text":"this got cut off half way thro';
  store.ingest('logs', [requestBody({ model: 'claude-opus-5', body: cut, body_length: 110141 })]);
  const agent = store.getSessionAgents(SESSION).agents.find((entry) => entry.key === 'main');
  const body = store.getAgentBody(SESSION, 'main', agent.bodies[0].seq);
  assert.equal(body.truncated, true);
  assert.equal(body.parsed, null);
});

test('an untruncated payload that will not parse reports the error rather than a half object', () => {
  const store = new TelemetryStore();
  const bad = '{not valid json';
  store.ingest('logs', [
    requestBody({ model: 'claude-opus-5', body: bad, body_length: Buffer.byteLength(bad) }),
  ]);
  const agent = store.getSessionAgents(SESSION).agents.find((entry) => entry.key === 'main');
  const body = store.getAgentBody(SESSION, 'main', agent.bodies[0].seq);
  assert.equal(body.parsed, null);
  assert.equal(typeof body.parseError, 'string');
  assert.ok(body.parseError.length > 0);
});

test('a payload whose record has rolled out is reported as gone, with its size intact', () => {
  const store = new TelemetryStore({ maxLogs: 2 });
  const payload = JSON.stringify({ system: [], tools: [], messages: [] });
  store.ingest('logs', [
    requestBody({ model: 'claude-opus-5', body: payload, body_length: Buffer.byteLength(payload) }),
  ]);
  const agent = store.getSessionAgents(SESSION).agents.find((entry) => entry.key === 'main');
  const seq = agent.bodies[0].seq;
  store.ingest('logs', [
    log('claude_code.user_prompt', { prompt: 'one' }),
    log('claude_code.user_prompt', { prompt: 'two' }),
    log('claude_code.user_prompt', { prompt: 'three' }),
  ]);
  const body = store.getAgentBody(SESSION, 'main', seq);
  assert.equal(body.available, false);
  assert.equal(body.bodyLength, Buffer.byteLength(payload));
  assert.equal(body.truncated, false);
});

test('an unknown body seq and an unknown agent are answered with null', () => {
  const store = new TelemetryStore();
  store.ingest('logs', [log('claude_code.user_prompt', { prompt: 'hi' })]);
  assert.equal(store.getAgentBody(SESSION, 'main', 999), null);
  assert.equal(store.getAgentContent(SESSION, 'Nope'), null);
});

test('a subagent reports what subagent_completed said about it', () => {
  const store = new TelemetryStore();
  store.ingest('logs', [
    log('claude_code.subagent_completed', {
      agent_type: 'Explore',
      'agent.source': 'builtin',
      is_built_in: 'true',
      is_async: 'false',
      model: 'claude-opus-5',
      final_model: 'claude-opus-5',
      model_swapped: 'false',
      total_tokens: 12345,
      total_tool_uses: 3,
      duration_ms: 4200,
    }),
  ]);
  const { agents } = store.getSessionAgents(SESSION);
  const explore = agents.find((agent) => agent.key === 'Explore');
  assert.equal(explore.completions.length, 1);
  const completion = explore.completions[0];
  assert.equal(completion.agentType, 'Explore');
  assert.equal(completion.source, 'builtin');
  assert.equal(completion.isBuiltIn, true);
  assert.equal(completion.isAsync, false);
  assert.equal(completion.model, 'claude-opus-5');
  assert.equal(completion.finalModel, 'claude-opus-5');
  assert.equal(completion.modelSwapped, false);
  assert.equal(completion.totalTokens, 12345);
  assert.equal(completion.totalToolUses, 3);
  assert.equal(completion.durationMs, 4200);
  const main = agents.find((agent) => agent.key === 'main');
  assert.equal(main.completions.length, 0);
});

test('two runs of the same subagent are one agent with two completions', () => {
  const store = new TelemetryStore();
  store.ingest('logs', [
    log('claude_code.subagent_completed', { agent_type: 'Explore', total_tokens: 100 }),
    log('claude_code.subagent_completed', { agent_type: 'Explore', total_tokens: 200 }),
  ]);
  const { agents } = store.getSessionAgents(SESSION);
  const explore = agents.filter((agent) => agent.key === 'Explore');
  assert.equal(explore.length, 1);
  assert.equal(explore[0].completions.length, 2);
});

test('content is returned per agent in the order it entered that context', () => {
  const store = new TelemetryStore();
  store.ingest('logs', [
    log('claude_code.user_prompt', { prompt: 'find the bug' }, NOW),
    log('claude_code.assistant_response', { response: 'looking now', 'agent.name': 'Explore' }, NOW + 100),
  ]);
  store.ingest('traces', [
    span(
      'claude_code.tool',
      { tool_name: 'Grep', tool_use_id: 'tu-1', agent_id: 'x1', query_source: 'agent:builtin:Explore' },
      { spanId: 'tool-1', startMs: 200, endMs: 300 },
    ),
  ]);
  store.ingest('logs', [
    log(
      'claude_code.tool_result',
      {
        tool_name: 'Grep',
        tool_use_id: 'tu-1',
        success: 'true',
        tool_input: JSON.stringify({ pattern: 'TODO' }),
        tool_result_size_bytes: 40,
      },
      NOW + 300,
    ),
  ]);

  const exploreContent = store.getAgentContent(SESSION, 'Explore', { limit: 10 });
  assert.equal(exploreContent.items.length, 2);
  assert.equal(exploreContent.items[0].kind, 'response');
  assert.equal(exploreContent.items[1].kind, 'tool');
  assert.deepEqual(exploreContent.items[1].arguments, { pattern: 'TODO' });
  assert.equal(exploreContent.items[1].resultBytes, 40);

  const mainContent = store.getAgentContent(SESSION, 'main', { limit: 10 });
  assert.equal(mainContent.items.length, 1);
  assert.equal(mainContent.items[0].kind, 'prompt');
});

test('a tool call with no span is listed under the main session', () => {
  const store = new TelemetryStore();
  store.ingest('logs', [
    log('claude_code.tool_result', { tool_name: 'Bash', tool_use_id: 'tu-9', success: 'true' }),
  ]);
  const mainContent = store.getAgentContent(SESSION, 'main', { limit: 10 });
  assert.equal(mainContent.items.length, 1);
  assert.equal(mainContent.items[0].kind, 'tool');

  const { agents } = store.getSessionAgents(SESSION);
  const toolItemsElsewhere = agents
    .filter((agent) => agent.key !== 'main')
    .reduce((sum, agent) => {
      const content = store.getAgentContent(SESSION, agent.key, { limit: 10 });
      return sum + content.items.filter((item) => item.kind === 'tool').length;
    }, 0);
  assert.equal(toolItemsElsewhere, 0);
});

test('the capture report names the switch behind every content kind', () => {
  const store = new TelemetryStore();
  store.ingest('logs', [
    log('claude_code.user_prompt', {}),
    log('claude_code.tool_result', { tool_name: 'Bash', success: 'true' }),
  ]);
  const off = store.getSessionAgents(SESSION).capture;
  assert.equal(off.prompts.present, false);
  assert.equal(off.prompts.switch, 'OTEL_LOG_USER_PROMPTS');
  assert.equal(off.toolArguments.present, false);
  assert.equal(off.toolArguments.switch, 'OTEL_LOG_TOOL_DETAILS');
  assert.equal(off.requestBodies.present, false);
  assert.equal(off.requestBodies.switch, 'OTEL_LOG_RAW_API_BODIES');
  assert.equal(off.prompts.seen, 1);
  assert.equal(off.toolArguments.seen, 1);
  assert.equal(off.requestBodies.seen, 0);

  const store2 = new TelemetryStore();
  const payload = JSON.stringify({ system: [], tools: [], messages: [] });
  store2.ingest('logs', [
    log('claude_code.user_prompt', { prompt: 'hi' }),
    log('claude_code.tool_result', {
      tool_name: 'Bash',
      success: 'true',
      tool_input: JSON.stringify({ command: 'ls' }),
    }),
    log('claude_code.api_request', { model: 'claude-opus-5', input_tokens: 10 }),
    log('claude_code.api_request_body', {
      model: 'claude-opus-5',
      body: payload,
      body_length: Buffer.byteLength(payload),
    }),
  ]);
  const on = store2.getSessionAgents(SESSION).capture;
  assert.equal(on.prompts.present, true);
  assert.equal(on.toolArguments.present, true);
  assert.equal(on.requestBodies.present, true);
});

test('tool output content is detected on the span event, not on the event', () => {
  const store = new TelemetryStore();
  store.ingest('traces', [
    span('claude_code.tool', { tool_name: 'Bash', tool_use_id: 'tu-5' }, {
      spanId: 'tool-5',
      events: [{ name: 'tool.output', timeMs: NOW + 50, attrs: { output: 'file listing here' } }],
    }),
  ]);
  const capture = store.getSessionAgents(SESSION).capture;
  assert.equal(capture.toolContent.present, true);
  const mainContent = store.getAgentContent(SESSION, 'main', { limit: 10 });
  const tool = mainContent.items.find((item) => item.kind === 'tool');
  assert.deepEqual(tool.output, { output: 'file listing here' });
});

test("an agent's wall time covers its own records only", () => {
  const store = new TelemetryStore();
  store.ingest('logs', [
    log('claude_code.api_request', { model: 'claude-opus-5', input_tokens: 10 }, NOW),
    log('claude_code.api_request', { model: 'claude-opus-5', input_tokens: 10 }, NOW + 1000),
    log(
      'claude_code.api_request',
      { model: 'claude-opus-5', input_tokens: 10, 'agent.name': 'Explore', query_source: 'agent:builtin:Explore' },
      NOW + 200,
    ),
    log(
      'claude_code.api_request',
      { model: 'claude-opus-5', input_tokens: 10, 'agent.name': 'Explore', query_source: 'agent:builtin:Explore' },
      NOW + 400,
    ),
  ]);
  const explore = store.getSessionAgents(SESSION).agents.find((agent) => agent.key === 'Explore');
  assert.equal(explore.durationMs, 200);
});

test('a failed tool call counts against the agent that made it (span first)', () => {
  const store = new TelemetryStore();
  store.ingest('traces', [
    span(
      'claude_code.tool',
      { tool_name: 'Bash', tool_use_id: 'tu-1', agent_id: 'a1', query_source: 'agent:builtin:Explore' },
      { spanId: 'tool-1' },
    ),
    span(
      'claude_code.tool.execution',
      { success: 'false', agent_id: 'a1', query_source: 'agent:builtin:Explore' },
      { spanId: 'exec-1', parentSpanId: 'tool-1' },
    ),
  ]);
  store.ingest('logs', [
    log('claude_code.tool_result', { tool_name: 'Bash', tool_use_id: 'tu-1', success: 'false', error_type: 'ENOENT' }),
  ]);
  const { agents } = store.getSessionAgents(SESSION);
  const explore = agents.find((agent) => agent.key === 'Explore');
  const bash = explore.tools.find((tool) => tool.name === 'Bash');
  assert.equal(bash.calls, 1);
  assert.equal(bash.failures, 1);
  assert.equal(explore.counts.toolFailures, 1);
  const session = store.getSession(SESSION);
  assert.equal(session.tools.find((tool) => tool.name === 'Bash').failures, 1);
  const main = agents.find((agent) => agent.key === 'main');
  assert.equal(main.tools.length, 0);
});

test('the order the two signals arrive in does not matter', () => {
  const store = new TelemetryStore();
  store.ingest('logs', [
    log('claude_code.tool_result', { tool_name: 'Bash', tool_use_id: 'tu-1', success: 'false', error_type: 'ENOENT' }),
  ]);
  store.ingest('traces', [
    span(
      'claude_code.tool',
      { tool_name: 'Bash', tool_use_id: 'tu-1', agent_id: 'a1', query_source: 'agent:builtin:Explore' },
      { spanId: 'tool-1' },
    ),
    span(
      'claude_code.tool.execution',
      { success: 'false', agent_id: 'a1', query_source: 'agent:builtin:Explore' },
      { spanId: 'exec-1', parentSpanId: 'tool-1' },
    ),
  ]);
  const { agents } = store.getSessionAgents(SESSION);
  const explore = agents.find((agent) => agent.key === 'Explore');
  const bash = explore.tools.find((tool) => tool.name === 'Bash');
  assert.equal(bash.calls, 1);
  assert.equal(bash.failures, 1);
});

test('a successful tool call adds no failure, and its result tokens reach the agent', () => {
  const store = new TelemetryStore();
  store.ingest('traces', [
    span(
      'claude_code.tool',
      { tool_name: 'Bash', tool_use_id: 'tu-2', agent_id: 'a1', query_source: 'agent:builtin:Explore' },
      { spanId: 'tool-2' },
    ),
  ]);
  store.ingest('logs', [
    log('claude_code.tool_result', {
      tool_name: 'Bash',
      tool_use_id: 'tu-2',
      success: 'true',
      tool_result_size_bytes: 400,
    }),
  ]);
  const { agents } = store.getSessionAgents(SESSION);
  const explore = agents.find((agent) => agent.key === 'Explore');
  const bash = explore.tools.find((tool) => tool.name === 'Bash');
  assert.equal(bash.calls, 1);
  assert.equal(bash.failures, 0);
  assert.equal(bash.resultTokens, 100);
  assert.equal(bash.resultTokensEstimated, 100);
  const sessionBash = store.getSession(SESSION).tools.find((tool) => tool.name === 'Bash');
  assert.equal(sessionBash.resultTokens, 100);
  assert.equal(sessionBash.resultTokensEstimated, 100);
});

test('a real result_tokens attribute is not re-estimated on the agent either', () => {
  const store = new TelemetryStore();
  store.ingest('traces', [
    span(
      'claude_code.tool',
      { tool_name: 'Bash', tool_use_id: 'tu-3', result_tokens: 42, agent_id: 'a1', query_source: 'agent:builtin:Explore' },
      { spanId: 'tool-3' },
    ),
  ]);
  store.ingest('logs', [
    log('claude_code.tool_result', {
      tool_name: 'Bash',
      tool_use_id: 'tu-3',
      success: 'false',
      tool_result_size_bytes: 999_999,
    }),
  ]);
  const { agents } = store.getSessionAgents(SESSION);
  const explore = agents.find((agent) => agent.key === 'Explore');
  const bash = explore.tools.find((tool) => tool.name === 'Bash');
  assert.equal(bash.resultTokens, 42);
  assert.equal(bash.resultTokensEstimated, 0);
  assert.equal(bash.failures, 1);
});

test('a failed tool call with no span reaches no agent', () => {
  const store = new TelemetryStore();
  store.ingest('logs', [
    log('claude_code.tool_result', { tool_name: 'Bash', tool_use_id: 'tu-9', success: 'false' }),
  ]);
  const session = store.getSession(SESSION);
  assert.equal(session.tools.find((tool) => tool.name === 'Bash').failures, 1);
  const { agents } = store.getSessionAgents(SESSION);
  for (const agent of agents) {
    assert.equal(agent.tools.length, 0);
  }
});

test('a failure joins the named bucket after the id-only bucket was folded into it', () => {
  const store = new TelemetryStore();
  store.ingest('traces', [
    span('claude_code.tool', { tool_name: 'Bash', tool_use_id: 'tu-7', agent_id: 'a7' }, { spanId: 'tool-7' }),
  ]);
  store.ingest('logs', [
    log('claude_code.api_request', {
      model: 'claude-opus-5',
      input_tokens: 10,
      'agent.name': 'Explore',
      query_source: 'agent:builtin:Explore',
      agent_id: 'a7',
    }),
  ]);
  store.ingest('logs', [
    log('claude_code.tool_result', { tool_name: 'Bash', tool_use_id: 'tu-7', success: 'false' }),
  ]);
  const { agents } = store.getSessionAgents(SESSION);
  assert.equal(agents.some((agent) => agent.key.startsWith('id:')), false);
  const explore = agents.find((agent) => agent.key === 'Explore');
  const bash = explore.tools.find((tool) => tool.name === 'Bash');
  assert.equal(bash.calls, 1);
  assert.equal(bash.failures, 1);
});
