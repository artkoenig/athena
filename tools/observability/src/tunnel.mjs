/**
 * Cloudflare Quick Tunnel wrapper.
 *
 * Getting telemetry out of a cloud session needs a publicly reachable collector,
 * and a quick tunnel is the only way there that costs nothing and needs no
 * account. Driving it from inside the CLI means the endpoint, the token and the
 * env block are produced together and always agree — assembling them by hand
 * across three terminals is where this usually goes wrong.
 *
 * cloudflared prints its URL *before* it has connected to Cloudflare's edge, and
 * says so ("it may take some time to be reachable"). If the edge connection then
 * fails — a firewall blocking outbound 7844 is the common cause — that URL never
 * works. So the URL is not the ready signal: the tunnel counts as up only once a
 * request actually comes back through it.
 */

import { spawn } from 'node:child_process';

const URL_RE = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i;
const URL_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 2_000;

export const INSTALL_HINT = `cloudflared is not installed. Install it with one of:

    macOS          brew install cloudflared
    Debian/Ubuntu  curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cf.deb && sudo dpkg -i cf.deb
    other          https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

  Or point at a binary you already have:  --tunnel /path/to/cloudflared`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Health needs no token, which is what makes it usable as the readiness probe. */
async function defaultVerify(url) {
  try {
    const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(8000) });
    return response.ok;
  } catch {
    return false;
  }
}

/** cloudflared's own diagnostics are good; surface them instead of a bare failure. */
function diagnostics(output) {
  const lines = output
    .split('\n')
    .filter((line) => /ERR |ERROR:|FAIL /.test(line))
    .map((line) => line.replace(/^\S+\s+(INF|ERR|WRN)\s+/, '').replace(/\s*\|\s*$/, '').trim())
    .filter(Boolean);
  return [...new Set(lines)].slice(0, 6);
}

/**
 * Start a quick tunnel to `port` and resolve once it is genuinely reachable.
 * Rejects if the binary is missing, the process dies, no URL appears, or the URL
 * never starts serving.
 */
export async function startTunnel({
  port,
  binary = 'cloudflared',
  urlTimeoutMs = URL_TIMEOUT_MS,
  readyTimeoutMs = READY_TIMEOUT_MS,
  verify = defaultVerify,
  onProgress = () => {},
} = {}) {
  const child = spawn(binary, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // cloudflared is chatty and splits its banner across writes, so match against
  // everything seen so far rather than the current chunk.
  let output = '';
  let exited = false;
  const stop = () => {
    if (!child.killed) child.kill('SIGTERM');
  };
  const fail = (message) => {
    stop();
    const detail = diagnostics(output);
    return Object.assign(new Error(detail.length ? `${message}\n\n    ${detail.join('\n    ')}` : message), {
      output,
    });
  };

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const collect = (chunk) => {
    output += chunk;
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);

  const spawnFailure = new Promise((_, reject) => {
    child.on('error', (error) =>
      reject(error.code === 'ENOENT' ? Object.assign(new Error(INSTALL_HINT), { code: 'ENOENT' }) : error),
    );
    child.on('exit', (code) => {
      exited = true;
      reject(fail(`cloudflared exited with code ${code}`));
    });
  });

  const findUrl = (async () => {
    const deadline = Date.now() + urlTimeoutMs;
    while (Date.now() < deadline) {
      const match = output.match(URL_RE);
      if (match) return match[0];
      await sleep(200);
    }
    throw fail(`cloudflared produced no tunnel URL within ${urlTimeoutMs} ms`);
  })();

  const url = await Promise.race([findUrl, spawnFailure]);
  onProgress(url);

  // The URL exists; now wait for it to actually serve, which is what proves the
  // edge connection came up.
  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline && !exited) {
    if (await verify(url)) return { url, stop, process: child };
    await sleep(POLL_INTERVAL_MS);
  }
  throw fail(
    `the tunnel at ${url} never became reachable. cloudflared needs outbound access ` +
      'to Cloudflare on port 7844 (QUIC/UDP, or TCP with --protocol http2)',
  );
}
