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
// rename — so what the hook reads is what a real write leaves behind.
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
// resolves to { code, stdout, stderr }. `input` goes in verbatim when it is a
// string, so a case can hand it something that is not JSON at all.
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

// A well-formed PostToolUse payload for a Bash call, common fields included.
// `agent_id` and `agent_type` are there because every write of a run state is
// made by a subagent, and that is the shape the hook actually meets.
const event = (command, extra = {}) => ({
  session_id: 'session-1',
  transcript_path: '/dev/null',
  cwd: '/nonexistent-cwd',
  permission_mode: 'default',
  agent_id: 'agent-7',
  agent_type: 'uroboros:implementer',
  hook_event_name: 'PostToolUse',
  tool_name: 'Bash',
  tool_input: { command },
  tool_response: 'recorded implement:i1.0\n',
  tool_use_id: 'toolu_1',
  ...extra,
});

// The recorder is always invoked like this, with the helper's own path in
// front and the state's path as the first argument of the subcommand.
const recordCall = (file) =>
  `node "/plugins/uroboros/skills/agent-brief/assets/backlog.mjs" record ${file} i1 implement:i1.0 /tmp/return.json`;

test('with no collector in the environment nothing is sent, and nothing is said', async () => {
  const dir = tmpDir();
  const file = writeState(dir, stateOf());
  const stub = await collectorStub();
  try {
    const result = await runHook(event(recordCall(file)), cleanEnv());

    assert.equal(result.code, 0, 'telemetry being off is the ordinary case, not a failure');
    assert.equal(result.stderr, '', 'an unconfigured collector is not worth a line in the debug log');
    assert.equal(stub.requests.length, 0, 'a reachable but unnamed collector receives nothing at all');
  } finally {
    await stub.close();
  }
});

test('a write of the run state is posted whole to the collector, identified by the issue it names', async () => {
  const dir = tmpDir();
  const file = writeState(dir, stateOf({ increments: [{ id: 'i1', status: 'todo' }], running: { label: 'research:i1.0' } }));
  const stub = await collectorStub();
  try {
    const result = await runHook(event(recordCall(file)), cleanEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: stub.url }));

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
    await runHook(event(recordCall(file)), cleanEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: stub.url }));

    assert.equal(stub.requests.length, 1);
    assert.equal(JSON.parse(stub.requests[0].body).id, dir);
  } finally {
    await stub.close();
  }
});

test('a path relative to the command is resolved against the directory the tool ran in, not this process', async () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'docs', 'issues', 'x'), { recursive: true });
  writeState(path.join(dir, 'docs', 'issues', 'x'), stateOf());
  const stub = await collectorStub();
  try {
    const result = await runHook(
      event('node backlog.mjs record docs/issues/x/backlog.json i1 implement:i1.0 /tmp/r.json', { cwd: dir }),
      cleanEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: stub.url }),
    );

    assert.equal(result.code, 0);
    assert.equal(stub.requests.length, 1, "a relative path is how an agent actually writes it, and the event's cwd is the only thing that can resolve it");
  } finally {
    await stub.close();
  }
});

test('a state unchanged since the last send is not sent again, so the reads of a run cost nothing', async () => {
  const dir = tmpDir();
  const file = writeState(dir, stateOf());
  const stub = await collectorStub();
  try {
    const env = cleanEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: stub.url });

    await runHook(event(recordCall(file)), env);
    assert.equal(stub.requests.length, 1, 'the write is sent');

    // What a run does between two writes: index, steps, codemap — every one of
    // them a Bash call naming the state, and not one of them a change.
    await runHook(event(`node backlog.mjs index ${file}`), env);
    await runHook(event(`node backlog.mjs steps ${file} i1 research:i1.0 --fields plan`), env);
    await runHook(event(`node backlog.mjs codemap ${file}`), env);
    assert.equal(stub.requests.length, 1, 'a read names the state and changes nothing, so it must not reach the collector');

    writeState(dir, stateOf({ increments: [{ id: 'i1', status: 'done' }] }));
    await runHook(event(recordCall(file)), env);
    assert.equal(stub.requests.length, 2, 'the next real write is sent');
    assert.equal(JSON.parse(stub.requests[1].body).state.increments[0].status, 'done');
  } finally {
    await stub.close();
  }
});

test('a send the collector refused is retried by the next call, not remembered as delivered', async () => {
  const dir = tmpDir();
  const file = writeState(dir, stateOf());
  const refusing = await collectorStub({ status: 500 });
  try {
    const result = await runHook(event(recordCall(file)), cleanEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: refusing.url }));
    assert.equal(result.code, 0, "a 500 is the collector's problem, never the run's");
    assert.match(result.stderr, /answered 500/);

    // Same bytes, and it goes again: the memo is written only once the
    // collector has actually taken the document.
    await runHook(event(recordCall(file)), cleanEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: refusing.url }));
    assert.equal(refusing.requests.length, 2);
  } finally {
    await refusing.close();
  }
});

