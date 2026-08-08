import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

// The CLI under test. Resolved relative to this file so the suite runs the
// same way from a checkout, a plugin cache or an installing project.
const cli = fileURLToPath(new URL('./backlog.mjs', import.meta.url));

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-'));
}

function writeJson(dir, name, value) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

// The four names the recorder's best-effort send reads. Stripped from every
// pre-existing case's environment so a developer with argus env evaluated in
// their shell never has this suite talking to a real collector.
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

function run(args) {
  return execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: cleanEnv() });
}

// Runs the CLI expecting it to exit non-zero, and returns the error object
// (`status`, `stdout`, `stderr`) instead of letting the throw escape. If the
// call unexpectedly succeeds, that is itself the test failure.
function runFails(args) {
  try {
    execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: cleanEnv() });
  } catch (err) {
    if (err.status !== undefined) return err;
    throw err;
  }
  throw new Error('expected `' + args.join(' ') + '` to exit non-zero, it exited 0');
}

// Spawned asynchronously so the event loop stays free to answer a
// collectorStub in this same process — execFileSync would block that loop
// and every send would hit its own timeout. Resolves to { stdout, stderr };
// rejects on a non-zero exit or on the 10s child timeout expiring.
function runAsync(args, env, options = {}) {
  return execFileAsync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env,
    timeout: 10000,
    ...options,
  });
}

// A real node:http server on 127.0.0.1:0, nothing mocked. Records every
// request it receives as { method, url, headers, body } (body as the raw
// string) and by default answers 200 {"ok":true}; `options.status` and
// `options.body` answer something else, `options.headers` adds response
// headers, and `options.hang: true` never answers at all — the socket is
// left open for the recorder's own abort to give up on.
function collectorStub(options = {}) {
  const { status = 200, body = { ok: true }, headers = {}, hang = false } = options;
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
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        // closeAllConnections() first: the never-answering case leaves a
        // socket open that a plain close() would wait on forever, hanging
        // the suite at exit instead of just this one server.
        close: () => new Promise((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
      });
    });
  });
}

const backlogTemplate = (increments) => ({
  issue: 'docs/issues/x',
  workflow: 'agile-loop',
  increments,
});

const incrementPayload = (id, title, extra = {}) => ({
  id,
  title,
  goal: title + '.',
  criteria: ['does ' + id],
  status: 'todo',
  note: '',
  ...extra,
});

test('init creates a fresh backlog.json in the documented shape', () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  const payload = backlogTemplate([
    incrementPayload('i1', 'First increment'),
    incrementPayload('i2', 'Second increment'),
  ]);
  const payloadFile = writeJson(dir, 'init-payload.json', payload);

  run(['init', backlogPath, payloadFile]);

  const content = fs.readFileSync(backlogPath, 'utf8');
  assert.equal(content.endsWith('\n'), true, 'the file must end with a trailing newline');
  const backlog = JSON.parse(content);
  assert.equal(backlog.version, 1);
  assert.equal(backlog.issue, payload.issue);
  assert.equal(backlog.workflow, payload.workflow);
  assert.equal(backlog.increments.length, 2);
  for (const [i, wanted] of payload.increments.entries()) {
    const got = backlog.increments[i];
    assert.equal(got.id, wanted.id);
    assert.equal(got.title, wanted.title);
    assert.equal(got.goal, wanted.goal);
    assert.deepEqual(got.criteria, wanted.criteria);
    assert.equal(got.status, wanted.status);
    assert.equal(got.note, wanted.note);
    assert.deepEqual(got.steps, [], 'a freshly written increment carries no steps yet');
  }
  assert.deepEqual(backlog.run.steps, []);
});

