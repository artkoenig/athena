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
      ['reachable', 'ingest', 'stored'],
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
