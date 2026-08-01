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
 *
 * By default cloudflared reaches the edge over QUIC, which is UDP. Plenty of
 * home routers, company networks and container runtimes drop outbound UDP while
 * letting TCP through, and cloudflared does not fall back on its own — it just
 * keeps retrying QUIC forever. Since that failure is both common and mechanical
 * to recover from, the second protocol is tried automatically rather than left
 * as a flag in the error message for the user to find.
 */

import { spawn } from 'node:child_process';

const URL_RE = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i;
const URL_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 2_000;

/** Tried in order; the first one that actually serves wins. */
const PROTOCOLS = [
  { flag: null, label: 'QUIC (UDP 7844)' },
  { flag: 'http2', label: 'HTTP/2 (TCP 7844)' },
];

// cloudflared retries the edge connection on its own, so a single failure line
// means nothing. Several in a row mean the path is blocked, not slow — that is
// worth abandoning early instead of sitting out the whole readiness window.
const EDGE_FAILURE_RE =
  /failed to dial to edge|failed to dial a quic connection|quic connection failed|connection is blocked or unreachable|allow outbound quic traffic/gi;
const EDGE_FAILURE_THRESHOLD = 4;

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
 * One tunnel attempt over one protocol. Rejects if the binary is missing, the
 * process dies, no URL appears, or the URL never starts serving. Only the last
 * of those is worth retrying over another protocol, so it is tagged
 * `edgeFailure` for the caller.
 */
async function attemptTunnel({
  port,
  binary,
  protocol,
  urlTimeoutMs,
  readyTimeoutMs,
  verify,
  onProgress,
}) {
  const args = ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`];
  if (protocol) args.push('--protocol', protocol);
  const child = spawn(binary, args, {
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

  // The URL arrives as output, so wait for it on the stream rather than polling:
  // a poll loop would keep a timer alive long after the URL was found and hold
  // the process open for the rest of its window.
  let announce = null;
  let urlTimer = null;
  const findUrl = new Promise((resolve, reject) => {
    announce = resolve;
    urlTimer = setTimeout(
      () => reject(fail(`cloudflared produced no tunnel URL within ${urlTimeoutMs} ms`)),
      urlTimeoutMs,
    );
  });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const collect = (chunk) => {
    output += chunk;
    const match = output.match(URL_RE);
    if (match) announce(match[0]);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);

  const spawnFailure = new Promise((_, reject) => {
    child.on('error', (error) =>
      reject(error.code === 'ENOENT' ? Object.assign(new Error(INSTALL_HINT), { code: 'ENOENT' }) : error),
    );
    // 'close' rather than 'exit': it fires once stdio has been drained, so the
    // diagnosis is complete. On 'exit' the last stderr chunk — usually the whole
    // reason the process died — may not have been delivered yet.
    child.on('close', (code) => {
      exited = true;
      reject(fail(`cloudflared exited with code ${code}`));
    });
  });

  let url;
  try {
    url = await Promise.race([findUrl, spawnFailure]);
  } finally {
    clearTimeout(urlTimer);
  }
  onProgress(url, protocol);

  // The URL exists; now wait for it to actually serve, which is what proves the
  // edge connection came up.
  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline && !exited) {
    if (await verify(url)) return { url, protocol, stop, process: child };
    if ((output.match(EDGE_FAILURE_RE) ?? []).length >= EDGE_FAILURE_THRESHOLD) break;
    await sleep(POLL_INTERVAL_MS);
  }
  throw Object.assign(fail(`the tunnel at ${url} never became reachable`), { edgeFailure: true });
}

/**
 * Start a quick tunnel to `port` and resolve once it is genuinely reachable,
 * falling back from QUIC to HTTP/2 if the edge connection cannot be made.
 * `protocol` pins one protocol and disables the fallback.
 */
export async function startTunnel({
  port,
  binary = 'cloudflared',
  protocol = null,
  urlTimeoutMs = URL_TIMEOUT_MS,
  readyTimeoutMs = READY_TIMEOUT_MS,
  verify = defaultVerify,
  onProgress = () => {},
  onFallback = () => {},
} = {}) {
  const attempts = protocol ? [{ flag: protocol, label: protocol }] : PROTOCOLS;

  for (const [index, attempt] of attempts.entries()) {
    try {
      return await attemptTunnel({
        port,
        binary,
        protocol: attempt.flag,
        urlTimeoutMs,
        readyTimeoutMs,
        verify,
        onProgress,
      });
    } catch (error) {
      const next = attempts[index + 1];
      // Anything but a blocked edge path — a missing binary, a crash — will fail
      // exactly the same way over the other protocol, so it is reported as is.
      if (!error.edgeFailure || !next) {
        if (error.edgeFailure) {
          error.message +=
            '\n\n  cloudflared needs outbound access to Cloudflare on port 7844. ' +
            'Both UDP (QUIC) and TCP (HTTP/2) were tried, so your network blocks the port itself.';
        }
        throw error;
      }
      onFallback(attempt, next);
    }
  }
}