test('init merges into an existing backlog: kept increments keep their steps, dropped ones vanish, new ones start empty, run.steps is untouched', () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  const firstPayload = backlogTemplate([
    incrementPayload('i1', 'Kept'),
    incrementPayload('i2', 'Dropped'),
  ]);
  run(['init', backlogPath, writeJson(dir, 'first.json', firstPayload)]);

  // Give i1 a recorded step and the run itself a step, so the merge's
  // preservation rule has something to preserve.
  run(['record', backlogPath, 'i1', 'research:i1.0', writeJson(dir, 'step.json', { plan: 'PLAN-MARKER' })]);
  run(['record', backlogPath, '-', 'decompose', writeJson(dir, 'run-step.json', { summary: 'opened' })]);

  const secondPayload = backlogTemplate([
    incrementPayload('i1', 'Kept'),
    incrementPayload('i3', 'New'),
  ]);
  run(['init', backlogPath, writeJson(dir, 'second.json', secondPayload)]);

  const backlog = JSON.parse(fs.readFileSync(backlogPath, 'utf8'));
  assert.equal(backlog.increments.length, 2);
  const i1 = backlog.increments.find((i) => i.id === 'i1');
  assert.equal(i1.steps.length, 1, 'the increment kept across a merge keeps the step it already recorded');
  assert.equal(i1.steps[0].label, 'research:i1.0');
  assert.equal(backlog.increments.some((i) => i.id === 'i2'), false, 'an increment absent from the new payload is dropped');
  const i3 = backlog.increments.find((i) => i.id === 'i3');
  assert.ok(i3, 'the increment new to the payload is present');
  assert.deepEqual(i3.steps, []);
  assert.equal(backlog.run.steps.length, 1, 'run.steps is preserved untouched by a later init');
  assert.equal(backlog.run.steps[0].label, 'decompose');
});

test('init stores the payload codemap at the top level, and a fresh init without one stores the empty string', () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  const withMap = { ...backlogTemplate([incrementPayload('i1', 'First')]), codemap: 'a.js — the parser' };

  run(['init', backlogPath, writeJson(dir, 'with-map.json', withMap)]);
  assert.equal(JSON.parse(fs.readFileSync(backlogPath, 'utf8')).codemap, 'a.js — the parser');

  const freshPath = path.join(dir, 'fresh.json');
  run(['init', freshPath, writeJson(dir, 'no-map.json', backlogTemplate([incrementPayload('i1', 'First')]))]);
  assert.equal(JSON.parse(fs.readFileSync(freshPath, 'utf8')).codemap, '', 'a backlog opened without a codemap carries the empty string, not undefined');
});

test('a re-cut without a codemap keeps the one already in the file, and one with a codemap replaces it', () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  run(['init', backlogPath, writeJson(dir, 'first.json', {
    ...backlogTemplate([incrementPayload('i1', 'First')]),
    codemap: 'a.js — the parser',
  })]);

  run(['init', backlogPath, writeJson(dir, 'silent.json', backlogTemplate([incrementPayload('i1', 'First')]))]);
  assert.equal(JSON.parse(fs.readFileSync(backlogPath, 'utf8')).codemap, 'a.js — the parser', 'an init payload that says nothing about the codemap cannot erase it');

  run(['init', backlogPath, writeJson(dir, 'replacing.json', {
    ...backlogTemplate([incrementPayload('i1', 'First')]),
    codemap: 'a.js — the parser\nb.js — its one caller',
  })]);
  assert.equal(JSON.parse(fs.readFileSync(backlogPath, 'utf8')).codemap, 'a.js — the parser\nb.js — its one caller');
});

test('close sheds step returns and leaves the codemap standing', () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  run(['init', backlogPath, writeJson(dir, 'init.json', {
    ...backlogTemplate([incrementPayload('i1', 'First')]),
    codemap: 'a.js — the parser',
  })]);
  run(['record', backlogPath, 'i1', 'research:i1.0', writeJson(dir, 'step.json', { plan: 'x' })]);

  run(['branch', backlogPath, 'i1', 'issue-branch--i1']);

  run(['close', backlogPath, 'i1', 'done']);

  const backlog = JSON.parse(fs.readFileSync(backlogPath, 'utf8'));
  assert.deepEqual(backlog.increments[0].steps, []);
  assert.equal(backlog.codemap, 'a.js — the parser', 'the codemap is run-level state, not a step return the close may shed');
  assert.equal(backlog.increments[0].branch, 'issue-branch--i1', "the increment's branch survives its close — a blocked increment's unmerged branch stays findable");
});

