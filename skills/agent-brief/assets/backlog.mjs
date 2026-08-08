#!/usr/bin/env node
// The only writer of an issue's `backlog.json`, and the only reader any agent
// of a run goes through. That file is the single source of truth of a run: what
// the increments are, what each step of each increment produced, the prompt
// each step was dispatched with, and what the review made of it. An agent
// writes its return here once and the next role reads it here; the workflow
// script carries no content between them, because the workflow runtime gives a
// script no filesystem at all.
//
// It is a CLI rather than a paragraph of instructions in every prompt because
// four of its rules are the kind an agent gets subtly wrong: an increment kept
// across a re-cut keeps the steps it already recorded, a step written a second
// time supersedes its own earlier entry instead of piling up beside it, closing
// an increment ends that attempt without losing what the attempt produced, and
// nothing recorded is ever deleted. Enforced in code, they are testable; asked
// for in prose, they are hoped for.
//
// Nothing here ever deletes. `close` moves an attempt's steps into the
// increment's `attempts`, and `record` moves a superseded entry into the new
// entry's `history`, so the file is the whole record of the run for whoever
// analyses it afterwards.
//
// Reads are addressed, never wholesale — that is what keeps the file free to
// grow. `index` is the run's skeleton with no step content in it, `steps` is
// the returns of the steps you name, and `codemap` is the map alone. `read`
// prints the file whole and exists for a human with git in hand; no agent of a
// run uses it.
//
// `record` prints one confirmation line and never any part of the file, so an
// agent forbidden to read the state can still write into it.
//
// Zero dependencies, no build step: it runs from a checkout, from a plugin
// cache and from an installing project alike, so it hard-codes no path.
import fs from 'node:fs'

const STATUSES = ['done', 'blocked', 'dropped']

const USAGE = [
  'usage:',
  '  backlog.mjs init    <backlogPath> <payloadFile>',
  '  backlog.mjs record  <backlogPath> <incrementId|-> <label> <payloadFile> [promptFile]',
  '  backlog.mjs branch  <backlogPath> <incrementId> <branchName>',
  '  backlog.mjs close   <backlogPath> <incrementId> <status> [note]',
  '  backlog.mjs index   <backlogPath>',
  '  backlog.mjs steps   <backlogPath> <incrementId|-> [label ...] [--fields a,b,c]',
  '  backlog.mjs codemap <backlogPath>',
  '  backlog.mjs read    <backlogPath>',
].join('\n')

// Exit 2 is "you called it wrong" — an unknown command, a missing argument,
// a payload that is not JSON. Exit 1 is "the call was well formed and the
// state says no" — no backlog there, no such increment, no such status. The
// two are separate so a caller can tell a typo from an answer.
function fail(message, code) {
  process.stderr.write(message + '\n')
  process.exit(code)
}

function readJson(file, what) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    fail(`cannot read ${what} at ${file}`, 2)
  }
  try {
    return JSON.parse(text)
  } catch (err) {
    fail(`${what} at ${file} is not valid JSON: ${err.message}`, 2)
  }
}

function readText(file, what) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    fail(`cannot read ${what} at ${file}`, 2)
  }
}

// A missing file is exit 1: every caller of this is asking about state that
// should already be there, and "it is not" is an answer, not a usage error.
function loadBacklog(backlogPath) {
  if (!fs.existsSync(backlogPath)) fail(`no backlog at ${backlogPath}`, 1)
  let text
  try {
    text = fs.readFileSync(backlogPath, 'utf8')
  } catch {
    fail(`cannot read the backlog at ${backlogPath}`, 1)
  }
  try {
    return JSON.parse(text)
  } catch (err) {
    fail(`the backlog at ${backlogPath} is not valid JSON: ${err.message}`, 2)
  }
}

// Every write lands in `<path>.tmp` and is renamed onto the target, so a step
// killed mid-write leaves either the whole old file or the whole new one and
// never half of either. A successful call leaves no `.tmp` behind.
function writeBacklog(backlogPath, backlog) {
  const tmp = backlogPath + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(backlog, null, 2) + '\n')
  fs.renameSync(tmp, backlogPath)
}

function shapeIncrement(raw, steps, branch, attempts) {
  return {
    id: String(raw.id),
    title: raw.title || '',
    goal: raw.goal || '',
    criteria: Array.isArray(raw.criteria) ? raw.criteria : [],
    status: raw.status || 'todo',
    note: raw.note || '',
    branch: branch || '',
    steps,
    attempts,
  }
}

