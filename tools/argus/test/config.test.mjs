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
  const bin = new URL('../bin/argus.mjs', import.meta.url).pathname;
  const { stdout } = await promisify(execFile)(process.execPath, [bin, 'env', '--format', 'settings']);
  const parsed = JSON.parse(stdout);
  assert.deepEqual(
    Object.keys(parsed),
    ['env'],
    'the environment block is the whole of what this format emits',
  );
  assert.equal(parsed.env.CLAUDE_CODE_ENABLE_TELEMETRY, '1');
  assert.equal(parsed.env.OTEL_EXPORTER_OTLP_ENDPOINT, 'http://127.0.0.1:4318');
});

test('a measurement is named by its local wall clock, zero padded', async () => {
  // Imported dynamically so a missing export fails this case alone instead of
  // taking the whole file down with it.
  const config = await import('../src/config.mjs');
  assert.equal(typeof config.runDirName, 'function', 'config.mjs must export runDirName');

  // Local time, not UTC: the directory name is what a person reads off their
  // own clock when comparing two runs.
  assert.equal(config.runDirName(new Date(2026, 7, 3, 14, 22, 5)), '2026-08-03T14-22-05');
  assert.equal(config.runDirName(new Date(2026, 0, 5, 0, 0, 0)), '2026-01-05T00-00-00');
  assert.equal(config.runDirName(new Date(2026, 11, 31, 23, 59, 59)), '2026-12-31T23-59-59');
});

test('--persist and --open together are refused, naming what each does', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const net = await import('node:net');
  const bin = new URL('../bin/argus.mjs', import.meta.url).pathname;

  // A port nobody holds, so a refusal cannot be confused with a failed bind.
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const started = Date.now();
  const error = await promisify(execFile)(
    process.execPath,
    [bin, 'start', '--port', String(port), '--persist', '/tmp/argus-write-here', '--open', '/tmp/argus-read-that'],
    { timeout: 8000 },
  ).then(
    () => null,
    (failure) => failure,
  );

  assert.ok(error, 'one writes and the other replays — the pair has no meaning, so it must not start');
  assert.ok(Date.now() - started < 5000, 'it refuses up front rather than running until something stops it');
  assert.equal(error.code, 1);
  const said = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  assert.match(said, /--persist/, 'the message has to say which flag does what');
  assert.match(said, /--open/);
});

test('parseDuration accepts the documented units', () => {
  assert.equal(parseDuration('90m'), 90 * 60_000);
  assert.equal(parseDuration('24h'), 86_400_000);
  assert.equal(parseDuration('500'), 500);
  assert.equal(parseDuration('', 7), 7);
  assert.throws(() => parseDuration('soon'), /invalid duration/);
});
