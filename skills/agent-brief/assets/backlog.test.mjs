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

// The four names that configure a telemetry collector. The recorder reads
// none of them any more — the case at the end of this file is what pins that —
// and they are stripped from every other case's environment so a developer
// with a collector's env block evaluated in their shell cannot have this suite
// talking to it either.
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
// collectorStub in this same process — execFileSync would block that loop, and
// a request the stub never got round to recording would look exactly like the
// silence the case at the end of this file is asserting. Resolves to
// { stdout, stderr }; rejects on a non-zero exit or on the 10s child timeout.
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
// string) and answers 200 {"ok":true}. It exists for one case: a collector
// that is genuinely there, genuinely reachable and genuinely listening, and
// that the recorder still never contacts.
function collectorStub() {
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
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        // closeAllConnections() first, so a keep-alive socket cannot hang
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

test('close ends the attempt without losing it, and leaves the codemap standing', () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  run(['init', backlogPath, writeJson(dir, 'init.json', {
    ...backlogTemplate([incrementPayload('i1', 'First')]),
    codemap: 'a.js — the parser',
  })]);
  run(['record', backlogPath, 'i1', 'research:i1.0', writeJson(dir, 'step.json', { plan: 'MARKER-CLOSED-PLAN' })]);

  run(['branch', backlogPath, 'i1', 'issue-branch--i1']);

  run(['close', backlogPath, 'i1', 'done']);

  const raw = fs.readFileSync(backlogPath, 'utf8');
  const backlog = JSON.parse(raw);
  assert.deepEqual(backlog.increments[0].steps, [], 'the closed attempt leaves no current step, so a hand-back is worked again rather than skipped');
  assert.equal(backlog.increments[0].attempts.length, 1, 'the attempt it closed is kept');
  assert.equal(backlog.increments[0].attempts[0].closedAs, 'done', 'the archived attempt carries the status it closed with');
  assert.equal(backlog.increments[0].attempts[0].steps[0].label, 'research:i1.0');
  assert.equal(raw.includes('MARKER-CLOSED-PLAN'), true, 'nothing a close touches is deleted — the step return is still in the file for whoever reads the run afterwards');
  assert.equal(backlog.codemap, 'a.js — the parser', 'the codemap is run-level state, untouched by a close');
  assert.equal(backlog.increments[0].branch, 'issue-branch--i1', "the increment's branch survives its close — a blocked increment's unmerged branch stays findable");
});

// `start` — the step in flight. Its whole job is to be visible while a step is
// being worked, so these cases pin what it writes, that a record clears it, and
// that it can never be the thing that stops an agent.

test('start writes the step in flight with its increment, its label and an ISO instant, and prints only the confirmation', () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  run(['init', backlogPath, writeJson(dir, 'init.json', backlogTemplate([
    incrementPayload('i1', 'First'),
    incrementPayload('i2', 'MARKER-IN-FILE-NOT-PAYLOAD'),
  ]))]);

  const stdout = run(['start', backlogPath, 'i1', 'research:i1.0']);

  assert.equal(stdout.trim().split('\n').length, 1, 'start prints exactly one line');
  assert.match(stdout, /research:i1\.0/, 'the confirmation names the label it announced');
  assert.equal(stdout.includes('MARKER-IN-FILE-NOT-PAYLOAD'), false, 'start must print nothing from the file it wrote to');

  const backlog = JSON.parse(fs.readFileSync(backlogPath, 'utf8'));
  assert.equal(backlog.running.label, 'research:i1.0');
  assert.equal(backlog.running.increment, 'i1');
  assert.match(backlog.running.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'at is an ISO timestamp');
  assert.equal(Object.prototype.hasOwnProperty.call(backlog.running, 'prompt'), false, 'no prompt file means no prompt key');
  assert.deepEqual(backlog.increments.find((i) => i.id === 'i1').steps, [], 'a start records no step: it announces one, and the step is recorded when it returns');
});

test('start stores the dispatch prompt verbatim, which is where a watching human reads the goal and the criteria', () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  run(['init', backlogPath, writeJson(dir, 'init.json', backlogTemplate([incrementPayload('i1', 'First')]))]);

  const prompt = 'Goal: build the thing.\n\nCriteria:\n  - it works\n  - "quoted" & <angled>\n';
  const promptPath = path.join(dir, 'prompt.txt');
  fs.writeFileSync(promptPath, prompt);
  run(['start', backlogPath, 'i1', 'build:i1.0', promptPath]);

  const backlog = JSON.parse(fs.readFileSync(backlogPath, 'utf8'));
  assert.equal(backlog.running.prompt, prompt, 'the prompt is stored byte for byte, newlines and punctuation included');
});

