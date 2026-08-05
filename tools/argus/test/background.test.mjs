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

/** The one measurement directory a start left in that project, absolute. */
function runDirOf(cwd) {
  const root = path.join(cwd, '.uroboros-telemetry');
  const runs = fs.existsSync(root) ? fs.readdirSync(root).filter((name) => name !== '.gitignore') : [];
  assert.equal(runs.length, 1, `expected exactly one measurement directory under ${root}, got ${runs.length}`);
  return path.join(root, runs[0]);
}

/** What a start left behind in that project, minus the .gitignore. */
function measurementsIn(cwd) {
  const root = path.join(cwd, '.uroboros-telemetry');
  return fs.existsSync(root) ? fs.readdirSync(root).filter((name) => name !== '.gitignore') : [];
}

/**
 * A real collector, reached through a front on `port` that passes everything
 * through untouched except `/api/config`, which the case decides. Identifying
 * the collector stays the real exchange — only the answer to "where do you
 * write?" is the variable, which is the whole subject of these cases and the
 * one thing no real collector can be made to get wrong on demand.
 */
async function frontedCollector({ cwd, session, port, config }) {
  const inner = await freePort();
  const started = await runBackground(cwd, ['--port', String(inner), '--exit-with', String(session.pid)]);
  const printed = started.out.match(/\bpid\b[^0-9]{0,12}(\d+)/i);
  assert.ok(printed, 'the banner has to name the process id');

  const held = new Set();
  const front = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://127.0.0.1');
    if (pathname === '/api/config') {
      config(req, res);
      return;
    }
    fetch(`http://127.0.0.1:${inner}${req.url}`)
      .then(async (upstream) => {
        const body = Buffer.from(await upstream.arrayBuffer());
        res.writeHead(upstream.status, {
          'content-type': upstream.headers.get('content-type') ?? 'application/json',
        });
        res.end(body);
      })
      .catch(() => {
        res.writeHead(502);
        res.end();
      });
  });
  front.on('connection', (socket) => held.add(socket));
  await new Promise((resolve) => front.listen(port, '127.0.0.1', resolve));

  return {
    inner,
    pid: Number(printed[1]),
    runDir: runDirOf(cwd),
    close: async () => {
      for (const socket of held) socket.destroy();
      await new Promise((resolve) => front.close(resolve));
    },
  };
}

/** Run a second start that is expected to attach, and give back its output. */
async function secondStart(cwd, args) {
  const result = await runBackground(cwd, args).then(
    (ok) => ok,
    (failure) => failure,
  );
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  assert.ok(
    !(result instanceof Error),
    `the port holds a collector, so a second start exits 0: exit ${result.code}, output: ${out.trim()}`,
  );
  return result.out;
}

// The sentence the defect prints over a collector that is recording. It is
// asserted against as an absence, not as a wording: a state that was never
// heard from must not be reported as a collector that answered.
const CLAIMS_NOTHING_KEPT = /keeps nothing on disk|nothing is kept on disk/i;

// What a JavaScript runtime error looks like once it has reached the caller as
// a message. A probe that falls over on what came back has not classified the
// port at all, so this is asserted as an absence in every case below — the
// wording of whatever the fix does say is deliberately not pinned.
const JS_RUNTIME_ERROR =
  /\b(?:TypeError|ReferenceError|RangeError|SyntaxError)\b|Cannot use '[a-z]+' operator|Cannot read (?:property|properties)|Cannot convert |is not a function|is not iterable|is not defined/i;

/**
 * Criterion 6 leaves a held port two outcomes and no third: attach — exit 0,
 * and say where the collector on it writes — or refuse — exit 1, and say so.
 * Which of the two an unusable answer deserves is the fix's to choose; this
 * only says that one of them has to be reached, with the port named, without a
 * crash, without the false claim that a recording collector keeps nothing, and
 * without a measurement of the second start's own.
 *
 * Complaints come back as a list rather than as a throw, so a caller checking a
 * family of bodies reports every one of them instead of the first.
 */
