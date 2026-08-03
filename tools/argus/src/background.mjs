/**
 * Starting the collector in the background, and ending it with the session.
 *
 * Two mechanisms, both small on purpose:
 *
 * - `spawnBackground` starts a second node process and waits for it to say it
 *   is listening — on file descriptor 3, not on stdout. A single JSON line
 *   there, and then the descriptor is closed, is what releases the calling
 *   shell: stdout stays free for whatever the caller redirects it to, and an
 *   open pipe would hold the shell for as long as the collector lives.
 * - `exitWhenGone` is the other half of "it ends with the session". A
 *   backgrounded child is orphaned the moment the short-lived shell that
 *   started it exits, so nothing would ever stop it. Polling the process it was
 *   started from costs one syscall every few seconds and needs no pidfile, no
 *   `stop` command and no registry — which is the whole point.
 */

import { spawn } from 'node:child_process';

const DEFAULT_READY_TIMEOUT_MS = 15_000;
const DEFAULT_WATCH_INTERVAL_MS = 5_000;

/** Is that process still there? EPERM means yes and not ours; ESRCH means gone. */
export function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * Run `onGone` once, as soon as `pid` is no longer running. Returns the timer,
 * which is unref'd so the watchdog never keeps its own process alive.
 */
export function exitWhenGone(pid, onGone, { intervalMs = DEFAULT_WATCH_INTERVAL_MS } = {}) {
  const timer = setInterval(() => {
    if (isRunning(pid)) return;
    clearInterval(timer);
    onGone();
  }, intervalMs);
  timer.unref?.();
  return timer;
}

/**
 * Spawn `process.execPath` with `argv` — the script path first — detached, with
 * a pipe on fd 3, and resolve with the JSON object the child writes there.
 *
 * Rejects when the child exits first, or when it says nothing within
 * `readyTimeoutMs`: the caller has to get its shell back either way, and a
 * child that never announced itself is not a collector anyone can use.
 */
export function spawnBackground({
  argv,
  readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
  cwd = process.cwd(),
  env = process.env,
  stdio = ['ignore', 'ignore', 'ignore'],
} = {}) {
  const child = spawn(process.execPath, argv, {
    cwd,
    env,
    // Its own process group: the shell that started this is gone in a moment,
    // and its exit must not take the collector with it.
    detached: true,
    stdio: [...stdio, 'pipe'],
  });

  return new Promise((resolve, reject) => {
    const ready = child.stdio[3];
    let buffer = '';
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
      ready.removeAllListeners('data');
      fn(value);
    };

    const onExit = (code, signal) =>
      finish(
        reject,
        new Error(`the collector exited before it was listening (${signal ? `signal ${signal}` : `code ${code}`})`),
      );
    const onError = (error) => finish(reject, error);

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, new Error(`the collector did not report itself listening within ${readyTimeoutMs} ms`));
    }, readyTimeoutMs);

    ready.setEncoding('utf8');
    ready.on('data', (chunk) => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end === -1) return;
      let announced;
      try {
        announced = JSON.parse(buffer.slice(0, end));
      } catch (error) {
        finish(reject, new Error(`the collector announced something unreadable: ${error.message}`));
        return;
      }
      // Nothing of the parent may hold the child, and nothing of the child may
      // hold the parent: this is the point where the two come apart.
      child.unref();
      ready.unref?.();
      finish(resolve, announced);
    });
    // A child that dies mid-write closes the pipe; the exit handler is the one
    // that reports it.
    ready.on('error', () => {});
    child.on('exit', onExit);
    child.on('error', onError);
  });
}

/** Drop `--name value`, `--name=value` and bare `--name` from an argument vector. */
export function withoutFlags(argv, names) {
  const drop = new Set(names);
  const kept = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      kept.push(arg);
      continue;
    }
    const inline = arg.indexOf('=');
    const name = inline === -1 ? arg.slice(2) : arg.slice(2, inline);
    if (!drop.has(name)) {
      kept.push(arg);
      continue;
    }
    // The same rule the parser uses: the next argument is this flag's value
    // unless it is a flag itself.
    const next = argv[i + 1];
    if (inline === -1 && next !== undefined && !next.startsWith('--')) i++;
  }
  return kept;
}