test('start with an increment id of "-" announces a run-level step and names no increment', () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  run(['init', backlogPath, writeJson(dir, 'init.json', backlogTemplate([incrementPayload('i1', 'First')]))]);

  run(['start', backlogPath, '-', 'replan:i1']);

  const backlog = JSON.parse(fs.readFileSync(backlogPath, 'utf8'));
  assert.equal(backlog.running.increment, '', 'the run-level scope is an empty increment, never the literal dash');
  assert.equal(backlog.running.label, 'replan:i1');
});

test('a start replaces the one before it: a run works one step at a time, so the marker is one slot', () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  run(['init', backlogPath, writeJson(dir, 'init.json', backlogTemplate([incrementPayload('i1', 'First')]))]);

  run(['start', backlogPath, 'i1', 'research:i1.0']);
  run(['start', backlogPath, 'i1', 'tests:i1.0']);

  const backlog = JSON.parse(fs.readFileSync(backlogPath, 'utf8'));
  assert.equal(backlog.running.label, 'tests:i1.0', 'the later start is the one that stands');
});

test('recording a step clears its own running marker, and leaves another step\'s alone', () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  run(['init', backlogPath, writeJson(dir, 'init.json', backlogTemplate([incrementPayload('i1', 'First')]))]);

  run(['start', backlogPath, 'i1', 'research:i1.0']);
  run(['record', backlogPath, 'i1', 'research:i1.0', writeJson(dir, 'p.json', { plan: 'x' })]);

  let backlog = JSON.parse(fs.readFileSync(backlogPath, 'utf8'));
  assert.equal(Object.prototype.hasOwnProperty.call(backlog, 'running'), false, 'the step landed, so the state stops saying it is running');

  run(['start', backlogPath, 'i1', 'tests:i1.0']);
  run(['record', backlogPath, 'i1', 'research:i1.0', writeJson(dir, 'q.json', { plan: 'y' })]);

  backlog = JSON.parse(fs.readFileSync(backlogPath, 'utf8'));
  assert.equal(backlog.running.label, 'tests:i1.0', 'a record for some other label must not clear the marker of the step still in flight');
});

test('a re-cut keeps the step in flight — init runs inside a planner step, and would otherwise erase its own marker', () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  run(['init', backlogPath, writeJson(dir, 'init.json', backlogTemplate([incrementPayload('i1', 'First')]))]);
  run(['start', backlogPath, '-', 'replan:i1']);

  run(['init', backlogPath, writeJson(dir, 'recut.json', backlogTemplate([
    incrementPayload('i1', 'First'),
    incrementPayload('i2', 'Second'),
  ]))]);

  const backlog = JSON.parse(fs.readFileSync(backlogPath, 'utf8'));
  assert.equal(backlog.running.label, 'replan:i1', 'the planner is still working, and the state still says so');
});

test('start against an increment id no increment has exits 1 and leaves the file untouched', () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  run(['init', backlogPath, writeJson(dir, 'init.json', backlogTemplate([incrementPayload('i1', 'First')]))]);
  const before = fs.readFileSync(backlogPath, 'utf8');

  const err = runFails(['start', backlogPath, 'nope', 'research:nope.0']);
  assert.equal(err.status, 1);
  assert.match(err.stderr, /no increment "nope"/);
  assert.equal(fs.readFileSync(backlogPath, 'utf8'), before, 'a start that names nothing real changes nothing');
});

