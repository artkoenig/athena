/**
 * Configuration resolution: defaults < environment < CLI flags.
 *
 * Two addresses are in play and they are easy to confuse, so the names keep
 * them apart: `collector` (plus `collectorToken`) is the process this one talks
 * to, `host`/`port` (plus `token`) is where this one listens.
 */

const FLAG_ALIASES = {
  '-p': '--port',
  '-h': '--host',
  '-t': '--token',
  '-c': '--collector',
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

function parsePort(input, fallback) {
  if (input === undefined || input === null || input === '' || input === true) return fallback;
  const value = Number.parseInt(String(input), 10);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`invalid port: ${input}`);
  return value;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** Loopback covers every 127.x.x.x, not just the canonical one. */
function isLoopback(host) {
  return LOOPBACK.has(host) || /^127\./.test(host);
}

const text = (value) => (value === true || value === undefined || value === '' ? null : (value ?? null));

export function resolveConfig(flags = {}, env = process.env) {
  const config = {
    // The collector this interface reads. ATHENA_OBS_URL is the same variable
    // the collector prints for agents, so a shell already pointed at one needs
    // no flag here.
    collector: (text(flags.collector) ?? text(env.ATHENA_OBS_URL) ?? 'http://127.0.0.1:4318')
      .trim()
      .replace(/\/+$/, ''),
    collectorToken: text(flags['collector-token']) ?? text(env.ATHENA_OBS_TOKEN),
    // Not 4318: the collector is usually on this machine already, and two
    // processes fighting for one port is a failure with no useful message.
    port: parsePort(flags.port ?? env.ATHENA_OBS_UI_PORT, 4319),
    host: text(flags.host) ?? text(env.ATHENA_OBS_UI_HOST) ?? '127.0.0.1',
    token: text(flags.token) ?? text(env.ATHENA_OBS_UI_TOKEN),
  };

  // Reachable from another machine, this process hands the collector's token to
  // every request it forwards. Unauthenticated that is the secret given away,
  // so the bind is refused rather than quietly served.
  if (!isLoopback(config.host) && !config.token) {
    throw new Error(
      `--host ${config.host} is reachable from outside this machine, so it needs a --token of its own: ` +
        'without one, anyone who can reach this port uses the collector with its token',
    );
  }
  return config;
}
