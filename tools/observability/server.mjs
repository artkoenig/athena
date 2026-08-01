/**
 * Entrypoint for platforms that capture a Node HTTP server instead of running a
 * command — Vercel looks for exactly this filename and routes to whatever
 * `listen()` binds. The CLI in bin/ stays the way to run this locally; it owns
 * flags, the tunnel and the reachability check, none of which mean anything on
 * a platform that hands you a URL.
 *
 * Read the warning below before deploying this to Vercel. It runs, but what it
 * can promise there is much less than what it promises anywhere else.
 */

import { TelemetryStore } from './src/store.mjs';
import { JsonlPersistence } from './src/persist.mjs';
import { createServer } from './src/server.mjs';
import { endpointFor, resolveConfig } from './src/config.mjs';

// The platform decides the address; a loopback default would make the service
// unreachable through its own router, so this entrypoint binds wide by default
// where the CLI deliberately does not.
const config = resolveConfig({}, { ATHENA_OBS_HOST: '0.0.0.0', ...process.env });
const endpoint = endpointFor(config);

const store = new TelemetryStore(config);
if (config.persist) {
  const persistence = new JsonlPersistence(config.persist, {
    maxBytes: config.persistMaxBytes,
    log: (message) => console.error(message),
  });
  const restored = await persistence.load(store);
  persistence.attach(store);
  console.error(`athena-observe: persisting to ${config.persist}` + (restored ? ` (replayed ${restored})` : ''));
}

if (!config.token) {
  console.error('athena-observe: WARNING — no ATHENA_OBS_TOKEN set. Anyone who finds this URL can');
  console.error('  push telemetry into it and read yours back.');
}

// Fluid compute shares one instance between concurrent invocations, so the store
// does survive from request to request — but that is an optimization, not a
// guarantee. Vercel scales instances out under load and reclaims them when idle,
// and there is no disk to fall back on. Two instances means two partial pictures
// of the same session, and an SSE client attached to one never learns about
// telemetry that landed on the other. Say so at boot rather than letting someone
// discover it as missing sessions.
if (process.env.VERCEL && !config.persist) {
  console.error('athena-observe: WARNING — on Vercel this keeps its data only in the instance that');
  console.error('  happens to serve the request. Expect history to vanish when the instance is');
  console.error('  recycled and sessions to split when more than one is running. Fine for watching');
  console.error('  a session live; not a record. See "Selbst hosten" in the README.');
}

const server = createServer({ store, token: config.token, endpoint: () => endpoint });
server.listen(config.port, config.host, () => {
  console.error(`athena-observe listening on ${endpoint} (bound to ${config.host}:${config.port})`);
});