// `init` is the planner's call, on the opening cut and on every re-cut alike.
// It is a merge, not an overwrite: the payload decides which increments exist
// and what they say, the file decides what they have already recorded. An
// increment the payload drops is gone with its steps; `run.steps` belongs to
// the run rather than to any increment, so a re-cut never touches it. The
// codemap is the payload's when it carries one and the file's when it does
// not, so a re-cut that says nothing about the map cannot erase it. An
// increment's branch is the file's alone — the `branch` subcommand is its one
// writer, so the payload cannot set or erase it. The attempts a kept increment
// has already closed travel with it untouched.
function init(backlogPath, payloadFile) {
  const payload = readJson(payloadFile, 'the init payload')
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.increments)) {
    fail('the init payload needs { issue, workflow, increments: [...] }, codemap optional', 2)
  }

  let priorSteps = new Map()
  let priorBranches = new Map()
  let priorAttempts = new Map()
  let runSteps = []
  let runAttempts = []
  let priorCodemap = ''
  if (fs.existsSync(backlogPath)) {
    const existing = loadBacklog(backlogPath)
    for (const increment of existing.increments || []) {
      priorSteps.set(increment.id, Array.isArray(increment.steps) ? increment.steps : [])
      priorBranches.set(increment.id, typeof increment.branch === 'string' ? increment.branch : '')
      priorAttempts.set(increment.id, Array.isArray(increment.attempts) ? increment.attempts : [])
    }
    runSteps = (existing.run && Array.isArray(existing.run.steps) && existing.run.steps) || []
    runAttempts = (existing.run && Array.isArray(existing.run.attempts) && existing.run.attempts) || []
    priorCodemap = typeof existing.codemap === 'string' ? existing.codemap : ''
  }

  const backlog = {
    version: 1,
    issue: payload.issue || '',
    workflow: payload.workflow || '',
    codemap: typeof payload.codemap === 'string' ? payload.codemap : priorCodemap,
    increments: payload.increments.map((increment) =>
      shapeIncrement(
        increment,
        priorSteps.get(String(increment.id)) || [],
        priorBranches.get(String(increment.id)) || '',
        priorAttempts.get(String(increment.id)) || [],
      ),
    ),
    run: { steps: runSteps, attempts: runAttempts },
  }

  writeBacklog(backlogPath, backlog)
  process.stdout.write(
    `wrote ${backlogPath} with ${backlog.increments.length} increment(s)\n`,
  )
}

// `record` is every agent's own call, once per step. The increment id `-` puts
// the step in `run.steps`, which is where the steps that sit between increments
// go — the opening cut, each close, the publish.
//
// The payload is the step's whole return, and it is the only copy of it: the
// next role reads it back out of here rather than being handed it in a prompt.
// The optional prompt file is the dispatch prompt that produced it, stored
// verbatim, so a run can be analysed afterwards against what each agent was
// actually asked.
//
// A label written a second time supersedes the earlier entry rather than
// replacing it: the old entry moves into the new one's `history`, oldest first,
// so a step worked again after a crash or a question keeps both attempts.
function record(backlogPath, incrementId, label, payloadFile, promptFile) {
  const payload = readJson(payloadFile, 'the step return')
  const prompt = promptFile === undefined ? null : readText(promptFile, 'the dispatch prompt')
  const backlog = loadBacklog(backlogPath)

  let steps
  if (incrementId === '-') {
    if (!backlog.run || !Array.isArray(backlog.run.steps)) {
      backlog.run = { steps: [], attempts: (backlog.run && backlog.run.attempts) || [] }
    }
    steps = backlog.run.steps
  } else {
    const increment = (backlog.increments || []).find((i) => i.id === incrementId)
    if (!increment) fail(`no increment "${incrementId}" in ${backlogPath}`, 1)
    if (!Array.isArray(increment.steps)) increment.steps = []
    steps = increment.steps
  }

  const entry = { label, at: new Date().toISOString(), return: payload }
  if (prompt !== null) entry.prompt = prompt

  const at = steps.findIndex((step) => step.label === label)
  if (at >= 0) {
    const prior = steps[at]
    const priorHistory = Array.isArray(prior.history) ? prior.history : []
    const superseded = Object.assign({}, prior)
    delete superseded.history
    entry.history = [...priorHistory, superseded]
    steps[at] = entry
  } else {
    steps.push(entry)
  }

  writeBacklog(backlogPath, backlog)
  process.stdout.write(`recorded ${label}\n`)
}

