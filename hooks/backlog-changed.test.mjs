import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The hook under test. Resolved relative to this file so the suite runs the
// same way from a checkout and from a plugin cache.
const hook = fileURLToPath(new URL('./backlog-changed.mjs', import.meta.url));

// The four names that configure a telemetry collector. Stripped from every
// child's environment, then set explicitly per case, so a developer with a
// collector's env block evaluated in their shell never has this suite talking
// to their real collector.
const OTLP_ENV_NAMES = [
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_HEADERS',
  'UROBOROS_OBS_URL',
  'UROBOROS_OBS_TOKEN',
];

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const name of OTLP_ENV_NAMES) delete env[name];
  return { ...env, ...extra };
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-changed-'));
}

const stateOf = (extra = {}) => ({
  version: 1,
  issue: 'docs/issues/x',
  workflow: 'agile-loop',
  codemap: '',
  increments: [],
  run: { steps: [] },
  ...extra,
});

// Writes the state the way the recorder does — through a temp file and a
// rename — so what the hook reads is what a real change leaves behind.
function writeState(dir, state) {
  const file = path.join(dir, 'backlog.json');
  fs.writeFileSync(file + '.tmp', JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(file + '.tmp', file);
  return file;
}

// A real node:http server on 127.0.0.1:0, nothing mocked. Records every
// request as { method, url, headers, body } (body as the raw string) and
// answers 200 {"ok":true} unless `options.status` says otherwise;
// `options.hang: true` never answers at all.
function collectorStub(options = {}) {
  const { status = 200, hang = false } = options;
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      if (hang) return;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: status < 400 }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        // closeAllConnections() first: the never-answering case leaves a
        // socket open that a plain close() would wait on forever, hanging the
        // suite at exit instead of just this one server.
        close: () => new Promise((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
      });
    });
  });
}

// Spawns the hook the way Claude Code does — the event as JSON on stdin — and
// resolves to { code, stdout, stderr }. `input` goes in verbatim, so a case
// can hand it something that is not JSON at all.
function runHook(input, env) {
  const child = spawn(hook, [], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  return new Promise((resolve) => {
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

const event = (file, extra = {}) => ({
  session_id: 'session-1',
  transcript_path: '/dev/null',
  cwd: '/home/someone/project',
  permission_mode: 'default',
  hook_event_name: 'FileChanged',
  file_path: file,
  change_type: 'modified',
  ...extra,
});

test('with no collector in the environment nothing is sent, and nothing is said', async () => {
  const dir = tmpDir();
  const file = writeState(dir, stateOf());
  const stub = await collectorStub();
  try {
    const result = await runHook(event(file), cleanEnv());

    assert.equal(result.code, 0, 'telemetry being off is the ordinary case, not a failure');
    assert.equal(result.stderr, '', 'an unconfigured collector is not worth a line in the debug log');
    assert.equal(stub.requests.length, 0, 'a reachable but unnamed collector receives nothing at all');
  } finally {
    await stub.close();
  }
});

test('a changed run state is posted whole to the collector, identified by the issue it names', async () => {
  const dir = tmpDir();
  const file = writeState(dir, stateOf({ increments: [{ id: 'i1', status: 'todo' }], running: { label: 'research:i1.0' } }));
  const stub = await collectorStub();
  try {
    const result = await runHook(event(file), cleanEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: stub.url }));

    assert.equal(result.code, 0);
    assert.equal(stub.requests.length, 1);
    const req = stub.requests[0];
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/api/runs', "the send lands on the collector's run-state endpoint");
    assert.match(req.headers['content-type'] || '', /application\/json/);

    const sent = JSON.parse(req.body);
    assert.equal(sent.id, 'docs/issues/x', 'the run is identified by the issue the state names');
    assert.deepEqual(sent.state, JSON.parse(fs.readFileSync(file, 'utf8')), 'the collector gets the file exactly as it stands');
    assert.equal(sent.state.running.label, 'research:i1.0', 'the step in flight reaches the collector while it is still in flight');
  } finally {
    await stub.close();
  }
});

test('a state that names no issue is filed under the directory it lives in, never under nothing', async () => {
  const dir = tmpDir();
  const file = writeState(dir, stateOf({ issue: '' }));
  const stub = await collectorStub();
  try {
    await runHook(event(file), cleanEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: stub.url }));

    assert.equal(stub.requests.length, 1);
    assert.equal(JSON.parse(stub.requests[0].body).id, dir);
  } finally {
    await stub.close();
  }
});

test('a created state is sent like a modified one — the opening cut is a change too', async () => {
  const dir = tmpDir();
  const file = writeState(dir, stateOf());
  const stub = await collectorStub();
  try {
    await runHook(event(file, { change_type: 'created' }), cleanEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: stub.url }));

    assert.equal(stub.requests.length, 1, 'the first write of a run is the one a watching human is most waiting for');
  } finally {
    await stub.close();
  }
});

test('a deleted state sends nothing and withdraws nothing', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'backlog.json');
  const stub = await collectorStub();
  try {
    const result = await runHook(event(file, { change_type: 'deleted' }), cleanEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: stub.url }));

    assert.equal(result.code, 0);
    assert.equal(stub.requests.length, 0, 'the collector keeps the last version it was given, which is what a finished run should read as');
  } finally {
    await stub.close();
  }
});