test('start before the state exists exits 0 and creates nothing: the opening cut has nothing to attach to', () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');

  const stdout = run(['start', backlogPath, '-', 'decompose']);

  assert.match(stdout, /no backlog/, 'it says why it announced nothing');
  assert.equal(fs.existsSync(backlogPath), false, '`init` is the only opener — a start must never create the file');
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

test('recording the same label twice supersedes the entry instead of duplicating it, and keeps the earlier one as history', () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  run(['init', backlogPath, writeJson(dir, 'init.json', backlogTemplate([incrementPayload('i1', 'First')]))]);

  run(['record', backlogPath, 'i1', 'research:i1.0', writeJson(dir, 'first.json', { plan: 'first attempt' })]);
  run(['record', backlogPath, 'i1', 'research:i1.0', writeJson(dir, 'second.json', { plan: 'second attempt' })]);
  run(['record', backlogPath, 'i1', 'research:i1.0', writeJson(dir, 'third.json', { plan: 'third attempt' })]);

  const backlog = JSON.parse(fs.readFileSync(backlogPath, 'utf8'));
  const i1 = backlog.increments.find((i) => i.id === 'i1');
  assert.equal(i1.steps.length, 1, 'a repeated step after a crash supersedes its own earlier entry, it does not pile up beside it');
  assert.equal(i1.steps[0].return.plan, 'third attempt', 'the current entry is the last one written');
  assert.deepEqual(
    i1.steps[0].history.map((h) => h.return.plan),
    ['first attempt', 'second attempt'],
    'every superseded entry is kept, oldest first',
  );
  assert.equal(
    i1.steps[0].history.some((h) => Object.prototype.hasOwnProperty.call(h, 'history')),
    false,
    'history is flat: an archived entry does not carry a history of its own',
  );
});

test('record stores the dispatch prompt verbatim beside the return when it is given one', () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  run(['init', backlogPath, writeJson(dir, 'init.json', backlogTemplate([incrementPayload('i1', 'First')]))]);

  // Not JSON, and not escaped by the caller: the prompt goes in as text, which
  // is what keeps a multi-thousand-character prompt from being corrupted on
  // its way into the file.
  const prompt = 'Issue directory: docs/issues/x\nRead `steps` first.\n  - a "quoted" line\n';
  const promptFile = path.join(dir, 'prompt.txt');
  fs.writeFileSync(promptFile, prompt);

  run(['record', backlogPath, 'i1', 'research:i1.0', writeJson(dir, 'payload.json', { plan: 'x' }), promptFile]);

  const backlog = JSON.parse(fs.readFileSync(backlogPath, 'utf8'));
  assert.equal(backlog.increments[0].steps[0].prompt, prompt, 'the prompt is stored byte for byte');
});

test('record without a prompt file stores no prompt key at all', () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  run(['init', backlogPath, writeJson(dir, 'init.json', backlogTemplate([incrementPayload('i1', 'First')]))]);

  run(['record', backlogPath, 'i1', 'research:i1.0', writeJson(dir, 'payload.json', { plan: 'x' })]);

  const step = JSON.parse(fs.readFileSync(backlogPath, 'utf8')).increments[0].steps[0];
  assert.equal(Object.prototype.hasOwnProperty.call(step, 'prompt'), false);
});

test('record with a prompt file that is not there exits 2 and leaves the file untouched', () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  run(['init', backlogPath, writeJson(dir, 'init.json', backlogTemplate([incrementPayload('i1', 'First')]))]);
  const before = fs.readFileSync(backlogPath, 'utf8');

  const err = runFails(['record', backlogPath, 'i1', 'research:i1.0', writeJson(dir, 'payload.json', { plan: 'x' }), path.join(dir, 'nope.txt')]);

  assert.equal(err.status, 2, 'a payload the caller named but did not write is a usage error, not an answer from the state');
  assert.equal(fs.readFileSync(backlogPath, 'utf8'), before);
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

test("close sets status and note and clears only the closed increment's current steps", () => {
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
  assert.deepEqual(i1.steps, [], "closing ends the increment's attempt");
  assert.equal(i1.attempts[0].steps.length, 1, 'and keeps that attempt whole');
  assert.equal(i2.steps.length, 1, "closing one increment leaves another increment's steps alone");
  assert.deepEqual(i2.attempts, [], 'and opens no attempt on it');
});

test("close carries the run steps of the closed increment into its attempt and leaves the run's own steps standing", () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  run(['init', backlogPath, writeJson(dir, 'init.json', backlogTemplate([
    incrementPayload('i1', 'First'),
    incrementPayload('i2', 'Second'),
  ]))]);
  // `decompose` belongs to the run and to no increment: it has to survive
  // every close with its label, or the resumed run would work the opening cut
  // again. `replan:i1` belongs to the increment being closed even though it
  // sits in run.steps, so it goes into the attempt with the rest — otherwise
  // an increment handed back as todo would find its previous close recorded.
  run(['record', backlogPath, '-', 'decompose', writeJson(dir, 'decompose.json', { summary: 'opened' })]);
  run(['record', backlogPath, '-', 'replan:i1', writeJson(dir, 'replan.json', { summary: 'closed' })]);
  run(['record', backlogPath, 'i1', 'research:i1.0', writeJson(dir, 'research.json', { plan: 'x' })]);

  run(['close', backlogPath, 'i1', 'done', 'the review accepted it']);

  const backlog = JSON.parse(fs.readFileSync(backlogPath, 'utf8'));
  assert.deepEqual(backlog.run.steps.map((s) => s.label), ['decompose'], 'the run-level step that names no increment stays current');
  assert.equal(backlog.run.steps[0].return.summary, 'opened', 'and keeps its return — nothing is deleted');
  const archived = backlog.increments.find((i) => i.id === 'i1').attempts[0].steps.map((s) => s.label);
  assert.deepEqual(archived.sort(), ['replan:i1', 'research:i1.0'], "the closed increment's own steps and its run-level close are archived together");
});