// `branch` names the branch an increment is worked on. The agent that creates
// the branch calls it — before the checkout diverges, so the name is in the
// state a resumed session reads. Recording a new name over an old one is the
// fresh-attempt case, not an error.
function branch(backlogPath, incrementId, branchName) {
  const backlog = loadBacklog(backlogPath)
  const increment = (backlog.increments || []).find((i) => i.id === incrementId)
  if (!increment) fail(`no increment "${incrementId}" in ${backlogPath}`, 1)

  increment.branch = branchName

  writeBacklog(backlogPath, backlog)
  process.stdout.write(`recorded branch ${branchName} on ${incrementId}\n`)
}

// `close` is the planner's verdict call. It ends the attempt without losing it:
// the increment's steps, together with the run-level steps that belong to this
// increment, move into an entry in `attempts` that carries the status they
// closed with. Nothing is deleted.
//
// Clearing `steps` is what an attempt boundary means to a resuming workflow. A
// run resumes by asking whether a label is recorded, so an increment the
// planner hands back as `todo` has to start with no recorded labels or its
// second attempt would skip every step of its first. The run's own steps that
// carry no increment id — the opening cut — stay where they are, so a close
// never re-dispatches them.
function close(backlogPath, incrementId, status, note) {
  if (!STATUSES.includes(status)) {
    fail(`status must be one of ${STATUSES.join('|')}, not "${status}"`, 1)
  }
  const backlog = loadBacklog(backlogPath)
  const increment = (backlog.increments || []).find((i) => i.id === incrementId)
  if (!increment) fail(`no increment "${incrementId}" in ${backlogPath}`, 1)

  increment.status = status
  increment.note = note || ''

  const carried = []
  if (backlog.run && Array.isArray(backlog.run.steps)) {
    const kept = []
    for (const step of backlog.run.steps) {
      if (typeof step.label === 'string' && step.label.endsWith(`:${incrementId}`)) carried.push(step)
      else kept.push(step)
    }
    backlog.run.steps = kept
  }

  const steps = [...(Array.isArray(increment.steps) ? increment.steps : []), ...carried]
  if (!Array.isArray(increment.attempts)) increment.attempts = []
  if (steps.length) {
    increment.attempts.push({ closedAs: status, at: new Date().toISOString(), steps })
  }
  increment.steps = []

  writeBacklog(backlogPath, backlog)
  process.stdout.write(`closed ${incrementId} as ${status}\n`)
}

// The steering projection. A workflow script decides what to dispatch next from
// a handful of small values a step returned — a boolean, a count, a list of
// commands, the questions that block the run — and never from the step's
// content. So the index carries every return field small enough to be one of
// those and drops everything else: a plan, a module map, a test plan, a list of
// cases or of findings is content, and content is read with `steps`, by the one
// role that needs it.
const SMALL_STRING = 500
const SMALL_LIST = 50
function smallValue(value) {
  if (typeof value === 'boolean' || typeof value === 'number') return true
  if (typeof value === 'string') return value.length <= SMALL_STRING
  if (Array.isArray(value)) {
    return (
      value.length <= SMALL_LIST &&
      value.every((item) => typeof item === 'string' && item.length <= SMALL_STRING)
    )
  }
  return false
}

function steering(ret) {
  const out = {}
  if (!ret || typeof ret !== 'object') return out
  for (const [key, value] of Object.entries(ret)) {
    if (smallValue(value)) out[key] = value
  }
  return out
}

// `asked` is computed rather than projected. Every role's return carries
// `questions`, a non-empty list ends the run, and a resumed run has to know
// which steps ended that way even when the questions themselves were too long
// to survive the projection.
function indexStep(step) {
  const ret = step && step.return
  const questions =
    ret && Array.isArray(ret.questions) ? ret.questions.filter(Boolean) : []
  return {
    label: step.label,
    at: step.at || '',
    asked: questions.length > 0,
    return: steering(ret),
  }
}