test('record appends a step to the named increment and prints only the confirmation, nothing from the file', () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  run(['init', backlogPath, writeJson(dir, 'init.json', backlogTemplate([
    incrementPayload('i1', 'First'),
    // A marker that exists in the file but not in the payload being
    // recorded, so leaking the file into stdout is caught by its absence.
    incrementPayload('i2', 'MARKER-IN-FILE-NOT-PAYLOAD'),
  ]))]);

  const payload = { plan: 'PLAN-MARKER', summary: 'plan summary' };
  const stdout = run(['record', backlogPath, 'i1', 'research:i1.0', writeJson(dir, 'payload.json', payload)]);

  assert.equal(stdout.trim().split('\n').length, 1, 'record prints exactly one line');
  assert.match(stdout, /research:i1\.0/, 'the confirmation names the label it recorded');
  assert.equal(stdout.includes('MARKER-IN-FILE-NOT-PAYLOAD'), false, 'record must print nothing from the file it wrote to — only the confirmation');

  const backlog = JSON.parse(fs.readFileSync(backlogPath, 'utf8'));
  const i1 = backlog.increments.find((i) => i.id === 'i1');
  assert.equal(i1.steps.length, 1);
  assert.equal(i1.steps[0].label, 'research:i1.0');
  assert.match(i1.steps[0].at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'at is an ISO timestamp');
  assert.deepEqual(i1.steps[0].return, payload);
});

test('recording the same label twice replaces the entry instead of duplicating it', () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  run(['init', backlogPath, writeJson(dir, 'init.json', backlogTemplate([incrementPayload('i1', 'First')]))]);

  run(['record', backlogPath, 'i1', 'research:i1.0', writeJson(dir, 'first.json', { plan: 'first attempt' })]);
  run(['record', backlogPath, 'i1', 'research:i1.0', writeJson(dir, 'second.json', { plan: 'second attempt' })]);

  const backlog = JSON.parse(fs.readFileSync(backlogPath, 'utf8'));
  const i1 = backlog.increments.find((i) => i.id === 'i1');
  assert.equal(i1.steps.length, 1, 'a repeated step after a crash replaces its own earlier entry, it does not pile up');
  assert.equal(i1.steps[0].return.plan, 'second attempt');
});

test('record with an increment id of "-" lands the step in run.steps and touches no increment', () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  run(['init', backlogPath, writeJson(dir, 'init.json', backlogTemplate([incrementPayload('i1', 'First')]))]);

  run(['record', backlogPath, '-', 'decompose', writeJson(dir, 'payload.json', { summary: 'opened' })]);

  const backlog = JSON.parse(fs.readFileSync(backlogPath, 'utf8'));
  assert.equal(backlog.run.steps.length, 1);
  assert.equal(backlog.run.steps[0].label, 'decompose');
  assert.deepEqual(backlog.increments[0].steps, [], "run.steps and an increment's steps are separate arrays");
});

test('record against an increment id no increment has exits 1 and leaves the file untouched', () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  run(['init', backlogPath, writeJson(dir, 'init.json', backlogTemplate([incrementPayload('i1', 'First')]))]);
  const before = fs.readFileSync(backlogPath, 'utf8');

  const err = runFails(['record', backlogPath, 'nope', 'research:nope.0', writeJson(dir, 'payload.json', { plan: 'x' })]);

  assert.equal(err.status, 1);
  assert.ok(err.stderr && err.stderr.length > 0, 'a message on stderr explains what went wrong');
  assert.equal(fs.readFileSync(backlogPath, 'utf8'), before, 'the file is byte-identical to before the failed call');
});

