import test from 'node:test';
import assert from 'node:assert/strict';

import { otelEnvFor, sessionNameOf, contentOf } from '../src/claude.mjs';

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

/* ------------------------- the content flags ------------------------- */

test('the env block turns the content flags on by default', () => {
  // Off by default meant every session was content-blind: no prompt text, no
  // tool arguments, no request/response bodies. Turning them on is what lets a
  // caller later ask the collector for the content at a point in time.
  const env = otelEnvFor('http://localhost:4318');
  assert.equal(env.OTEL_LOG_USER_PROMPTS, '1');
  assert.equal(env.OTEL_LOG_TOOL_DETAILS, '1');
  assert.equal(env.OTEL_LOG_TOOL_CONTENT, '1');
  assert.equal(env.OTEL_LOG_RAW_API_BODIES, '1');
  // Inline ('1') is what makes the body reach the collector at all; 'file:<dir>'
  // would leave the body on the agent's own disk, out of the collector's reach.
  assert.ok(
    !String(env.OTEL_LOG_RAW_API_BODIES).startsWith('file:'),
    'OTEL_LOG_RAW_API_BODIES must be inline, not a file: value',
  );
});

test('the content flags do not ride on the traces opt-in', () => {
  // The four content flags are unconditional: someone who turns traces off
  // (losing span-based agent attribution) still gets content.
  const env = otelEnvFor('http://localhost:4318', { traces: false });
  assert.equal(env.OTEL_LOG_USER_PROMPTS, '1');
  assert.equal(env.OTEL_LOG_TOOL_DETAILS, '1');
  assert.equal(env.OTEL_LOG_TOOL_CONTENT, '1');
  assert.equal(env.OTEL_LOG_RAW_API_BODIES, '1');
  assert.ok(!('OTEL_TRACES_EXPORTER' in env), 'traces: false is the existing behaviour this case must not disturb');
});

/* --------------------------- contentOf(log) ---------------------------- */

test('an inline request body is classified with its untruncated length', () => {
  // body_length is the length before truncation, which is what a caller needs
  // to know "how much was cut off", so it must survive as a number even though
  // the CLI always sends it as a string attribute.
  const result = contentOf({
    eventName: 'claude_code.api_request_body',
    attrs: {
      body: '{"messages":[]}',
      body_length: '61440',
      body_truncated: 'true',
      model: 'claude-opus-5',
      query_source: 'agent:builtin:researcher',
    },
  });
  assert.equal(result.kind, 'request_body');
  assert.equal(result.text, '{"messages":[]}');
  assert.equal(result.length, 61440);
  assert.equal(result.truncated, true);
  assert.equal(result.ref, null);
});

test('a body the CLI wrote to a file is classified by its reference, with no text', () => {
  // In file mode the CLI never puts the body on the wire, only a path on its own
  // disk; a caller must be able to tell "no text arrived" from "empty body".
  const result = contentOf({
    eventName: 'claude_code.api_request_body',
    attrs: {
      body_ref: '/tmp/bodies/abc.request.json',
      body_length: '120000',
    },
  });
  assert.equal(result.kind, 'request_body');
  assert.equal(result.text, null);
  assert.equal(result.ref, '/tmp/bodies/abc.request.json');
  assert.equal(result.length, 120000);
  assert.equal(result.truncated, false);
});

test('a response body is its own kind', () => {
  // Requests and responses are distinguishable at a glance, not folded into one
  // generic "body" kind.
  const result = contentOf({
    eventName: 'claude_code.api_response_body',
    attrs: { body: '{"id":"msg_1"}', body_length: '13', request_id: 'req_1' },
  });
  assert.equal(result.kind, 'response_body');
  assert.equal(result.text, '{"id":"msg_1"}');
});

test('prompt, assistant response and tool input are content too', () => {
  // Bodies are not the only content: these three event kinds carry text on
  // their own, gated by OTEL_LOG_USER_PROMPTS/OTEL_LOG_TOOL_DETAILS.
  const prompt = contentOf({
    eventName: 'claude_code.user_prompt',
    attrs: { prompt: 'hello', prompt_length: '5' },
  });
  assert.equal(prompt.kind, 'user_prompt');
  assert.equal(prompt.text, 'hello');
  assert.equal(prompt.length, 5);

  const response = contentOf({
    eventName: 'claude_code.assistant_response',
    attrs: { response: 'hi', response_length: '2' },
  });
  assert.equal(response.kind, 'assistant_response');
  assert.equal(response.text, 'hi');
  assert.equal(response.length, 2);

  const toolInput = contentOf({
    eventName: 'claude_code.tool_result',
    attrs: { tool_name: 'Read', tool_input: '{"file":"a"}', tool_input_size_bytes: '12' },
  });
  assert.equal(toolInput.kind, 'tool_input');
  assert.equal(toolInput.text, '{"file":"a"}');
  assert.equal(toolInput.length, 12);
});

test('the older attribute name for tool input is still read', () => {
  // Mirrors the fallback toolParametersOf already documents for CLI versions
  // before 2.1.x renamed tool_parameters to tool_input.
  const result = contentOf({
    eventName: 'claude_code.tool_result',
    attrs: { tool_name: 'Read', tool_parameters: '{"file":"a"}' },
  });
  assert.equal(result.kind, 'tool_input');
  assert.equal(result.text, '{"file":"a"}');
});

test('an event that carries no content at all is not content', () => {
  // api_request carries no content under any configuration, so this says "this
  // kind of event is not content", never "the flags were off" — nothing here
  // may pin flagless behaviour.
  const result = contentOf({
    eventName: 'claude_code.api_request',
    attrs: { model: 'claude-opus-5', input_tokens: 10 },
  });
  assert.equal(result, null);
});
