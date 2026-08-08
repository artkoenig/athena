import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createServer } from '../src/server.mjs';

/**
 * A stand-in collector. It records every request it is handed, so a test can
 * assert what the interface put on the wire *upstream* — which is where the
 * token has to appear and the browser's cookie has to not.
 */
async function startFakeCollector({ token = null, routes = {} } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      requests.push({ method: req.method, url: req.url, headers: { ...req.headers }, body });
      if (token && req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      const route = routes[req.url.split('?')[0]];
      if (route) {
        route(req, res, body);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    requests,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function withUi({ collector: collectorOptions = {}, ...uiOptions }, run) {
  const collector = await startFakeCollector(collectorOptions);
  const server = createServer({ collector: collector.url, log: () => {}, ...uiOptions });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({ base, collector });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await collector.close();
  }
}

test('the interface serves the page on its own port', async () => {
  await withUi({}, async ({ base }) => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(await page.text(), /uroboros/i);

    const script = await fetch(`${base}/app.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type'), /javascript/);

    const styles = await fetch(`${base}/styles.css`);
    assert.equal(styles.status, 200);
    assert.match(styles.headers.get('content-type'), /text\/css/);

    // Nothing above the served directory is reachable.
    assert.notEqual((await fetch(`${base}/../package.json`)).status, 200);
  });
});

test('the interface supplies the collector token itself and strips the browser cookie', async () => {
  await withUi(
    { collectorToken: 'collector-secret', collector: { token: 'collector-secret' } },
    async ({ base, collector }) => {
      const response = await fetch(`${base}/api/sessions?limit=5`, {
        headers: { cookie: 'uroboros_obs_token=whatever-the-browser-had' },
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true, path: '/api/sessions?limit=5' });

      const upstream = collector.requests.at(-1);
      assert.equal(upstream.url, '/api/sessions?limit=5', 'the query string travels with the request');
      assert.equal(upstream.headers.authorization, 'Bearer collector-secret');
      assert.equal(upstream.headers.cookie, undefined, "the browser's cookie must not reach the collector");
    },
  );
});

test('OTLP paths are proxied too, body and method intact', async () => {
  await withUi({ collectorToken: 'c', collector: { token: 'c' } }, async ({ base, collector }) => {
    const body = Buffer.from([0x0a, 0x02, 0x08, 0x01]);
    const response = await fetch(`${base}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-protobuf' },
      body,
    });
    assert.equal(response.status, 200);

    const upstream = collector.requests.at(-1);
    assert.equal(upstream.method, 'POST');
    assert.equal(upstream.url, '/v1/traces');
    assert.deepEqual([...upstream.body], [...body]);
    assert.equal(upstream.headers.authorization, 'Bearer c');
  });
});

test('the live stream comes through the proxy rather than being buffered', async () => {
  const routes = {
    '/api/stream': (req, res) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
      });
      res.write('event: hello\ndata: {"seq":0}\n\n');
      setTimeout(() => res.write('event: ingest\ndata: {"seq":1}\n\n'), 30);
    },
  };
  await withUi({ collectorToken: 'c', collector: { token: 'c', routes } }, async ({ base }) => {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/stream`, { signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('event: ingest')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    assert.match(text, /event: hello/);
    assert.match(text, /event: ingest/, 'a frame written later must arrive without waiting for the stream to end');
    controller.abort();
  });
});

test('an upstream 401 becomes a 502 that names the cause', async () => {
  // A 401 handed straight back would tell the browser to ask *the user* for a
  // credential it never had: the token belongs to this process, not to them.
  await withUi(
    { collectorToken: 'wrong-secret', collector: { token: 'right-secret' } },
    async ({ base }) => {
      const response = await fetch(`${base}/api/sessions`);
      assert.equal(response.status, 502);
      assert.match(response.headers.get('content-type'), /application\/json/);
      const body = await response.json();
      assert.match(JSON.stringify(body), /token/i, 'the body has to say the collector rejected the token');
    },
  );
});

test('every other upstream status passes through unchanged', async () => {
  const routes = {
    '/api/sessions/nope': (req, res) => {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'unknown session' }));
    },
  };
  await withUi({ collector: { routes } }, async ({ base }) => {
    const response = await fetch(`${base}/api/sessions/nope`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'unknown session' });
  });
});

test('on loopback the browser never handles a token', async () => {
  await withUi({ collectorToken: 'collector-secret', collector: { token: 'collector-secret' } }, async ({ base, collector }) => {
    const page = await fetch(`${base}/`, { redirect: 'manual' });
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('set-cookie'), null, 'nothing to hand the browser when it needs no credential');

    const data = await fetch(`${base}/api/sessions`);
    assert.equal(data.status, 200, 'the browser sends no credential and still gets the data');
    assert.equal(collector.requests.at(-1).headers.authorization, 'Bearer collector-secret');
  });
});

test('with --token the interface trades the token in the query for a cookie', async () => {
  await withUi({ token: 'ui-secret', collectorToken: 'c', collector: { token: 'c' } }, async ({ base }) => {
    assert.equal((await fetch(`${base}/api/sessions`)).status, 401, 'the data stays shut without the token');

    const handoff = await fetch(`${base}/?token=ui-secret`, { redirect: 'manual' });
    assert.equal(handoff.status, 302);
    assert.equal(handoff.headers.get('location'), '/', 'the secret leaves the address bar');
    const cookie = handoff.headers.get('set-cookie');
    assert.match(cookie, /^uroboros_obs_token=ui-secret;/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);

    const jar = { cookie: 'uroboros_obs_token=ui-secret' };
    assert.equal((await fetch(`${base}/api/sessions`, { headers: jar })).status, 200);

    // The app shell is not gated: a browser puts the token on the document
    // request because it is in the URL, but not on the <link> and <script> that
    // document then pulls in — gating those leaves a page with no script.
    for (const asset of ['/', '/app.js', '/styles.css']) {
      assert.equal((await fetch(`${base}${asset}`)).status, 200, `${asset} must load unauthenticated`);
    }
  });
});
