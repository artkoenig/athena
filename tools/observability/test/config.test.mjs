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

test('parseDuration accepts the documented units', () => {
  assert.equal(parseDuration('90m'), 90 * 60_000);
  assert.equal(parseDuration('24h'), 86_400_000);
  assert.equal(parseDuration('500'), 500);
  assert.equal(parseDuration('', 7), 7);
  assert.throws(() => parseDuration('soon'), /invalid duration/);
});
