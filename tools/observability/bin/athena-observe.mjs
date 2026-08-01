#!/usr/bin/env node
/**
 * athena-observe — OpenTelemetry collector and web UI for Claude Agent SDK and
 * Claude Code sessions.
 *
 * Usage:
 *   athena-observe [start] [options]   start the collector + UI
 *   athena-observe env [options]       print the OTEL_* variables agents need
 */

import { TelemetryStore } from '../src/store.mjs';
import { JsonlPersistence } from '../src/persist.mjs';
import { createServer } from '../src/server.mjs';
import { endpointFor, parseArgs, resolveConfig } from '../src/config.mjs';
import { otelEnvFor } from '../src/claude.mjs';

const HELP = `
athena-observe — monitor Claude Agent SDK / Claude Code sessions over OpenTelemetry

  athena-observe [start]        Start the OTLP collector and the web UI.
  athena-observe env            Print the OTEL_* variables that point an agent here.

Options
  -p, --port <n>                Port for OTLP ingest and the UI      (default 4318)
  -h, --host <addr>             Bind address                         (default 127.0.0.1)
  -t, --token <secret>          Require "Authorization: Bearer <secret>"
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

  const server = createServer({ store, token: config.token, endpoint });

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

  server.listen(config.port, config.host, () => {
    const env = otelEnvFor(endpoint, { traces: config.traces, token: config.token });
    const bound = `${config.host}:${config.port}`;
    console.error(`\n  athena-observe listening on ${endpoint}${config.publicUrl ? `  (bound to ${bound})` : ''}`);
    console.error(`  UI          ${endpoint}${config.token ? `/?token=${config.token}` : '/'}`);
    console.error(`  OTLP ingest ${endpoint}/v1/{traces,metrics,logs}  (http/protobuf and http/json)`);
    console.error('\n  Point an agent at it:\n');
    console.error(
      renderEnv(env, 'shell')
        .split('\n')
        .map((line) => `    ${line}`)
        .join('\n'),
    );
    console.error('');
  });

  const shutdown = () => {
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
