#!/usr/bin/env node
/**
 * athena-observe — OpenTelemetry collector and web UI for Claude Agent SDK and
 * Claude Code sessions.
 *
 * Usage:
 *   athena-observe [start] [options]   start the collector + UI
 *   athena-observe env [options]       print the OTEL_* variables agents need
 */

import crypto from 'node:crypto';

import { TelemetryStore } from '../src/store.mjs';
import { JsonlPersistence } from '../src/persist.mjs';
import { createServer } from '../src/server.mjs';
import { endpointFor, parseArgs, resolveConfig } from '../src/config.mjs';
import { otelEnvFor, sessionNameHook } from '../src/claude.mjs';
import { probeCollector } from '../src/probe.mjs';
import { startTunnel } from '../src/tunnel.mjs';

const HELP = `
athena-observe — monitor Claude Agent SDK / Claude Code sessions over OpenTelemetry

  athena-observe [start]        Start the OTLP collector and the web UI.
  athena-observe env            Print the OTEL_* variables that point an agent here.
  athena-observe check          Verify a collector is reachable from *here* and
                                actually stores what it accepts. Run it inside the
                                environment the agent runs in.

Options
  -p, --port <n>                Port for OTLP ingest and the UI      (default 4318)
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
      --persist [dir]           Append records to JSONL and replay them on restart
      --retention <duration>    Drop records older than this          (default 24h)
      --max-spans <n>           Span buffer size                     (default 50000)
      --max-logs <n>            Event buffer size                    (default 50000)
      --max-metrics <n>         Metric point buffer size             (default 50000)
      --max-sessions <n>        Sessions kept in memory              (default 500)
      --traces false            Leave traces out of the printed env block
      --format <fmt>            Output format for "env": shell (default), json,
                                dotenv, settings (.claude/settings.local.json,
                                includes the SessionStart hook that names
                                sessions in the UI)
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
    // The SessionStart hook rides along: it is what makes those sessions show up
    // under a name rather than a UUID, and it needs no configuration of its own.
    case 'settings':
      return JSON.stringify({ env, hooks: sessionNameHook() }, null, 2);
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
    // A split endpoint is its own verdict: the export itself works, so saying it
    // does not arrive would be wrong — but so would calling this healthy, since
    // what arrives is only ever visible to one instance out of several.
    const failed = result.steps.filter((step) => !step.ok).map((step) => step.name);
    console.error(
      result.ok
        ? `\n  Telemetry from this environment reaches ${result.endpoint}.\n`
        : failed.length === 1 && failed[0] === 'single'
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

  const store = new TelemetryStore(config);
  let persistence = null;
  if (config.persist) {
    persistence = new JsonlPersistence(config.persist, {
      maxBytes: config.persistMaxBytes,
      log: (message) => console.error(message),
    });
    const restored = await persistence.load(store);
    persistence.attach(store);
    console.error(
      `athena-observe: persisting to ${config.persist}` +
        (restored ? ` (replayed ${restored} records)` : ''),
    );
  }

  // A tunnel puts the collector on the public internet, so it must not be open.
  if (flags.tunnel && !config.token) {
    config.token = crypto.randomBytes(16).toString('hex');
  }

  let advertised = endpoint;
  const server = createServer({ store, token: config.token, endpoint: () => advertised });
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
        `athena-observe: port ${config.port} is already in use. ` +
          'Pick another with --port, or stop the process holding it.',
      );
    } else {
      console.error(`athena-observe: ${error.message}`);
    }
    process.exit(1);
  });

  // With a tunnel the process is on this machine, so the loopback address is the
  // better thing to click — it skips the hop and keeps working if the tunnel
  // drops. Deployed somewhere (a PaaS setting RENDER_EXTERNAL_URL, a reverse
  // proxy, --public-url) there is no "here" to browse, so the public URL is the
  // only one that opens anything.
  const uiBase = config.publicUrl && !flags.tunnel ? endpoint : endpointFor({ host: config.host, port: config.port });
  const localUi = `${uiBase}${config.token ? `/?token=${config.token}` : '/'}`;

  server.listen(config.port, config.host, async () => {
    const bound = `${config.host}:${config.port}`;
    console.error(`\n  athena-observe listening on ${endpoint}${config.publicUrl ? `  (bound to ${bound})` : ''}`);
    console.error(`  UI          ${localUi}`);
    console.error(`  OTLP ingest ${endpoint}/v1/{traces,metrics,logs}  (http/protobuf and http/json)`);

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
      console.error(`    node bin/athena-observe.mjs --public-url <url> --token ${config.token}\n`);
      console.error('  Or skip tunnelling entirely and deploy the collector — see "Selbst hosten"');
      console.error('  in the README. Then the public address is the deployment, and this');
      console.error('  machine never has to be reachable at all.\n');
      return;
    }
    advertised = tunnel.url;
    tunnel.process.on('exit', () => {
      // The advertised URL is dead once the tunnel is gone; say so rather than
      // letting the UI keep handing out an endpoint that no longer resolves.
      console.error('\n  athena-observe: the tunnel closed — the public URL is no longer reachable.\n');
      advertised = endpoint;
    });

    console.error(`\n  Public URL  ${tunnel.url}`);
    console.error(`  Token       ${config.token}`);
    console.error('\n  Set these in the cloud session environment, then start a NEW session:\n');
    printEnv('dotenv');
    console.error('\n  Verify from inside that session with:\n');
    console.error('    node tools/observability/bin/athena-observe.mjs check\n');
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
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`athena-observe: ${error.message}`);
  process.exit(1);
});
