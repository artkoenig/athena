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

function run(args) {
  return execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
}

// Runs the CLI expecting it to exit non-zero, and returns the error object
// (`status`, `stdout`, `stderr`) instead of letting the throw escape. If the
// call unexpectedly succeeds, that is itself the test failure.
function runFails(args) {
  try {
    run(args);
  } catch (err) {
    if (err.status !== undefined) return err;
    throw err;
  }
  throw new Error('expected `' + args.join(' ') + '` to exit non-zero, it exited 0');
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
