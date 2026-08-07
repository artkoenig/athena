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

/**
 * A trace payload for the agent-lanes route: a main interaction span plus two
 * subagent `claude_code.tool` spans of one `query_source`, with distinct
 * `agent_id` — the headline "two concurrent instances of one type" shape.
 */
function agentsTracePayload(sessionId) {
  const rootSpanId = '22'.repeat(8);
  const toolASpanId = '33'.repeat(8);
  const toolBSpanId = '44'.repeat(8);
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
                  spanId: rootSpanId,
                  name: 'claude_code.interaction',
                  startTimeUnixNano: T0,
                  endTimeUnixNano: T0 + 2000n * 1000000n,
                  attributes: [{ key: 'session.id', value: { stringValue: sessionId } }],
                },
                {
                  traceId: '11'.repeat(16),
                  spanId: toolASpanId,
                  parentSpanId: rootSpanId,
                  name: 'claude_code.tool',
                  startTimeUnixNano: T0 + 100n * 1000000n,
                  endTimeUnixNano: T0 + 500n * 1000000n,
                  attributes: [
                    { key: 'session.id', value: { stringValue: sessionId } },
                    { key: 'agent_id', value: { stringValue: 'agt-a' } },
                    { key: 'parent_agent_id', value: { stringValue: 'agt-main' } },
                    { key: 'query_source', value: { stringValue: 'agent:builtin:researcher' } },
                  ],
                },
                {
                  traceId: '11'.repeat(16),
                  spanId: toolBSpanId,
                  parentSpanId: rootSpanId,
                  name: 'claude_code.tool',
                  startTimeUnixNano: T0 + 150n * 1000000n,
                  endTimeUnixNano: T0 + 700n * 1000000n,
                  attributes: [
                    { key: 'session.id', value: { stringValue: sessionId } },
                    { key: 'agent_id', value: { stringValue: 'agt-b' } },
                    { key: 'parent_agent_id', value: { stringValue: 'agt-main' } },
                    { key: 'query_source', value: { stringValue: 'agent:builtin:researcher' } },
                  ],
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

/** A single OTLP attribute pair, string-valued like the CLI sends every content attribute. */
function otlpAttr(key, value) {
  return { key, value: { stringValue: String(value) } };
}

/**
 * An OTLP/JSON logs payload for one or more content-bearing log records, in the
 * same shape as `logsPayloadJson` above. `records` is `[{ eventName, timeMs, attrs }]`.
 */
function contentLogsPayloadJson(sessionId, records) {
  return JSON.stringify({
    resourceLogs: [
      {
        resource: { attributes: [{ key: 'session.id', value: { stringValue: sessionId } }] },
        scopeLogs: [
          {
            logRecords: records.map((record) => ({
              timeUnixNano: String(BigInt(record.timeMs) * 1000000n),
              severityNumber: 9,
              eventName: record.eventName,
              ...(record.spanId ? { spanId: record.spanId } : {}),
              attributes: [
                otlpAttr('session.id', sessionId),
                ...Object.entries(record.attrs).map(([key, value]) => otlpAttr(key, value)),
              ],
            })),
          },
        ],
      },
    ],
  });
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

test('content-bearing records are listed over the API, without their text by default', async () => {
  await withServer({}, async ({ base }) => {
    const t = Date.now();
    const payload = contentLogsPayloadJson('s-content', [
      {
        eventName: 'claude_code.api_request_body',
        timeMs: t,
        attrs: {
          body: '{"messages":["hello there"]}',
          body_length: '29',
          model: 'claude-opus-5',
          query_source: 'agent:builtin:researcher',
        },
      },
      {
        eventName: 'claude_code.api_response_body',
        timeMs: t + 500,
        attrs: { body: '{"id":"msg_1"}', body_length: '13' },
      },
      {
        eventName: 'claude_code.user_prompt',
        timeMs: t + 1000,
        attrs: { prompt: 'hi', prompt_length: '2' },
      },
    ]);
    // Assert the ingest itself, so a failed POST reports as a failed POST rather
    // than a confusing empty-content assertion further down.
    const ingested = await fetch(`${base}/v1/logs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });
    assert.equal(ingested.status, 200);

    const response = await fetch(`${base}/api/content?session=s-content`);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.items.length, 3);
    assert.deepEqual(
      result.items.map((item) => item.kind),
      ['request_body', 'response_body', 'user_prompt'],
    );
    const first = result.items[0];
    assert.equal(typeof first.timeMs, 'number');
    assert.equal(first.length, 29);
    assert.equal(first.truncated, false);
    assert.equal(first.querySource, 'agent:builtin:researcher');
    assert.equal(first.attribution.query_source, 'agent:builtin:researcher');
    assert.ok(!('text' in first), 'text is opt-in via ?body=1 and must be absent by default');
  });
});

test('the content at a point in time is one request away', async () => {
  await withServer({}, async ({ base }) => {
    const t = Date.now();
    const payload = contentLogsPayloadJson('s-content', [
      {
        eventName: 'claude_code.api_request_body',
        timeMs: t,
        attrs: { body: '{"messages":["first"]}', body_length: '23' },
      },
      {
        eventName: 'claude_code.api_response_body',
        timeMs: t + 500,
        attrs: { body: '{"id":"msg_1"}', body_length: '13' },
      },
      {
        eventName: 'claude_code.user_prompt',
        timeMs: t + 1000,
        attrs: { prompt: 'hi', prompt_length: '2' },
      },
      {
        eventName: 'claude_code.api_request_body',
        timeMs: t + 2000,
        attrs: { body: '{"messages":["second"]}', body_length: '24' },
      },
    ]);
    const ingested = await fetch(`${base}/v1/logs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });
    assert.equal(ingested.status, 200);

    const response = await fetch(
      `${base}/api/content?session=s-content&kind=request_body&at=${t + 1500}&limit=1&body=1`,
    );
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].kind, 'request_body');
    assert.equal(result.items[0].text, '{"messages":["first"]}');
  });
});