test('closing a second increment leaves the first increment\'s archived attempt alone', () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  run(['init', backlogPath, writeJson(dir, 'init.json', backlogTemplate([
    incrementPayload('i1', 'First'),
    incrementPayload('i2', 'Second'),
  ]))]);
  run(['record', backlogPath, '-', 'decompose', writeJson(dir, 'decompose.json', { summary: 'opened' })]);
  run(['record', backlogPath, 'i1', 'research:i1.0', writeJson(dir, 'research1.json', { plan: 'x' })]);
  run(['close', backlogPath, 'i1', 'done']);

  run(['record', backlogPath, 'i2', 'research:i2.0', writeJson(dir, 'research2.json', { plan: 'y' })]);
  run(['close', backlogPath, 'i2', 'done']);

  const backlog = JSON.parse(fs.readFileSync(backlogPath, 'utf8'));
  assert.equal(backlog.increments.find((i) => i.id === 'i1').attempts.length, 1, 'the first close is not re-archived by the second');
  assert.equal(backlog.increments.find((i) => i.id === 'i2').attempts.length, 1);
  assert.deepEqual(backlog.run.steps.map((s) => s.label), ['decompose']);
});

test('an increment closed and re-cut starts a second attempt, and its first one is still there', () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  run(['init', backlogPath, writeJson(dir, 'init.json', backlogTemplate([incrementPayload('i1', 'First')]))]);
  run(['record', backlogPath, 'i1', 'research:i1.0', writeJson(dir, 'first.json', { plan: 'MARKER-FIRST-ATTEMPT' })]);
  run(['close', backlogPath, 'i1', 'blocked', 'the review never accepted it']);

  // The planner hands it back as todo, which is what `init` writes, and the
  // second attempt records the same label again.
  run(['init', backlogPath, writeJson(dir, 'recut.json', backlogTemplate([incrementPayload('i1', 'First')]))]);
  run(['record', backlogPath, 'i1', 'research:i1.0', writeJson(dir, 'second.json', { plan: 'MARKER-SECOND-ATTEMPT' })]);

  const raw = fs.readFileSync(backlogPath, 'utf8');
  const i1 = JSON.parse(raw).increments[0];
  assert.equal(i1.steps.length, 1, 'the second attempt records against an empty step list');
  assert.equal(i1.steps[0].return.plan, 'MARKER-SECOND-ATTEMPT');
  assert.equal(i1.steps[0].history, undefined, 'the second attempt does not inherit the first as history — the close already archived it');
  assert.equal(i1.attempts.length, 1, 'a re-cut carries the archived attempt through');
  assert.equal(raw.includes('MARKER-FIRST-ATTEMPT'), true, 'the first attempt is still in the file');
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

// The step a run's index has to summarise without leaking: two long content
// fields, a list of objects, and the small values a workflow steers on.
const researchReturn = {
  needsTests: true,
  plan: 'MARKER-PLAN-CONTENT'.padEnd(2000, '.'),
  testPlan: 'MARKER-TESTPLAN-CONTENT'.padEnd(2000, '.'),
  checks: ['./test.sh'],
  cases: [{ case: 'MARKER-CASE-OBJECT', file: 'x.test.mjs' }],
  questions: [],
  summary: 'plan summary',
};

test('index carries the cut, the step labels and the small steering values, and no step content at all', () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  run(['init', backlogPath, writeJson(dir, 'init.json', {
    ...backlogTemplate([incrementPayload('i1', 'First'), incrementPayload('i2', 'Second')]),
    codemap: 'MARKER-CODEMAP-CONTENT',
  })]);
  run(['branch', backlogPath, 'i1', 'issue-branch--i1']);
  run(['record', backlogPath, '-', 'decompose', writeJson(dir, 'decompose.json', { summary: 'opened', questions: [] })]);
  run(['record', backlogPath, 'i1', 'research:i1.0', writeJson(dir, 'research.json', researchReturn)]);

  const stdout = run(['index', backlogPath]);
  const idx = JSON.parse(stdout);

  assert.deepEqual(idx.increments.map((i) => i.id), ['i1', 'i2'], 'the cut is what a workflow steers on, so it is in the index whole');
  assert.equal(idx.increments[0].title, 'First');
  assert.deepEqual(idx.increments[0].criteria, ['does i1']);
  assert.equal(idx.increments[0].branch, 'issue-branch--i1');
  assert.deepEqual(idx.increments[0].steps.map((s) => s.label), ['research:i1.0']);
  assert.deepEqual(idx.run.steps.map((s) => s.label), ['decompose']);

  const step = idx.increments[0].steps[0];
  assert.equal(step.asked, false, 'a step whose return carried no question did not ask one');
  assert.equal(step.return.needsTests, true, 'a boolean is a steering value and survives');
  assert.deepEqual(step.return.checks, ['./test.sh'], 'a short list of short strings is a steering value and survives');
  assert.equal(step.return.summary, 'plan summary');

  assert.equal(stdout.includes('MARKER-PLAN-CONTENT'), false, 'a long string is content and is never in the index');
  assert.equal(stdout.includes('MARKER-TESTPLAN-CONTENT'), false, 'nor is a second one');
  assert.equal(stdout.includes('MARKER-CASE-OBJECT'), false, 'a list of objects is content and is never in the index');
  assert.equal(stdout.includes('MARKER-CODEMAP-CONTENT'), false, 'the codemap is content and is never in the index');
  assert.equal(idx.hasCodemap, true, 'the index says a codemap is there without carrying it');
});

