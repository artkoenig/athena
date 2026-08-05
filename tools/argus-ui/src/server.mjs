/**
 * The interface's HTTP surface: the page out of `public/`, and everything the
 * page asks for forwarded to a collector.
 *
 * A reverse proxy rather than a browser talking to the collector directly,
 * because `EventSource` cannot set an `Authorization` header: a cross-origin
 * page would have to carry the collector's token in the query string of every
 * request, which puts the secret in the address bar and in every copied link.
 * Here the token stays in this process and never reaches the browser at all.
 */

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

/*
 * A token in the query string is a poor way to hold a browser session: it sits
 * in history, gets copied along with any link, and has to be re-pasted on every
 * visit. So it is accepted once and traded for a cookie, which the browser then
 * attaches by itself — including on the requests it makes on its own, where it
 * can set no header at all. HttpOnly keeps it away from scripts, SameSite=Strict
 * stops another site from making an authenticated request with it.
 */
const TOKEN_COOKIE = 'uroboros_obs_token';
const TOKEN_COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

/** Headers that describe one hop and must not be copied onto the next. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const PROXIED = (pathname) => pathname.startsWith('/api/') || pathname.startsWith('/v1/');

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

export function createServer({
  collector = 'http://127.0.0.1:4318',
  collectorToken = null,
  token = null,
  log = console.error,
} = {}) {
  const upstream = new URL(String(collector).replace(/\/+$/, ''));
  const transport = upstream.protocol === 'https:' ? https : http;

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
    if ((req.headers.authorization ?? '') === `Bearer ${token}`) return true;
    if (cookieToken(req) === token) return true;
    return url.searchParams.get('token') === token;
  };

  const serveStatic = (res, pathname) => {
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

  const proxy = (req, res) => {
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (HOP_BY_HOP.has(name) || name === 'host' || name === 'content-length') continue;
      // Whatever credential the browser holds is this process's, not the
      // collector's. Forwarding it would hand a stranger's cookie to a service
      // that has its own idea of what a token means.
      if (name === 'cookie' || name === 'authorization') continue;
      headers[name] = value;
    }
    if (collectorToken) headers.authorization = `Bearer ${collectorToken}`;
    if (req.headers['content-length'] !== undefined) headers['content-length'] = req.headers['content-length'];

    const request = transport.request(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port,
        method: req.method,
        path: `${upstream.pathname === '/' ? '' : upstream.pathname}${req.url}`,
        headers,
      },
      (answer) => {
        // A 401 handed straight back would make the browser ask the user for a
        // credential they never had: the token belongs to this process.
        if (answer.statusCode === 401) {
          answer.resume();
          sendJson(res, 502, {
            error: 'collector rejected this interface',
            hint:
              `the collector at ${upstream.origin} rejected the token this UI was started with — ` +
              'start argus-ui with --collector-token <secret>, or set UROBOROS_OBS_TOKEN',
          });
          return;
        }
        const out = {};
        for (const [name, value] of Object.entries(answer.headers)) {
          if (HOP_BY_HOP.has(name)) continue;
          out[name] = value;
        }
        res.writeHead(answer.statusCode, out);
        // Piped, not buffered: an SSE frame written minutes into a stream has
        // to reach the page when it is written, not when the stream ends.
        answer.pipe(res);
      },
    );

    request.on('error', (error) => {
      log(`argus-ui: ${upstream.origin} did not answer (${error.message})`);
      if (!res.headersSent) {
        sendJson(res, 502, {
          error: 'collector unreachable',
          hint: `no answer from ${upstream.origin}: ${error.message}`,
        });
      } else {
        res.end();
      }
    });
    // A closed stream — a reload, a shut tab — has to release the upstream one
    // too, or the collector keeps writing into a socket nobody reads.
    res.on('close', () => request.destroy());
    req.pipe(request);
  };

  return http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

    // One visit carrying the token is enough. Hand back a cookie and bounce to
    // the same page without it, so the secret leaves the address bar and the
    // history entry, and the next visit needs nothing at all.
    if (token && req.method === 'GET' && !PROXIED(url.pathname) && url.searchParams.get('token') === token) {
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

    if (PROXIED(url.pathname)) {
      // The page and its sub-resources stay ungated: a browser puts the token on
      // the document request because it is in the URL, but not on the <link> and
      // <script> that document then pulls in — sub-resource requests do not
      // inherit a query string, and gating them leaves a page with no script.
      // They are identical for every visitor and carry neither data nor secret.
      if (!authorized(req, url)) {
        res.setHeader('www-authenticate', 'Bearer');
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      proxy(req, res);
      return;
    }

    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    serveStatic(res, url.pathname);
  });
}
