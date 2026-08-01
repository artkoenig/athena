import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startTunnel } from '../src/tunnel.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-tunnel-'));

/**
 * Stand in for cloudflared so the tests never touch the network. The scripts
 * `exec` their final sleep so that SIGTERM reaches it — a forked sleep would
 * outlive the shell, hold the stdio pipes open and stall the whole suite.
 */
function fakeBinary(name, script) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return file;
}

const BANNER = `echo "Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):"
echo "https://fake-tunnel.trycloudflare.com"`;

test('resolves only once the URL actually serves, not when it is printed', async () => {
  const binary = fakeBinary('serves.sh', `${BANNER}\nexec sleep 30`);
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
  const binary = fakeBinary('never.sh', `${BANNER}\necho "ERR Failed to dial a quic connection"\nexec sleep 30`);
  await assert.rejects(
    startTunnel({ port: 4318, binary, readyTimeoutMs: 1500, verify: async () => false }),
    (error) => {
      assert.match(error.message, /never became reachable/);
      // cloudflared's own diagnosis is the useful part; it must survive.
      assert.match(error.message, /quic connection/i);
      assert.match(error.message, /port 7844/, 'the failure has to name what to unblock');
      return true;
    },
  );
});

// A quick tunnel uses QUIC by default and cloudflared never falls back on its
// own, so a network that drops outbound UDP would otherwise be a dead end.
const FALLBACK_BINARY = `case "$*" in
  *"--protocol http2"*)
    echo "https://over-tcp.trycloudflare.com" ;;
  *)
    echo "https://over-quic.trycloudflare.com"
    for i in 1 2 3 4 5 6; do echo "ERR Failed to dial a quic connection error=timeout"; done ;;
esac
exec sleep 30`;

test('falls back from QUIC to HTTP/2 when UDP is blocked', async () => {
  const binary = fakeBinary('fallback.sh', FALLBACK_BINARY);
  const notices = [];
  const tunnel = await startTunnel({
    port: 4318,
    binary,
    readyTimeoutMs: 20_000,
    onFallback: (failed, next) => notices.push([failed.label, next.label]),
    verify: async (url) => url.includes('over-tcp'),
  });
  try {
    assert.equal(tunnel.url, 'https://over-tcp.trycloudflare.com');
    assert.equal(tunnel.protocol, 'http2');
    assert.deepEqual(notices, [['QUIC (UDP 7844)', 'HTTP/2 (TCP 7844)']]);
  } finally {
    tunnel.stop();
  }
});

test('a blocked edge gives up on that protocol early instead of waiting it out', async () => {
  const binary = fakeBinary('blocked.sh', FALLBACK_BINARY);
  const started = Date.now();
  const tunnel = await startTunnel({
    port: 4318,
    binary,
    // Long enough that sitting out the window would be obvious in the elapsed time.
    readyTimeoutMs: 60_000,
    verify: async (url) => url.includes('over-tcp'),
  });
  const elapsed = Date.now() - started;
  tunnel.stop();
  assert.ok(elapsed < 15_000, `fell back after ${elapsed} ms; it should not wait out the window`);
});

test('--tunnel-protocol pins one transport and disables the fallback', async () => {
  const binary = fakeBinary('pinned.sh', FALLBACK_BINARY);
  const notices = [];
  await assert.rejects(
    startTunnel({
      port: 4318,
      binary,
      protocol: 'quic',
      readyTimeoutMs: 1500,
      onFallback: () => notices.push('fell back'),
      verify: async (url) => url.includes('over-tcp'),
    }),
    /never became reachable/,
  );
  assert.deepEqual(notices, [], 'a pinned protocol must not silently switch');
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
  const binary = fakeBinary('quiet.sh', 'exec sleep 30');
  await assert.rejects(startTunnel({ port: 4318, binary, urlTimeoutMs: 800 }), /no tunnel URL/);
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
