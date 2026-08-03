import test from 'node:test';
import assert from 'node:assert/strict';

import { parseArgs, resolveConfig } from '../src/config.mjs';

test('the defaults point at a collector on this machine and a port of their own', () => {
  const config = resolveConfig({}, {});
  assert.equal(config.collector, 'http://127.0.0.1:4318');
  assert.equal(config.collectorToken, null);
  assert.equal(config.port, 4319, 'the interface must not fight the collector for 4318');
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.token, null);
});

test('the collector and its token come from the environment, and flags win over it', () => {
  const fromEnv = resolveConfig(
    {},
    { ATHENA_OBS_URL: 'https://obs.example.com', ATHENA_OBS_TOKEN: 'env-secret' },
  );
  assert.equal(fromEnv.collector, 'https://obs.example.com');
  assert.equal(fromEnv.collectorToken, 'env-secret');

  const fromFlags = resolveConfig(
    { collector: 'https://flag.example.com', 'collector-token': 'flag-secret' },
    { ATHENA_OBS_URL: 'https://obs.example.com', ATHENA_OBS_TOKEN: 'env-secret' },
  );
  assert.equal(fromFlags.collector, 'https://flag.example.com');
  assert.equal(fromFlags.collectorToken, 'flag-secret');
});

test('a non-loopback bind without --token is refused', () => {
  // Reachable from another machine, the interface hands out the collector's
  // token on every request it proxies. Unauthenticated that is the secret given
  // away, so the bind is refused rather than quietly served.
  assert.throws(() => resolveConfig({ host: '0.0.0.0' }, {}), /token/i);
  assert.throws(() => resolveConfig({ host: '192.168.1.10' }, {}), /token/i);

  // With a token of its own the same bind is allowed.
  assert.equal(resolveConfig({ host: '0.0.0.0', token: 'ui-secret' }, {}).host, '0.0.0.0');
  // And loopback needs nothing, which is the case criterion 8 rests on.
  assert.equal(resolveConfig({ host: '127.0.0.1' }, {}).host, '127.0.0.1');
  assert.equal(resolveConfig({ host: '::1' }, {}).host, '::1');
});

test('parseArgs reads the documented flag forms', () => {
  const { flags } = parseArgs(['--collector', 'http://c:4318', '--collector-token=abc', '--port', '5000', '--token', 's']);
  assert.equal(flags.collector, 'http://c:4318');
  assert.equal(flags['collector-token'], 'abc');
  assert.equal(flags.port, '5000');
  assert.equal(flags.token, 's');
});
