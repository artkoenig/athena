import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { TelemetryStore } from '../src/store.mjs';
import { createServer } from '../src/server.mjs';
import { probeCollector } from '../src/probe.mjs';

async function withServer(options, run) {
  const store = new TelemetryStore();
  const server = createServer({ store, log: () => {}, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run({ base: `http://127.0.0.1:${server.address().port}`, store });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const stepsByName = (result) => Object.fromEntries(result.steps.map((step) => [step.name, step]));

test('a healthy collector passes every step and the span is readable afterwards', async () => {
  await withServer({}, async ({ base, store }) => {
    const result = await probeCollector(`${base}/`, {});
    assert.equal(result.ok, true, JSON.stringify(result.steps));
    assert.equal(result.endpoint, base, 'trailing slash is normalized away');
    assert.deepEqual(
      result.steps.map((step) => step.name),
      ['reachable', 'single', 'ingest', 'stored'],
    );
    // The probe must land in the store, not just return 200.
    assert.ok(store.getSession(result.sessionId));
  });
});

test('a token-gated collector distinguishes a missing token from a wrong one', async () => {
  await withServer({ token: 'secret' }, async ({ base }) => {
    const missing = await probeCollector(base, {});
    assert.equal(missing.ok, false);
    assert.equal(stepsByName(missing).reachable.ok, true, 'health must stay reachable without a token');
    assert.match(stepsByName(missing).ingest.detail, /requires a token/);

    const wrong = await probeCollector(base, { token: 'nope' });
    assert.match(stepsByName(wrong).ingest.detail, /token rejected/);

    const right = await probeCollector(base, { token: 'secret' });
    assert.equal(right.ok, true, JSON.stringify(right.steps));
  });
});

test('an unreachable endpoint reports rather than throws, and stops early', async () => {
  // Port 1 is privileged and nothing listens there.
  const result = await probeCollector('http://127.0.0.1:1', { timeoutMs: 2000 });
  assert.equal(result.ok, false);
  assert.equal(result.steps.length, 1, 'no point trying to ingest into nothing');
  assert.match(result.steps[0].detail, /cannot reach/);
});

test('something else answering on the endpoint is not mistaken for a collector', async () => {
  const other = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>some other service</html>');
  });
  await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve));
  try {
    const result = await probeCollector(`http://127.0.0.1:${other.address().port}`, {});
    assert.equal(result.ok, false);
    assert.match(result.steps[0].detail, /not an athena-observe collector/);
  } finally {
    await new Promise((resolve) => other.close(resolve));
  }
});

test('a login gate in front of the collector is named, not mistaken for a bad endpoint', async () => {
  // An access gate (Vercel Deployment Protection, Cloudflare Access, a password
  // wall) redirects every request to its own host. The OTLP exporter follows
  // that redirect, posts spans to a sign-in page and drops the HTML answer
  // without a word, so this is exactly the silent failure the probe exists for.
  const gate = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>Sign in to continue</html>');
  });
  await new Promise((resolve) => gate.listen(0, '127.0.0.1', resolve));
  const gateHost = `127.0.0.1:${gate.address().port}`;

  const collector = http.createServer((req, res) => {
    res.writeHead(302, { location: `http://${gateHost}/sso` });
    res.end();
  });
  await new Promise((resolve) => collector.listen(0, '127.0.0.1', resolve));

  try {
    const result = await probeCollector(`http://127.0.0.1:${collector.address().port}`);
    assert.equal(result.ok, false);
    assert.match(result.steps[0].detail, /redirects to/);
    assert.match(result.steps[0].detail, /access gate/);
    // The walk stops there: nothing past this step can succeed or be diagnosed.
    assert.equal(result.steps.length, 1);
  } finally {
    await new Promise((resolve) => collector.close(resolve));
    await new Promise((resolve) => gate.close(resolve));
  }
});

test('one URL served by several processes is reported, not counted as healthy', async () => {
  // This is what a serverless platform does with an in-memory store: every
  // instance holds the telemetry that happened to be routed to it and knows
  // nothing of the rest, so a session shows up on one reload and is gone on the
  // next. Sequential requests tend to stick to a single instance, which is why
  // it looks fine until the requests overlap — the probe therefore fires its
  // health checks concurrently.
  let served = 0;
  const balanced = http.createServer((req, res) => {
    if (req.url.startsWith('/api/health')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, uptimeMs: 1, instance: `i${served++ % 3}` }));
      return;
    }
    res.writeHead(500).end();
  });
  await new Promise((resolve) => balanced.listen(0, '127.0.0.1', resolve));
  try {
    const result = await probeCollector(`http://127.0.0.1:${balanced.address().port}`, {});
    assert.equal(result.ok, false);
    const single = stepsByName(result).single;
    assert.equal(single.ok, false);
    assert.match(single.detail, /3 instances answer this URL/);
    assert.match(single.detail, /appear and vanish/);
  } finally {
    await new Promise((resolve) => balanced.close(resolve));
  }
});

test('a collector too old to identify itself is not accused of being several', async () => {
  const legacy = http.createServer((req, res) => {
    if (req.url.startsWith('/api/health')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, uptimeMs: 1 }));
      return;
    }
    res.writeHead(500).end();
  });
  await new Promise((resolve) => legacy.listen(0, '127.0.0.1', resolve));
  try {
    const result = await probeCollector(`http://127.0.0.1:${legacy.address().port}`, {});
    assert.equal(stepsByName(result).single, undefined, 'silence beats a wrong verdict');
  } finally {
    await new Promise((resolve) => legacy.close(resolve));
  }
});
