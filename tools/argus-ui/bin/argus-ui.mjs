#!/usr/bin/env node
/**
 * argus-ui — the web interface for an argus collector.
 *
 * Local only, and deliberately: it is started from a checkout, never deployed,
 * never shipped, and it knows the collector through nothing but its HTTP API.
 *
 * Usage:
 *   argus-ui [options]        serve the page and proxy to a running collector
 */

import { createServer } from '../src/server.mjs';
import { parseArgs, resolveConfig } from '../src/config.mjs';

const HELP = `
argus-ui — the web interface for an argus collector

  argus-ui                      Serve the page on http://127.0.0.1:4319 and read
                                the collector at http://127.0.0.1:4318.

Options
  -c, --collector <url>         Collector to read              (default http://127.0.0.1:4318)
      --collector-token <s>     Token the collector was started with
  -p, --port <n>                Port to serve the page on      (default 4319)
  -h, --host <addr>             Bind address                   (default 127.0.0.1)
  -t, --token <secret>          Require this token for the data; mandatory when
                                --host is reachable from another machine
      --help                    Show this message

Environment
  UROBOROS_OBS_URL, UROBOROS_OBS_TOKEN            the collector and its token
  UROBOROS_OBS_UI_PORT, UROBOROS_OBS_UI_HOST, UROBOROS_OBS_UI_TOKEN   this process
`.trim();

function main(argv) {
  const { flags } = parseArgs(argv);
  if (flags.help) {
    console.log(HELP);
    return;
  }

  const config = resolveConfig(flags);
  const server = createServer({
    collector: config.collector,
    collectorToken: config.collectorToken,
    token: config.token,
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(
        `argus-ui: port ${config.port} is already in use. ` +
          'Pick another with --port, or stop the process holding it.',
      );
    } else {
      console.error(`argus-ui: ${error.message}`);
    }
    process.exit(1);
  });

  server.listen(config.port, config.host, () => {
    const shown = config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host;
    const base = `http://${shown.includes(':') ? `[${shown}]` : shown}:${config.port}`;
    console.error(`\n  argus-ui on ${base}${config.token ? `/?token=${config.token}` : ''}`);
    console.error(`  reading     ${config.collector}${config.collectorToken ? '  (with a token)' : ''}\n`);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
    // Open SSE streams would otherwise hold the process forever.
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(`argus-ui: ${error.message}`);
  process.exit(1);
}
