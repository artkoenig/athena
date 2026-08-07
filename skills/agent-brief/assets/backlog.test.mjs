import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

function run(args, input) {
  return execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', input });
}

// Runs the CLI expecting it to exit non-zero, and returns the error object
// (`status`, `stdout`, `stderr`) instead of letting the throw escape. If the
// call unexpectedly succeeds, that is itself the test failure.
function runFails(args, input) {
  try {
    run(args, input);
  } catch (err) {
    if (err.status !== undefined) return err;
    throw err;
  }
  throw new Error('expected `' + args.join(' ') + '` to exit non-zero, it exited 0');
}

const backlogTemplate = (increments) => ({
  issue: 'docs/issues/x',
  workflow: 'loop',
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

test("record keeps each finding's classification in the verdict it stores under the round's label", () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  run(['init', backlogPath, writeJson(dir, 'init.json', backlogTemplate([incrementPayload('i1', 'First')]))]);

  const payload = {
    findings: [
      { claim: 'no guard', reproduction: 'delete the container, nothing goes red', criterion: 'c1', kind: 'coverage-gap', fix: 'needs-plan' },
      { claim: 'wrong number', reproduction: 'x at line 3', criterion: 'c2', kind: 'defect', fix: 'direct' },
    ],
    reason: 'another round',
    questions: [],
    summary: 'verdict summary',
  };
  run(['record', backlogPath, 'i1', 'review:i1.1', writeJson(dir, 'payload.json', payload)]);

  const backlog = JSON.parse(fs.readFileSync(backlogPath, 'utf8'));
  const i1 = backlog.increments.find((i) => i.id === 'i1');
  assert.equal(i1.steps.length, 1, 'the round is recorded as exactly one step');
  assert.equal(i1.steps[0].label, 'review:i1.1', "the round is in the step's label");
  assert.deepEqual(i1.steps[0].return.findings.map((f) => f.kind), ['coverage-gap', 'defect'],
    "the verdict's own findings keep the classification the reviewer set for each one");
});

test('record reads the step return from stdin when the payload argument is "-", quotes and markup and all', () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  run(['init', backlogPath, writeJson(dir, 'init.json', backlogTemplate([incrementPayload('i1', 'First')]))]);

  // The exact three things the criterion names: double quotes, an HTML
  // attribute, a newline — plus a backslash and an apostrophe, free.
  const payload = {
    summary: 'a lane keyed by data-lane-id="main"',
    plan: 'line one\nline two, with a backslash \\ and an apostrophe it\'s',
    questions: [],
  };
  const stdout = run(['record', backlogPath, 'i1', 'research:i1.0', '-'], JSON.stringify(payload));

  assert.equal(stdout.trim().split('\n').length, 1, 'record prints exactly one line');
  assert.match(stdout, /research:i1\.0/, 'the confirmation names the label it recorded');

  const backlog = JSON.parse(fs.readFileSync(backlogPath, 'utf8'));
  const i1 = backlog.increments.find((i) => i.id === 'i1');
  assert.equal(i1.steps.length, 1);
  assert.equal(i1.steps[0].label, 'research:i1.0');
  assert.match(i1.steps[0].at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'at is an ISO timestamp');
  assert.deepEqual(i1.steps[0].return, payload, 'the payload round-trips byte-for-byte through stdin, which is what "records correctly" means');
});

// The two meanings of "-" meet in one call: the increment id and the payload
// argument are each independently "-", and only the payload one means stdin.
test('record on stdin with an increment id of "-" lands the run-level step in run.steps', () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  run(['init', backlogPath, writeJson(dir, 'init.json', backlogTemplate([incrementPayload('i1', 'First')]))]);

  run(['record', backlogPath, '-', 'decompose', '-'], JSON.stringify({ summary: 'opened' }));

  const backlog = JSON.parse(fs.readFileSync(backlogPath, 'utf8'));
  assert.equal(backlog.run.steps.length, 1);
  assert.equal(backlog.run.steps[0].label, 'decompose');
  assert.deepEqual(backlog.increments[0].steps, [], "the payload dash is read as stdin and the increment dash still means run-level, in the same call");
});

