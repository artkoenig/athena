import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { TelemetryStore } from '../src/store.mjs';
import { createServer } from '../src/server.mjs';
import { encodeMessage } from '../src/otlp/protobuf.mjs';
import { EXPORT_TRACE_REQUEST, EXPORT_LOGS_REQUEST } from '../src/otlp/schema.mjs';

const T0 = BigInt(Date.now()) * 1000000n;

function tracePayload(sessionId) {
  return encodeMessage(
    {
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: 'agent' } },
              { key: 'session.id', value: { stringValue: sessionId } },
            ],
          },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: '11'.repeat(16),
                  spanId: '22'.repeat(8),
                  name: 'claude_code.interaction',
                  startTimeUnixNano: T0,
                  endTimeUnixNano: T0 + 1500n * 1000000n,
                  attributes: [{ key: 'session.id', value: { stringValue: sessionId } }],
                },
              ],
            },
          ],
        },
      ],
    },
    EXPORT_TRACE_REQUEST,
  );
}

function logsPayloadJson(sessionId) {
  return JSON.stringify({
    resourceLogs: [
      {
        resource: { attributes: [{ key: 'session.id', value: { stringValue: sessionId } }] },
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: String(T0),
                severityNumber: 9,
                eventName: 'claude_code.api_request',
                attributes: [
                  { key: 'session.id', value: { stringValue: sessionId } },
                  { key: 'model', value: { stringValue: 'claude-opus-5' } },
                  { key: 'input_tokens', value: { intValue: '750' } },
                  { key: 'cost_usd', value: { doubleValue: 0.02 } },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
}

function logsPayloadBody(sessionId, { eventName, timeMs, attrs = {}, spanId = '' }) {
  return JSON.stringify({
    resourceLogs: [
      {
        resource: { attributes: [{ key: 'session.id', value: { stringValue: sessionId } }] },
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: String(BigInt(timeMs) * 1000000n),
                severityNumber: 9,
                eventName,
                spanId,
                attributes: [
                  { key: 'session.id', value: { stringValue: sessionId } },
                  ...Object.entries(attrs).map(([key, value]) => ({ key, value: { stringValue: String(value) } })),
                ],
              },
            ],
          },
        ],
      },
    ],
  });
}

function agentDispatchTracePayload(sessionId, { toolSpanId, execSpanId }) {
  return encodeMessage(
    {
      resourceSpans: [
        {
          resource: { attributes: [{ key: 'session.id', value: { stringValue: sessionId } }] },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: '33'.repeat(16),
                  spanId: toolSpanId,
                  name: 'claude_code.tool',
                  startTimeUnixNano: T0,
                  endTimeUnixNano: T0 + 100n * 1000000n,
                  attributes: [
                    { key: 'session.id', value: { stringValue: sessionId } },
                    { key: 'tool_name', value: { stringValue: 'Agent' } },
                    { key: 'subagent_type', value: { stringValue: 'general-purpose' } },
                  ],
                },
                {
                  traceId: '33'.repeat(16),
                  spanId: execSpanId,
                  parentSpanId: toolSpanId,
                  name: 'claude_code.tool.execution',
                  startTimeUnixNano: T0,
                  endTimeUnixNano: T0 + 100n * 1000000n,
                  attributes: [{ key: 'session.id', value: { stringValue: sessionId } }],
                },
              ],
            },
          ],
        },
      ],
    },
    EXPORT_TRACE_REQUEST,
  );
}

