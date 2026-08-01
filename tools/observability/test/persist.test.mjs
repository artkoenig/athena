import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TelemetryStore } from '../src/store.mjs';
import { JsonlPersistence } from '../src/persist.mjs';

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'athena-obs-'));

const logRecord = (sessionId, tokens) => ({
  eventName: 'claude_code.api_request',
  severity: 'INFO',
  timeMs: Date.now(),
  observedMs: Date.now(),
  body: null,
  traceId: '',
  spanId: '',
  resource: { 'service.name': 'agent' },
  attrs: { 'session.id': sessionId, model: 'claude-opus-5', input_tokens: tokens },
});

/** Wait for the append stream to reach disk. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

test('records survive a restart', async () => {
  const dir = tmpdir();
  const first = new TelemetryStore();
  const writer = new JsonlPersistence(dir);
  writer.attach(first);
  first.ingest('logs', [logRecord('s1', 100), logRecord('s1', 50)]);
  await settle();
  writer.close();

  const second = new TelemetryStore();
  const reader = new JsonlPersistence(dir);
  const restored = await reader.load(second);
  reader.close();

  assert.equal(restored, 2);
  assert.equal(second.getSession('s1').tokens.input, 150);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('replayed records are not written back to disk', async () => {
  const dir = tmpdir();
  const store = new TelemetryStore();
  const persistence = new JsonlPersistence(dir);
  persistence.attach(store);
  store.ingest('logs', [logRecord('s1', 10)], { replay: true });
  await settle();
  persistence.close();
  assert.equal(fs.existsSync(path.join(dir, 'logs.jsonl')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a torn trailing line is skipped instead of failing the load', async () => {
  const dir = tmpdir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'logs.jsonl'),
    `${JSON.stringify(logRecord('s1', 7))}\n{"eventName":"claude_code.api_re`,
  );
  const store = new TelemetryStore();
  const persistence = new JsonlPersistence(dir);
  assert.equal(await persistence.load(store), 1);
  persistence.close();
  assert.equal(store.getSession('s1').tokens.input, 7);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('files rotate once past the size cap', async () => {
  const dir = tmpdir();
  const store = new TelemetryStore();
  const persistence = new JsonlPersistence(dir, { maxBytes: 400 });
  persistence.attach(store);
  for (let i = 0; i < 20; i++) store.ingest('logs', [logRecord('s1', i)]);
  await settle();
  persistence.close();
  assert.ok(fs.existsSync(path.join(dir, 'logs.1.jsonl')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('session names survive a restart, records or not', async () => {
  const dir = tmpdir();
  const first = new TelemetryStore();
  const writer = new JsonlPersistence(dir);
  await writer.load(first);
  writer.attach(first);
  first.setSessionName('s-name', 'athena · main');
  first.ingest('logs', [logRecord('s-other', 10)]);
  await settle();
  writer.close();

  const second = new TelemetryStore();
  const reader = new JsonlPersistence(dir);
  const restored = await reader.load(second);
  reader.close();
  // Names are not records: they restore the label without inflating the count.
  assert.equal(restored, 1);
  assert.equal(second.getSession('s-name').name, 'athena · main');
  assert.equal(second.getSession('s-name').counts.logs, 0);
  assert.equal(second.getSession('s-other').name, null);
});

test('the last name written for a session wins on replay', async () => {
  const dir = tmpdir();
  const first = new TelemetryStore();
  const writer = new JsonlPersistence(dir);
  await writer.load(first);
  writer.attach(first);
  first.setSessionName('s-renamed', 'first try');
  first.setSessionName('s-renamed', 'second try');
  await settle();
  writer.close();

  const second = new TelemetryStore();
  const reader = new JsonlPersistence(dir);
  await reader.load(second);
  reader.close();
  assert.equal(second.getSession('s-renamed').name, 'second try');
});