test('index marks the step that ended a run with a question, and carries the questions themselves', () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  run(['init', backlogPath, writeJson(dir, 'init.json', backlogTemplate([incrementPayload('i1', 'First')]))]);
  run(['record', backlogPath, 'i1', 'research:i1.0', writeJson(dir, 'asked.json', {
    ...researchReturn,
    questions: ['MARKER-HUMAN-QUESTION'],
  })]);

  const idx = JSON.parse(run(['index', backlogPath]));
  const step = idx.increments[0].steps[0];

  assert.equal(step.asked, true, 'a resumed run has to know which steps ended on a question');
  assert.deepEqual(step.return.questions, ['MARKER-HUMAN-QUESTION'], 'and it puts them back in front of the step it works again');
});

test('index reports a long question as asked even though the question itself does not survive the projection', () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  run(['init', backlogPath, writeJson(dir, 'init.json', backlogTemplate([incrementPayload('i1', 'First')]))]);
  run(['record', backlogPath, 'i1', 'research:i1.0', writeJson(dir, 'asked.json', {
    questions: ['q'.padEnd(4000, 'q')],
    summary: 'asked at length',
  })]);

  const idx = JSON.parse(run(['index', backlogPath]));
  const step = idx.increments[0].steps[0];

  assert.equal(step.asked, true, '`asked` is computed, not projected, so the one fact the run protocol turns on cannot be dropped for being long');
  assert.equal(step.return.questions, undefined, 'the long question itself is content, and the step reads it back from the file');
});

test('index counts an increment\'s archived attempts without carrying them', () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  run(['init', backlogPath, writeJson(dir, 'init.json', backlogTemplate([incrementPayload('i1', 'First')]))]);
  run(['record', backlogPath, 'i1', 'research:i1.0', writeJson(dir, 'research.json', { plan: 'MARKER-ARCHIVED'.padEnd(2000, '.') })]);
  run(['close', backlogPath, 'i1', 'blocked', 'not accepted']);

  const stdout = run(['index', backlogPath]);
  const idx = JSON.parse(stdout);

  assert.equal(idx.increments[0].attempts, 1);
  assert.deepEqual(idx.increments[0].steps, [], 'a closed increment has no current step');
  assert.equal(stdout.includes('MARKER-ARCHIVED'), false, 'the archive grows in the file and never in the index');
});