test('record against a path with no file exits 1 and creates nothing', () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');

  const err = runFails(['record', backlogPath, 'i1', 'research:i1.0', writeJson(dir, 'payload.json', { plan: 'x' })]);

  assert.equal(err.status, 1);
  assert.equal(fs.existsSync(backlogPath), false);
});

test('branch records the branch on the named increment and prints only the confirmation, nothing from the file', () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  run(['init', backlogPath, writeJson(dir, 'init.json', backlogTemplate([
    incrementPayload('i1', 'First'),
    incrementPayload('i2', 'MARKER-IN-FILE-NOT-PAYLOAD'),
  ]))]);

  const stdout = run(['branch', backlogPath, 'i1', 'issue-branch--i1']);

  assert.equal(stdout.trim().split('\n').length, 1, 'branch prints exactly one line');
  assert.match(stdout, /issue-branch--i1/, 'the confirmation names the branch it recorded');
  assert.equal(stdout.includes('MARKER-IN-FILE-NOT-PAYLOAD'), false, 'branch must print nothing from the file it wrote to — only the confirmation');

  const backlog = JSON.parse(fs.readFileSync(backlogPath, 'utf8'));
  assert.equal(backlog.increments.find((i) => i.id === 'i1').branch, 'issue-branch--i1');
  assert.equal(backlog.increments.find((i) => i.id === 'i2').branch, '', 'the other increment keeps the empty branch init gave it');
});

test('branch recorded a second time replaces the name — the fresh-attempt case, not an error', () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  run(['init', backlogPath, writeJson(dir, 'init.json', backlogTemplate([incrementPayload('i1', 'First')]))]);

  run(['branch', backlogPath, 'i1', 'issue-branch--i1']);
  run(['branch', backlogPath, 'i1', 'issue-branch--i1-take2']);

  const backlog = JSON.parse(fs.readFileSync(backlogPath, 'utf8'));
  assert.equal(backlog.increments[0].branch, 'issue-branch--i1-take2');
});

test('branch against an increment id no increment has exits 1 and leaves the file untouched', () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  run(['init', backlogPath, writeJson(dir, 'init.json', backlogTemplate([incrementPayload('i1', 'First')]))]);
  const before = fs.readFileSync(backlogPath, 'utf8');

  const err = runFails(['branch', backlogPath, 'nope', 'issue-branch--nope']);

  assert.equal(err.status, 1);
  assert.equal(fs.readFileSync(backlogPath, 'utf8'), before, 'the file is byte-identical to before the failed call');
});

test('a re-cut keeps a recorded increment branch, and the init payload cannot set one', () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  run(['init', backlogPath, writeJson(dir, 'init.json', backlogTemplate([incrementPayload('i1', 'First')]))]);
  run(['branch', backlogPath, 'i1', 'issue-branch--i1']);

  run(['init', backlogPath, writeJson(dir, 'recut.json', backlogTemplate([
    incrementPayload('i1', 'First'),
    incrementPayload('i2', 'Second', { branch: 'smuggled-branch' }),
  ]))]);

  const backlog = JSON.parse(fs.readFileSync(backlogPath, 'utf8'));
  assert.equal(backlog.increments.find((i) => i.id === 'i1').branch, 'issue-branch--i1', 'an init payload that says nothing about the branch cannot erase it');
  assert.equal(backlog.increments.find((i) => i.id === 'i2').branch, '', 'the branch subcommand is the one writer — a payload branch is ignored');
});