// `index` is the run's skeleton: what the cut is, what each increment stands
// at, which steps are recorded, and the steering values of each. It never
// carries the codemap or any step's content, so it stays the same size however
// long the run gets — which is what lets the file itself keep everything.
function index(backlogPath) {
  const backlog = loadBacklog(backlogPath)
  const out = {
    version: backlog.version || 1,
    issue: backlog.issue || '',
    workflow: backlog.workflow || '',
    hasCodemap: typeof backlog.codemap === 'string' && backlog.codemap.length > 0,
    increments: (backlog.increments || []).map((increment) => ({
      id: increment.id,
      title: increment.title || '',
      goal: increment.goal || '',
      criteria: Array.isArray(increment.criteria) ? increment.criteria : [],
      status: increment.status || 'todo',
      note: increment.note || '',
      branch: increment.branch || '',
      steps: (increment.steps || []).map(indexStep),
      attempts: (increment.attempts || []).length,
    })),
    run: { steps: ((backlog.run && backlog.run.steps) || []).map(indexStep) },
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n')
}

// `steps` is how a role takes its brief: it names the increment and the labels
// it needs, and gets those steps' returns. Naming no label returns every step of
// that scope. A label with no entry is simply absent from the answer, so a
// caller can ask for a step that may not have run.
//
// `--fields` is what keeps a role's independence when its brief and something it
// must not see sit in the same step. The test-author reads the researcher's
// `testPlan` and must never meet its `plan`, so its prompt names the fields and
// the rest never reaches it. Without the flag the step comes back whole, which
// is what the closing planner wants.
function steps(backlogPath, incrementId, labels, fields) {
  const backlog = loadBacklog(backlogPath)
  let source
  if (incrementId === '-') {
    source = (backlog.run && backlog.run.steps) || []
  } else {
    const increment = (backlog.increments || []).find((i) => i.id === incrementId)
    if (!increment) fail(`no increment "${incrementId}" in ${backlogPath}`, 1)
    source = increment.steps || []
  }
  const wanted = labels.length
    ? labels.map((label) => source.find((step) => step.label === label)).filter(Boolean)
    : source
  const project = (ret) => {
    if (!fields) return ret
    const out = {}
    if (!ret || typeof ret !== 'object') return out
    for (const field of fields) {
      if (Object.prototype.hasOwnProperty.call(ret, field)) out[field] = ret[field]
    }
    return out
  }
  const out = wanted.map((step) => ({
    label: step.label,
    at: step.at || '',
    return: project(step.return),
  }))
  process.stdout.write(JSON.stringify(out, null, 2) + '\n')
}

// The planner's map of the files the issue has to change. Every researcher
// starts from it, and it is the one piece of content that belongs to the run
// rather than to a step.
function codemap(backlogPath) {
  const backlog = loadBacklog(backlogPath)
  process.stdout.write((typeof backlog.codemap === 'string' ? backlog.codemap : '') + '\n')
}

// The whole file, byte for byte. This is for a human analysing a finished run,
// not for an agent in one: a run's reads are addressed, so that the file may
// keep everything without any step paying for the rest of it.
function read(backlogPath) {
  if (!fs.existsSync(backlogPath)) fail(`no backlog at ${backlogPath}`, 1)
  let text
  try {
    text = fs.readFileSync(backlogPath, 'utf8')
  } catch {
    fail(`cannot read the backlog at ${backlogPath}`, 1)
  }
  process.stdout.write(text)
}

const [command, ...rest] = process.argv.slice(2)

function need(count) {
  if (rest.length < count) fail(`${command} needs ${count} argument(s)\n${USAGE}`, 2)
}

switch (command) {
  case 'init':
    need(2)
    init(rest[0], rest[1])
    break
  case 'record':
    need(4)
    record(rest[0], rest[1], rest[2], rest[3], rest[4])
    break
  case 'branch':
    need(3)
    branch(rest[0], rest[1], rest[2])
    break
  case 'close':
    need(3)
    close(rest[0], rest[1], rest[2], rest[3])
    break
  case 'index':
    need(1)
    index(rest[0])
    break
  case 'steps': {
    need(2)
    const at = rest.indexOf('--fields')
    if (at >= 0 && at + 1 >= rest.length) fail(`--fields needs a comma-separated list\n${USAGE}`, 2)
    const fields =
      at >= 0 ? rest[at + 1].split(',').map((f) => f.trim()).filter(Boolean) : null
    const labels = (at >= 0 ? rest.slice(2, at) : rest.slice(2)).filter(Boolean)
    steps(rest[0], rest[1], labels, fields)
    break
  }
  case 'codemap':
    need(1)
    codemap(rest[0])
    break
  case 'read':
    need(1)
    read(rest[0])
    break
  default:
    fail(command ? `unknown command "${command}"\n${USAGE}` : USAGE, 2)
}
