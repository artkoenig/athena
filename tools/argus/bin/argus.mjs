#!/usr/bin/env node
/**
 * argus — OpenTelemetry collector for Claude Agent SDK and Claude Code
 * sessions. It ingests, aggregates, persists and serves JSON; the page that
 * displays all that is a separate process (argus-ui).
 *
 * Usage:
 *   argus [start] [options]   start the collector
 *   argus env [options]       print the OTEL_* variables agents need
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { exitWhenGone, spawnBackground, withoutFlags } from '../src/background.mjs';
import { TelemetryStore } from '../src/store.mjs';
import { createRunDir, JsonlPersistence } from '../src/persist.mjs';
import { createServer } from '../src/server.mjs';
import { endpointFor, parseArgs, PERSIST_ROOT, resolveConfig } from '../src/config.mjs';
import { otelEnvFor } from '../src/claude.mjs';
import { probeCollector } from '../src/probe.mjs';
import { startTunnel } from '../src/tunnel.mjs';

const HELP = `
argus — monitor Claude Agent SDK / Claude Code sessions over OpenTelemetry

  argus [start]                 Start the OTLP collector. It serves data, not a
                                page: run argus-ui to look at what it collects.
  argus env                     Print the OTEL_* variables that point an agent here.
  argus check                   Verify a collector is reachable from *here* and
                                actually stores what it accepts. Run it inside the
                                environment the agent runs in.

Options
  -p, --port <n>                Port for OTLP ingest and the API     (default 4318)
  -h, --host <addr>             Bind address                         (default 127.0.0.1)
  -t, --token <secret>          Require "Authorization: Bearer <secret>"
      --tunnel [binary]         Open a Cloudflare quick tunnel, generate a token
                                and print the env block for a cloud session.
                                Everything a remote agent needs, in one command.
                                Falls back from QUIC to HTTP/2 if UDP is blocked.
      --tunnel-protocol <p>     Pin the tunnel transport (quic | http2) instead
                                of trying both
      --public-url <url>        Advertise this URL instead of the bind address
                                (behind a tunnel or reverse proxy)
      --background              Start the collector and return to the caller.
                                It ends when the process it was started from
                                does, so a session takes its collector with it
      --exit-with <pid>         Shut down when that process is gone
                                (default $CLAUDE_PID, the session itself)
      --persist <dir>           Write the measurement into exactly this directory
                                instead of <cwd>/.athena-telemetry/<timestamp>.
                                Write-only: it never replays what is there
      --no-persist              Keep nothing on disk
      --open <dir>              Replay an existing measurement and show it,
                                retention off, writing nothing into it
      --retention <duration>    Drop records older than this          (default 24h)
      --max-spans <n>           Span buffer size                     (default 50000)
      --max-logs <n>            Event buffer size                    (default 50000)
      --max-metrics <n>         Metric point buffer size             (default 50000)
      --max-sessions <n>        Sessions kept in memory              (default 500)
      --traces false            Leave traces out of the printed env block
      --format <fmt>            Output format for "env": shell (default), json,
                                dotenv, settings (.claude/settings.local.json)
      --help                    Show this message

Environment
  ATHENA_OBS_PORT, ATHENA_OBS_HOST, ATHENA_OBS_TOKEN, ATHENA_OBS_PUBLIC_URL,
  ATHENA_OBS_PERSIST, ATHENA_OBS_RETENTION, ATHENA_OBS_MAX_SPANS,
  ATHENA_OBS_MAX_LOGS, ATHENA_OBS_MAX_METRICS, ATHENA_OBS_MAX_SESSIONS
`.trim();

function renderEnv(env, format) {
  switch (format) {
    case 'json':
      return JSON.stringify(env, null, 2);
    // Ready to drop into .claude/settings.local.json, which applies the block to
    // every session in the project without anyone having to remember an export.
    case 'settings':
      return JSON.stringify({ env }, null, 2);
    case 'dotenv':
      return Object.entries(env)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n');
    default:
      return Object.entries(env)
        .map(([key, value]) => `export ${key}="${value}"`)
        .join('\n');
  }
}

// How long a port may take to answer, by question. The connection is the one
// that decides whether the port is free, so it is the only one a free port
// pays — and a refused connection on loopback comes back at once. The health
// request is asked only of a port that already accepted a connection, so its
// budget is what a listener that never answers costs before it is called a
// stranger; a collector on the same machine answers /api/health in
// milliseconds.
const CONNECT_TIMEOUT_MS = 3000;
const HEALTH_TIMEOUT_MS = 1000;

/**
 * Does anything accept a connection there? Refused is the ordinary "free port"
 * answer; anything accepted holds the port, whether or not it ever says a word.
 */