test("close sets status and note and empties only the closed increment's steps", () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  run(['init', backlogPath, writeJson(dir, 'init.json', backlogTemplate([
    incrementPayload('i1', 'First'),
    incrementPayload('i2', 'Second'),
  ]))]);
  run(['record', backlogPath, 'i1', 'research:i1.0', writeJson(dir, 'p1.json', { plan: 'x' })]);
  run(['record', backlogPath, 'i2', 'research:i2.0', writeJson(dir, 'p2.json', { plan: 'y' })]);

  run(['close', backlogPath, 'i1', 'done', 'the review accepted it']);

  const backlog = JSON.parse(fs.readFileSync(backlogPath, 'utf8'));
  const i1 = backlog.increments.find((i) => i.id === 'i1');
  const i2 = backlog.increments.find((i) => i.id === 'i2');
  assert.equal(i1.status, 'done');
  assert.equal(i1.note, 'the review accepted it');
  assert.deepEqual(i1.steps, [], "closing sheds the increment's own step returns");
  assert.equal(i2.steps.length, 1, "closing one increment leaves another increment's steps alone");
});

test("close sheds the returns of the run's own steps and keeps their labels", () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  run(['init', backlogPath, writeJson(dir, 'init.json', backlogTemplate([
    incrementPayload('i1', 'First'),
    incrementPayload('i2', 'Second'),
  ]))]);
  // A run-level step return (decompose's, the whole cut) is the largest
  // payload backlog.json ever holds and belongs to no single increment, so
  // it is the one this case marks and checks for.
  const decomposePayload = {
    increments: [incrementPayload('i1', 'First'), incrementPayload('i2', 'Second')],
    summary: 'MARKER-RUN-STEP-RETURN',
  };
  run(['record', backlogPath, '-', 'decompose', writeJson(dir, 'decompose.json', decomposePayload)]);
  run(['record', backlogPath, 'i1', 'research:i1.0', writeJson(dir, 'research.json', { plan: 'x' })]);

  run(['close', backlogPath, 'i1', 'done', 'the review accepted it']);

  const raw = fs.readFileSync(backlogPath, 'utf8');
  const backlog = JSON.parse(raw);
  assert.equal(backlog.run.steps.length, 1, "closing sheds the run step's return, not the entry itself — the label stays so resume still skips it");
  assert.equal(backlog.run.steps[0].label, 'decompose');
  assert.match(backlog.run.steps[0].at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'at is still an ISO timestamp after the shed');
  assert.equal(Object.prototype.hasOwnProperty.call(backlog.run.steps[0], 'return'), false, 'the shed run step carries no return key at all');
  assert.equal(raw.includes('MARKER-RUN-STEP-RETURN'), false, 'the sizable run-level payload is gone from the file on disk, not just absent from one parsed field');
});

test('closing a second increment leaves the already-shed run steps shed', () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  run(['init', backlogPath, writeJson(dir, 'init.json', backlogTemplate([
    incrementPayload('i1', 'First'),
    incrementPayload('i2', 'Second'),
  ]))]);
  const decomposePayload = {
    increments: [incrementPayload('i1', 'First'), incrementPayload('i2', 'Second')],
    summary: 'MARKER-RUN-STEP-RETURN',
  };
  run(['record', backlogPath, '-', 'decompose', writeJson(dir, 'decompose.json', decomposePayload)]);
  run(['record', backlogPath, 'i1', 'research:i1.0', writeJson(dir, 'research1.json', { plan: 'x' })]);
  run(['close', backlogPath, 'i1', 'done']);

  run(['record', backlogPath, 'i2', 'research:i2.0', writeJson(dir, 'research2.json', { plan: 'y' })]);
  run(['close', backlogPath, 'i2', 'done']);

  const backlog = JSON.parse(fs.readFileSync(backlogPath, 'utf8'));
  assert.equal(backlog.run.steps.length, 1, 'a second close does not re-grow the run steps the first close already shed');
  assert.equal(Object.prototype.hasOwnProperty.call(backlog.run.steps[0], 'return'), false, 'the run step shed by the first close stays shed after the second');
});

