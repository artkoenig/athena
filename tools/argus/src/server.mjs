/**
 * HTTP surface: an OTLP receiver and the JSON API over what it collected.
 *
 * `/v1/*` is the OTLP ingest path (as the OTLP/HTTP spec mandates) and `/api/*`
 * is the read API. Nothing else is served: the web page lives in its own
 * process (`tools/argus-ui`) and reaches this one over exactly that API, so a
 * deployed collector carries no browser-facing file at all.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

import { decodeExportRequest } from './otlp/decode.mjs';
import { EVENT, attributionOf, describeEvent, otelEnvFor } from './claude.mjs';

const MAX_BODY_BYTES = 32 * 1024 * 1024;
const SSE_FLUSH_MS = 250;

/*
 * Identifies this process, so a caller can tell whether the URL it is talking to
 * is one collector or several. The store is in memory, so several is not a
 * smaller version of one: telemetry lands in whichever instance took the POST
 * and is invisible from every other, which looks exactly like sessions
 * appearing and vanishing at random. It is worth being able to prove.
 */
const INSTANCE_ID = crypto.randomBytes(6).toString('hex');

/** What a request for a page is answered with, since there is no page here. */
const NO_INTERFACE =
  'this is the argus collector, which serves data and no interface — run argus-ui and point it here';

