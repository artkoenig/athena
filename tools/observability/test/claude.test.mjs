import test from 'node:test';
import assert from 'node:assert/strict';

import { otelEnvFor, sessionNameHook, sessionNameOf } from '../src/claude.mjs';

test('a session name is read from the resource, and from metric attributes', () => {
  assert.equal(sessionNameOf({ resource: { 'session.name': 'athena-refactor' } }), 'athena-refactor');
  // Custom resource attributes ride along on metric attributes too, and metrics
  // are the one signal that may arrive without a resource block worth the name.
  assert.equal(sessionNameOf({ attrs: { 'session.name': 'athena-refactor' } }), 'athena-refactor');
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
  // Naming is the hook's job — it works out the name per session, so there is
  // nothing to bake into an env block that gets pasted into many of them.
  const env = otelEnvFor('http://localhost:4318');
  assert.ok(!('OTEL_RESOURCE_ATTRIBUTES' in env));
});

test('the settings hook points at the shipped script and needs no arguments', async () => {
  const { SessionStart } = sessionNameHook();
  const command = SessionStart[0].hooks[0].command;
  assert.equal(SessionStart[0].hooks[0].type, 'command');
  assert.match(command, /^node "\/.*hooks\/session-name\.mjs"$/);
  // The path is real, not assembled from a guess about the install layout.
  const file = command.match(/"(.+)"/)[1];
  const { access } = await import('node:fs/promises');
  await access(file);
});
