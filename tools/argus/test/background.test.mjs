import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { exitWhenGone, spawnBackground } from '../src/background.mjs';

const BIN = fileURLToPath(new URL('../bin/argus.mjs', import.meta.url));
const execFileP = promisify(execFile);

const projectDir = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'argus-project-')));

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** A process that does nothing but exist, standing in for the session. */
function sacrificialProcess() {
  return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function collectorAnswers(port) {
  try {
    return (await fetch(`http://127.0.0.1:${port}/api/health`)).ok;
  } catch {
    return false;
  }
}

async function waitForSilence(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await collectorAnswers(port))) return true;
    await delay(200);
  }
  return false;
}

/** Run `argus start --background`; it has to come back on its own. */
async function runBackground(cwd, args) {
  const result = await execFileP(process.execPath, [BIN, 'start', '--background', ...args], {
    cwd,
    timeout: 25_000,
    encoding: 'utf8',
  }).catch((error) => {
    assert.notEqual(error.killed, true, `start --background never returned to its caller: ${error.stderr ?? ''}`);
    throw error;
  });
  return { ...result, out: `${result.stdout}${result.stderr}` };
}

/* ----------------------------- the mechanism ---------------------------- */

test('spawnBackground returns what the child announced on its readiness descriptor', async () => {
  const dir = projectDir();
  const script = path.join(dir, 'child.mjs');
  fs.writeFileSync(
    script,
    [
      "import fs from 'node:fs';",
      // One JSON line, then the descriptor is closed: an open pipe would hold
      // the shell that started all this.
      "fs.writeSync(3, JSON.stringify({ ready: true, pid: process.pid, port: 4318 }) + '\\n');",
      'fs.closeSync(3);',
      'setTimeout(() => {}, 30000);',
    ].join('\n'),
  );

  const announced = await spawnBackground({ argv: [script], readyTimeoutMs: 15_000 });
  assert.equal(announced.ready, true);
  assert.equal(announced.port, 4318);
  assert.equal(typeof announced.pid, 'number');
  assert.ok(alive(announced.pid), 'the child keeps running after the parent has its answer');

  process.kill(announced.pid, 'SIGKILL');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a child that dies without announcing is reported, not waited for', async () => {
  const dir = projectDir();
  const script = path.join(dir, 'child.mjs');
  fs.writeFileSync(script, 'process.exit(7);\n');

  await assert.rejects(
    () => spawnBackground({ argv: [script], readyTimeoutMs: 15_000 }),
    (error) => error instanceof Error && error.message.length > 0,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a child that never announces gives up at readyTimeoutMs', async () => {
  const dir = projectDir();
  const script = path.join(dir, 'child.mjs');
  fs.writeFileSync(script, 'setTimeout(() => {}, 4000);\n');

  const started = Date.now();
  await assert.rejects(() => spawnBackground({ argv: [script], readyTimeoutMs: 300 }));
  assert.ok(Date.now() - started < 3000, 'the caller is released by the timeout, not by the child');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('exitWhenGone fires once, and only once its process is gone', async () => {
  const watched = sacrificialProcess();
  let gone = 0;
  const handle = exitWhenGone(watched.pid, () => gone++, { intervalMs: 20 });

  await delay(200);
  assert.equal(gone, 0, 'a living process must not look gone');

  watched.kill('SIGKILL');
  await once(watched, 'exit');
  await delay(300);
  assert.equal(gone, 1, 'the shutdown is run once, not on every tick');

  if (typeof handle === 'function') handle();
  else if (handle && typeof handle.unref === 'function') clearInterval(handle);
});

/* ------------------------- what a start does with it -------------------- */

test('start --background returns to its caller and prints the endpoint, the token, the directory and the pid', async () => {
  const cwd = projectDir();
  const port = await freePort();
  const session = sacrificialProcess();

  try {
    const { out } = await runBackground(cwd, [
      '--port',
      String(port),
      '--token',
      'banner-secret',
      '--exit-with',
      String(session.pid),
    ]);

    assert.ok(await collectorAnswers(port), 'the collector keeps listening after the caller is back');
    assert.match(out, new RegExp(`http://127\\.0\\.0\\.1:${port}`), 'the endpoint');
    assert.match(out, /banner-secret/, 'the token');

    const runs = fs.readdirSync(path.join(cwd, '.athena-telemetry')).filter((name) => name !== '.gitignore');
    assert.equal(runs.length, 1);
    const runDir = path.join(cwd, '.athena-telemetry', runs[0]);
    assert.ok(out.includes(runDir), `the absolute measurement directory (${runDir}) is not in the banner`);

    const printed = out.match(/\bpid\b[^0-9]{0,12}(\d+)/i);
    assert.ok(printed, 'the banner has to name the process id');
    const pid = Number(printed[1]);
    assert.ok(alive(pid), 'the printed process id is running');

    // Killing what it printed stops the collector — which is what makes the
    // number useful rather than decorative.
    process.kill(pid, 'SIGTERM');
    assert.ok(await waitForSilence(port, 10_000), 'the printed pid is the collector');
  } finally {
    session.kill('SIGKILL');
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('the collector shuts itself down when the process it was started from disappears', async () => {
  const cwd = projectDir();
  const port = await freePort();
  const session = sacrificialProcess();

  try {
    await runBackground(cwd, ['--port', String(port), '--exit-with', String(session.pid)]);
    assert.ok(await collectorAnswers(port));

    session.kill('SIGKILL');
    await once(session, 'exit');

    assert.ok(
      await waitForSilence(port, 20_000),
      'nothing else ends it: no pidfile, no stop command, no registry',
    );
  } finally {
    if (alive(session.pid)) session.kill('SIGKILL');
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('a second start on a live collector names its directory instead of starting another', async () => {
  const first = projectDir();
  const second = projectDir();
  const port = await freePort();
  const session = sacrificialProcess();

  try {
    await runBackground(first, ['--port', String(port), '--exit-with', String(session.pid)]);
    const runs = fs.readdirSync(path.join(first, '.athena-telemetry')).filter((name) => name !== '.gitignore');
    assert.equal(runs.length, 1);
    const runDir = path.join(first, '.athena-telemetry', runs[0]);

    const { out } = await runBackground(second, ['--port', String(port), '--exit-with', String(session.pid)]);
    assert.ok(
      out.includes(runDir),
      `a second start has to name where the collector already on that port is writing (${runDir})`,
    );
    assert.ok(await collectorAnswers(port), 'and leave it running');
  } finally {
    session.kill('SIGKILL');
    await waitForSilence(port, 20_000);
    fs.rmSync(first, { recursive: true, force: true });
    fs.rmSync(second, { recursive: true, force: true });
  }
});

test('a collector whose event loop is blocked past one probe is still a collector', async () => {
  const first = projectDir();
  const second = projectDir();
  const port = await freePort();
  const session = sacrificialProcess();
  // Signalling a process that has already gone is not a failure of this case.
  const signal = (pid, sig) => {
    try {
      process.kill(pid, sig);
    } catch {
      /* already gone */
    }
  };
  let collectorPid = 0;

  try {
    const started = await runBackground(first, ['--port', String(port), '--exit-with', String(session.pid)]);
    const runs = fs.readdirSync(path.join(first, '.athena-telemetry')).filter((name) => name !== '.gitignore');
    assert.equal(runs.length, 1);
    const runDir = path.join(first, '.athena-telemetry', runs[0]);

    const printed = started.out.match(/\bpid\b[^0-9]{0,12}(\d+)/i);
    assert.ok(printed, 'the banner has to name the process id');
    collectorPid = Number(printed[1]);

    // A collector that is busy decoding an export answers nothing while it
    // works, but the kernel keeps accepting connections on its listening
    // socket: the port is held, and one probe in that window goes unanswered.
    // SIGSTOP produces exactly that shape on the real collector, deterministically
    // and without pushing megabytes through it. A stub server would have to
    // reproduce whatever exchange tells a second start where the first one
    // writes — an exchange no criterion names — so the real thing is used.
    signal(collectorPid, 'SIGSTOP');
    const secondStart = runBackground(second, [
      '--port',
      String(port),
      '--exit-with',
      String(session.pid),
    ]).then(
      (ok) => ok,
      (failure) => failure,
    );

    // 3500 ms: longer than the 3051 ms slowest health answer measured under
    // real ingest load, so no single attempt of a sane length outlives this
    // block — and far inside any total window generous enough to tolerate that
    // same 3051 ms plus retries. A slow machine only shortens the part of the
    // block the second start actually sees, so load cannot turn this red.
    await delay(3500);
    signal(collectorPid, 'SIGCONT');

    const result = await secondStart;
    const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    assert.ok(
      !(result instanceof Error),
      `one unanswered probe must not decide: exit ${result.code}, output: ${out.trim()}`,
    );
    assert.ok(
      result.out.includes(runDir),
      `a busy collector is still a collector, so its directory (${runDir}) has to be named: ${result.out.trim()}`,
    );
    assert.ok(await collectorAnswers(port), 'and it was answering all along, once its loop was free');
  } finally {
    if (collectorPid) signal(collectorPid, 'SIGCONT');
    session.kill('SIGKILL');
    if (collectorPid) signal(collectorPid, 'SIGKILL');
    await waitForSilence(port, 20_000);
    fs.rmSync(first, { recursive: true, force: true });
    fs.rmSync(second, { recursive: true, force: true });
  }
});

test('a port held by something that is not a collector is an error, not an attach', async () => {
  const cwd = projectDir();
  const port = await freePort();
  const squatter = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('this is not a collector');
  });
  await new Promise((resolve) => squatter.listen(port, '127.0.0.1', resolve));

  try {
    const error = await runBackground(cwd, ['--port', String(port)]).then(
      () => null,
      (failure) => failure,
    );
    assert.ok(error, 'attaching to a stranger would silently measure nothing');
    assert.equal(error.code, 1);
    assert.match(`${error.stdout ?? ''}${error.stderr ?? ''}`, new RegExp(String(port)), 'it has to say which port');
  } finally {
    await new Promise((resolve) => squatter.close(resolve));
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('a port held by a listener that never answers is the same error, and leaves no run directory', async () => {
  const cwd = projectDir();
  const port = await freePort();
  // Accepts the connection and then says nothing at all — the case an HTTP
  // squatter cannot produce, because it always answers.
  const accepted = new Set();
  const mute = net.createServer((socket) => accepted.add(socket));
  await new Promise((resolve) => mute.listen(port, '127.0.0.1', resolve));

  try {
    const error = await runBackground(cwd, ['--port', String(port)]).then(
      () => null,
      (failure) => failure,
    );

    assert.ok(error, 'a listener that never answers is not a free port');
    assert.notEqual(error.code, 0);

    // The caller has to read the diagnosis from the command it ran, not from a
    // file the command left somewhere.
    const out = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    assert.match(out, new RegExp(String(port)), 'it has to say which port');
    assert.match(out, /not a collector/i, `it has to say what is wrong, got: ${out.trim()}`);

    // No wall-clock bound here on purpose. Telling a silent listener apart from
    // a busy collector costs time by construction — the port is only a stranger
    // once the whole retry window has expired — so this path is meant to be
    // slow. Timing it would also time an `execFile` of node: spawn, module load,
    // connect and exit, which is a measurement of the machine and goes red under
    // load with nothing changed. The one deadline that stays is `runBackground`'s
    // own: the command has to come back to its caller by itself, not be killed.
    const telemetry = path.join(cwd, '.athena-telemetry');
    const left = fs.existsSync(telemetry)
      ? fs.readdirSync(telemetry).filter((name) => name !== '.gitignore')
      : [];
    assert.deepEqual(left, [], 'a start that never started must leave no measurement directory behind');
  } finally {
    for (const socket of accepted) socket.destroy();
    await new Promise((resolve) => mute.close(resolve));
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