test('index on a missing file exits 1 and prints nothing on stdout', () => {
  const dir = tmpDir();

  const err = runFails(['index', path.join(dir, 'backlog.json')]);

  assert.equal(err.status, 1);
  assert.equal(err.stdout || '', '');
});

test('steps returns the named steps of an increment, whole, and nothing else', () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  run(['init', backlogPath, writeJson(dir, 'init.json', backlogTemplate([incrementPayload('i1', 'First')]))]);
  run(['record', backlogPath, 'i1', 'research:i1.0', writeJson(dir, 'research.json', researchReturn)]);
  run(['record', backlogPath, 'i1', 'tests:i1.0', writeJson(dir, 'tests.json', { cases: [{ case: 'MARKER-UNNAMED-STEP' }] })]);

  const out = JSON.parse(run(['steps', backlogPath, 'i1', 'research:i1.0']));

  assert.equal(out.length, 1, 'only the step that was named comes back');
  assert.equal(out[0].label, 'research:i1.0');
  assert.equal(out[0].return.plan, researchReturn.plan, 'the content comes back whole — this is the channel between the roles');
  assert.equal(out[0].return.testPlan, researchReturn.testPlan);
  assert.equal(JSON.stringify(out).includes('MARKER-UNNAMED-STEP'), false, 'the step nobody named is not in the answer');
});

test('steps --fields returns only the named fields, so a role never meets what its brief does not name', () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  run(['init', backlogPath, writeJson(dir, 'init.json', backlogTemplate([incrementPayload('i1', 'First')]))]);
  run(['record', backlogPath, 'i1', 'research:i1.0', writeJson(dir, 'research.json', researchReturn)]);

  // The test-author's read: the test plan and nothing else. Meeting the
  // implementation plan is what would make its tests an implementer's tests.
  const stdout = run(['steps', backlogPath, 'i1', 'research:i1.0', '--fields', 'testPlan']);
  const out = JSON.parse(stdout);

  assert.deepEqual(Object.keys(out[0].return), ['testPlan'], 'only the named field comes back');
  assert.equal(out[0].return.testPlan, researchReturn.testPlan, 'and it comes back whole');
  assert.equal(stdout.includes('MARKER-PLAN-CONTENT'), false, 'the field nobody named never reaches the reader');
});

test('steps --fields takes several fields and ignores one the return does not carry', () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  run(['init', backlogPath, writeJson(dir, 'init.json', backlogTemplate([incrementPayload('i1', 'First')]))]);
  run(['record', backlogPath, 'i1', 'research:i1.0', writeJson(dir, 'research.json', researchReturn)]);

  const out = JSON.parse(run(['steps', backlogPath, 'i1', 'research:i1.0', '--fields', 'plan,moduleMap,environment']));

  assert.deepEqual(Object.keys(out[0].return), ['plan'], 'a field the step never recorded is absent, not null');
});

test('steps --fields with no list after it exits 2', () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  run(['init', backlogPath, writeJson(dir, 'init.json', backlogTemplate([incrementPayload('i1', 'First')]))]);

  assert.equal(runFails(['steps', backlogPath, 'i1', '--fields']).status, 2);
});

test('steps returns several named steps at once, and skips a label that has no entry', () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  run(['init', backlogPath, writeJson(dir, 'init.json', backlogTemplate([incrementPayload('i1', 'First')]))]);
  run(['record', backlogPath, 'i1', 'research:i1.0', writeJson(dir, 'research.json', { plan: 'x' })]);

  const out = JSON.parse(run(['steps', backlogPath, 'i1', 'research:i1.0', 'tests:i1.0']));

  assert.deepEqual(out.map((s) => s.label), ['research:i1.0'], 'a caller may name a step that never ran — it is simply absent, not an error');
});

