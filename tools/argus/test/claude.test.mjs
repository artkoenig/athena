import test from 'node:test';
import assert from 'node:assert/strict';

import { otelEnvFor, sessionNameOf, describeEvent } from '../src/claude.mjs';

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

test('the env block includes the content flags by default: user prompts, tool details, tool content and raw api bodies', () => {
  const env = otelEnvFor('http://localhost:4318');
  assert.equal(env.OTEL_LOG_USER_PROMPTS, '1');
  assert.equal(env.OTEL_LOG_TOOL_DETAILS, '1');
  assert.equal(env.OTEL_LOG_TOOL_CONTENT, '1');
  assert.equal(env.OTEL_LOG_RAW_API_BODIES, '1');
  // The CLI's own default already truncates a first real request at 61,440 chars;
  // the raised ceiling has to clear that bar or "exact full text" is a broken promise.
  assert.ok(Number(env.CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH) > 61440);
});

test('the content flags are not gated behind traces: content is not a tracing feature', () => {
  const env = otelEnvFor('http://localhost:4318', { traces: false });
  assert.equal(env.OTEL_LOG_USER_PROMPTS, '1');
  assert.equal(env.OTEL_LOG_TOOL_DETAILS, '1');
  assert.equal(env.OTEL_LOG_TOOL_CONTENT, '1');
  assert.equal(env.OTEL_LOG_RAW_API_BODIES, '1');
  assert.ok(Number(env.CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH) > 61440);
});

test('describeEvent on an api_request_body record never lets the body text leak into the summary', () => {
  const secret = 'BEGIN-SECRET-DO-NOT-LEAK-42';
  const body = `{"messages":[{"role":"user","content":"${secret}"}]}`;
  const summary = describeEvent({
    eventName: 'claude_code.api_request_body',
    attrs: {
      model: 'claude-sonnet-5',
      query_source: 'sdk',
      body,
      body_length: String(body.length),
      body_truncated: 'false',
    },
  });
  assert.ok(!summary.includes(secret), 'the summary must never include the body text');
  assert.match(summary, new RegExp(String(body.length)), 'the summary has to name the size instead of the text');
});