test('close on a backlog that carries no run key exits 0 and writes the status', () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  // Written by hand, not by init, so it matches a backlog that predates the
  // run key entirely — the crash risk the shed's own fix could introduce.
  fs.writeFileSync(backlogPath, JSON.stringify({
    version: 1,
    issue: 'docs/issues/x',
    workflow: 'agile-loop',
    increments: [
      { id: 'i1', title: 'First', goal: 'First.', criteria: ['does i1'], status: 'todo', note: '', steps: [] },
    ],
  }));

  const stdout = run(['close', backlogPath, 'i1', 'done']);

  assert.equal(stdout.trim().split('\n').length, 1, 'close prints exactly one confirmation line');
  assert.match(stdout, /closed i1 as done/, 'the confirmation names the increment and the status it was closed with');
  const backlog = JSON.parse(fs.readFileSync(backlogPath, 'utf8'));
  assert.equal(backlog.increments[0].status, 'done');
});

test('close with a status outside done|blocked|dropped exits 1 and leaves the file untouched', () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  run(['init', backlogPath, writeJson(dir, 'init.json', backlogTemplate([incrementPayload('i1', 'First')]))]);
  const before = fs.readFileSync(backlogPath, 'utf8');

  const err = runFails(['close', backlogPath, 'i1', 'finished']);

  assert.equal(err.status, 1);
  assert.equal(fs.readFileSync(backlogPath, 'utf8'), before);
});

test("read prints the file's exact content", () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  run(['init', backlogPath, writeJson(dir, 'init.json', backlogTemplate([incrementPayload('i1', 'First')]))]);

  const stdout = run(['read', backlogPath]);

  assert.equal(stdout, fs.readFileSync(backlogPath, 'utf8'), 'read must reproduce the file byte for byte');
});

test('read on a missing file exits 1 and prints nothing on stdout', () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');

  const err = runFails(['read', backlogPath]);

  assert.equal(err.status, 1);
  assert.equal(err.stdout || '', '');
});

test('a successful record leaves no .tmp file behind', () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  run(['init', backlogPath, writeJson(dir, 'init.json', backlogTemplate([incrementPayload('i1', 'First')]))]);

  run(['record', backlogPath, 'i1', 'research:i1.0', writeJson(dir, 'payload.json', { plan: 'x' })]);

  assert.equal(fs.existsSync(backlogPath + '.tmp'), false, 'the atomic write via rename leaves nothing behind after a successful call');
});

// The best-effort push to a collector. Shared mechanics across every
// subcommand that writes, not one command's own rules, so it sits here at
// the end rather than inside any one command's block.

test('every write sends the document it just wrote to the collector, and read sends nothing', async () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  const stub = await collectorStub();
  try {
    const env = cleanEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: stub.url });

    await runAsync(['init', backlogPath, writeJson(dir, 'init.json', backlogTemplate([incrementPayload('i1', 'First')]))], env);
    const afterInit = fs.readFileSync(backlogPath, 'utf8');

    await runAsync(['record', backlogPath, 'i1', 'research:i1.0', writeJson(dir, 'step.json', { plan: 'x' })], env);
    const afterRecord = fs.readFileSync(backlogPath, 'utf8');

    await runAsync(['branch', backlogPath, 'i1', 'some-branch'], env);
    const afterBranch = fs.readFileSync(backlogPath, 'utf8');

    await runAsync(['close', backlogPath, 'i1', 'done', 'accepted'], env);
    const afterClose = fs.readFileSync(backlogPath, 'utf8');

    await runAsync(['read', backlogPath], env);

    assert.equal(stub.requests.length, 4, 'read must add no fifth request — it never writes, so it never sends');

    const expectedAfter = [afterInit, afterRecord, afterBranch, afterClose];
    for (const [i, req] of stub.requests.entries()) {
      assert.equal(req.method, 'POST', `request ${i} is a POST`);
      assert.equal(req.url, '/api/runs', `request ${i} lands on the collector's run-state endpoint`);
      assert.match(req.headers['content-type'] || '', /application\/json/, `request ${i} carries a JSON content-type`);
      const sent = JSON.parse(req.body);
      assert.equal(sent.id, 'docs/issues/x', `request ${i} identifies the run by the issue the state names`);
      assert.deepEqual(sent.state, JSON.parse(expectedAfter[i]), `request ${i}'s state is exactly the file as it stood right after that write`);
    }

    const closedState = JSON.parse(stub.requests[3].body).state;
    assert.equal(closedState.increments[0].status, 'done', "the fourth request's state carries close's own effect");
    assert.deepEqual(closedState.increments[0].steps, [], 'the shed is in what the collector gets, not just in the file');
  } finally {
    await stub.close();
  }
});

