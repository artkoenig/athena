import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { TelemetryStore } from '../src/store.mjs';
import { JsonlPersistence } from '../src/persist.mjs';

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'uroboros-obs-'));

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

test("a run's state survives a restart", async () => {
  const dir = tmpdir();
  const first = new TelemetryStore();
  const writer = new JsonlPersistence(dir);
  writer.attach(first);
  const state = backlogState();
  first.putRunState('run-a', state);
  const writtenAtMs = first.getRun('run-a').updatedAtMs;
  await settle();
  writer.close();

  const second = new TelemetryStore();
  const reader = new JsonlPersistence(dir);
  const restored = await reader.load(second);
  reader.close();

  assert.ok(restored >= 1, 'load must count the run line');
  const run = second.getRun('run-a');
  assert.deepEqual(run.state, state);
  assert.equal(run.updatedAtMs, writtenAtMs, 'the restored timestamp is the one written, not a fresh clock reading');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('two writes of one run replay as one run holding the latest state', async () => {
  const dir = tmpdir();
  const store = new TelemetryStore();
  const writer = new JsonlPersistence(dir);
  writer.attach(store);
  store.putRunState('run-a', backlogState({ issue: 'docs/issues/2026-08-08-a' }));
  const second = backlogState({ issue: 'docs/issues/2026-08-08-b' });
  store.putRunState('run-a', second);
  await settle();
  writer.close();

  const restored = new TelemetryStore();
  const reader = new JsonlPersistence(dir);
  await reader.load(restored);
  reader.close();

  assert.equal(restored.listRuns().total, 1);
  assert.deepEqual(restored.getRun('run-a').state, second);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a replayed run state is not written back to disk', async () => {
  const dir = tmpdir();
  const store = new TelemetryStore();
  const persistence = new JsonlPersistence(dir);
  persistence.attach(store);
  store.putRunState('run-a', backlogState(), { replay: true });
  await settle();
  persistence.close();
  assert.equal(fs.existsSync(path.join(dir, 'runs.jsonl')), false);
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

/* ------------------------------------------------------------------------ *
 * What a start actually writes into the project it is measuring. These run
 * the entry point in a scratch working directory, because the criteria are
 * about that directory's contents, not about a class.
 * ------------------------------------------------------------------------ */

const BIN = fileURLToPath(new URL('../bin/argus.mjs', import.meta.url));
const execFileP = promisify(execFile);

/** A scratch stand-in for the project being measured, symlinks resolved. */
const projectDir = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'argus-project-')));

/** Ask the OS for a port nobody holds; a fixed one fails against whatever runs. */
async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function startCollector({ cwd, args = [] }) {
  const port = await freePort();
  const proc = spawn(process.execPath, [BIN, 'start', '--port', String(port), ...args], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  proc.stdout.on('data', (chunk) => (output += chunk));
  proc.stderr.on('data', (chunk) => (output += chunk));

  const base = `http://127.0.0.1:${port}`;
  const stop = async () => {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGTERM');
    if (proc.exitCode === null && proc.signalCode === null) {
      await new Promise((resolve) => proc.once('exit', resolve));
    }
  };

  const deadline = Date.now() + 20_000;
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`the collector exited (${proc.exitCode}): ${output}`);
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`the collector never listened: ${output}`);
    }
    await delay(50);
  }
  return { base, port, proc, stop, output: () => output };
}

const getJson = async (url) => {
  const response = await fetch(url);
  assert.equal(response.status, 200, `${url} answered ${response.status}`);
  return response.json();
};

/** The run directory a collector reports, which is how anything else finds it. */
async function runDirOf(base) {
  const config = await getJson(`${base}/api/config`);
  assert.equal(typeof config.persist, 'string', '/api/config must name the run directory it is writing to');
  return config.persist;
}

/** Name, size and mtime of everything under a directory — enough to see a write. */
function snapshot(dir) {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .map((entry) => {
      const full = path.join(entry.parentPath ?? entry.path, entry.name);
      const stat = fs.statSync(full);
      return `${path.relative(dir, full)} ${stat.isDirectory() ? 'dir' : stat.size} ${stat.mtimeMs}`;
    })
    .sort();
}