const SIGNAL_BY_PATH = {
  '/v1/traces': 'traces',
  '/v1/metrics': 'metrics',
  '/v1/logs': 'logs',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decompress(buffer, encoding = '') {
  if (!buffer.length) return buffer;
  if (encoding.includes('gzip')) return zlib.gunzipSync(buffer);
  if (encoding.includes('deflate')) return zlib.inflateSync(buffer);
  return buffer;
}

/** OTLP wants a same-content-type response; both signals accept an empty one. */
function sendOtlpAck(res, contentType) {
  if (contentType.includes('json')) {
    sendJson(res, 200, { partialSuccess: {} });
    return;
  }
  res.writeHead(200, { 'content-type': 'application/x-protobuf', 'content-length': 0 });
  res.end();
}

/** The two events whose `body` attribute is a whole request or response. */
const RAW_BODY_EVENTS = new Set([EVENT.apiRequestBody, EVENT.apiResponseBody]);

/**
 * The event tail returns whole records, and with `OTEL_LOG_RAW_API_BODIES` on a
 * single page of it can carry dozens of 60 KB bodies on every poll. Drop the
 * `body` attribute of the two body events and nothing else: `body_length`,
 * `body_truncated` and every other attribute stay, and the full text is one
 * `/api/content?body=1` away.
 *
 * Always on a copy — deleting from the stored record would destroy the content
 * the collector exists to keep.
 */
function withoutRawBody(event) {
  if (!RAW_BODY_EVENTS.has(event.eventName) || event.attrs?.body === undefined) return event;
  const { body, ...attrs } = event.attrs;
  return { ...event, attrs };
}

function intParam(params, key, fallback, max = Number.MAX_SAFE_INTEGER) {
  const raw = params.get(key);
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.min(value, max);
}

export function createServer({ store, token = null, endpoint = '', persist = null, log = console.error } = {}) {
  // A tunnel URL only exists once the tunnel is up, after the server is already
  // listening, so the endpoint may be supplied as a getter and resolved per request.
  const endpointOf = () => (typeof endpoint === 'function' ? endpoint() : endpoint);
  const clients = new Set();
  let pending = null;
  let flushTimer = null;

  const flush = () => {
    flushTimer = null;
    if (!pending || !clients.size) {
      pending = null;
      return;
    }
    const frame = `event: ingest\ndata: ${JSON.stringify(pending)}\n\n`;
    pending = null;
    for (const client of clients) {
      client.write(frame);
    }
  };

  // Coalesce bursts: an agent flushing every second can produce hundreds of
  // records per push, and the UI only needs to know that something changed.
  store.subscribe(({ signal, records = [], sessionIds, seq, replay }) => {
    if (replay || !clients.size) return;
    pending ??= { seq: 0, sessionIds: [], counts: { traces: 0, metrics: 0, logs: 0 }, events: [] };
    pending.seq = Math.max(pending.seq, seq);
    pending.counts[signal] += records.length;
    for (const id of sessionIds) {
      if (!pending.sessionIds.includes(id)) pending.sessionIds.push(id);
    }
    if (signal === 'logs') {
      for (const record of records.slice(-40)) {
        pending.events.push({
          seq: record.seq,
          timeMs: record.timeMs,
          sessionId: record.sessionId,
          traceId: record.traceId,
          eventName: record.eventName,
          severity: record.severity,
          isError: Boolean(record.isError),
          summary: describeEvent(record),
        });
      }
      pending.events = pending.events.slice(-80);
    }
    flushTimer ??= setTimeout(flush, SSE_FLUSH_MS);
  });

  /*
   * Two ways in, both for a program: the header an OTLP exporter sets, and the
   * query parameter `check` uses. No browser session — nothing here is opened
   * in a browser, so there is no cookie to issue and none to accept.
   */
  const authorized = (req, url) => {
    if (!token) return true;
    if ((req.headers.authorization ?? '') === `Bearer ${token}`) return true;
    return url.searchParams.get('token') === token;
  };

  const handleIngest = async (req, res, signal) => {
    const contentType = req.headers['content-type'] ?? 'application/x-protobuf';
    const raw = await readBody(req);
    const body = decompress(raw, req.headers['content-encoding'] ?? '');
    const records = decodeExportRequest(signal, body, contentType);
    store.ingest(signal, records);
    sendOtlpAck(res, contentType);
  };

  const handleApi = (req, res, url) => {
    const { pathname, searchParams } = url;

    if (pathname === '/api/config') {
      const endpoint = endpointOf();
      sendJson(res, 200, {
        endpoint,
        requiresToken: Boolean(token),
        // The measurement directory this collector writes to, absolute, or null
        // when it keeps nothing. A second `start` reads it here to say where the
        // collector already on this port is putting its records.
        persist: persist ?? null,
        retentionMs: store.options.retentionMs,
        limits: {
          spans: store.options.maxSpans,
          logs: store.options.maxLogs,
          metricPoints: store.options.maxMetricPoints,
          sessions: store.options.maxSessions,
        },
        env: otelEnvFor(endpoint, { token }),
      });
      return true;
    }
    if (pathname === '/api/stats') {
      sendJson(res, 200, store.stats());
      return true;
    }
    if (pathname === '/api/facets') {
      sendJson(res, 200, store.facets());
      return true;
    }
    if (pathname === '/api/sessions') {
      sendJson(
        res,
        200,
        store.listSessions({
          search: searchParams.get('search') ?? '',
          limit: intParam(searchParams, 'limit', 100, 500),
          offset: intParam(searchParams, 'offset', 0),
        }),
      );
      return true;
    }
    const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (sessionMatch) {
      const session = store.getSession(decodeURIComponent(sessionMatch[1]));
      if (!session) sendJson(res, 404, { error: 'unknown session' });
      else sendJson(res, 200, session);
      return true;
    }
    const agentsMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/agents$/);
    if (agentsMatch) {
      const agents = store.getAgents(decodeURIComponent(agentsMatch[1]));
      if (!agents) sendJson(res, 404, { error: 'unknown session' });
      else sendJson(res, 200, agents);
      return true;
    }
    const traceMatch = pathname.match(/^\/api\/traces\/([^/]+)$/);
    if (traceMatch) {
      const trace = store.getTrace(decodeURIComponent(traceMatch[1]));
      if (!trace) sendJson(res, 404, { error: 'unknown trace' });
      else sendJson(res, 200, trace);
      return true;
    }
    if (pathname === '/api/events') {
      const events = store.queryEvents({
        sessionId: searchParams.get('session'),
        eventName: searchParams.get('event'),
        traceId: searchParams.get('trace'),
        search: searchParams.get('search') ?? '',
        errorsOnly: searchParams.get('errors') === '1',
        sinceSeq: intParam(searchParams, 'sinceSeq', 0),
        limit: intParam(searchParams, 'limit', 200, 2000),
      });
      sendJson(res, 200, {
        items: events.map((event) => ({
          ...withoutRawBody(event),
          summary: describeEvent(event),
          attribution: attributionOf(event.attrs),
        })),
      });
      return true;
    }
    if (pathname === '/api/content') {
      // Text is opt-in: a hundred inline bodies are megabytes, and a caller that
      // wants one body asks for one.
      const withText = searchParams.get('body') === '1';
      const kindParam = searchParams.get('kind');
      const kinds = kindParam
        ? kindParam.split(',').map((kind) => kind.trim()).filter(Boolean)
        : null;
      const records = store.queryContent({
        sessionId: searchParams.get('session'),
        kinds,
        // An unparseable `at` falls back to "no bound" rather than erroring.
        atMs: intParam(searchParams, 'at', null),
        limit: intParam(searchParams, 'limit', 100, 500),
      });
      sendJson(res, 200, {
        items: records.map(({ log: record, content }) => {
          const attrs = record.attrs ?? {};
          const item = {
            seq: record.seq,
            timeMs: record.timeMs,
            sessionId: record.sessionId,
            traceId: record.traceId,
            spanId: record.spanId,
            eventName: record.eventName,
            kind: content.kind,
            length: content.length,
            truncated: content.truncated,
            ref: content.ref,
            model: attrs.model ?? null,
            querySource: attrs.query_source ?? null,
            requestId: attrs.request_id ?? null,
            attribution: attributionOf(attrs),
            // What actually arrived, which is below `length` when the CLI
            // truncated and 0 when it sent only a reference.
            storedLength: content.text ? content.text.length : 0,
          };
          if (withText) item.text = content.text;
          return item;
        }),
      });
      return true;
    }
    if (pathname === '/api/metrics') {
      sendJson(res, 200, {
        items: store.queryMetrics({
          sessionId: searchParams.get('session'),
          name: searchParams.get('name'),
          limit: intParam(searchParams, 'limit', 500, 5000),
        }),
      });
      return true;
    }
    return false;
  };

  const handleStream = (req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ seq: store.seq })}\n\n`);
    clients.add(res);
    // Proxies drop idle streams; a comment line every 20s keeps them open.
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 20_000);
    const cleanup = () => {
      clearInterval(heartbeat);
      clients.delete(res);
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const signal = SIGNAL_BY_PATH[url.pathname];

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type,authorization,content-encoding',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
      });
      res.end();
      return;
    }

    const ok = authorized(req, url);

    // Liveness stays reachable without the token so container healthchecks and
    // uptime probes work; the record counter is only added for callers that
    // authenticated, so an unauthenticated prober learns nothing about volume.
    if (url.pathname === '/api/health' && req.method === 'GET') {
      const payload = { ok: true, uptimeMs: Date.now() - store.startedAt, instance: INSTANCE_ID };
      if (ok) payload.seq = store.seq;
      sendJson(res, 200, payload);
      return;
    }

    // Everything but that one probe is gated. The exemption the page and its
    // sub-resources used to have went with the page: what is left on this port
    // is telemetry going in and telemetry coming out.
    if (!ok) {
      res.setHeader('www-authenticate', 'Bearer');
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    if (signal) {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      handleIngest(req, res, signal).catch((error) => {
        log(`ingest ${signal} failed: ${error.message}`);
        sendJson(res, error.status ?? 400, { error: error.message });
      });
      return;
    }

    if (url.pathname === '/api/stream') {
      handleStream(req, res);
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      if (req.method === 'DELETE' && url.pathname === '/api/data') {
        store.clear();
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      if (!handleApi(req, res, url)) sendJson(res, 404, { error: 'unknown endpoint' });
      return;
    }

    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }

    // No page, and saying so beats an empty 404: someone who opened this port
    // in a browser is one process away from what they were looking for.
    sendJson(res, 404, { error: 'not found', hint: NO_INTERFACE });
  });

  server.on('close', () => {
    if (flushTimer) clearTimeout(flushTimer);
    for (const client of clients) client.end();
    clients.clear();
  });

  return server;
}