test('a Bash call that never mentions a run state is dropped without a word', async () => {
  const dir = tmpDir();
  writeState(dir, stateOf());
  const stub = await collectorStub();
  try {
    const env = cleanEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: stub.url });

    for (const command of ['npm test', 'git commit -m "backlog"', 'node backlog.mjs --help']) {
      const result = await runHook(event(command), env);
      assert.equal(result.code, 0);
      assert.equal(result.stderr, '', `\`${command}\` is the overwhelming majority of Bash calls and must cost nothing at all`);
    }
    assert.equal(stub.requests.length, 0);
  } finally {
    await stub.close();
  }
});

test('the half-written file the recorder renames away is not mistaken for the state', async () => {
  const dir = tmpDir();
  const file = writeState(dir, stateOf());
  fs.writeFileSync(file + '.tmp', '{ "issue": "docs/issu');
  const stub = await collectorStub();
  try {
    const result = await runHook(event(`cat ${file}.tmp`), cleanEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: stub.url }));

    assert.equal(result.code, 0);
    assert.equal(stub.requests.length, 0, 'backlog.json.tmp is not backlog.json, and the boundary in the pattern is what says so');
  } finally {
    await stub.close();
  }
});

test('a tool that is not Bash is dropped, however the matcher was read', async () => {
  const dir = tmpDir();
  const file = writeState(dir, stateOf());
  const stub = await collectorStub();
  try {
    const result = await runHook(
      event(recordCall(file), { tool_name: 'Read', tool_input: { file_path: file } }),
      cleanEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: stub.url }),
    );

    assert.equal(result.code, 0);
    assert.equal(stub.requests.length, 0, 'the matcher is a pattern the CLI applies; this is the guarantee');
  } finally {
    await stub.close();
  }
});

test('an input that is not JSON costs the run nothing', async () => {
  const stub = await collectorStub();
  try {
    const result = await runHook('not json at all', cleanEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: stub.url }));

    assert.equal(result.code, 0);
    assert.match(result.stderr, /not JSON/);
    assert.equal(stub.requests.length, 0);
  } finally {
    await stub.close();
  }
});

test('a state that is not there, and one that does not parse, are skipped and the write that follows sends it', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'backlog.json');
  const stub = await collectorStub();
  try {
    const env = cleanEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: stub.url });

    // The opening cut announces itself before `init` has written anything.
    const missing = await runHook(event(`node backlog.mjs start ${file} - decompose /tmp/p.txt`), env);
    assert.equal(missing.code, 0);
    assert.match(missing.stderr, /cannot read/);

    fs.writeFileSync(file, '{ "issue": "docs/issu');
    const half = await runHook(event(recordCall(file)), env);
    assert.equal(half.code, 0);
    assert.match(half.stderr, /does not parse/);
    assert.equal(stub.requests.length, 0);

    writeState(dir, stateOf());
    const whole = await runHook(event(recordCall(file)), env);
    assert.equal(whole.code, 0);
    assert.equal(whole.stderr, '');
    assert.equal(stub.requests.length, 1, 'the next write sends the whole document, so nothing is lost by skipping');
  } finally {
    await stub.close();
  }
});

test('the token in the OTLP headers variable rides as the bearer header', async () => {
  const dir = tmpDir();
  const file = writeState(dir, stateOf());
  const stub = await collectorStub();
  try {
    await runHook(event(recordCall(file)), cleanEnv({
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
    await runHook(event(recordCall(file)), cleanEnv({ UROBOROS_OBS_URL: stub.url, UROBOROS_OBS_TOKEN: 'env-secret' }));

    assert.equal(stub.requests.length, 1);
    assert.equal(stub.requests[0].url, '/api/runs');
    assert.equal(stub.requests[0].headers.authorization, 'Bearer env-secret');
  } finally {
    await stub.close();
  }
});

test('a collector that refuses the connection, and one that never answers, both exit 0', async () => {
  const dir = tmpDir();
  const file = writeState(dir, stateOf());

  // Claim a free port and give it straight back: it now refuses outright.
  // Using a just-closed port rather than a fixed one keeps this case from
  // colliding with whatever else is listening on this machine.
  const gone = await collectorStub();
  const deadUrl = gone.url;
  await gone.close();
  const refused = await runHook(event(recordCall(file)), cleanEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: deadUrl }));
  assert.equal(refused.code, 0);
  assert.match(refused.stderr, /send failed/);

  const hanging = await collectorStub({ hang: true });
  try {
    const result = await runHook(event(recordCall(file)), cleanEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: hanging.url }));
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
    const sent = await runHook(event(recordCall(file)), cleanEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: stub.url }));
    const quiet = await runHook(event('npm test'), cleanEnv());

    assert.equal(sent.stdout, '');
    assert.equal(quiet.stdout, '');
  } finally {
    await stub.close();
  }
});