const pad = (n) => String(n).padStart(2, '0');
const stampOf = (date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T` +
  `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
/** Every name a start in the next few seconds could pick. */
const stampsAhead = () => [0, 1000, 2000, 3000, 4000].map((offset) => stampOf(new Date(Date.now() + offset)));

test('persistence is on by default, one timestamped directory per measurement', async () => {
  const cwd = projectDir();
  const collector = await startCollector({ cwd });
  try {
    const runDir = await runDirOf(collector.base);
    assert.ok(path.isAbsolute(runDir), 'the run directory is reported absolute');
    assert.equal(path.dirname(runDir), path.join(cwd, '.uroboros-telemetry'));
    assert.match(path.basename(runDir), /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/);
    assert.ok(fs.existsSync(runDir), 'and it exists by the time the collector is listening');
  } finally {
    await collector.stop();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('two starts in the same project get two distinct directories', async () => {
  const cwd = projectDir();
  const first = await startCollector({ cwd });
  const second = await startCollector({ cwd });
  try {
    const a = await runDirOf(first.base);
    const b = await runDirOf(second.base);
    assert.notEqual(a, b, 'two measurements must not land in one directory');
    assert.ok(fs.existsSync(a));
    assert.ok(fs.existsSync(b));
  } finally {
    await first.stop();
    await second.stop();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('a name already taken is suffixed -2, then -3', async () => {
  const cwd = projectDir();
  const root = path.join(cwd, '.uroboros-telemetry');
  fs.mkdirSync(root, { recursive: true });
  // Take every name the next few seconds could produce, so the collision is
  // certain however the clock falls while the process starts.
  const taken = stampsAhead();
  for (const name of taken) fs.mkdirSync(path.join(root, name), { recursive: true });

  const first = await startCollector({ cwd });
  try {
    const chosen = path.basename(await runDirOf(first.base));
    assert.match(chosen, /-2$/, 'a taken name is suffixed, never shared');
    assert.ok(taken.includes(chosen.replace(/-2$/, '')), `unexpected name: ${chosen}`);
  } finally {
    await first.stop();
  }

  for (const name of taken) fs.mkdirSync(path.join(root, `${name}-2`), { recursive: true });
  const second = await startCollector({ cwd });
  try {
    const chosen = path.basename(await runDirOf(second.base));
    assert.match(chosen, /-3$/, 'and the suffix keeps counting');
  } finally {
    await second.stop();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('the measured project gets a self-ignoring directory and nothing else', async () => {
  const cwd = projectDir();
  fs.writeFileSync(path.join(cwd, 'keep.txt'), 'untouched');
  const before = fs.statSync(path.join(cwd, 'keep.txt'));

  const collector = await startCollector({ cwd });
  await collector.stop();

  try {
    assert.deepEqual(
      fs.readdirSync(cwd).sort(),
      ['.uroboros-telemetry', 'keep.txt'],
      'nothing outside the measurement directory may appear',
    );
    assert.equal(fs.readFileSync(path.join(cwd, 'keep.txt'), 'utf8'), 'untouched');
    assert.equal(fs.statSync(path.join(cwd, 'keep.txt')).mtimeMs, before.mtimeMs);

    // Self-ignoring, so measuring a project never shows up in its git status —
    // and no `git` subprocess had to run to arrange that.
    const ignore = path.join(cwd, '.uroboros-telemetry', '.gitignore');
    assert.ok(fs.existsSync(ignore), '.uroboros-telemetry/.gitignore is written with the root');
    assert.equal(fs.readFileSync(ignore, 'utf8').trim(), '*');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('--no-persist writes nothing at all', async () => {
  const cwd = projectDir();
  const collector = await startCollector({ cwd, args: ['--no-persist'] });
  try {
    assert.equal((await getJson(`${collector.base}/api/config`)).persist, null);
  } finally {
    await collector.stop();
  }
  assert.deepEqual(fs.readdirSync(cwd), [], 'the measured project is left exactly as it was');
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('--persist <dir> means exactly that directory, and never replays it', async () => {
  const cwd = projectDir();
  const dir = path.join(cwd, 'store');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'logs.jsonl'), `${JSON.stringify(logRecord('s-already-there', 42))}\n`);

  const collector = await startCollector({ cwd, args: ['--persist', dir] });
  try {
    const sessions = await getJson(`${collector.base}/api/sessions`);
    assert.equal(sessions.total, 0, '--persist only ever writes — replaying is what --open is for');
    assert.equal(await runDirOf(collector.base), dir, 'no timestamp nesting under an explicit directory');
  } finally {
    await collector.stop();
  }

  const nested = fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  assert.deepEqual(nested.map((entry) => entry.name), [], 'nothing is nested inside it');
  assert.equal(fs.existsSync(path.join(cwd, '.uroboros-telemetry')), false);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('--open <dir> replays it however old it is, and writes nothing into it', async () => {
  const cwd = projectDir();
  const dir = path.join(cwd, 'measurement');
  fs.mkdirSync(dir);
  // Three days old: past the 24h default retention, which is what evicts a
  // reopened measurement during replay unless retention is turned off.
  const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
  const archived = { ...logRecord('s-archived', 1234), timeMs: threeDaysAgo, observedMs: threeDaysAgo };
  fs.writeFileSync(path.join(dir, 'logs.jsonl'), `${JSON.stringify(archived)}\n`);
  const before = snapshot(dir);

  const collector = await startCollector({ cwd, args: ['--open', dir] });
  try {
    const sessions = await getJson(`${collector.base}/api/sessions`);
    assert.equal(sessions.total, 1, 'an old measurement has to survive its own replay');
    assert.equal(sessions.items[0].id, 's-archived');
    assert.equal(sessions.items[0].tokens.input, 1234);
  } finally {
    await collector.stop();
  }

  assert.deepEqual(snapshot(dir), before, '--open must not write into what it opens');
  assert.equal(fs.existsSync(path.join(cwd, '.uroboros-telemetry')), false, '--open opens nothing for writing');
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('a run state written into a measurement is served again by a collector opened on it', async () => {
  const cwd = projectDir();
  const dir = path.join(cwd, 'store');
  const state = backlogState();

  const first = await startCollector({ cwd, args: ['--persist', dir] });
  let posted;
  try {
    const response = await fetch(`${first.base}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'run-a', state }),
    });
    assert.equal(response.status, 200);
    posted = await response.json();
  } finally {
    await first.stop();
  }

  const second = await startCollector({ cwd, args: ['--open', dir] });
  try {
    const list = await getJson(`${second.base}/api/runs`);
    assert.equal(list.total, 1);
    const run = await getJson(`${second.base}/api/runs/${posted.id}`);
    assert.deepEqual(run.state, state);
  } finally {
    await second.stop();
  }
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('--open on a directory that is not there is an error, not an empty collector', async () => {
  // The worst outcome available: a typo would look exactly like a measurement
  // that recorded nothing, and the person asked for one by name.
  const cwd = projectDir();
  const missing = path.join(cwd, 'no-such-measurement');
  const port = await freePort();

  const started = Date.now();
  const error = await execFileP(process.execPath, [BIN, 'start', '--port', String(port), '--open', missing], {
    cwd,
    timeout: 8000,
    encoding: 'utf8',
  }).then(
    () => null,
    (failure) => failure,
  );

  assert.ok(error, 'a measurement that is not there has to be said out loud');
  assert.ok(Date.now() - started < 5000, 'it refuses up front rather than listening on an empty store');
  assert.notEqual(error.code, 0);
  const said = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  assert.ok(said.includes(missing), `the message has to name the path it could not find (${missing})`);
  assert.equal(fs.existsSync(missing), false, 'and it must not create what it was asked to read');

  fs.rmSync(cwd, { recursive: true, force: true });
});