function accepts(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (answer) => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** What is answering on that address: nothing, a collector, or a stranger. */
async function inspectPort(base, token) {
  // The connection classifies the port, not the request. A listener that
  // accepts and then says nothing would time the health request out, and
  // calling that a free port is how a start proceeds onto a port it cannot
  // have: the child dies on EADDRINUSE and the caller is told the wrong thing.
  const { hostname, port } = new URL(base);
  if (!(await accepts(hostname, Number(port)))) return { kind: 'free' };

  let response;
  try {
    response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
  } catch {
    // Something holds the port and did not answer as a collector does.
    return { kind: 'stranger' };
  }
  let health = null;
  try {
    health = await response.json();
  } catch {
    return { kind: 'stranger' };
  }
  // /api/health answers without a token by design, and names the process. Both
  // are what make "is this one of ours" answerable from the outside.
  if (!response.ok || health?.ok !== true || typeof health.instance !== 'string') return { kind: 'stranger' };

  let persist = null;
  try {
    const url = `${base}/api/config${token ? `?token=${encodeURIComponent(token)}` : ''}`;
    const config = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (config.ok) persist = (await config.json()).persist ?? null;
  } catch {
    // Its measurement directory is worth naming, not worth failing over.
  }
  return { kind: 'collector', persist };
}

/**
 * `start --background`: hand the caller its shell back with a collector still
 * listening. The child is this same script, started with `--ready-fd 3` so it
 * can say when it is up, and `--exit-with` so it ends with the session.
 */
async function startInBackground(argv, config, endpoint) {
  const local = endpointFor({ host: config.host, port: config.port });

  // A second start is not a second collector. The port already holding one is
  // the answer to "am I measuring?", so say where that one writes and stop.
  const found = await inspectPort(local, config.token);
  if (found.kind === 'collector') {
    console.error(`\n  argus is already listening on ${local}`);
    console.error(`  Measurement ${found.persist ?? '(this collector keeps nothing on disk)'}`);
    console.error('  Nothing was started; that collector keeps running.\n');
    return;
  }
  if (found.kind === 'stranger') {
    console.error(
      `argus: port ${config.port} is held by something that is not a collector. ` +
        'Stop it, or start on another port with --port.',
    );
    process.exitCode = 1;
    return;
  }

  const runDir = config.open || !config.persistDefault
    ? config.persist
    : createRunDir(path.resolve(process.cwd(), PERSIST_ROOT));

  // stdout and stderr of a backgrounded process have to land somewhere it can
  // be read afterwards; inside the measurement is where someone will look.
  let logFile = null;
  let logFd = 'ignore';
  if (runDir) {
    fs.mkdirSync(runDir, { recursive: true });
    logFile = path.join(runDir, 'collector.log');
    logFd = fs.openSync(logFile, 'a');
  }

  const exitWith = config.exitWith;
  const childArgv = [
    fileURLToPath(import.meta.url),
    ...withoutFlags(argv, ['background', 'ready-fd', 'exit-with', 'persist', 'no-persist', 'open']),
    '--ready-fd',
    '3',
    ...(exitWith ? ['--exit-with', String(exitWith)] : []),
    ...(config.open ? ['--open', config.open] : runDir ? ['--persist', runDir] : ['--no-persist']),
  ];

  let announced;
  try {
    announced = await spawnBackground({ argv: childArgv, stdio: ['ignore', logFd, logFd] });
  } catch (error) {
    throw new Error(
      `${error.message} on port ${config.port}` + (logFile ? ` — its output is in ${logFile}` : ''),
    );
  } finally {
    if (logFd !== 'ignore') fs.closeSync(logFd);
  }

  console.error(`\n  argus listening on ${announced.endpoint ?? local}`);
  if (config.token) console.error(`  Token       ${config.token}`);
  console.error(`  Measurement ${announced.persist ?? '(nothing is kept on disk)'}`);
  console.error(`  pid ${announced.pid}`);
  if (exitWith) console.error(`  It stops when process ${exitWith} does — the session it was started from.`);
  else console.error('  Nothing will stop it but you: no --exit-with was given and CLAUDE_PID is not set.');
  console.error('\n  Point an agent at it, then start a NEW session:\n');
  console.error(
    renderEnv(otelEnvFor(endpoint, { traces: config.traces, token: config.token }), 'shell')
      .split('\n')
      .map((line) => `    ${line}`)
      .join('\n'),
  );
  console.error('');
}

async function main(argv) {
  const { flags, positional } = parseArgs(argv);
  if (flags.help) {
    console.log(HELP);
    return;
  }

  const command = positional[0] ?? 'start';
  const config = resolveConfig(flags);
  const endpoint = endpointFor(config);

  if (command === 'env') {
    const env = otelEnvFor(endpoint, { traces: config.traces, token: config.token });
    console.log(renderEnv(env, flags.format === true ? 'shell' : (flags.format ?? 'shell')));
    return;
  }
  if (command === 'check') {
    // Default to whatever the agent in this shell is already exporting to, so a
    // bare `check` diagnoses the configuration actually in effect.
    const target = config.publicUrl ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? endpoint;
    const secret =
      config.token ??
      (process.env.OTEL_EXPORTER_OTLP_HEADERS ?? '').match(/Authorization=Bearer\s+(\S+)/i)?.[1] ??
      null;
    const result = await probeCollector(target, { token: secret });
    for (const step of result.steps) {
      console.error(`  ${step.ok ? '✓' : '✗'} ${step.name.padEnd(10)} ${step.detail}`);
    }
    // One failure is its own verdict: the export itself works, so saying it does
    // not arrive would be wrong — but so would calling this healthy. A split
    // endpoint shows only the share of telemetry that lands on one instance.
    const failed = result.steps.filter((step) => !step.ok).map((step) => step.name);
    const only = (name) => failed.length === 1 && failed[0] === name;
    console.error(
      result.ok
        ? `\n  Telemetry from this environment reaches ${result.endpoint}.\n`
        : only('single')
          ? `\n  Telemetry reaches ${result.endpoint}, but only one instance of several will ever show it.\n`
          : `\n  Telemetry from this environment does NOT reach ${result.endpoint}.\n`,
    );
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command !== 'start') {
    console.error(`unknown command: ${command}\n`);
    console.error(HELP);
    process.exitCode = 1;
    return;
  }

  // A measurement that is not there has to be said out loud: a typo would
  // otherwise look exactly like a run that recorded nothing.
  if (config.open && !fs.existsSync(config.open)) {
    console.error(`argus: no measurement at ${config.open} — --open replays a directory that already exists`);
    process.exitCode = 1;
    return;
  }

  if (flags.background) {
    await startInBackground(argv, config, endpoint);
    return;
  }

  const store = new TelemetryStore(config);
  let persistence = null;
  // Where this collector writes, absolute — null when it keeps nothing. The
  // default is a timestamped directory in the project being measured, so two
  // runs can be compared instead of one overwriting the other.
  let runDir = config.persist;
  if (!config.open && config.persistDefault) {
    runDir = createRunDir(path.resolve(process.cwd(), PERSIST_ROOT));
  }

  if (config.open) {
    // Read direction: replay it and let go of it. Nothing is attached, so
    // nothing this collector receives is written back into what it opened.
    const archive = new JsonlPersistence(config.open);
    const restored = await archive.load(store);
    archive.close();
    console.error(`argus: opened ${config.open} (replayed ${restored} records, retention off)`);
  } else if (runDir) {
    persistence = new JsonlPersistence(runDir, {
      maxBytes: config.persistMaxBytes,
      log: (message) => console.error(message),
    });
    // Write direction only. Replaying here would mix an older measurement into
    // the one being recorded; `--open` is how an old one is looked at.
    persistence.attach(store);
    console.error(`argus: persisting to ${runDir}`);
  }

  // A tunnel puts the collector on the public internet, so it must not be open.
  if (flags.tunnel && !config.token) {
    config.token = crypto.randomBytes(16).toString('hex');
  }

  let advertised = endpoint;
  const server = createServer({
    store,
    token: config.token,
    endpoint: () => advertised,
    persist: runDir,
  });
  let tunnel = null;

  const printEnv = (format, indent = '    ') =>
    console.error(
      renderEnv(otelEnvFor(advertised, { traces: config.traces, token: config.token }), format)
        .split('\n')
        .map((line) => `${indent}${line}`)
        .join('\n'),
    );

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(
        `argus: port ${config.port} is already in use. ` +
          'Pick another with --port, or stop the process holding it.',
      );
    } else {
      console.error(`argus: ${error.message}`);
    }
    process.exit(1);
  });

  server.listen(config.port, config.host, async () => {
    // One JSON line on the readiness descriptor, from inside the listen
    // callback, and then it is closed: the caller waiting on it gets its shell
    // back at the first moment the collector can actually be used.
    if (config.readyFd !== null) {
      try {
        fs.writeSync(
          config.readyFd,
          `${JSON.stringify({
            ready: true,
            pid: process.pid,
            port: config.port,
            endpoint,
            token: config.token,
            persist: runDir,
          })}\n`,
        );
      } finally {
        fs.closeSync(config.readyFd);
      }
    }

    const bound = `${config.host}:${config.port}`;
    console.error(`\n  argus listening on ${endpoint}${config.publicUrl ? `  (bound to ${bound})` : ''}`);
    console.error(`  OTLP ingest ${endpoint}/v1/{traces,metrics,logs}  (http/protobuf and http/json)`);
    console.error(`  JSON API    ${endpoint}/api/…  — the page that reads it is argus-ui`);

    if (!flags.tunnel) {
      console.error('\n  Point an agent at it:\n');
      printEnv('shell');
      console.error('');
      return;
    }

    console.error('\n  Opening a Cloudflare quick tunnel …');
    try {
      tunnel = await startTunnel({
        port: config.port,
        binary: flags.tunnel === true ? 'cloudflared' : flags.tunnel,
        protocol: flags['tunnel-protocol'] ?? null,
        onProgress: (url) => console.error(`  Got ${url}, waiting for it to serve …`),
        onFallback: (failed, next) =>
          console.error(`  ${failed.label} did not get through — retrying over ${next.label} …`),
      });
    } catch (error) {
      console.error(`\n  Tunnel failed: ${error.message}\n`);
      console.error(`  The collector is still running locally on ${endpoint}.`);
      // A blocked 7844 is a firewall rule, not a hiccup: retrying cloudflared in
      // any form will fail the same way. Every alternative below goes out over a
      // port such a network almost certainly already allows, so name them here
      // rather than making someone go looking for what "any other tunnel" means.
      console.error('\n  Something else has to carry it. These leave over 22 or 443:\n');
      console.error(`    ssh -R 80:localhost:${config.port} nokey@localhost.run   # nothing to install`);
      console.error(`    tailscale funnel ${config.port}                          # stable URL, needs an account`);
      console.error(`    ngrok http ${config.port}                                # needs an account`);
      console.error('\n  Each prints a URL. Restart with it:\n');
      console.error(`    node bin/argus.mjs --public-url <url> --token ${config.token}\n`);
      console.error('  Or skip tunnelling entirely and deploy the collector — see "Selbst hosten"');
      console.error('  in the README. Then the public address is the deployment, and this');
      console.error('  machine never has to be reachable at all.\n');
      return;
    }
    advertised = tunnel.url;
    tunnel.process.on('exit', () => {
      // The advertised URL is dead once the tunnel is gone; say so rather than
      // keep handing out an endpoint that no longer resolves.
      console.error('\n  argus: the tunnel closed — the public URL is no longer reachable.\n');
      advertised = endpoint;
    });

    console.error(`\n  Public URL  ${tunnel.url}`);
    console.error(`  Token       ${config.token}`);
    console.error('\n  Set these in the cloud session environment, then start a NEW session:\n');
    printEnv('dotenv');
    console.error('\n  Verify from inside that session with:\n');
    console.error('    node tools/argus/bin/argus.mjs check\n');
  });

  const shutdown = () => {
    tunnel?.stop();
    server.close(() => {
      persistence?.close();
      process.exit(0);
    });
    // Open SSE streams would otherwise hold the process forever.
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // It ends with the session. Nothing else stops a backgrounded collector: the
  // shell that started it is long gone, and there is no pidfile to find it by.
  if (config.exitWith) {
    exitWhenGone(config.exitWith, () => {
      console.error(`\n  argus: process ${config.exitWith} is gone — shutting down.\n`);
      shutdown();
    });
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`argus: ${error.message}`);
  process.exit(1);
});
