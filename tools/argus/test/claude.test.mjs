import test from 'node:test';
import assert from 'node:assert/strict';

import { otelEnvFor, sessionNameOf } from '../src/claude.mjs';

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
  // A name belongs to one session; this block gets pasted into many, so it
  // carries no OTEL_RESOURCE_ATTRIBUTES for anyone to forget to change.
  const env = otelEnvFor('http://localhost:4318');
  assert.ok(!('OTEL_RESOURCE_ATTRIBUTES' in env));
});

test('the env block carries the collector address under its own stable name', () => {
  // The OTEL_* variables say where an agent sends telemetry; ATHENA_OBS_* say
  // where the collector is, which is what this tool's own commands read.
  const open = otelEnvFor('http://localhost:4318');
  assert.equal(open.ATHENA_OBS_URL, 'http://localhost:4318');
  assert.ok(!('ATHENA_OBS_TOKEN' in open), 'no token, nothing to pass on');

  const gated = otelEnvFor('https://collector.example', { token: 'secret' });
  assert.equal(gated.ATHENA_OBS_URL, 'https://collector.example');
  assert.equal(gated.ATHENA_OBS_TOKEN, 'secret');
  assert.equal(gated.OTEL_EXPORTER_OTLP_HEADERS, 'Authorization=Bearer secret');
});
