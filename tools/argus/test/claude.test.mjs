import test from 'node:test';
import assert from 'node:assert/strict';

import { otelEnvFor, sessionNameOf, agentRefOf, EVENT } from '../src/claude.mjs';

test('a session name is read from the resource, and from metric attributes', () => {
  assert.equal(sessionNameOf({ resource: { 'session.name': 'uroboros-refactor' } }), 'uroboros-refactor');
  // Custom resource attributes ride along on metric attributes too, and metrics
  // are the one signal that may arrive without a resource block worth the name.
  assert.equal(sessionNameOf({ attrs: { 'session.name': 'uroboros-refactor' } }), 'uroboros-refactor');
  assert.equal(sessionNameOf({ resource: { 'session_name': 'snake-case' } }), 'snake-case');
});

test('a session without a name resolves to null rather than a placeholder', () => {
  assert.equal(sessionNameOf({ resource: { 'service.name': 'claude-code' } }), null);
  assert.equal(sessionNameOf({ resource: { 'session.name': '   ' } }), null);
  assert.equal(sessionNameOf({}), null);
  assert.equal(sessionNameOf(undefined), null);
});

test('percent-encoded names are decoded, malformed ones survive as-is', () => {
  assert.equal(sessionNameOf({ resource: { 'session.name': 'nightly%20run' } }), 'nightly run');
  assert.equal(sessionNameOf({ resource: { 'session.name': '100%' } }), '100%');
});

test('long names are capped', () => {
  const name = sessionNameOf({ resource: { 'session.name': 'x'.repeat(500) } });
  assert.equal(name.length, 120);
});

test('the env block stays free of naming configuration', () => {
  // A name belongs to one session; this block gets pasted into many, so it
  // carries no OTEL_RESOURCE_ATTRIBUTES for anyone to forget to change.
  const env = otelEnvFor('http://localhost:4318');
  assert.ok(!('OTEL_RESOURCE_ATTRIBUTES' in env));
});

test('the env block carries the collector address under its own stable name', () => {
  // The OTEL_* variables say where an agent sends telemetry; UROBOROS_OBS_* say
  // where the collector is, which is what this tool's own commands read.
  const open = otelEnvFor('http://localhost:4318');
  assert.equal(open.UROBOROS_OBS_URL, 'http://localhost:4318');
  assert.ok(!('UROBOROS_OBS_TOKEN' in open), 'no token, nothing to pass on');

  const gated = otelEnvFor('https://collector.example', { token: 'secret' });
  assert.equal(gated.UROBOROS_OBS_URL, 'https://collector.example');
  assert.equal(gated.UROBOROS_OBS_TOKEN, 'secret');
  assert.equal(gated.OTEL_EXPORTER_OTLP_HEADERS, 'Authorization=Bearer secret');
});

test('a record with no attribution attributes belongs to the main session', () => {
  for (const attrs of [{}, { query_source: 'sdk' }, { query_source: 'main' }]) {
    const ref = agentRefOf(attrs);
    assert.equal(ref.key, 'main');
    assert.equal(ref.kind, 'main');
    assert.equal(ref.name, null);
  }
});

test('agent.name names the subagent a record belongs to', () => {
  const ref = agentRefOf({ 'agent.name': 'Explore', query_source: 'agent:builtin:Explore' });
  assert.equal(ref.key, 'Explore');
  assert.equal(ref.name, 'Explore');
  assert.equal(ref.kind, 'subagent');
});

test('query_source alone names a subagent', () => {
  const builtin = agentRefOf({ query_source: 'agent:builtin:Explore' });
  assert.equal(builtin.key, 'Explore');
  assert.equal(builtin.name, 'Explore');

  const plugin = agentRefOf({ query_source: 'agent:plugin:acme:Digger' });
  assert.equal(plugin.key, 'Digger');
  assert.equal(plugin.name, 'Digger');
});

test('a bare subagent source becomes one unnamed bucket', () => {
  const ref = agentRefOf({ query_source: 'subagent' });
  assert.equal(ref.key, 'subagent');
  assert.equal(ref.name, null);
  assert.equal(ref.kind, 'subagent');
});

test('auxiliary and compact are their own kind, not the main session', () => {
  const auxiliary = agentRefOf({ query_source: 'auxiliary' });
  assert.equal(auxiliary.key, 'auxiliary');
  assert.equal(auxiliary.kind, 'system');

  const compact = agentRefOf({ query_source: 'compact' });
  assert.equal(compact.key, 'compact');
  assert.equal(compact.kind, 'system');
});

test('an agent_id with no name keys the agent by its id and keeps the id', () => {
  const bare = agentRefOf({ agent_id: 'a10f6aaeff1f24fa1' });
  assert.equal(bare.key, 'id:a10f6aaeff1f24fa1');
  assert.equal(bare.name, null);
  assert.equal(bare.agentId, 'a10f6aaeff1f24fa1');

  const named = agentRefOf({ 'agent.name': 'Explore', agent_id: 'a10f6aaeff1f24fa1' });
  assert.equal(named.key, 'Explore');
  assert.equal(named.agentId, 'a10f6aaeff1f24fa1');
});

test('empty attribute values do not name an agent', () => {
  const ref = agentRefOf({ 'agent.name': '', query_source: '' });
  assert.equal(ref.key, 'main');
  assert.equal(ref.kind, 'main');
});

test('the subagent completion event is known by name', () => {
  assert.equal(EVENT.subagentCompleted, 'claude_code.subagent_completed');
});
