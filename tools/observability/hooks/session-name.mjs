#!/usr/bin/env node
/**
 * SessionStart hook: give the session a name in athena-observe.
 *
 * Claude Code exports no session name — `session.id` is a UUID, and the OTel
 * resource that could carry a label is built once at process start, before any
 * hook runs. So the name cannot travel with the telemetry; this hook sends it to
 * the collector directly, keyed by the `session_id` every hook is handed.
 *
 * It configures itself from the same variables the session already exports to:
 * OTEL_EXPORTER_OTLP_ENDPOINT for the address, OTEL_EXPORTER_OTLP_HEADERS for
 * the token. A session that is not being monitored has neither, and the hook
 * does nothing.
 *
 * Nothing it does may disturb the session it names: every failure path exits 0
 * and prints nothing, so an unreachable collector costs a session start no more
 * than the timeout below.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';

const TIMEOUT_MS = 2000;

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    // No stdin at all (someone running this by hand) must not hang the session.
    const timer = setTimeout(() => resolve(''), TIMEOUT_MS);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      resolve('');
    });
  });
}

function git(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

/**
 * What a session is called: the repository it works in, and the branch it works
 * on. That is the pair that tells two concurrent sessions apart at a glance —
 * an id does not, and the working directory alone stops being enough as soon as
 * two branches of the same repo are checked out side by side. Outside a
 * repository the directory name is all there is.
 *
 * ATHENA_OBS_SESSION_NAME overrides it, for runs that know better: a CI job with
 * a build number, an SDK harness naming its own fleet.
 */
export function deriveName(cwd, env = process.env) {
  const override = (env.ATHENA_OBS_SESSION_NAME ?? '').trim();
  if (override) return override;
  const dir = cwd || env.CLAUDE_PROJECT_DIR || process.cwd();
  const root = git(dir, ['rev-parse', '--show-toplevel']);
  if (!root) return path.basename(dir);
  const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const repo = path.basename(root);
  // A detached HEAD reports "HEAD", which names nothing.
  return branch && branch !== 'HEAD' ? `${repo} · ${branch}` : repo;
}

/** The collector this session is already exporting to, or null. */
export function collectorFrom(env = process.env) {
  const endpoint = (env.ATHENA_OBS_URL ?? env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '').trim();
  if (!endpoint) return null;
  const token =
    (env.ATHENA_OBS_TOKEN ?? '').trim() ||
    (env.OTEL_EXPORTER_OTLP_HEADERS ?? '').match(/Authorization=Bearer\s+([^,\s]+)/i)?.[1] ||
    null;
  return { endpoint: endpoint.replace(/\/+$/, ''), token };
}

async function main() {
  const input = await readStdin();
  let hook = {};
  try {
    hook = JSON.parse(input);
  } catch {
    // Not being called as a hook: nothing to name.
  }
  const sessionId = hook.session_id;
  const collector = collectorFrom();
  if (!sessionId || !collector) return;

  const name = deriveName(hook.cwd);
  if (!name) return;

  await fetch(`${collector.endpoint}/api/sessions/${encodeURIComponent(sessionId)}/name`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(collector.token ? { authorization: `Bearer ${collector.token}` } : {}),
    },
    body: JSON.stringify({ name }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

// Only when run as the hook, so the helpers above stay importable for tests.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch(() => {
    // A collector that is down, slow or unauthenticated is not the session's
    // problem. Stay silent and let it start.
  });
}
