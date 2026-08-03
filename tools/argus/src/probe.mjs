/**
 * Reachability check for a collector, meant to be run from wherever the agent
 * runs — a cloud session container, a CI job, another machine on the LAN.
 *
 * The OTLP exporter fails silently by design: if the endpoint is wrong, blocked
 * by a network policy or rejecting the token, the agent keeps working and simply
 * never reports. That leaves "nothing shows up in the UI" with no way to tell
 * which of those it was. This walks the same path the exporter takes and says
 * which step broke.
 */

import crypto from 'node:crypto';

import { encodeMessage } from './otlp/protobuf.mjs';
import { EXPORT_TRACE_REQUEST } from './otlp/schema.mjs';

const DEFAULT_TIMEOUT_MS = 15_000;

function probePayload(sessionId, traceId) {
  const now = BigInt(Date.now()) * 1_000_000n;
  const attr = (key, stringValue) => ({ key, value: { stringValue } });
  return encodeMessage(
    {
      resourceSpans: [
        {
          resource: {
            attributes: [attr('service.name', 'argus-check'), attr('session.id', sessionId)],
          },
          scopeSpans: [
            {
              spans: [
                {
                  traceId,
                  spanId: crypto.randomBytes(8).toString('hex'),
                  name: 'argus.check',
                  startTimeUnixNano: now,
                  endTimeUnixNano: now + 1_000_000n,
                  attributes: [attr('session.id', sessionId)],
                },
              ],
            },
          ],
        },
      ],
    },
    EXPORT_TRACE_REQUEST,
  );
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Walk the export path against `endpoint` and report each step. Resolves rather
 * than throws — a failed check is a result, not an error.
 */
export async function probeCollector(endpoint, { token = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const base = String(endpoint).trim().replace(/\/+$/, '');
  const steps = [];
  const record = (name, ok, detail) => {
    steps.push({ name, ok, detail });
    return ok;
  };

  // 1. Is anything listening, and is it us? /api/health needs no token, so a 401
  //    here means something else is answering on that URL.
  let reachable = false;
  try {
    const response = await fetchWithTimeout(`${base}/api/health`, {}, timeoutMs);
    const body = await response.text();
    // An access gate in front of the collector answers every request with a
    // redirect to its own login, so the exporter uploads spans to a sign-in page
    // and gets HTML back — which it discards without a word. Landing on another
    // host is the giveaway, and worth naming: no amount of fixing the token or
    // the endpoint helps while requests never arrive.
    const landed = new URL(response.url);
    const asked = new URL(base);
    if (landed.host !== asked.host) {
      record(
        'reachable',
        false,
        `${base} redirects to ${landed.host} — an access gate is answering instead of the collector. ` +
          'Turn it off for this service, or give the agent its bypass token as an extra OTLP header',
      );
    } else if (!response.ok) {
      record('reachable', false, `${base}/api/health answered HTTP ${response.status}`);
    } else if (!body.includes('"ok"')) {
      record('reachable', false, `${base} answered, but it is not an argus collector`);
    } else {
      reachable = record('reachable', true, `${base} is an argus collector`);
    }
  } catch (error) {
    const cause = error.name === 'AbortError' ? `no answer within ${timeoutMs} ms` : error.message;
    record('reachable', false, `cannot reach ${base}: ${cause}`);
  }
  if (!reachable) return { ok: false, endpoint: base, steps };

  // 2. Is it one collector or several? The store is in memory, so a URL served
  //    by more than one process is not a slower collector, it is a broken one:
  //    each instance sees the subset of telemetry that happened to be routed to
  //    it, and a reload picks one at random. That reads as sessions appearing
  //    and disappearing, which is a hard thing to diagnose from the outside and
  //    an easy one to measure — sequential requests tend to stick to a single
  //    instance, so the requests have to overlap for the split to show.
  try {
    const seen = new Set();
    const replies = await Promise.all(
      Array.from({ length: 8 }, () =>
        fetchWithTimeout(`${base}/api/health`, {}, timeoutMs)
          .then((response) => response.json())
          .catch(() => null),
      ),
    );
    for (const reply of replies) if (reply?.instance) seen.add(reply.instance);
    if (seen.size > 1) {
      record(
        'single',
        false,
        `${seen.size} instances answer this URL, each with its own memory — telemetry will appear and vanish. ` +
          'Pin the service to one instance, or move it to a platform that runs one process',
      );
    } else if (seen.size === 1) {
      record('single', true, 'one collector process answers this URL');
    }
    // No instance id at all means an older collector; silence beats a wrong verdict.
  } catch {
    // A failure here says nothing about the export path, which is what this
    // command is for. Leave the step out rather than fail a working collector.
  }

  // 3. Push a real OTLP span the same way the exporter would.
  const sessionId = `athena-check-${crypto.randomBytes(4).toString('hex')}`;
  const traceId = crypto.randomBytes(16).toString('hex');
  const headers = { 'content-type': 'application/x-protobuf' };
  if (token) headers.authorization = `Bearer ${token}`;

  let accepted = false;
  try {
    const response = await fetchWithTimeout(
      `${base}/v1/traces`,
      { method: 'POST', headers, body: probePayload(sessionId, traceId) },
      timeoutMs,
    );
    if (response.status === 401) {
      record('ingest', false, token ? 'token rejected' : 'collector requires a token, none given');
    } else if (!response.ok) {
      record('ingest', false, `POST /v1/traces answered HTTP ${response.status}`);
    } else {
      accepted = record('ingest', true, 'OTLP span accepted');
    }
  } catch (error) {
    record('ingest', false, `POST /v1/traces failed: ${error.message}`);
  }
  if (!accepted) return { ok: false, endpoint: base, steps };

  // 4. Read it back, so this proves storage and not just a 200.
  try {
    const url = `${base}/api/sessions?search=${encodeURIComponent(sessionId)}${token ? `&token=${encodeURIComponent(token)}` : ''}`;
    const response = await fetchWithTimeout(url, {}, timeoutMs);
    if (!response.ok) {
      record('stored', false, `GET /api/sessions answered HTTP ${response.status}`);
    } else {
      const body = await response.json();
      const found = (body.items ?? []).some((item) => item.id === sessionId);
      record('stored', found, found ? `probe session ${sessionId} is in the store` : 'span accepted but not stored');
    }
  } catch (error) {
    record('stored', false, `GET /api/sessions failed: ${error.message}`);
  }

  return { ok: steps.every((step) => step.ok), endpoint: base, sessionId, steps };
}
