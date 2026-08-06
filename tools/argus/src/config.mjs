/**
 * Configuration resolution: defaults < environment < CLI flags.
 *
 * Environment variables are prefixed `UROBOROS_OBS_` so they never collide with
 * the `OTEL_*` variables an agent process in the same shell is using to *send*
 * telemetry here.
 */

import path from 'node:path';

const DURATION_RE = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/;

/** Where a measurement lands when nobody names a directory. */
export const PERSIST_ROOT = '.uroboros-telemetry';

const pad = (value) => String(value).padStart(2, '0');

/**
 * The name of one measurement's directory: local wall clock, zero padded, to
 * the second. Local and not UTC because it is read off the same clock as the
 * run it belongs to, when two of them are being compared.
 */
export function runDirName(date = new Date()) {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T` +
    `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  );
}

export function parseDuration(input, fallback) {
  if (input === undefined || input === null || input === '') return fallback;
  const match = String(input).trim().match(DURATION_RE);
  if (!match) throw new Error(`invalid duration: ${input}`);
  const value = Number(match[1]);
  const unit = match[2] ?? 'ms';
  const factor = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
  return value * factor;
}

function parseCount(input, fallback) {
  if (input === undefined || input === null || input === '') return fallback;
  const value = Number.parseInt(String(input).replace(/[_,]/g, ''), 10);
  if (!Number.isFinite(value) || value < 0) throw new Error(`invalid number: ${input}`);
  return value;
}

const FLAG_ALIASES = {
  '-p': '--port',
  '-h': '--host',
  '-t': '--token',
  '-V': '--version',
  '-?': '--help',
};

/** Parse `--key value`, `--key=value` and boolean `--flag` forms. */
export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    if (!arg.startsWith('-')) {
      positional.push(arg);
      continue;
    }
    arg = FLAG_ALIASES[arg] ?? arg;
    if (!arg.startsWith('--')) throw new Error(`unknown flag: ${arg}`);
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) flags[key] = true;
    else {
      flags[key] = next;
      i++;
    }
  }
  return { flags, positional };
}

/** `--flag` with no value, or an explicit `--flag=false`. */
const asBoolean = (value) => value === true || value === 'true' || value === '1';

const asDir = (value) => (typeof value === 'string' && value !== '' ? path.resolve(value) : null);

/**
 * Bare PORT is a platform saying "I assigned this one and I route to it" —
 * Render, Railway, Fly and Heroku all announce themselves that way, and nothing
 * else sets it by accident.
 */
const onPlatform = (env) => env.PORT !== undefined && env.PORT !== '';

export function resolveConfig(flags = {}, env = process.env) {
  // One writes a new measurement, the other replays an old one; together they
  // say nothing, and guessing which was meant is how a measurement gets written
  // into the one that was supposed to be read.
  if (flags.persist !== undefined && flags.open !== undefined) {
    throw new Error(
      '--persist <dir> writes a measurement into that directory, --open <dir> replays one that is ' +
        'already there and writes nothing. Pass one or the other, not both',
    );
  }

  const open = asDir(flags.open);
  const explicitPersist = asDir(flags.persist ?? env.UROBOROS_OBS_PERSIST);
  const persistOff = asBoolean(flags['no-persist']) || open !== null;

  const config = {
    // The measurement being replayed, read-only, or null. `--open` never opens
    // anything for writing.
    open,
    // The directory records are appended to: the one that was named, or null —
    // in which case `persistDefault` says whether a timestamped one under
    // `.uroboros-telemetry/` is to be created at start.
    persist: persistOff ? null : explicitPersist,
    persistDefault: !persistOff && explicitPersist === null,
    // The process this collector belongs to. CLAUDE_PID is the session's own,
    // exported into every command it runs, which is what "it ends with the
    // session" means in practice.
    exitWith: parseCount(flags['exit-with'] ?? env.CLAUDE_PID, 0) || null,
    // Where a background start listens for the "I am up" line. Set by that
    // start on the child it spawns, never by a person.
    readyFd: flags['ready-fd'] === undefined ? null : parseCount(flags['ready-fd'], 0) || null,
    // Loopback is the right default on a machine someone is sitting at: a
    // collector without a token accepts telemetry from anyone who reaches it,
    // so it is not put on the LAN unless that was asked for.
    //
    // A platform that assigns the port routes to the container's public
    // interface, so there a loopback bind is never what was meant — the port
    // scan finds nothing, the deploy times out, and the log says the collector
    // came up fine, because it did. The same variable that gives us the port
    // tells us which of the two situations this is, so the default follows it
    // instead of making every deployment remember a second variable.
    host: flags.host ?? env.UROBOROS_OBS_HOST ?? (onPlatform(env) ? '0.0.0.0' : '127.0.0.1'),
    // Bare PORT is how every PaaS assigns one — Render, Railway, Fly, Heroku all
    // inject it and route to whatever binds it. It ranks below the namespaced
    // variable so a deliberate UROBOROS_OBS_PORT still wins on a host that sets it.
    port: parseCount(flags.port ?? env.UROBOROS_OBS_PORT ?? env.PORT, 4318),
    token: flags.token === true ? null : (flags.token ?? env.UROBOROS_OBS_TOKEN ?? null),
    // Render publishes the service under a name the process cannot derive from
    // its bind address, and gets that name to it as RENDER_EXTERNAL_URL. Taking
    // it means the printed env block and the setup dialog show the URL an agent
    // can actually reach, instead of a loopback address that is true but useless.
    publicUrl: flags['public-url'] ?? env.UROBOROS_OBS_PUBLIC_URL ?? env.RENDER_EXTERNAL_URL ?? null,
    // A reopened measurement is as old as it is. Retention would evict it during
    // the replay itself and leave an empty store that looks like a bad recording.
    retentionMs: open
      ? Infinity
      : parseDuration(flags.retention ?? env.UROBOROS_OBS_RETENTION, 24 * 60 * 60 * 1000),
    maxSpans: parseCount(flags['max-spans'] ?? env.UROBOROS_OBS_MAX_SPANS, 50_000),
    maxLogs: parseCount(flags['max-logs'] ?? env.UROBOROS_OBS_MAX_LOGS, 50_000),
    maxMetricPoints: parseCount(flags['max-metrics'] ?? env.UROBOROS_OBS_MAX_METRICS, 50_000),
    maxSessions: parseCount(flags['max-sessions'] ?? env.UROBOROS_OBS_MAX_SESSIONS, 500),
    persistMaxBytes: parseCount(flags['persist-max-bytes'] ?? env.UROBOROS_OBS_PERSIST_MAX_BYTES, 64 * 1024 * 1024),
    traces: flags.traces === 'false' ? false : true,
  };
  if (!config.port) throw new Error('port must be a positive number');
  return config;
}

/**
 * The URL agents should export to. A wildcard bind is not a usable endpoint, so
 * fall back to a loopback address when the server listens on all interfaces.
 *
 * Behind a tunnel or reverse proxy the reachable URL has nothing to do with the
 * bind address, so `publicUrl` overrides it outright — that is the address that
 * ends up in the printed env block and in the UI's setup dialog.
 */
export function endpointFor({ host, port, publicUrl = null }) {
  if (publicUrl) return String(publicUrl).trim().replace(/\/+$/, '');
  const reachable =
    host === '0.0.0.0' || host === '::' || host === '' ? 'localhost' : host.includes(':') ? `[${host}]` : host;
  return `http://${reachable}:${port}`;
}
