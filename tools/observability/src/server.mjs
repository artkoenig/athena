/**
 * HTTP surface: an OTLP receiver and the monitoring UI on the same port.
 *
 * Running both on one listener is what makes the setup a single line of config —
 * `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` also happens to be the URL
 * you open in a browser. `/v1/*` is the OTLP ingest path (as the OTLP/HTTP spec
 * mandates), `/api/*` is the read API for the UI, everything else is static.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { decodeExportRequest } from './otlp/decode.mjs';
import { attributionOf, describeEvent, otelEnvFor } from './claude.mjs';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const SSE_FLUSH_MS = 250;

/*
 * A token in the query string is a poor way to hold a browser session: it sits
 * in history, gets copied along with any link, and has to be re-pasted on every
 * visit — for a secret the operator already configured once on the server. So it
 * is accepted once and immediately traded for a cookie, which the browser then
 * attaches to everything by itself. HttpOnly keeps it away from scripts, and
 * SameSite=Strict means another site cannot make an authenticated request with
 * it, which is what keeps the ingest and delete endpoints safe from a page the
 * user merely happens to visit.
 */
const TOKEN_COOKIE = 'athena_obs_token';
const TOKEN_COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

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

function intParam(params, key, fallback, max = Number.MAX_SAFE_INTEGER) {
  const raw = params.get(key);
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.min(value, max);
}

export function createServer({ store, token = null, endpoint = '', log = console.error } = {}) {
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
  store.subscribe(({ signal, records, sessionIds, seq, replay }) => {
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

  const cookieToken = (req) => {
    for (const part of (req.headers.cookie ?? '').split(';')) {
      const index = part.indexOf('=');
      if (index > 0 && part.slice(0, index).trim() === TOKEN_COOKIE) {
        return decodeURIComponent(part.slice(index + 1).trim());
      }
    }
    return null;
  };

  const authorized = (req, url) => {
    if (!token) return true;
    const header = req.headers.authorization ?? '';
    // How an agent authenticates. Everything below exists because a browser
    // cannot set this header on the requests it makes on its own.
    if (header === `Bearer ${token}`) return true;
    // How a browser authenticates once it has been here: the cookie rides on
    // every request the page makes, including sub-resources and EventSource.
    if (cookieToken(req) === token) return true;
    // How it gets that cookie in the first place — one visit carrying the token,
    // after which the query parameter is traded for the cookie and dropped.
    return url.searchParams.get('token') === token;
  };

  const serveStatic = (req, res, pathname) => {
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = path.join(PUBLIC_DIR, relative);
    if (!file.startsWith(PUBLIC_DIR)) {
      sendJson(res, 403, { error: 'forbidden' });
      return;
    }
    fs.readFile(file, (error, content) => {
      if (error) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
        'content-length': content.length,
        'cache-control': 'no-cache',
      });
      res.end(content);
    });
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
          ...event,
          summary: describeEvent(event),
          attribution: attributionOf(event.attrs),
        })),
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
      const payload = { ok: true, uptimeMs: Date.now() - store.startedAt };
      if (ok) payload.seq = store.seq;
      sendJson(res, 200, payload);
      return;
    }

    // The app shell is not gated, only the data is. A browser sends the token on
    // the document request — it is in the URL — but not on the <link> and
    // <script> it then goes and fetches, because sub-resource requests do not
    // inherit the query string. Gating those served a 401 for styles.css and
    // app.js, which left a page with no script at all: the static markup, an
    // empty env block and nothing that could explain itself. index.html, app.js
    // and styles.css are identical for every visitor and contain neither
    // telemetry nor the token, so there is nothing to protect there.
    const needsAuth = Boolean(signal) || url.pathname.startsWith('/api/');
    if (!ok && needsAuth) {
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

    // One visit carrying the token is enough. Hand back a cookie and bounce to
    // the same page without it, so the secret leaves the address bar and the
    // history entry, and the next visit needs nothing at all.
    if (token && url.searchParams.get('token') === token) {
      url.searchParams.delete('token');
      const secure = req.headers['x-forwarded-proto'] === 'https' || Boolean(req.socket.encrypted);
      res.writeHead(302, {
        'set-cookie':
          `${TOKEN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; ` +
          `Max-Age=${TOKEN_COOKIE_MAX_AGE}${secure ? '; Secure' : ''}`,
        location: `${url.pathname}${url.search}${url.hash}`,
      });
      res.end();
      return;
    }

    serveStatic(req, res, url.pathname);
  });

  server.on('close', () => {
    if (flushTimer) clearTimeout(flushTimer);
    for (const client of clients) client.end();
    clients.clear();
  });

  return server;
}