test('the event tail no longer carries whole bodies', async () => {
  await withServer({}, async ({ base }) => {
    const t = Date.now();
    const payload = contentLogsPayloadJson('s-content', [
      {
        eventName: 'claude_code.api_request_body',
        timeMs: t,
        attrs: { body: '{"messages":["hello there"]}', body_length: '29' },
      },
      {
        eventName: 'claude_code.api_response_body',
        timeMs: t + 500,
        attrs: { body: '{"id":"msg_1"}', body_length: '13' },
      },
      {
        eventName: 'claude_code.user_prompt',
        timeMs: t + 1000,
        attrs: { prompt: 'hi', prompt_length: '2' },
      },
    ]);
    const ingested = await fetch(`${base}/v1/logs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });
    assert.equal(ingested.status, 200);

    const events = await (await fetch(`${base}/api/events?session=s-content`)).json();
    const bodyEvent = events.items.find((item) => item.eventName === 'claude_code.api_request_body');
    assert.ok(bodyEvent, 'the api_request_body event must still appear in the tail');
    assert.equal(bodyEvent.attrs.body_length, '29');
    assert.ok(!('body' in bodyEvent.attrs), 'the whole body must not ride along in the event tail');

    const content = await (
      await fetch(`${base}/api/content?session=s-content&kind=request_body&limit=1&body=1`)
    ).json();
    assert.equal(content.items.length, 1);
    assert.equal(
      content.items[0].text,
      '{"messages":["hello there"]}',
      'the stored record must still carry the full text — it was copied, not stripped',
    );
  });
});

test('asking without a session asks across all of them, and a bad at is ignored rather than fatal', async () => {
  await withServer({}, async ({ base }) => {
    const t = Date.now();
    const payload = contentLogsPayloadJson('s-content', [
      {
        eventName: 'claude_code.api_request_body',
        timeMs: t,
        attrs: { body: '{"messages":["hi"]}', body_length: '20' },
      },
    ]);
    const ingested = await fetch(`${base}/v1/logs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });
    assert.equal(ingested.status, 200);

    const all = await fetch(`${base}/api/content`);
    assert.equal(all.status, 200);
    const allResult = await all.json();
    assert.ok(
      allResult.items.some((item) => item.kind === 'request_body'),
      'a session-less query still lists this session\'s content',
    );

    // intParam already falls back on an unparseable value — the fallback is
    // asserted here, not an error.
    const badAt = await fetch(`${base}/api/content?session=s-content&at=nonsense`);
    assert.equal(badAt.status, 200);
    const badAtResult = await badAt.json();
    assert.equal(badAtResult.items.length, 1);
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

test('GET /api/sessions/:id/agents answers with one lane per agent instance', async () => {
  await withServer({}, async ({ base }) => {
    // Assert the ingest itself, so a failed POST reports as a failed POST rather
    // than as a confusing empty-lanes assertion further down.
    const ingested = await fetch(`${base}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-protobuf' },
      body: agentsTracePayload('s-agents'),
    });
    assert.equal(ingested.status, 200);

    const response = await fetch(`${base}/api/sessions/s-agents/agents`);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.items.length, 3);
    assert.deepEqual(
      result.items.map((item) => item.kind),
      ['main', 'subagent', 'subagent'],
    );
    for (const item of result.items) {
      assert.equal(typeof item.firstMs, 'number');
      assert.equal(typeof item.lastMs, 'number');
      assert.equal(typeof item.durationMs, 'number');
      assert.equal(typeof item.spanCount, 'number');
    }
  });
});

test('GET /api/sessions/:id/agents for an unknown session is a 404', async () => {
  await withServer({}, async ({ base }) => {
    const response = await fetch(`${base}/api/sessions/nope/agents`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'unknown session' });
  });
});

test('the drawn data actually reaches a client over HTTP, decoded from the wire', async () => {
  await withServer({}, async ({ base }) => {
    // Assert the ingest itself, so a failed POST reports as a failed POST rather
    // than as a confusing empty-lanes assertion further down.
    const ingestedTrace = await fetch(`${base}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-protobuf' },
      body: agentsTracePayload('s-lane-activity'),
    });
    assert.equal(ingestedTrace.status, 200);

    const toolASpanId = '33'.repeat(8); // the tool span id agentsTracePayload already uses for agt-a
    const t = Date.now();
    const ingestedLogs = await fetch(`${base}/v1/logs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: contentLogsPayloadJson('s-lane-activity', [
        {
          eventName: 'claude_code.api_request_body',
          timeMs: t,
          spanId: toolASpanId,
          attrs: { body: '{"m":1}', body_truncated: 'true', body_length: '65000' },
        },
      ]),
    });
    assert.equal(ingestedLogs.status, 200);

    const response = await fetch(`${base}/api/sessions/s-lane-activity/agents`);
    assert.equal(response.status, 200);
    const result = await response.json();

    const lane = result.items.find((item) => item.id === 'agent:agt-a');
    assert.ok(lane, 'expected an agent:agt-a lane');
    assert.equal(lane.activity.length, 1);
    assert.equal(lane.activity[0].kind, 'tool');
    assert.equal(lane.context.length, 1);
    assert.equal(lane.context[0].length, 65000, 'the reported body_length must survive truncation over the wire');
    assert.equal(lane.contextPeak, 65000);

    for (const item of result.items) {
      assert.ok('activity' in item, `${item.id} is missing activity`);
      assert.ok('activityTotal' in item, `${item.id} is missing activityTotal`);
      assert.ok('context' in item, `${item.id} is missing context`);
      assert.ok('contextPeak' in item, `${item.id} is missing contextPeak`);
    }
  });
});

test('GET /api/sessions/:id/context answers with the lane context, and the lanes payload stays free of the text', async () => {
  await withServer({}, async ({ base }) => {
    // Assert the ingest itself, so a failed POST reports as a failed POST rather
    // than as a confusing empty-context assertion further down.
    const ingestedTrace = await fetch(`${base}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-protobuf' },
      body: agentsTracePayload('s-context'),
    });
    assert.equal(ingestedTrace.status, 200);

    const toolASpanId = '33'.repeat(8); // the tool span id agentsTracePayload uses for agt-a
    const t = Date.now();
    const bodyText = JSON.stringify({ messages: [{ role: 'user', content: 'needle-in-the-body' }] });
    const reportedLength = bodyText.length + 50_000; // larger than the delivered text, on purpose
    const ingestedLogs = await fetch(`${base}/v1/logs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: contentLogsPayloadJson('s-context', [
        {
          eventName: 'claude_code.api_request_body',
          timeMs: t,
          spanId: toolASpanId,
          attrs: { body: bodyText, body_length: String(reportedLength) },
        },
      ]),
    });
    assert.equal(ingestedLogs.status, 200);

    const lanes = await fetch(`${base}/api/sessions/s-context/agents`);
    assert.equal(lanes.status, 200);
    const lanesPayload = await lanes.json();
    assert.ok(
      !JSON.stringify(lanesPayload).includes('needle-in-the-body'),
      'the lanes payload must not carry the whole body text',
    );
    const lane = lanesPayload.items.find((item) => item.id === 'agent:agt-a');
    assert.equal(lane.context[0].length, reportedLength);

    const response = await fetch(`${base}/api/sessions/s-context/context?lane=agent:agt-a&at=${t}`);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.record.text, bodyText);
    assert.equal(result.record.length, reportedLength);
  });
});

test('GET /api/sessions/:id/context for an unknown session is a 404', async () => {
  await withServer({}, async ({ base }) => {
    const response = await fetch(`${base}/api/sessions/nope/context?lane=main`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'unknown session' });
  });
});

test('GET /api/sessions/:id/context without a lane is a 400', async () => {
  await withServer({}, async ({ base }) => {
    const ingested = await fetch(`${base}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-protobuf' },
      body: agentsTracePayload('s-context-400'),
    });
    assert.equal(ingested.status, 200);

    const response = await fetch(`${base}/api/sessions/s-context-400/context`);
    assert.equal(response.status, 400);
  });
});

test('GET /api/sessions/:id/context for a lane with nothing before the bound answers with a null record', async () => {
  await withServer({}, async ({ base }) => {
    const ingested = await fetch(`${base}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-protobuf' },
      body: agentsTracePayload('s-context-none'),
    });
    assert.equal(ingested.status, 200);

    const t = Date.now();
    const response = await fetch(`${base}/api/sessions/s-context-none/context?lane=agent:agt-b&at=${t}`);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.record, null);
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