test('steps with no label named returns every current step of that scope', () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  run(['init', backlogPath, writeJson(dir, 'init.json', backlogTemplate([incrementPayload('i1', 'First')]))]);
  run(['record', backlogPath, 'i1', 'research:i1.0', writeJson(dir, 'research.json', { plan: 'x' })]);
  run(['record', backlogPath, 'i1', 'review:i1.0', writeJson(dir, 'review.json', { findings: [] })]);

  const out = JSON.parse(run(['steps', backlogPath, 'i1']));

  assert.deepEqual(out.map((s) => s.label), ['research:i1.0', 'review:i1.0'], 'this is the closing planner\'s read: everything the attempt produced');
});

test('steps with an increment id of "-" returns the run\'s own steps', () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  run(['init', backlogPath, writeJson(dir, 'init.json', backlogTemplate([incrementPayload('i1', 'First')]))]);
  run(['record', backlogPath, '-', 'decompose', writeJson(dir, 'decompose.json', { summary: 'opened' })]);
  run(['record', backlogPath, 'i1', 'research:i1.0', writeJson(dir, 'research.json', { plan: 'x' })]);

  const out = JSON.parse(run(['steps', backlogPath, '-']));

  assert.deepEqual(out.map((s) => s.label), ['decompose']);
});

test('steps against an increment id no increment has exits 1', () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  run(['init', backlogPath, writeJson(dir, 'init.json', backlogTemplate([incrementPayload('i1', 'First')]))]);

  const err = runFails(['steps', backlogPath, 'nope']);

  assert.equal(err.status, 1);
});

test('codemap prints the map alone, and the empty line when there is none', () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  run(['init', backlogPath, writeJson(dir, 'init.json', {
    ...backlogTemplate([incrementPayload('i1', 'First')]),
    codemap: 'a.js — the parser\nb.js — its one caller',
  })]);
  run(['record', backlogPath, 'i1', 'research:i1.0', writeJson(dir, 'research.json', researchReturn)]);

  const stdout = run(['codemap', backlogPath]);

  assert.equal(stdout, 'a.js — the parser\nb.js — its one caller\n');
  assert.equal(stdout.includes('MARKER-PLAN-CONTENT'), false, 'the map comes on its own, with no step return beside it');

  const freshPath = path.join(dir, 'fresh.json');
  run(['init', freshPath, writeJson(dir, 'no-map.json', backlogTemplate([incrementPayload('i1', 'First')]))]);
  assert.equal(run(['codemap', freshPath]), '\n');
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

// The decoupling. Nothing here writes to a network, so the one case that
// remains is the negative: a collector named in the environment, reachable and
// recording every request, receives nothing at all. Shared mechanics across
// every subcommand rather than one command's own rules, so it sits here at the
// end.

test('a write sends nothing anywhere, even with a reachable collector named in the environment', async () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  const stub = await collectorStub();
  try {
    const env = cleanEnv({
      OTEL_EXPORTER_OTLP_ENDPOINT: stub.url,
      OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer s3cret',
      UROBOROS_OBS_URL: stub.url,
      UROBOROS_OBS_TOKEN: 'env-secret',
    });

    const init = await runAsync(['init', backlogPath, writeJson(dir, 'init.json', backlogTemplate([incrementPayload('i1', 'First')]))], env);
    assert.equal(init.stdout, `wrote ${backlogPath} with 1 increment(s)\n`);
    assert.equal(init.stderr, '');

    await runAsync(['start', backlogPath, 'i1', 'research:i1.0'], env);
    const record = await runAsync(['record', backlogPath, 'i1', 'research:i1.0', writeJson(dir, 'step.json', { plan: 'x' })], env);
    assert.equal(record.stdout, 'recorded research:i1.0\n');
    assert.equal(record.stderr, '');

    await runAsync(['branch', backlogPath, 'i1', 'some-branch'], env);
    await runAsync(['close', backlogPath, 'i1', 'done', 'accepted'], env);
    await runAsync(['read', backlogPath], env);

    assert.equal(stub.requests.length, 0, 'the recorder reached the collector — the run is watched by a separate process now, and an agent that writes the state must not talk to anything');

    const backlog = JSON.parse(fs.readFileSync(backlogPath, 'utf8'));
    assert.equal(backlog.increments[0].status, 'done', 'every write itself still happened');
    assert.equal(backlog.increments[0].attempts[0].steps[0].label, 'research:i1.0');
  } finally {
    await stub.close();
  }
});
