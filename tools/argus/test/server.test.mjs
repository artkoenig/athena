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

function contentLogsPayloadJson(sessionId, overrides = {}) {
  const body = overrides.body ?? '{"messages":[{"role":"user","content":"hello"}]}';
  const attributes = [
    { key: 'session.id', value: { stringValue: sessionId } },
    { key: 'model', value: { stringValue: 'claude-sonnet-5' } },
    { key: 'query_source', value: { stringValue: 'sdk' } },
    { key: 'prompt.id', value: { stringValue: 'prompt-1' } },
    { key: 'event.sequence', value: { stringValue: '5' } },
    { key: 'body', value: { stringValue: body } },
    { key: 'body_length', value: { stringValue: String(body.length) } },
    { key: 'body_truncated', value: { stringValue: 'false' } },
  ];
  if (overrides.requestId) {
    attributes.push({ key: 'request_id', value: { stringValue: overrides.requestId } });
  }
  return JSON.stringify({
    resourceLogs: [
      {
        resource: { attributes: [{ key: 'session.id', value: { stringValue: sessionId } }] },
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: String(overrides.timeUnixNano ?? T0),
                severityNumber: 9,
                eventName: overrides.eventName ?? 'claude_code.api_request_body',
                attributes,
              },
            ],
          },
        ],
      },
    ],
  });
}

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
    assert.equal(config.env.OTEL_LOG_RAW_API_BODIES, '1');
    assert.equal(config.requiresToken, false);
  });
});

test('POST of an api_request_body log is served by GET /api/content, without the body', async () => {
  await withServer({}, async ({ base }) => {
    const ingested = await fetch(`${base}/v1/logs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: contentLogsPayloadJson('s-content'),
    });
    assert.equal(ingested.status, 200);

    const listed = await (await fetch(`${base}/api/content?session=s-content`)).json();
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0].model, 'claude-sonnet-5');
    assert.ok(!('body' in listed.items[0]), 'the index route must never carry the body');
  });
});

test('GET /api/content/at at the record time answers with the full body', async () => {
  await withServer({}, async ({ base }) => {
    await fetch(`${base}/v1/logs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: contentLogsPayloadJson('s-content-at'),
    });
    const atMs = Number(T0 / 1000000n);
    const response = await fetch(`${base}/api/content/at?session=s-content-at&at=${atMs}`);
    assert.equal(response.status, 200);
    const { item } = await response.json();
    assert.equal(item.body, '{"messages":[{"role":"user","content":"hello"}]}');
  });
});

test('GET /api/content/at before the first record answers 200 with a null item, not 404', async () => {
  await withServer({}, async ({ base }) => {
    await fetch(`${base}/v1/logs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: contentLogsPayloadJson('s-content-early'),
    });
    const atMs = Number(T0 / 1000000n) - 60_000;
    const response = await fetch(`${base}/api/content/at?session=s-content-early&at=${atMs}`);
    assert.equal(response.status, 200);
    const { item } = await response.json();
    assert.equal(item, null);
  });
});

test('GET /api/content/at without a session is a 400', async () => {
  await withServer({}, async ({ base }) => {
    assert.equal((await fetch(`${base}/api/content/at?at=0`)).status, 400);
  });
});

test('/api/events strips the body but keeps its length, and /api/content/at still serves the whole body afterwards', async () => {
  await withServer({}, async ({ base }) => {
    await fetch(`${base}/v1/logs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: contentLogsPayloadJson('s-tail'),
    });

    const events = await (await fetch(`${base}/api/events?session=s-tail`)).json();
    assert.equal(events.items.length, 1);
    const item = events.items[0];
    assert.ok(!item.attrs || !('body' in item.attrs), 'the event tail must not ship the body');
    assert.ok(item.content, 'the event tail must carry the content metadata instead of the body');
    assert.equal(item.content.bodyChars, '{"messages":[{"role":"user","content":"hello"}]}'.length);

    const atMs = Number(T0 / 1000000n);
    const at = await (await fetch(`${base}/api/content/at?session=s-tail&at=${atMs}`)).json();
    assert.equal(
      at.item.body,
      '{"messages":[{"role":"user","content":"hello"}]}',
      'the API projection on /api/events must not have mutated the stored record',
    );
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

test("POST /api/runs accepts a run's state and answers with the id it filed it under", async () => {
  await withServer({}, async ({ base, store }) => {
    const state = backlogState();
    const response = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'run-a', state }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.id, 'run-a');
    assert.equal(typeof body.updatedAtMs, 'number');
    assert.deepEqual(store.getRun('run-a').state, state);
  });
});

test('a POST that names no id is identified by the issue in the state it carries', async () => {
  await withServer({}, async ({ base }) => {
    const state = backlogState({ issue: 'docs/issues/2026-08-08-x' });
    const response = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.id, 'docs/issues/2026-08-08-x');

    const fetched = await fetch(`${base}/api/runs/${encodeURIComponent('docs/issues/2026-08-08-x')}`);
    assert.equal(fetched.status, 200);
    assert.deepEqual((await fetched.json()).state, state);
  });
});

