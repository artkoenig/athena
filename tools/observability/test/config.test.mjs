import test from 'node:test';
import assert from 'node:assert/strict';

import { endpointFor, parseArgs, parseDuration, resolveConfig } from '../src/config.mjs';

test('endpointFor turns a bind address into a URL an agent can actually reach', () => {
  assert.equal(endpointFor({ host: '127.0.0.1', port: 4318 }), 'http://127.0.0.1:4318');
  // A wildcard bind is not a usable destination.
  assert.equal(endpointFor({ host: '0.0.0.0', port: 4318 }), 'http://localhost:4318');
  assert.equal(endpointFor({ host: '::', port: 9000 }), 'http://localhost:9000');
  assert.equal(endpointFor({ host: '::1', port: 9000 }), 'http://[::1]:9000');
});

test('publicUrl overrides the bind address and is normalized', () => {
  // Behind a tunnel the reachable URL is unrelated to what the process bound to.
  assert.equal(
    endpointFor({ host: '127.0.0.1', port: 4318, publicUrl: 'https://x.trycloudflare.com/' }),
    'https://x.trycloudflare.com',
  );
  assert.equal(
    endpointFor({ host: '0.0.0.0', port: 4318, publicUrl: '  https://obs.example.com//  ' }),
    'https://obs.example.com',
  );
});

test('resolveConfig layers defaults, environment and flags', () => {
  const fromEnv = resolveConfig({}, { ATHENA_OBS_PUBLIC_URL: 'https://env.example', ATHENA_OBS_PORT: '9999' });
  assert.equal(fromEnv.publicUrl, 'https://env.example');
  assert.equal(fromEnv.port, 9999);

  const { flags } = parseArgs(['--public-url', 'https://flag.example', '--port=4444']);
  const fromFlags = resolveConfig(flags, { ATHENA_OBS_PUBLIC_URL: 'https://env.example' });
  assert.equal(fromFlags.publicUrl, 'https://flag.example', 'flags win over the environment');
  assert.equal(fromFlags.port, 4444);

  assert.equal(resolveConfig({}, {}).publicUrl, null);
});

test('a PaaS can hand over the port and the public URL without extra config', () => {
  // Render, Railway, Fly and Heroku all assign the port through bare PORT and
  // route to whatever binds it, so ignoring it means the service never answers.
  const paas = resolveConfig({}, { PORT: '10000', RENDER_EXTERNAL_URL: 'https://obs.onrender.com' });
  assert.equal(paas.port, 10000);
  // Without this the printed env block would advertise a loopback address that
  // is correct about the bind and useless to an agent somewhere else.
  assert.equal(paas.publicUrl, 'https://obs.onrender.com');
  assert.equal(endpointFor(paas), 'https://obs.onrender.com');

  // The namespaced variables are the deliberate ones, so they outrank the
  // platform's guess rather than the other way round.
  const pinned = resolveConfig(
    {},
    {
      PORT: '10000',
      ATHENA_OBS_PORT: '4318',
      RENDER_EXTERNAL_URL: 'https://obs.onrender.com',
      ATHENA_OBS_PUBLIC_URL: 'https://obs.example.com',
    },
  );
  assert.equal(pinned.port, 4318);
  assert.equal(pinned.publicUrl, 'https://obs.example.com');

  // And a flag still beats both.
  const { flags } = parseArgs(['--port=5000', '--public-url', 'https://flag.example']);
  const fromFlags = resolveConfig(flags, { PORT: '10000', RENDER_EXTERNAL_URL: 'https://obs.onrender.com' });
  assert.equal(fromFlags.port, 5000);
  assert.equal(fromFlags.publicUrl, 'https://flag.example');
});

test('the settings format nests the env block the way Claude Code expects', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const bin = new URL('../bin/athena-observe.mjs', import.meta.url).pathname;
  const { stdout } = await promisify(execFile)(process.execPath, [bin, 'env', '--format', 'settings']);
  const parsed = JSON.parse(stdout);
  assert.deepEqual(
    Object.keys(parsed),
    ['env', 'hooks'],
    'settings.local.json keys live under "env", the naming hook under "hooks"',
  );
  assert.equal(parsed.env.CLAUDE_CODE_ENABLE_TELEMETRY, '1');
  assert.equal(parsed.env.OTEL_EXPORTER_OTLP_ENDPOINT, 'http://127.0.0.1:4318');
  assert.match(parsed.hooks.SessionStart[0].hooks[0].command, /session-name\.mjs/);
});

test('parseDuration accepts the documented units', () => {
  assert.equal(parseDuration('90m'), 90 * 60_000);
  assert.equal(parseDuration('24h'), 86_400_000);
  assert.equal(parseDuration('500'), 500);
  assert.equal(parseDuration('', 7), 7);
  assert.throws(() => parseDuration('soon'), /invalid duration/);
});