test('the confirmation lines and the exit codes are unchanged with a collector configured', async () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  const stub = await collectorStub();
  try {
    const env = cleanEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: stub.url });

    const init = await runAsync(['init', backlogPath, writeJson(dir, 'init.json', backlogTemplate([incrementPayload('i1', 'First')]))], env);
    assert.equal(init.stdout, `wrote ${backlogPath} with 1 increment(s)\n`);
    assert.equal(init.stderr, '');

    const record = await runAsync(['record', backlogPath, 'i1', 'research:i1.0', writeJson(dir, 'step.json', { plan: 'x' })], env);
    assert.equal(record.stdout, 'recorded research:i1.0\n');
    assert.equal(record.stderr, '');

    const branch = await runAsync(['branch', backlogPath, 'i1', 'some-branch'], env);
    assert.equal(branch.stdout, 'recorded branch some-branch on i1\n');
    assert.equal(branch.stderr, '');

    const close = await runAsync(['close', backlogPath, 'i1', 'done'], env);
    assert.equal(close.stdout, 'closed i1 as done\n');
    assert.equal(close.stderr, '');
  } finally {
    await stub.close();
  }
});

test('the token in the OTLP headers variable rides as the bearer header', async () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  const stub = await collectorStub();
  try {
    const env = cleanEnv({
      OTEL_EXPORTER_OTLP_ENDPOINT: stub.url,
      OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer s3cret',
    });

    await runAsync(['init', backlogPath, writeJson(dir, 'init.json', backlogTemplate([incrementPayload('i1', 'First')]))], env);

    assert.equal(stub.requests.length, 1);
    assert.equal(stub.requests[0].headers.authorization, 'Bearer s3cret', 'the OTLP headers variable configures the send, exactly as it configures every other exporter uroboros already has');
  } finally {
    await stub.close();
  }
});

test('UROBOROS_OBS_URL and UROBOROS_OBS_TOKEN configure the send when the OTLP names are absent', async () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  const stub = await collectorStub();
  try {
    const env = cleanEnv({ UROBOROS_OBS_URL: stub.url, UROBOROS_OBS_TOKEN: 'env-secret' });

    await runAsync(['init', backlogPath, writeJson(dir, 'init.json', backlogTemplate([incrementPayload('i1', 'First')]))], env);

    assert.equal(stub.requests.length, 1);
    assert.equal(stub.requests[0].url, '/api/runs');
    assert.equal(stub.requests[0].headers.authorization, 'Bearer env-secret');
  } finally {
    await stub.close();
  }
});

test('with no collector in the environment nothing is sent', async () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  const stub = await collectorStub();
  try {
    const env = cleanEnv();

    const init = await runAsync(['init', backlogPath, writeJson(dir, 'init.json', backlogTemplate([incrementPayload('i1', 'First')]))], env);
    assert.equal(init.stdout, `wrote ${backlogPath} with 1 increment(s)\n`);
    assert.equal(init.stderr, '');

    const record = await runAsync(['record', backlogPath, 'i1', 'research:i1.0', writeJson(dir, 'step.json', { plan: 'x' })], env);
    assert.equal(record.stdout, 'recorded research:i1.0\n');
    assert.equal(record.stderr, '');

    assert.equal(stub.requests.length, 0, 'a reachable but unconfigured collector receives nothing at all');
    const backlog = JSON.parse(fs.readFileSync(backlogPath, 'utf8'));
    assert.equal(backlog.increments[0].steps[0].label, 'research:i1.0', 'the write itself still happens with no collector configured');
  } finally {
    await stub.close();
  }
});

