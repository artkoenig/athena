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

const FIXTURE = fileURLToPath(new URL('../scripts/with-collector.mjs', import.meta.url));
const execFileP = promisify(execFile);

const projectDir = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'argus-project-')));

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function collectorAnswers(port) {
  try {
    return (await fetch(`http://127.0.0.1:${port}/api/health`)).ok;
  } catch {
    return false;
  }
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * The collector gives the port back before it exits: argus.mjs closes the
 * listening socket first and only exits from the close callback, with a 2 s
 * unref'd fallback. A pid asserted the moment a connect is refused is
 * therefore legitimately still alive. Polls until it is gone (true) or the
 * deadline passes (false) — it returns as soon as the pid goes, so this is a
 * bound and never a measured duration.
 */
async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!alive(pid)) return true;
    if (Date.now() >= deadline) return false;
    await delay(100);
  }
}

/**
 * A silent /api/health is weaker evidence than a refused connection — the
 * criterion is about the port being held, not about the collector answering.
 * Polls a raw connect on 127.0.0.1:port until it is refused (true) or the
 * deadline passes (false).
 */
async function nothingAccepts(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const refused = await new Promise((resolve) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        resolve(false);
      });
      socket.once('error', () => resolve(true));
    });
    if (refused) return true;
    await delay(200);
  }
  return false;
}

/**
 * Runs the fixture the way `runBackground` and `secondStart` run `argus.mjs`
 * in background.test.mjs: a non-zero exit is expected in several of these
 * cases, so the rejection is folded into the result instead of thrown.
 * `result.code` is always the process's own exit code (0 on success), and
 * `result.out` is stdout and stderr concatenated.
 */
async function runFixture(cwd, args) {
  const settled = await execFileP(process.execPath, [FIXTURE, ...args], {
    cwd,
    timeout: 60_000,
    encoding: 'utf8',
  }).then(
    (ok) => ok,
    (failure) => failure,
  );
  const code = settled instanceof Error ? settled.code : 0;
  const out = `${settled.stdout ?? ''}${settled.stderr ?? ''}`;
  return { code, out, raw: settled };
}

