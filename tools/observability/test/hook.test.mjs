import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TelemetryStore } from '../src/store.mjs';
import { createServer } from '../src/server.mjs';
import { collectorFrom, deriveName } from '../hooks/session-name.mjs';

const HOOK = new URL('../hooks/session-name.mjs', import.meta.url).pathname;

/** Run the hook the way Claude Code does: JSON on stdin, environment inherited. */
async function runHook(input, env) {
  const child = execFile(process.execPath, [HOOK], { env: { PATH: process.env.PATH, ...env } });
  child.stdin.end(JSON.stringify(input));
  await once(child, 'close');
}

async function withServer(options, run) {
  const store = new TelemetryStore();
  const server = createServer({ store, endpoint: 'http://test', log: () => {}, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({ base, store });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('the hook names the session it is told about', async () => {
  await withServer({}, async ({ base, store }) => {
    await runHook(
      { hook_event_name: 'SessionStart', session_id: 'hooked', cwd: process.cwd() },
      { OTEL_EXPORTER_OTLP_ENDPOINT: base, ATHENA_OBS_SESSION_NAME: 'from the hook' },
    );
    assert.equal(store.getSession('hooked').name, 'from the hook');
  });
});

test('the hook authenticates with the token the session already exports with', async () => {
  await withServer({ token: 'secret' }, async ({ base, store }) => {
    await runHook(
      { hook_event_name: 'SessionStart', session_id: 'hooked-auth', cwd: process.cwd() },
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: base,
        OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer secret',
        ATHENA_OBS_SESSION_NAME: 'authenticated',
      },
    );
    assert.equal(store.getSession('hooked-auth').name, 'authenticated');
  });
});

test('a session that is not being monitored is left alone', async () => {
  await withServer({}, async ({ store }) => {
    // No endpoint in the environment: telemetry is off, so there is nothing to name.
    await runHook({ hook_event_name: 'SessionStart', session_id: 'unmonitored', cwd: process.cwd() }, {});
    assert.equal(store.sessions.size, 0);
  });
});

test('an unreachable collector does not fail the session start', async () => {
  // Port 1 is not listening; the hook must still exit cleanly and print nothing.
  const child = execFile(process.execPath, [HOOK], {
    env: { PATH: process.env.PATH, OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1' },
  });
  child.stdin.end(JSON.stringify({ session_id: 'nowhere', cwd: process.cwd() }));
  let stdout = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  const [code] = await once(child, 'close');
  assert.equal(code, 0);
  assert.equal(stdout, '');
});

test('names are derived from repository and branch, and fall back to the directory', () => {
  const name = deriveName(process.cwd(), {});
  const [repo, branch] = name.split(' · ');
  assert.equal(repo, 'athena');
  assert.ok(branch, 'a checked-out branch is part of the name');

  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-obs-hook-'));
  assert.equal(deriveName(outside, {}), path.basename(outside));
  assert.equal(deriveName(outside, { ATHENA_OBS_SESSION_NAME: 'explicit' }), 'explicit');
});

test('the collector is read from the exporter variables, token included', () => {
  assert.equal(collectorFrom({}), null);
  assert.deepEqual(
    collectorFrom({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318/',
      OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer abc123',
    }),
    { endpoint: 'http://localhost:4318', token: 'abc123' },
  );
  assert.deepEqual(collectorFrom({ ATHENA_OBS_URL: 'http://elsewhere:9000' }), {
    endpoint: 'http://elsewhere:9000',
    token: null,
  });
});