test('a collector that refuses the connection costs neither the exit code nor a word of output', async () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  // Start a stub to claim a free port, then close it: the port now refuses
  // the connection outright. Using a just-closed port rather than a fixed
  // one keeps this case from colliding with whatever else is listening on
  // this machine.
  const stub = await collectorStub();
  const url = stub.url;
  await stub.close();

  const env = cleanEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: url });

  const init = await runAsync(['init', backlogPath, writeJson(dir, 'init.json', backlogTemplate([incrementPayload('i1', 'First')]))], env);
  assert.equal(init.stdout, `wrote ${backlogPath} with 1 increment(s)\n`);
  assert.equal(init.stderr, '');

  const record = await runAsync(['record', backlogPath, 'i1', 'research:i1.0', writeJson(dir, 'step.json', { plan: 'x' })], env);
  assert.equal(record.stdout, 'recorded research:i1.0\n');
  assert.equal(record.stderr, '');

  const backlog = JSON.parse(fs.readFileSync(backlogPath, 'utf8'));
  assert.equal(backlog.increments[0].steps[0].label, 'research:i1.0');
});

test('a collector that never answers costs at most a short wait, and nothing else', async () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  // init happens with no collector configured — only the record under test
  // is sent to the hanging stub, so a stray init request cannot mask what
  // the assertion below is checking.
  run(['init', backlogPath, writeJson(dir, 'init.json', backlogTemplate([incrementPayload('i1', 'First')]))]);

  const stub = await collectorStub({ hang: true });
  try {
    const env = cleanEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: stub.url });
    const record = await runAsync(['record', backlogPath, 'i1', 'research:i1.0', writeJson(dir, 'step.json', { plan: 'x' })], env);
    // No wall-clock assertion: a spawn's duration measures process start and
    // the machine's load, not the recorder. What matters is that the call
    // resolves at all — the 10s child timeout given to runAsync is the only
    // clock here, and it is far looser than the recorder's own bound (a ~2s
    // abort on the send). A recorder that waited on the collector forever
    // would show up here as a killed child and a thrown promise, not as a
    // hang of the suite.
    assert.equal(record.stdout, 'recorded research:i1.0\n', 'the call resolves well inside the 10s child timeout');
    assert.equal(record.stderr, '');
    assert.equal(stub.requests.length, 1, 'the send did reach the collector — this is a stall on the response, not a recorder that skipped sending');
  } finally {
    await stub.close();
  }
});

test('a collector that refuses the state leaves the exit code and the confirmation line alone', async () => {
  const refusals = [
    { status: 500, body: { error: 'internal' }, headers: {} },
    { status: 401, body: { error: 'unauthorized' }, headers: { 'www-authenticate': 'Bearer' } },
  ];
  for (const { status, body, headers } of refusals) {
    const dir = tmpDir();
    const backlogPath = path.join(dir, 'backlog.json');
    run(['init', backlogPath, writeJson(dir, 'init.json', backlogTemplate([incrementPayload('i1', 'First')]))]);

    const stub = await collectorStub({ status, body, headers });
    try {
      const env = cleanEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: stub.url });
      const record = await runAsync(['record', backlogPath, 'i1', 'research:i1.0', writeJson(dir, 'step.json', { plan: 'x' })], env);

      assert.equal(record.stdout, 'recorded research:i1.0\n', `a collector answering ${status} still leaves the confirmation line untouched`);
      assert.equal(record.stderr, '');
      assert.equal(stub.requests.length, 1, `the send did reach the collector — it is the ${status} response that is being tolerated, not a skipped send`);
      const backlog = JSON.parse(fs.readFileSync(backlogPath, 'utf8'));
      assert.equal(backlog.increments[0].steps[0].label, 'research:i1.0', `the write to disk stands regardless of the collector's ${status}`);
    } finally {
      await stub.close();
    }
  }
});