test('a file that is not a run state is not sent, however the matcher was read', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'backlogXjson');
  fs.writeFileSync(file, JSON.stringify(stateOf()));
  const stub = await collectorStub();
  try {
    const result = await runHook(event(file), cleanEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: stub.url }));

    assert.equal(result.code, 0);
    assert.equal(stub.requests.length, 0, 'the matcher is a pattern the CLI applies; this is the guarantee');
    assert.match(result.stderr, /not a run state/);
  } finally {
    await stub.close();
  }
});

test('an input that is not JSON, and one that names no file, cost the run nothing', async () => {
  const stub = await collectorStub();
  try {
    const env = cleanEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: stub.url });

    const garbage = await runHook('not json at all', env);
    assert.equal(garbage.code, 0);
    assert.match(garbage.stderr, /not JSON/);

    const nameless = await runHook({ hook_event_name: 'FileChanged', change_type: 'modified' }, env);
    assert.equal(nameless.code, 0);
    assert.match(nameless.stderr, /no file_path/);

    assert.equal(stub.requests.length, 0);
  } finally {
    await stub.close();
  }
});

test('a state that is gone or does not parse is skipped, and the write that follows sends it', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'backlog.json');
  const stub = await collectorStub();
  try {
    const env = cleanEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: stub.url });

    const missing = await runHook(event(file), env);
    assert.equal(missing.code, 0);
    assert.match(missing.stderr, /cannot read/);

    fs.writeFileSync(file, '{ "issue": "docs/issu');
    const half = await runHook(event(file), env);
    assert.equal(half.code, 0);
    assert.match(half.stderr, /cannot read/);
    assert.equal(stub.requests.length, 0);

    writeState(dir, stateOf());
    const whole = await runHook(event(file), env);
    assert.equal(whole.code, 0);
    assert.equal(whole.stderr, '');
    assert.equal(stub.requests.length, 1, 'the next change sends the whole document, so nothing is lost by skipping');
  } finally {
    await stub.close();
  }
});

test('the token in the OTLP headers variable rides as the bearer header', async () => {
  const dir = tmpDir();
  const file = writeState(dir, stateOf());
  const stub = await collectorStub();
  try {
    await runHook(event(file), cleanEnv({
      OTEL_EXPORTER_OTLP_ENDPOINT: stub.url,
      OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer s3cret',
    }));

    assert.equal(stub.requests.length, 1);
    assert.equal(stub.requests[0].headers.authorization, 'Bearer s3cret', 'the OTLP headers variable configures this send exactly as it configures every other exporter uroboros already has');
  } finally {
    await stub.close();
  }
});

test('UROBOROS_OBS_URL and UROBOROS_OBS_TOKEN configure the send when the OTLP names are absent', async () => {
  const dir = tmpDir();
  const file = writeState(dir, stateOf());
  const stub = await collectorStub();
  try {
    await runHook(event(file), cleanEnv({ UROBOROS_OBS_URL: stub.url, UROBOROS_OBS_TOKEN: 'env-secret' }));

    assert.equal(stub.requests.length, 1);
    assert.equal(stub.requests[0].url, '/api/runs');
    assert.equal(stub.requests[0].headers.authorization, 'Bearer env-secret');
  } finally {
    await stub.close();
  }
});

test('a collector that refuses the state, that refuses the connection, or that never answers, all exit 0', async () => {
  const dir = tmpDir();
  const file = writeState(dir, stateOf());

  const refusing = await collectorStub({ status: 500 });
  try {
    const result = await runHook(event(file), cleanEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: refusing.url }));
    assert.equal(result.code, 0, 'a 500 is the collector\'s problem, never the run\'s');
    assert.equal(refusing.requests.length, 1, 'the send did reach it — it is the answer that is being tolerated, not a skipped send');
    assert.match(result.stderr, /answered 500/);
  } finally {
    await refusing.close();
  }

  // Claim a free port and give it straight back: it now refuses outright.
  // Using a just-closed port rather than a fixed one keeps this case from
  // colliding with whatever else is listening on this machine.
  const gone = await collectorStub();
  const deadUrl = gone.url;
  await gone.close();
  const refused = await runHook(event(file), cleanEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: deadUrl }));
  assert.equal(refused.code, 0);
  assert.match(refused.stderr, /send failed/);

  const hanging = await collectorStub({ hang: true });
  try {
    const result = await runHook(event(file), cleanEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: hanging.url }));
    // No wall-clock assertion: a spawn's duration measures process start and
    // the machine's load. What matters is that it ends at all — a hook that
    // waited on the collector forever would hang this suite, not fail it.
    assert.equal(result.code, 0);
    assert.equal(hanging.requests.length, 1, 'this is a stall on the response, not a hook that skipped sending');
    assert.match(result.stderr, /send failed/);
  } finally {
    await hanging.close();
  }
});

test('nothing is ever written to stdout: a hook that prints is a hook whose output has to be parsed', async () => {
  const dir = tmpDir();
  const file = writeState(dir, stateOf());
  const stub = await collectorStub();
  try {
    const sent = await runHook(event(file), cleanEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: stub.url }));
    const quiet = await runHook(event(file), cleanEnv());

    assert.equal(sent.stdout, '');
    assert.equal(quiet.stdout, '');
  } finally {
    await stub.close();
  }
});