function allowedOutcomeProblems({ label, result, port, cwd, runDir }) {
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const failed = result instanceof Error;
  const code = failed ? (result.code ?? `signal ${result.signal}`) : 0;
  const problems = [];
  const note = (why) => problems.push(`${label}: ${why} — exit ${code}, output: ${out.trim()}`);

  if (JS_RUNTIME_ERROR.test(out)) {
    note('the probe fell over on the body instead of classifying the port, and a JavaScript runtime error is neither outcome');
  } else if (code === 0) {
    if (CLAIMS_NOTHING_KEPT.test(out)) {
      note(`the collector on that port is recording into ${runDir}, so a body that says nothing about persistence must not be reported as one that said nothing is kept`);
    }
  } else if (code !== 1) {
    note('the two outcomes are exit 0, having attached, and exit 1, having refused; this is neither');
  }
  if (!out.includes(String(port))) note('whichever way it goes, it has to say which port it is about');
  if (measurementsIn(cwd).length) note('a second start must not create a measurement of its own, whichever way it goes');
  return problems;
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

    const runs = fs.readdirSync(path.join(cwd, '.uroboros-telemetry')).filter((name) => name !== '.gitignore');
    assert.equal(runs.length, 1);
    const runDir = path.join(cwd, '.uroboros-telemetry', runs[0]);
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
    const runs = fs.readdirSync(path.join(first, '.uroboros-telemetry')).filter((name) => name !== '.gitignore');
    assert.equal(runs.length, 1);
    const runDir = path.join(first, '.uroboros-telemetry', runs[0]);

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
    const runs = fs.readdirSync(path.join(first, '.uroboros-telemetry')).filter((name) => name !== '.gitignore');
    assert.equal(runs.length, 1);
    const runDir = path.join(first, '.uroboros-telemetry', runs[0]);

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

test('a collector that frees its loop for one request and no more is still named with its directory', async () => {
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
  // The blip is spun, not slept. A timer that fires late widens the window, and
  // a wider window is exactly what lets the second request through — this case
  // would then pass on a tool that only ever asks once. A spin is exact to well
  // under a millisecond, and this process has nothing else to do while the
  // collector has its moment.
  const runFor = (pid, ms) => {
    signal(pid, 'SIGCONT');
    const until = Date.now() + ms;
    while (Date.now() < until) {
      /* hold this loop so the blip is the length it says it is */
    }
    signal(pid, 'SIGSTOP');
  };
  let collectorPid = 0;

  try {
    const started = await runBackground(first, ['--port', String(port), '--exit-with', String(session.pid)]);
    const runs = fs.readdirSync(path.join(first, '.uroboros-telemetry')).filter((name) => name !== '.gitignore');
    assert.equal(runs.length, 1);
    const runDir = path.join(first, '.uroboros-telemetry', runs[0]);

    const printed = started.out.match(/\bpid\b[^0-9]{0,12}(\d+)/i);
    assert.ok(printed, 'the banner has to name the process id');
    collectorPid = Number(printed[1]);

    // Same shape as the case above — a real collector whose loop is taken away
    // by SIGSTOP — but this time the loop comes back for one moment only.
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

    // 2000 ms: past any first probe of a sane length (the slowest health answer
    // ever measured here was 3051 ms, so a first attempt is at least a second
    // and starts within a few hundred ms of the spawn) and well short of a
    // second attempt's expiry. The point is only that the blip lands while the
    // start is waiting on an unanswered request, not on a particular attempt.
    await delay(2000);

    // 15 ms: enough for the collector to answer the request already sitting in
    // its socket, far too little for the round trip that would carry a *second*
    // request there and back. That is the whole case — a loop that frees up for
    // one request must not leave the start half-informed. 40 ms would admit both
    // and prove nothing.
    runFor(collectorPid, 15);

    // Blocked again for longer than any single request budget, so a second
    // request that is only ever asked once cannot succeed by waiting.
    await delay(4000);
    signal(collectorPid, 'SIGCONT');

    const result = await secondStart;
    const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    assert.ok(
      !(result instanceof Error),
      `the port holds a collector, so a second start exits 0: exit ${result.code}, output: ${out.trim()}`,
    );
    assert.ok(
      result.out.includes(runDir),
      `every step of finding out who holds the port has to be as patient as the first, or the answer is worse than silence — it names no directory while the first collector records into ${runDir}: ${result.out.trim()}`,
    );

    const telemetry = path.join(second, '.uroboros-telemetry');
    const left = fs.existsSync(telemetry)
      ? fs.readdirSync(telemetry).filter((name) => name !== '.gitignore')
      : [];
    assert.deepEqual(left, [], 'and no second measurement of its own');
    assert.ok(await collectorAnswers(port), 'the first collector is left running');
  } finally {
    if (collectorPid) signal(collectorPid, 'SIGCONT');
    session.kill('SIGKILL');
    if (collectorPid) signal(collectorPid, 'SIGKILL');
    await waitForSilence(port, 20_000);
    fs.rmSync(first, { recursive: true, force: true });
    fs.rmSync(second, { recursive: true, force: true });
  }
});

/* --------- what a second start says about where the first one writes ------ */

test('a second start without the running collector’s token must not report it as keeping nothing on disk', async () => {
  const first = projectDir();
  const second = projectDir();
  const port = await freePort();
  const session = sacrificialProcess();

  try {
    // The first collector persists, and guards its API with its own token.
    await runBackground(first, [
      '--port',
      String(port),
      '--token',
      'secretA',
      '--exit-with',
      String(session.pid),
    ]);
    const runDir = runDirOf(first);
    assert.ok(fs.existsSync(runDir), 'the first collector is recording into a directory on disk');

    // The second start carries a different token. /api/health is ungated, so the
    // collector is still correctly identified; /api/config answers 401, so where
    // it writes is refused, not denied.
    const out = await secondStart(second, [
      '--port',
      String(port),
      '--token',
      'secretB',
      '--exit-with',
      String(session.pid),
    ]);

    assert.doesNotMatch(
      out,
      CLAIMS_NOTHING_KEPT,
      `the collector is recording into ${runDir}; a refused question about it must not be reported as an answer: ${out.trim()}`,
    );
    assert.deepEqual(measurementsIn(second), [], 'and no second measurement of its own');
    assert.ok(await collectorAnswers(port), 'the first collector is left running');
  } finally {
    session.kill('SIGKILL');
    await waitForSilence(port, 20_000);
    fs.rmSync(first, { recursive: true, force: true });
    fs.rmSync(second, { recursive: true, force: true });
  }
});

test('a collector whose /api/config is not there must not be reported as keeping nothing on disk', async () => {
  const first = projectDir();
  const second = projectDir();
  const port = await freePort();
  const session = sacrificialProcess();
  // An older collector on the port has no such route: the question is answered,
  // and the answer says nothing about persistence either way.
  const held = await frontedCollector({
    cwd: first,
    session,
    port,
    config: (_req, res) => {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    },
  });

  try {
    assert.ok(fs.existsSync(held.runDir), 'the collector behind the front is recording into a directory');

    const out = await secondStart(second, ['--port', String(port), '--exit-with', String(session.pid)]);

    assert.doesNotMatch(
      out,
      CLAIMS_NOTHING_KEPT,
      `a route that is not there says nothing about persistence, and the collector is recording into ${held.runDir}: ${out.trim()}`,
    );
    assert.deepEqual(measurementsIn(second), [], 'and no second measurement of its own');
  } finally {
    await held.close();
    session.kill('SIGKILL');
    await waitForSilence(held.inner, 20_000);
    fs.rmSync(first, { recursive: true, force: true });
    fs.rmSync(second, { recursive: true, force: true });
  }
});

test('a collector whose /api/config never answers must not be reported as keeping nothing on disk', async () => {
  const first = projectDir();
  const second = projectDir();
  const port = await freePort();
  const session = sacrificialProcess();
  // Accepts the request and says nothing for as long as the probe is willing to
  // wait — silence, which is the one state that is never an answer.
  const held = await frontedCollector({
    cwd: first,
    session,
    port,
    config: () => {
      /* never answers */
    },
  });

  try {
    assert.ok(fs.existsSync(held.runDir), 'the collector behind the front is recording into a directory');

    // No wall-clock assertion: the probe is meant to spend its window on a
    // question that goes unanswered, and timing an execFile of node measures the
    // machine. runBackground's own timeout is the bound that stays — the command
    // has to come back to its caller by itself.
    const out = await secondStart(second, ['--port', String(port), '--exit-with', String(session.pid)]);

    assert.doesNotMatch(
      out,
      CLAIMS_NOTHING_KEPT,
      `nothing came back, so nothing was said about persistence, and the collector is recording into ${held.runDir}: ${out.trim()}`,
    );
    assert.deepEqual(measurementsIn(second), [], 'and no second measurement of its own');
  } finally {
    await held.close();
    session.kill('SIGKILL');
    await waitForSilence(held.inner, 20_000);
    fs.rmSync(first, { recursive: true, force: true });
    fs.rmSync(second, { recursive: true, force: true });
  }
});

test('the three things a second start can learn about persistence read as three different answers', async () => {
  const dirs = [projectDir(), projectDir(), projectDir(), projectDir(), projectDir(), projectDir()];
  const [firstNone, secondNone, firstRefused, secondRefused, firstKept, secondKept] = dirs;
  const ports = [await freePort(), await freePort(), await freePort()];
  const [portNone, portRefused, portKept] = ports;
  const session = sacrificialProcess();
  // The port is the only thing that differs between the three banners by
  // construction, so it is taken out before they are compared.
  const withoutPort = (out, port) => out.split(String(port)).join('<port>').trim();

  try {
    // a. It answered, and it genuinely keeps nothing.
    await runBackground(firstNone, [
      '--port',
      String(portNone),
      '--no-persist',
      '--exit-with',
      String(session.pid),
    ]);
    const said = withoutPort(
      await secondStart(secondNone, ['--port', String(portNone), '--exit-with', String(session.pid)]),
      portNone,
    );

    // b. It answered, and refused the question.
    await runBackground(firstRefused, [
      '--port',
      String(portRefused),
      '--token',
      'secretA',
      '--exit-with',
      String(session.pid),
    ]);
    const refusedDir = runDirOf(firstRefused);
    const refused = withoutPort(
      await secondStart(secondRefused, [
        '--port',
        String(portRefused),
        '--token',
        'secretB',
        '--exit-with',
        String(session.pid),
      ]),
      portRefused,
    );

    // c. It answered, and named the directory.
    await runBackground(firstKept, [
      '--port',
      String(portKept),
      '--token',
      'secretA',
      '--exit-with',
      String(session.pid),
    ]);
    const keptDir = runDirOf(firstKept);
    const kept = withoutPort(
      await secondStart(secondKept, [
        '--port',
        String(portKept),
        '--token',
        'secretA',
        '--exit-with',
        String(session.pid),
      ]),
      portKept,
    );

    assert.ok(
      kept.includes(keptDir),
      `a collector that named its directory has to be reported with it (${keptDir}): ${kept}`,
    );
    assert.notEqual(
      refused,
      said,
      `a collector that refused the question about ${refusedDir} is not a collector that said it keeps nothing — the two must not read the same`,
    );
    assert.notEqual(refused, kept, 'and a refusal is not a directory either');
    assert.notEqual(said, kept, 'and keeping nothing is not a directory either');

    for (const [cwd, port] of [
      [secondNone, portNone],
      [secondRefused, portRefused],
      [secondKept, portKept],
    ]) {
      assert.deepEqual(measurementsIn(cwd), [], 'no second start creates a measurement of its own');
      assert.ok(await collectorAnswers(port), 'and every first collector is left running');
    }
  } finally {
    session.kill('SIGKILL');
    for (const port of ports) await waitForSilence(port, 20_000);
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a collector whose /api/config answers a JSON string is classified, not crashed on', async () => {
  const first = projectDir();
  const second = projectDir();
  const port = await freePort();
  const session = sacrificialProcess();
  // 200, well-formed JSON, and not an object: the route answered, and what came
  // back carries no fields to look in. Nothing in the criteria makes an answer
  // of this shape anything but an answer that says nothing about persistence.
  const held = await frontedCollector({
    cwd: first,
    session,
    port,
    config: (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify('nope'));
    },
  });

  try {
    assert.ok(fs.existsSync(held.runDir), 'the collector behind the front is recording into a directory');

    const result = await runBackground(second, [
      '--port',
      String(port),
      '--exit-with',
      String(session.pid),
    ]).then(
      (ok) => ok,
      (failure) => failure,
    );

    assert.deepEqual(
      allowedOutcomeProblems({
        label: 'a body of "nope"',
        result,
        port,
        cwd: second,
        runDir: held.runDir,
      }),
      [],
      'a 200 whose body is a string is still an answer, and criterion 6 has an outcome for it',
    );
    assert.ok(await collectorAnswers(held.inner), 'and the collector it asked is left running');
  } finally {
    await held.close();
    session.kill('SIGKILL');
    await waitForSilence(held.inner, 20_000);
    fs.rmSync(first, { recursive: true, force: true });
    fs.rmSync(second, { recursive: true, force: true });
  }
});

test('every JSON body that is not an object is classified the same way, over and over on the same port', async () => {
  const first = projectDir();
  const port = await freePort();
  const session = sacrificialProcess();
  // The whole family a scalar body belongs to, empty members included: what a
  // JSON document can be when it is not an object. The truthy ones and the
  // falsy ones are both here because a body is looked at, not weighed — and
  // `null` is here twice over, since it is the one non-object that a type test
  // most easily mistakes for an object.
  const shapes = [
    { label: 'a string body', json: '"nope"' },
    { label: 'an empty string body', json: '""' },
    { label: 'a number body', json: '42' },
    { label: 'the number zero', json: '0' },
    { label: 'a boolean body', json: 'true' },
    { label: 'a null body', json: 'null' },
    { label: 'an empty array body', json: '[]' },
    { label: 'an array of objects', json: '[{"persist":"/somewhere"}]' },
  ];

  // One front, one held port, one body at a time: the second start is run once
  // per shape against the same collector, which also puts the repeat under
  // test — probing a held port eight times must leave it exactly as it was.
  let body = 'null';
  const held = await frontedCollector({
    cwd: first,
    session,
    port,
    config: (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
    },
  });
  const seconds = [];

  try {
    assert.ok(fs.existsSync(held.runDir), 'the collector behind the front is recording into a directory');

    const problems = [];
    for (const shape of shapes) {
      body = shape.json;
      const cwd = projectDir();
      seconds.push(cwd);
      const result = await runBackground(cwd, [
        '--port',
        String(port),
        '--exit-with',
        String(session.pid),
      ]).then(
        (ok) => ok,
        (failure) => failure,
      );
      problems.push(...allowedOutcomeProblems({ label: shape.label, result, port, cwd, runDir: held.runDir }));
      if (!(await collectorAnswers(held.inner))) {
        problems.push(`${shape.label}: the collector that already held the port has to be left running`);
      }
    }

    assert.deepEqual(
      problems,
      [],
      `a second start has to reach one of criterion 6's two outcomes for every one of these:\n  ${problems.join('\n  ')}`,
    );
    assert.equal(
      fs.readdirSync(path.join(first, '.uroboros-telemetry')).filter((name) => name !== '.gitignore').length,
      1,
      'and eight probes of a held port leave the collector on it with the one measurement it started with',
    );
  } finally {
    await held.close();
    session.kill('SIGKILL');
    await waitForSilence(held.inner, 20_000);
    for (const dir of [first, ...seconds]) fs.rmSync(dir, { recursive: true, force: true });
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
    const telemetry = path.join(cwd, '.uroboros-telemetry');
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