test('a second POST for the same run replaces what the collector held', async () => {
  await withServer({}, async ({ base }) => {
    const first = backlogState({ issue: 'docs/issues/2026-08-08-a' });
    const second = backlogState({ issue: 'docs/issues/2026-08-08-b' });
    for (const state of [first, second]) {
      const response = await fetch(`${base}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'run-a', state }),
      });
      assert.equal(response.status, 200);
    }

    const fetched = await (await fetch(`${base}/api/runs/run-a`)).json();
    assert.deepEqual(fetched.state, second);
    const list = await (await fetch(`${base}/api/runs`)).json();
    assert.equal(list.total, 1);
  });
});

test('a POST with neither an id nor an issue, and a POST that is not JSON, are both 400 and the collector keeps serving', async () => {
  await withServer({}, async ({ base }) => {
    const noId = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: { increments: [] } }),
    });
    assert.equal(noId.status, 400);

    const notJson = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.equal(notJson.status, 400);

    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    const list = await (await fetch(`${base}/api/runs`)).json();
    assert.equal(list.total, 0);
  });
});

test('GET /api/runs lists the runs held and GET /api/runs/:id serves one whole', async () => {
  await withServer({}, async ({ base }) => {
    const stateA = backlogState({ issue: 'docs/issues/2026-08-08-a' });
    const stateB = backlogState({ issue: 'docs/issues/2026-08-08-b' });
    await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'run-a', state: stateA }),
    });
    await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'run-b', state: stateB }),
    });

    const list = await (await fetch(`${base}/api/runs`)).json();
    assert.equal(list.total, 2);
    assert.deepEqual(list.items.map((item) => item.id).sort(), ['run-a', 'run-b']);
    for (const item of list.items) {
      assert.equal(typeof item.updatedAtMs, 'number');
      assert.ok(!('state' in item), 'the list route must never carry the state');
    }

    const fetchedA = await (await fetch(`${base}/api/runs/run-a`)).json();
    assert.deepEqual(fetchedA.state, stateA);
  });
});

test('GET /api/runs/:id for a run the collector does not hold is a 404', async () => {
  await withServer({}, async ({ base }) => {
    const response = await fetch(`${base}/api/runs/nope`);
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.ok(body.error);
  });
});

test('a method the run endpoint does not take is still a 405', async () => {
  await withServer({}, async ({ base }) => {
    assert.equal((await fetch(`${base}/api/runs`, { method: 'PUT' })).status, 405);
    assert.equal((await fetch(`${base}/api/runs`, { method: 'DELETE' })).status, 405);
  });
});

test('the run endpoints are gated exactly like the rest of the API', async () => {
  await withServer({ token: 'secret' }, async ({ base }) => {
    const state = backlogState();
    const post = () =>
      fetch(`${base}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'run-a', state }),
      });

    const postUnauth = await post();
    assert.equal(postUnauth.status, 401);
    assert.ok(postUnauth.headers.get('www-authenticate'));

    const listUnauth = await fetch(`${base}/api/runs`);
    assert.equal(listUnauth.status, 401);
    assert.ok(listUnauth.headers.get('www-authenticate'));

    const getUnauth = await fetch(`${base}/api/runs/run-a`);
    assert.equal(getUnauth.status, 401);
    assert.ok(getUnauth.headers.get('www-authenticate'));

    const postAuthed = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
      body: JSON.stringify({ id: 'run-a', state }),
    });
    assert.equal(postAuthed.status, 200);

    const listAuthed = await fetch(`${base}/api/runs`, { headers: { authorization: 'Bearer secret' } });
    assert.equal(listAuthed.status, 200);

    assert.equal((await fetch(`${base}/api/runs?token=secret`)).status, 200);
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

test('a write to a run state puts a run frame on the stream, naming the run that changed', async () => {
  await withServer({}, async ({ base }) => {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/stream`, { signal: controller.signal });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    const first = decoder.decode((await reader.read()).value);
    assert.match(first, /event: hello/);

    await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'run-sse', state: backlogState() }),
    });

    let frame = '';
    while (!frame.includes('event: run')) {
      frame += decoder.decode((await reader.read()).value);
    }
    assert.match(frame, /"id":"run-sse"/);
    assert.match(frame, /"updatedAtMs":\d+/);
    controller.abort();
  });
});

test('an api_response_body log is served by GET /api/content and GET /api/content/at when filtered by event, and the default event still means api_request_body', async () => {
  await withServer({}, async ({ base }) => {
    const responseText = '{"content":[{"type":"text","text":"response body text"}]}';
    await fetch(`${base}/v1/logs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: contentLogsPayloadJson('s-response', {
        eventName: 'claude_code.api_response_body',
        body: responseText,
        requestId: 'req_011Cdm',
      }),
    });

    const listed = await (
      await fetch(`${base}/api/content?session=s-response&event=claude_code.api_response_body`)
    ).json();
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0].eventName, 'claude_code.api_response_body');
    assert.ok(!('body' in listed.items[0]), 'the index route must never carry the body for a response record either');

    const atMs = Number(T0 / 1000000n);
    const withEvent = await (
      await fetch(`${base}/api/content/at?session=s-response&at=${atMs}&event=claude_code.api_response_body`)
    ).json();
    assert.equal(withEvent.item.body, responseText);

    const withoutEvent = await (await fetch(`${base}/api/content/at?session=s-response&at=${atMs}`)).json();
    assert.equal(
      withoutEvent.item,
      null,
      'without an event filter the route defaults to api_request_body, and this session holds no request body',
    );
  });
});

test('an api_response_body log does not ship its body through the polled event tail either', async () => {
  await withServer({}, async ({ base }) => {
    const responseText = '{"content":[{"type":"text","text":"response body text"}]}';
    await fetch(`${base}/v1/logs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: contentLogsPayloadJson('s-response-tail', {
        eventName: 'claude_code.api_response_body',
        body: responseText,
        requestId: 'req_011Cdm',
      }),
    });

    const events = await (await fetch(`${base}/api/events?session=s-response-tail`)).json();
    assert.equal(events.items.length, 1);
    const item = events.items[0];
    assert.ok(!item.attrs || !('body' in item.attrs), 'the event tail must not ship a response body any more than a request body');
    assert.ok(item.content, 'the event tail must carry the content metadata for a response record too');
    assert.equal(item.content.bodyChars, responseText.length);
  });
});