async function withServer(options, run) {
  const store = new TelemetryStore();
  const server = createServer({ store, endpoint: 'http://test', log: () => {}, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({ base, store });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('accepts OTLP protobuf on /v1/traces', async () => {
  await withServer({}, async ({ base, store }) => {
    const response = await fetch(`${base}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-protobuf' },
      body: tracePayload('s-proto'),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/x-protobuf');
    assert.equal(store.getSession('s-proto').counts.interactions, 1);
  });
});

test('accepts OTLP/JSON on /v1/logs and answers in JSON', async () => {
  await withServer({}, async ({ base, store }) => {
    const response = await fetch(`${base}/v1/logs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: logsPayloadJson('s-json'),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { partialSuccess: {} });
    const session = store.getSession('s-json');
    assert.equal(session.tokens.input, 750);
    assert.equal(session.costUsd, 0.02);
  });
});

test('a TaskCreate tool_result with the real CLI event.name shape reaches the Tasks tab', async () => {
  // Regression test: Claude Code 2.1.x sends the `event.name` log attribute
  // unprefixed ('tool_result'), not as 'claude_code.tool_result'. Every
  // downstream switch keys off the prefixed EVENT.* constants, so without
  // canonicalizing this in decode.mjs, tool_result events silently vanish —
  // counted nowhere, todos state never reconstructed — despite arriving fine
  // and showing up in the raw /api/events feed.
  const sessionId = 's-real-taskcreate';
  const payload = JSON.stringify({
    resourceLogs: [
      {
        resource: { attributes: [{ key: 'session.id', value: { stringValue: sessionId } }] },
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: String(T0),
                severityNumber: 9,
                body: { stringValue: 'claude_code.tool_result' },
                attributes: [
                  { key: 'session.id', value: { stringValue: sessionId } },
                  { key: 'event.name', value: { stringValue: 'tool_result' } },
                  { key: 'tool_name', value: { stringValue: 'TaskCreate' } },
                  { key: 'success', value: { stringValue: 'true' } },
                  {
                    key: 'tool_input',
                    value: {
                      stringValue: JSON.stringify({ subject: 'Fix flaky test', description: 'CI flakes' }),
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });

  await withServer({}, async ({ base }) => {
    const response = await fetch(`${base}/v1/logs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });
    assert.equal(response.status, 200);

    const detail = await (await fetch(`${base}/api/sessions/${sessionId}`)).json();
    assert.equal(detail.todos.callsSeen, 1);
    assert.equal(detail.todos.unlinkedCreates.length, 1);
    assert.equal(detail.todos.unlinkedCreates[0].subject, 'Fix flaky test');
  });
});

test('accepts gzip-encoded bodies', async () => {
  await withServer({}, async ({ base, store }) => {
    const response = await fetch(`${base}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-protobuf', 'content-encoding': 'gzip' },
      body: zlib.gzipSync(tracePayload('s-gzip')),
    });
    assert.equal(response.status, 200);
    assert.ok(store.getSession('s-gzip'));
  });
});

test('malformed payloads are rejected without killing the server', async () => {
  await withServer({}, async ({ base }) => {
    const bad = await fetch(`${base}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.equal(bad.status, 400);
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
  });
});

test('GET on an ingest path is a 405', async () => {
  await withServer({}, async ({ base }) => {
    assert.equal((await fetch(`${base}/v1/metrics`)).status, 405);
  });
});

test('read API exposes sessions, traces and events', async () => {
  await withServer({}, async ({ base }) => {
    // Assert the ingest itself, so a failed POST reports as a failed POST rather
    // than as a confusing empty-store assertion further down.
    const ingestedTrace = await fetch(`${base}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-protobuf' },
      body: tracePayload('s-api'),
    });
    assert.equal(ingestedTrace.status, 200);
    const ingestedLogs = await fetch(`${base}/v1/logs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: logsPayloadJson('s-api'),
    });
    assert.equal(ingestedLogs.status, 200);

    const sessions = await (await fetch(`${base}/api/sessions`)).json();
    assert.equal(sessions.total, 1);
    assert.equal(sessions.items[0].id, 's-api');

    const session = await (await fetch(`${base}/api/sessions/s-api`)).json();
    assert.equal(session.traces.length, 1);

    const trace = await (await fetch(`${base}/api/traces/${'11'.repeat(16)}`)).json();
    assert.equal(trace.spanCount, 1);
    assert.equal(trace.durationMs, 1500);

    const events = await (await fetch(`${base}/api/events?session=s-api`)).json();
    assert.equal(events.items.length, 1);
    assert.match(events.items[0].summary, /claude-opus-5/);
    assert.equal(events.items[0].attribution.model, 'claude-opus-5');

    const stats = await (await fetch(`${base}/api/stats`)).json();
    assert.equal(stats.totals.sessions, 1);

    const facets = await (await fetch(`${base}/api/facets`)).json();
    assert.equal(facets.events[0].name, 'claude_code.api_request');

    assert.equal((await fetch(`${base}/api/sessions/nope`)).status, 404);
    assert.equal((await fetch(`${base}/api/nope`)).status, 404);
  });
});

test('/api/config returns a ready-to-paste agent environment', async () => {
  await withServer({ endpoint: 'http://collector:4318' }, async ({ base }) => {
    const config = await (await fetch(`${base}/api/config`)).json();
    assert.equal(config.env.OTEL_EXPORTER_OTLP_ENDPOINT, 'http://collector:4318');
    assert.equal(config.env.CLAUDE_CODE_ENABLE_TELEMETRY, '1');
    assert.equal(config.env.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA, '1');
    assert.equal(config.env.OTEL_METRIC_EXPORT_INTERVAL, '1000');
    assert.equal(config.requiresToken, false);
  });
});

test('/api/config names the run directory, so a second start can find it', async () => {
  // This is how `start --background` reports what an already-running collector
  // is writing to instead of starting a second one.
  const dir = path.join(os.tmpdir(), 'argus-run-dir-fixture');
  await withServer({ persist: dir }, async ({ base }) => {
    const config = await (await fetch(`${base}/api/config`)).json();
    assert.equal(config.persist, dir);
  });

  await withServer({}, async ({ base }) => {
    const config = await (await fetch(`${base}/api/config`)).json();
    assert.equal(config.persist, null, 'no persistence is reported as null, not left out');
  });
});

test('with a token set, everything but GET /api/health is gated', async () => {
  await withServer({ token: 'secret' }, async ({ base }) => {
    // There is no app shell here any more, so the reason the page and its
    // sub-resources used to be exempt is gone with it: what is left is data and
    // ingest, and all of it is behind the token.
    for (const gated of ['/', '/index.html', '/app.js', '/styles.css', '/api/sessions', '/api/stream', '/api/config']) {
      assert.equal((await fetch(`${base}${gated}`)).status, 401, `${gated} must be gated`);
    }
    // Container healthchecks and uptime probes have no token to offer.
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
  });
});

test('the collector keeps no browser session: it issues no cookie and accepts none', async () => {
  await withServer({ token: 'secret' }, async ({ base }) => {
    // The cookie existed to keep a secret out of a browser's address bar. The
    // browser is a separate process now and never talks to this port, so the
    // whole trade goes — leaving Bearer for agents and ?token= for `check`.
    const visit = await fetch(`${base}/?token=secret`, { redirect: 'manual' });
    assert.equal(visit.headers.get('set-cookie'), null, 'the collector must not start a browser session');
    assert.equal(visit.status, 404, 'an authorized request for a page is still a request for nothing');

    assert.equal(
      (await fetch(`${base}/api/stats`, { headers: { cookie: 'uroboros_obs_token=secret' } })).status,
      401,
      'a cookie is not a credential here',
    );
  });
});

test('a token gates ingest and the API, via header or query parameter', async () => {
  await withServer({ token: 'secret' }, async ({ base }) => {
    assert.equal((await fetch(`${base}/api/stats`)).status, 401);
    assert.equal(
      (
        await fetch(`${base}/v1/traces`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-protobuf' },
          body: tracePayload('s-auth'),
        })
      ).status,
      401,
    );
    assert.equal(
      (await fetch(`${base}/api/stats`, { headers: { authorization: 'Bearer secret' } })).status,
      200,
    );
    assert.equal((await fetch(`${base}/api/stats?token=secret`)).status, 200);
    const config = await (await fetch(`${base}/api/config?token=secret`)).json();
    assert.equal(config.env.OTEL_EXPORTER_OTLP_HEADERS, 'Authorization=Bearer secret');
  });
});

test('health answers without a token but only counts records for authorized callers', async () => {
  await withServer({ token: 'secret' }, async ({ base }) => {
    // Container healthchecks and uptime probes have no token to offer.
    const open = await fetch(`${base}/api/health`);
    assert.equal(open.status, 200);
    const body = await open.json();
    assert.equal(body.ok, true);
    assert.ok(typeof body.uptimeMs === 'number');
    assert.equal(body.seq, undefined, 'ingest volume must not leak to anonymous probes');

    const authed = await (await fetch(`${base}/api/health?token=secret`)).json();
    assert.equal(authed.seq, 0);
  });
});

test('health identifies the process, so several instances behind one URL are visible', async () => {
  await withServer({}, async ({ base }) => {
    // Without a token either — a caller has to be able to tell how many
    // collectors a URL stands for before it has any credentials for them.
    const first = await (await fetch(`${base}/api/health`)).json();
    const second = await (await fetch(`${base}/api/health`)).json();
    assert.ok(first.instance, 'health must identify the process');
    assert.equal(first.instance, second.instance, 'one process must not look like two');
  });
});

test('the collector serves no interface: every path outside the API is a JSON 404 naming argus-ui', async () => {
  await withServer({}, async ({ base }) => {
    for (const pathname of ['/', '/index.html', '/app.js', '/styles.css', '/whatever']) {
      const response = await fetch(`${base}${pathname}`);
      assert.equal(response.status, 404, `${pathname} must not be served`);
      assert.match(response.headers.get('content-type'), /application\/json/, `${pathname} answers JSON`);
      const body = await response.json();
      assert.match(
        JSON.stringify(body),
        /argus-ui/,
        `${pathname} has to say where the interface actually lives`,
      );
    }
  });
});

test('DELETE /api/data resets the store', async () => {
  await withServer({}, async ({ base, store }) => {
    await fetch(`${base}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-protobuf' },
      body: tracePayload('s-reset'),
    });
    assert.equal(store.sessions.size, 1);
    assert.equal((await fetch(`${base}/api/data`, { method: 'DELETE' })).status, 200);
    assert.equal(store.sessions.size, 0);
  });
});

test('the SSE stream announces ingest', async () => {
  await withServer({}, async ({ base }) => {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/stream`, { signal: controller.signal });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    const first = decoder.decode((await reader.read()).value);
    assert.match(first, /event: hello/);

    await fetch(`${base}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-protobuf' },
      body: tracePayload('s-sse'),
    });

    let frame = '';
    while (!frame.includes('event: ingest')) {
      frame += decoder.decode((await reader.read()).value);
    }
    assert.match(frame, /"sessionIds":\["s-sse"\]/);
    controller.abort();
  });
});

test('GET /api/sessions/:id/content answers the content records, with agent and timeMs, never a body', async () => {
  await withServer({}, async ({ base }) => {
    const sessionId = 's-content';
    const ingested = await fetch(`${base}/v1/logs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: logsPayloadBody(sessionId, {
        eventName: 'claude_code.api_request_body',
        timeMs: Number(T0 / 1000000n),
        attrs: {
          model: 'claude-opus-5',
          body: '{"messages":[]}',
          body_length: '15',
          body_truncated: 'false',
          query_source: 'sdk',
        },
      }),
    });
    assert.equal(ingested.status, 200);

    const content = await (await fetch(`${base}/api/sessions/${sessionId}/content`)).json();
    assert.equal(content.items.length, 1);
    assert.equal(content.items[0].agent, 'main');
    assert.equal(typeof content.items[0].timeMs, 'number');
    assert.ok(!('body' in content.items[0]), 'the content list must never carry the full text');
  });
});

test('GET /api/sessions/:id/context answers the nearest body, null before every body, 404 for an unknown session', async () => {
  await withServer({}, async ({ base }) => {
    const sessionId = 's-context';
    const t0 = Number(T0 / 1000000n);
    const bodyText = '{"messages":[{"role":"user","content":"hi"}]}';
    const ingested = await fetch(`${base}/v1/logs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: logsPayloadBody(sessionId, {
        eventName: 'claude_code.api_request_body',
        timeMs: t0,
        attrs: {
          model: 'claude-opus-5',
          body: bodyText,
          body_length: String(bodyText.length),
          body_truncated: 'false',
          query_source: 'sdk',
        },
      }),
    });
    assert.equal(ingested.status, 200);

    const at = await (await fetch(`${base}/api/sessions/${sessionId}/context?at=${t0 + 1000}`)).json();
    assert.equal(at.context.body, bodyText);

    const before = await (await fetch(`${base}/api/sessions/${sessionId}/context?at=${t0 - 1000}`)).json();
    assert.equal(before.context, null);

    assert.equal((await fetch(`${base}/api/sessions/nope/context?at=${t0}`)).status, 404);
  });
});

test('GET /api/events no longer ships body text: length and a resolved agent survive, the text does not', async () => {
  await withServer({}, async ({ base }) => {
    const sessionId = 's-events-body';
    const bodyText = 'x'.repeat(500);
    const ingested = await fetch(`${base}/v1/logs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: logsPayloadBody(sessionId, {
        eventName: 'claude_code.api_request_body',
        timeMs: Number(T0 / 1000000n),
        attrs: {
          model: 'claude-opus-5',
          body: bodyText,
          body_length: String(bodyText.length),
          body_truncated: 'false',
          query_source: 'sdk',
        },
      }),
    });
    assert.equal(ingested.status, 200);

    const events = await (await fetch(`${base}/api/events?session=${sessionId}`)).json();
    assert.equal(events.items.length, 1);
    const item = events.items[0];
    assert.ok(!JSON.stringify(item).includes(bodyText), 'body text must not ride along on the event feed');
    assert.equal(item.bodyLength, bodyText.length);
    assert.equal(item.agent, 'main');
  });
});

test('GET /api/events?agent filters by lane, and GET /api/sessions/:id lists the lanes', async () => {
  await withServer({}, async ({ base }) => {
    const sessionId = 's-lanes';
    const t0 = Number(T0 / 1000000n);
    const toolSpanId = '44'.repeat(8);
    const execSpanId = '55'.repeat(8);

    const trace = await fetch(`${base}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-protobuf' },
      body: agentDispatchTracePayload(sessionId, { toolSpanId, execSpanId }),
    });
    assert.equal(trace.status, 200);

    const mainBody = await fetch(`${base}/v1/logs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: logsPayloadBody(sessionId, {
        eventName: 'claude_code.api_request_body',
        timeMs: t0,
        attrs: { model: 'm', body: '{"main":1}', body_length: '10', body_truncated: 'false', query_source: 'sdk' },
      }),
    });
    assert.equal(mainBody.status, 200);

    const subBody = await fetch(`${base}/v1/logs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: logsPayloadBody(sessionId, {
        eventName: 'claude_code.api_request_body',
        timeMs: t0 + 1000,
        attrs: {
          model: 'm',
          body: '{"sub":1}',
          body_length: '9',
          body_truncated: 'false',
          query_source: 'agent:builtin:general-purpose',
        },
        spanId: execSpanId,
      }),
    });
    assert.equal(subBody.status, 200);

    const filtered = await (await fetch(`${base}/api/events?session=${sessionId}&agent=${execSpanId}`)).json();
    assert.equal(filtered.items.length, 1);
    assert.equal(filtered.items[0].agent, execSpanId);

    const detail = await (await fetch(`${base}/api/sessions/${sessionId}`)).json();
    assert.equal(detail.agents.length, 2);
    assert.ok(detail.agents.some((agent) => agent.key === 'main'));
    assert.ok(detail.agents.some((agent) => agent.name === 'general-purpose'));
  });
});
