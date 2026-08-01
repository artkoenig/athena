import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startTunnel } from '../src/tunnel.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-tunnel-'));

/** Stand in for cloudflared so the tests never touch the network. */
function fakeBinary(name, script) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return file;
}

const BANNER = `echo "Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):"
echo "https://fake-tunnel.trycloudflare.com"`;

test('resolves only once the URL actually serves, not when it is printed', async () => {
  const binary = fakeBinary('serves.sh', `${BANNER}\nsleep 30`);
  const seen = [];
  let attempts = 0;
  const tunnel = await startTunnel({
    port: 4318,
    binary,
    readyTimeoutMs: 10_000,
    onProgress: (url) => seen.push(url),
    // Fail twice first: cloudflared prints the URL before the edge connection is up.
    verify: async () => ++attempts >= 3,
  });
  try {
    assert.equal(tunnel.url, 'https://fake-tunnel.trycloudflare.com');
    assert.deepEqual(seen, ['https://fake-tunnel.trycloudflare.com'], 'the URL is reported while waiting');
    assert.equal(attempts, 3, 'it kept probing until the tunnel served');
  } finally {
    tunnel.stop();
  }
});

test('a URL that never serves is a failure, not a result', async () => {
  const binary = fakeBinary('never.sh', `${BANNER}\necho "ERR Failed to dial a quic connection"\nsleep 30`);
  await assert.rejects(
    startTunnel({ port: 4318, binary, readyTimeoutMs: 1500, verify: async () => false }),
    (error) => {
      assert.match(error.message, /never became reachable/);
      // cloudflared's own diagnosis is the useful part; it must survive.
      assert.match(error.message, /quic connection/i);
      return true;
    },
  );
});

test('a missing binary explains how to install it', async () => {
  await assert.rejects(startTunnel({ port: 4318, binary: path.join(dir, 'absent') }), (error) => {
    assert.equal(error.code, 'ENOENT');
    assert.match(error.message, /brew install cloudflared/);
    return true;
  });
});

test('a binary that dies reports its output instead of timing out', async () => {
  const binary = fakeBinary('dies.sh', 'echo "ERROR: something went wrong" >&2\nexit 1');
  await assert.rejects(startTunnel({ port: 4318, binary, urlTimeoutMs: 5000 }), (error) => {
    assert.match(error.message, /exited with code 1/);
    assert.match(error.message, /something went wrong/);
    return true;
  });
});

test('no URL within the window fails rather than hanging', async () => {
  const binary = fakeBinary('quiet.sh', 'sleep 30');
  await assert.rejects(startTunnel({ port: 4318, binary, urlTimeoutMs: 800 }), /no tunnel URL/);
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
