/**
 * Configuration resolution: defaults < environment < CLI flags.
 *
 * Environment variables are prefixed `ATHENA_OBS_` so they never collide with
 * the `OTEL_*` variables an agent process in the same shell is using to *send*
 * telemetry here.
 */

const DURATION_RE = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/;

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

export function resolveConfig(flags = {}, env = process.env) {
  const config = {
    host: flags.host ?? env.ATHENA_OBS_HOST ?? '127.0.0.1',
    // Bare PORT is how every PaaS assigns one — Render, Railway, Fly, Heroku all
    // inject it and route to whatever binds it. It ranks below the namespaced
    // variable so a deliberate ATHENA_OBS_PORT still wins on a host that sets it.
    port: parseCount(flags.port ?? env.ATHENA_OBS_PORT ?? env.PORT, 4318),
    token: flags.token === true ? null : (flags.token ?? env.ATHENA_OBS_TOKEN ?? null),
    // Render publishes the service under a name the process cannot derive from
    // its bind address, and gets that name to it as RENDER_EXTERNAL_URL. Taking
    // it means the printed env block and the setup dialog show the URL an agent
    // can actually reach, instead of a loopback address that is true but useless.
    publicUrl: flags['public-url'] ?? env.ATHENA_OBS_PUBLIC_URL ?? env.RENDER_EXTERNAL_URL ?? null,
    persist: flags.persist === true ? '.athena-telemetry' : (flags.persist ?? env.ATHENA_OBS_PERSIST ?? null),
    retentionMs: parseDuration(flags.retention ?? env.ATHENA_OBS_RETENTION, 24 * 60 * 60 * 1000),
    maxSpans: parseCount(flags['max-spans'] ?? env.ATHENA_OBS_MAX_SPANS, 50_000),
    maxLogs: parseCount(flags['max-logs'] ?? env.ATHENA_OBS_MAX_LOGS, 50_000),
    maxMetricPoints: parseCount(flags['max-metrics'] ?? env.ATHENA_OBS_MAX_METRICS, 50_000),
    maxSessions: parseCount(flags['max-sessions'] ?? env.ATHENA_OBS_MAX_SESSIONS, 500),
    persistMaxBytes: parseCount(flags['persist-max-bytes'] ?? env.ATHENA_OBS_PERSIST_MAX_BYTES, 64 * 1024 * 1024),
    traces: flags.traces === 'false' ? false : true,
    // Label for the session the printed env block will start, not for the
    // collector itself — see sessionNameOf in claude.mjs.
    sessionName: flags.name === true ? null : (flags.name ?? env.ATHENA_OBS_SESSION_NAME ?? null),
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
