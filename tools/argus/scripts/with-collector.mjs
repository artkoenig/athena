#!/usr/bin/env node
/**
 * with-collector — one collector, for the lifetime of one command.
 *
 * An agent that wants to look at the API needs a collector for a minute and
 * needs the port back afterwards. Everything that takes here is already in the
 * tool: `argus start --ready-fd 3` says when it is listening, `--exit-with
 * <pid>` makes it die with the process it was started from, and `--no-persist`
 * keeps it from leaving a measurement in whatever project the agent stands in.
 * This script is the thin wrapper over those three, so nobody has to improvise
 * a `pkill` again.
 *
 *   node tools/argus/scripts/with-collector.mjs [--port <n>] -- <command> [args...]
 *
 * The command gets ARGUS_URL and ARGUS_PORT, its stdout untouched — the banner
 * goes to stderr — and its own exit code back. The collector is stopped when
 * the command exits, whatever it exits with; `--exit-with` is the backstop for
 * the case where this wrapper is killed outright and never gets to stop it.
 */

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { isRunning, spawnBackground } from '../src/background.mjs';

const ARGUS = fileURLToPath(new URL('../bin/argus.mjs', import.meta.url));

const USAGE = `
with-collector — run one command against a collector of its own

  node tools/argus/scripts/with-collector.mjs [--port <n>] -- <command> [args...]

Everything after the first -- is the command. It runs with ARGUS_URL and
ARGUS_PORT pointing at a collector started on a free port (or on --port), and
that collector is stopped when the command exits. Nothing is written to disk
and the command's own exit code comes back.
`.trim();

const TERM_GRACE_MS = 5_000;
const KILL_GRACE_MS = 2_000;
const PORT_GRACE_MS = 5_000;
const POLL_MS = 50;
/** A leaked port is a failure of this script's one promise, so it has its own code. */
const PORT_STILL_HELD = 70;

/**
 * Hand-rolled on purpose: parseArgs in ../src/config.mjs has no notion of a
 * `--` terminator, so it would swallow the command's own flags.
 */
function parse(argv) {
  const separator = argv.indexOf('--');
  const own = separator === -1 ? argv : argv.slice(0, separator);
  const command = separator === -1 ? [] : argv.slice(separator + 1);
  let port = null;
  let help = false;

  for (let i = 0; i < own.length; i++) {
    const arg = own[i];
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg === '--port' || arg === '-p') {
      port = own[++i];
      continue;
    }
    if (arg.startsWith('--port=')) {
      port = arg.slice('--port='.length);
      continue;
    }
    return { error: `unknown option: ${arg}`, command, help };
  }

  if (port !== null) {
    const parsed = Number(port);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      return { error: `--port needs a port number, not ${JSON.stringify(port ?? null)}`, command, help };
    }
    port = parsed;
  }
  return { port, command, help, error: null };
}

/** A port the OS picked, so two runs at once never collide. */
async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** Does anything accept a connection there? Refused is the free-port answer. */
function accepts(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (answer) => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(1_000, () => done(true));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function poll(question, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await question()) return true;
    if (Date.now() >= deadline) return false;
    await delay(POLL_MS);
  }
}

const signal = (pid, name) => {
  try {
    process.kill(pid, name);
  } catch {
    /* already gone */
  }
};

/**
 * Take the collector down and give the port back. SIGTERM first, because a
 * collector that shuts down closes its persistence; SIGKILL when it will not
 * go. The verdict is the port, not the process: a socket that still accepts is
 * what the next run trips over.
 */
async function stop(pid, port) {
  signal(pid, 'SIGTERM');
  if (!(await poll(() => !isRunning(pid), TERM_GRACE_MS))) {
    signal(pid, 'SIGKILL');
    await poll(() => !isRunning(pid), KILL_GRACE_MS);
  }
  return poll(async () => !(await accepts(port)), PORT_GRACE_MS);
}

async function main(argv) {
  const { port: chosen, command, help, error } = parse(argv);
  if (help) {
    console.log(USAGE);
    return 0;
  }
  if (error || command.length === 0) {
    if (error) console.error(`with-collector: ${error}`);
    console.error(USAGE);
    return 2;
  }

  const port = chosen ?? (await freePort());
  // A collector that fails to start has to leave something to read.
  const logFile = path.join(os.tmpdir(), `argus-with-collector-${process.pid}.log`);
  const logFd = fs.openSync(logFile, 'a');

  let announced;
  try {
    announced = await spawnBackground({
      argv: [
        ARGUS,
        'start',
        '--port',
        String(port),
        // Ad-hoc inspection leaves no measurement in the project it is run from.
        '--no-persist',
        '--ready-fd',
        '3',
        // The backstop: this wrapper killed outright still frees the port.
        '--exit-with',
        String(process.pid),
      ],
      stdio: ['ignore', logFd, logFd],
    });
  } catch (failure) {
    console.error(`with-collector: no collector on port ${port}: ${failure.message} — its output is in ${logFile}`);
    return 1;
  } finally {
    fs.closeSync(logFd);
  }

  const url = `http://127.0.0.1:${port}`;
  const collector = announced.pid;
  // stderr, always: the command's stdout stays exactly what the command wrote.
  console.error(`with-collector: argus on ${url}, pid ${collector}`);
  console.error('with-collector: it stops when the command exits.');

  const leaked = () => {
    console.error(`with-collector: port ${port} is still held — collector pid ${collector} would not go.`);
    return PORT_STILL_HELD;
  };

  for (const name of ['SIGINT', 'SIGTERM']) {
    process.on(name, () => {
      stop(collector, port).then((freed) =>
        process.exit(freed ? 128 + (os.constants.signals[name] ?? 0) : PORT_STILL_HELD),
      );
    });
  }

  const child = spawn(command[0], command.slice(1), {
    stdio: 'inherit',
    env: { ...process.env, ARGUS_URL: url, ARGUS_PORT: String(port) },
  });
  // A command that cannot be spawned at all must still not leave a collector
  // behind, so the error is kept and reported after the stop.
  let spawnFailure = null;
  child.on('error', (failure) => {
    spawnFailure = failure;
  });

  let freed = false;
  let code = 0;
  try {
    const [exitCode, killedBy] = await once(child, 'close');
    code = killedBy ? 128 + (os.constants.signals[killedBy] ?? 0) : (exitCode ?? 0);
  } finally {
    freed = await stop(collector, port);
  }

  if (spawnFailure) {
    console.error(`with-collector: ${spawnFailure.message}`);
    return freed ? 127 : leaked();
  }
  return freed ? code : leaked();
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`with-collector: ${error.message}`);
    process.exit(1);
  });