test('a command run through the fixture reaches a live collector and leaves no measurement behind', async () => {
  const cwd = projectDir();
  const script = path.join(cwd, 'child.mjs');
  fs.writeFileSync(
    script,
    [
      "import fs from 'node:fs';",
      'const res = await fetch(`${process.env.ARGUS_URL}/api/health`);',
      "fs.writeFileSync('out.json', await res.text());",
      'process.stdout.write(process.env.ARGUS_PORT);',
    ].join('\n'),
  );

  try {
    const result = await runFixture(cwd, ['--', process.execPath, script]);
    assert.equal(result.code, 0, `a command run through the fixture has to come back 0: ${result.out}`);

    const body = JSON.parse(fs.readFileSync(path.join(cwd, 'out.json'), 'utf8'));
    assert.equal(body.ok, true, `the command has to reach a live collector through ARGUS_URL: ${JSON.stringify(body)}`);

    const banner = (result.raw.stderr ?? '').match(/127\.0\.0\.1:(\d+)/);
    assert.ok(banner, `the banner has to name the collector's address: ${result.raw.stderr}`);
    assert.equal(
      (result.raw.stdout ?? '').trim(),
      banner[1],
      'the command\'s stdout has to be exactly the port it was handed, with the fixture\'s banner kept on stderr',
    );

    assert.ok(
      !fs.existsSync(path.join(cwd, '.uroboros-telemetry')),
      'an ad-hoc run through the fixture must leave no measurement directory behind',
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('the port is free and the collector gone once the fixture has returned', async () => {
  const port = await freePort();
  const cwd = projectDir();
  const script = path.join(cwd, 'child.mjs');
  fs.writeFileSync(script, 'await fetch(`${process.env.ARGUS_URL}/api/health`);\n');

  try {
    const result = await runFixture(cwd, ['--port', String(port), '--', process.execPath, script]);
    assert.equal(result.code, 0, `a command that succeeds against a live collector has to leave the fixture at 0: ${result.out}`);

    const printed = result.out.match(/\bpid\b[^0-9]{0,12}(\d+)/i);
    assert.ok(printed, `the banner has to name the collector's pid: ${result.out}`);
    const pid = Number(printed[1]);

    assert.ok(
      await waitForExit(pid, 10_000),
      'the collector process the banner named has to be gone once the fixture returns',
    );

    assert.ok(
      await nothingAccepts(port, 10_000),
      'the port must not still be held once the fixture has returned',
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('a command that fails still takes the collector down, and its exit code comes back', async () => {
  const port = await freePort();
  const cwd = projectDir();
  const script = path.join(cwd, 'child.mjs');
  fs.writeFileSync(script, 'await fetch(`${process.env.ARGUS_URL}/api/health`);\nprocess.exit(3);\n');

  try {
    const result = await runFixture(cwd, ['--port', String(port), '--', process.execPath, script]);
    assert.equal(result.code, 3, `the fixture has to hand back the failing command's own exit code: ${result.out}`);

    assert.ok(
      await nothingAccepts(port, 10_000),
      'a failing command must not leave the collector holding the port',
    );

    const printed = result.out.match(/\bpid\b[^0-9]{0,12}(\d+)/i);
    assert.ok(printed, `the banner has to name the collector's pid: ${result.out}`);
    assert.ok(
      await waitForExit(Number(printed[1]), 10_000),
      'the collector process must not survive a failing command',
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('two runs on the same port both get a collector', async () => {
  const port = await freePort();
  const cwds = [projectDir(), projectDir()];

  try {
    for (const cwd of cwds) {
      const script = path.join(cwd, 'child.mjs');
      fs.writeFileSync(
        script,
        [
          "import fs from 'node:fs';",
          'const res = await fetch(`${process.env.ARGUS_URL}/api/health`);',
          "fs.writeFileSync('marker.json', await res.text());",
        ].join('\n'),
      );

      const result = await runFixture(cwd, ['--port', String(port), '--', process.execPath, script]);
      assert.equal(result.code, 0, `each run on this port has to get a collector to talk to: ${result.out}`);

      const marker = JSON.parse(fs.readFileSync(path.join(cwd, 'marker.json'), 'utf8'));
      assert.equal(marker.ok, true, `each run has to reach a live collector: ${JSON.stringify(marker)}`);
    }

    assert.ok(
      await nothingAccepts(port, 10_000),
      'the second run has to release the socket too, not just silence the collector — a stop that only silences would leave this red',
    );
  } finally {
    for (const cwd of cwds) fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('a fixture killed outright leaves no collector on the port', async () => {
  const port = await freePort();
  const wrapper = spawn(
    process.execPath,
    [
      FIXTURE,
      '--port',
      String(port),
      '--',
      process.execPath,
      '-e',
      'process.stderr.write(`COMMAND ${process.pid}\\n`); setTimeout(() => {}, 30000);',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let stderr = '';
  wrapper.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  let collectorPid;
  let commandPid;

  try {
    const deadline = Date.now() + 25_000;
    let up = false;
    let commandNamed = null;
    while (Date.now() < deadline) {
      up = await collectorAnswers(port);
      commandNamed = stderr.match(/COMMAND (\d+)/);
      if (up && commandNamed) break;
      await delay(200);
    }
    assert.ok(up, `the collector has to come up before the wrapper can be killed out from under it: ${stderr}`);
    assert.ok(commandNamed, `the command has to have named itself so the case can clean it up: ${stderr}`);

    const printed = stderr.match(/\bpid\b[^0-9]{0,12}(\d+)/i);
    assert.ok(printed, `the banner has to name the collector's pid before it can be checked: ${stderr}`);
    collectorPid = Number(printed[1]);
    commandPid = Number(commandNamed[1]);

    wrapper.kill('SIGKILL');
    await once(wrapper, 'exit');

    assert.ok(
      await nothingAccepts(port, 30_000),
      'even an outright kill of the fixture must not leave the collector holding the port — the 5 s exitWhenGone poll needs room',
    );
    assert.ok(
      await waitForExit(collectorPid, 10_000),
      'the collector process must not survive its wrapper being killed',
    );
  } finally {
    try {
      wrapper.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    if (commandPid) {
      try {
        process.kill(commandPid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    if (collectorPid) {
      try {
        process.kill(collectorPid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
});

test('a port already held is reported, and the command never runs', async () => {
  const port = await freePort();
  const squatter = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('not a collector');
  });
  await new Promise((resolve) => squatter.listen(port, '127.0.0.1', resolve));
  const cwd = projectDir();
  const script = path.join(cwd, 'child.mjs');
  fs.writeFileSync(script, "import fs from 'node:fs';\nfs.writeFileSync('marker.txt', 'ran');\n");

  try {
    const result = await runFixture(cwd, ['--port', String(port), '--', process.execPath, script]);
    assert.notEqual(
      result.code,
      0,
      `a port that is already held has to fail the fixture rather than run the command anyway: ${result.out}`,
    );
    assert.ok(result.out.includes(String(port)), `the failure has to say which port was already held: ${result.out}`);
    assert.ok(
      !fs.existsSync(path.join(cwd, 'marker.txt')),
      'the command must never have run against a port the fixture could not take',
    );
    assert.ok(
      !(await nothingAccepts(port, 500)),
      'the squatter is still there — the fixture must not have torn down a listener it never started',
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    await new Promise((resolve) => squatter.close(resolve));
  }
});

test('with no command it says how it is used', async () => {
  const cwd = projectDir();

  try {
    const noArgs = await runFixture(cwd, []);
    assert.equal(noArgs.code, 2, `running with nothing at all has to be a usage error: ${noArgs.out}`);
    assert.match(noArgs.out, /--/, `the usage message has to name the -- separator: ${noArgs.out}`);
    assert.match(noArgs.out, /with-collector/, `the usage message has to name the fixture: ${noArgs.out}`);

    const port = await freePort();
    const noSeparator = await runFixture(cwd, ['--port', String(port)]);
    assert.equal(noSeparator.code, 2, `a --port with no command is still a usage error: ${noSeparator.out}`);
    assert.match(noSeparator.out, /--/, `the usage message has to name the -- separator: ${noSeparator.out}`);
    assert.match(noSeparator.out, /with-collector/, `the usage message has to name the fixture: ${noSeparator.out}`);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