test('the same return recorded from a file and recorded on stdin lands the same stored return', () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  run(['init', backlogPath, writeJson(dir, 'init.json', backlogTemplate([
    incrementPayload('i1', 'First'),
    incrementPayload('i2', 'Second'),
  ]))]);

  const payload = {
    summary: 'a lane keyed by data-lane-id="main"',
    plan: 'line one\nline two, with a backslash \\ and an apostrophe it\'s',
    questions: [],
  };
  run(['record', backlogPath, 'i1', 'research:i1.0', writeJson(dir, 'payload.json', payload)]);
  run(['record', backlogPath, 'i2', 'research:i2.0', '-'], JSON.stringify(payload));

  const backlog = JSON.parse(fs.readFileSync(backlogPath, 'utf8'));
  const i1 = backlog.increments.find((i) => i.id === 'i1');
  const i2 = backlog.increments.find((i) => i.id === 'i2');
  // Compare the return only — the `at` timestamps legitimately differ.
  assert.deepEqual(i1.steps[0].return, i2.steps[0].return, 'the file form and the stdin form must store the identical return');
  assert.deepEqual(i1.steps[0].return, payload);
  assert.deepEqual(i2.steps[0].return, payload);
});

test('record with a payload file that does not exist exits 2 and leaves the backlog untouched', () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  run(['init', backlogPath, writeJson(dir, 'init.json', backlogTemplate([incrementPayload('i1', 'First')]))]);
  const before = fs.readFileSync(backlogPath, 'utf8');

  // The case that goes red if the dash branch swallows the file branch.
  const err = runFails(['record', backlogPath, 'i1', 'research:i1.0', path.join(dir, 'nope.json')]);

  assert.equal(err.status, 2);
  assert.ok(err.stderr && err.stderr.length > 0, 'a message on stderr explains what went wrong');
  assert.match(err.stderr, /nope\.json/, 'the message names the missing file');
  assert.equal(fs.readFileSync(backlogPath, 'utf8'), before, 'the file is byte-identical to before the failed call');
});

test('record with "-" and nothing on stdin exits 2 and leaves the backlog untouched', () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  run(['init', backlogPath, writeJson(dir, 'init.json', backlogTemplate([incrementPayload('i1', 'First')]))]);
  const before = fs.readFileSync(backlogPath, 'utf8');

  const err = runFails(['record', backlogPath, 'i1', 'research:i1.0', '-'], '');

  assert.equal(err.status, 2);
  assert.match(err.stderr, /stdin/, 'the message names stdin as the source that carried nothing');
  assert.equal(fs.readFileSync(backlogPath, 'utf8'), before, 'the file is byte-identical to before the failed call');
});

test('record with malformed JSON on stdin exits 2, says so of stdin, and leaves the backlog untouched', () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  run(['init', backlogPath, writeJson(dir, 'init.json', backlogTemplate([incrementPayload('i1', 'First')]))]);
  const before = fs.readFileSync(backlogPath, 'utf8');

  const err = runFails(['record', backlogPath, 'i1', 'research:i1.0', '-'], '{"summary": "unterminated');

  assert.equal(err.status, 2);
  assert.match(err.stderr, /stdin/, 'the message names stdin, not a file path, as the source of the malformed JSON');
  assert.equal(fs.readFileSync(backlogPath, 'utf8'), before, 'the file is byte-identical to before the failed call');
});

// Pins that the stdin form was not implemented by making the fourth argument
// optional: a call that omits it entirely must not sit waiting on stdin.
test('record without a payload argument exits 2 rather than waiting for stdin', () => {
  const dir = tmpDir();
  const backlogPath = path.join(dir, 'backlog.json');
  run(['init', backlogPath, writeJson(dir, 'init.json', backlogTemplate([incrementPayload('i1', 'First')]))]);

  const err = runFails(['record', backlogPath, 'i1', 'research:i1.0'], '');

  assert.equal(err.status, 2);
  assert.match(err.stderr, /usage:/, 'the message names the usage rather than hanging');
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
    workflow: 'loop',
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
