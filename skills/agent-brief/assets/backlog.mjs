#!/usr/bin/env node
// The only writer of an issue's `backlog.json`. That file is the whole durable
// state of a run: what the increments are, what each step of each increment
// returned, and what the review made of it. A session that dies mid-run resumes
// from it and from nothing else.
//
// It is a CLI rather than a paragraph of instructions in every prompt because
// three of its rules are the kind an agent gets subtly wrong: an increment kept
// across a re-cut keeps the steps it already recorded, a step repeated after a
// crash replaces its own earlier entry instead of piling up, and closing an
// increment sheds its step returns and the returns of the run's own steps.
// Enforced in code, they are testable; asked for in prose, they are hoped for.
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
  '  backlog.mjs init   <backlogPath> <payloadFile>',
  '  backlog.mjs record <backlogPath> <incrementId|-> <label> <payloadFile|->',
  '  backlog.mjs close  <backlogPath> <incrementId> <status> [note]',
  '  backlog.mjs read   <backlogPath>',
  '',
  'record reads the step return from stdin when its payload argument is `-`.',
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

// The step return arrives either as a path to a JSON file or, with a payload
// argument of `-`, on stdin. Stdin is the form the agents are told to use:
// building the file first put a heredoc between an agent and its own return,
// and a summary carrying quotes or HTML attributes did not survive it.
function readPayload(source, what) {
  if (source !== '-') return readJson(source, what)
  if (process.stdin.isTTY) fail(`${what} was asked for on stdin, but stdin is a terminal`, 2)
  let text
  try {
    text = fs.readFileSync(0, 'utf8')
  } catch {
    fail(`cannot read ${what} from stdin`, 2)
  }
  if (!text.trim()) fail(`${what} on stdin is empty`, 2)
  try {
    return JSON.parse(text)
  } catch (err) {
    fail(`${what} on stdin is not valid JSON: ${err.message}`, 2)
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

function shapeIncrement(raw, steps) {
  return {
    id: String(raw.id),
    title: raw.title || '',
    goal: raw.goal || '',
    criteria: Array.isArray(raw.criteria) ? raw.criteria : [],
    status: raw.status || 'todo',
    note: raw.note || '',
    steps,
  }
}

// `init` is the planner's call, on the opening cut and on every re-cut alike.
// It is a merge, not an overwrite: the payload decides which increments exist
// and what they say, the file decides what they have already recorded. An
// increment the payload drops is gone with its steps; `run.steps` belongs to
// the run rather than to any increment, so a re-cut never touches it.
function init(backlogPath, payloadFile) {
  const payload = readJson(payloadFile, 'the init payload')
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.increments)) {
    fail('the init payload needs { issue, workflow, increments: [...] }', 2)
  }

  let priorSteps = new Map()
  let runSteps = []
  if (fs.existsSync(backlogPath)) {
    const existing = loadBacklog(backlogPath)
    for (const increment of existing.increments || []) {
      priorSteps.set(increment.id, Array.isArray(increment.steps) ? increment.steps : [])
    }
    runSteps = (existing.run && Array.isArray(existing.run.steps) && existing.run.steps) || []
  }

  const backlog = {
    version: 1,
    issue: payload.issue || '',
    workflow: payload.workflow || '',
    increments: payload.increments.map((increment) =>
      shapeIncrement(increment, priorSteps.get(String(increment.id)) || []),
    ),
    run: { steps: runSteps },
  }

  writeBacklog(backlogPath, backlog)
  process.stdout.write(
    `wrote ${backlogPath} with ${backlog.increments.length} increment(s)\n`,
  )
}

// `record` is every agent's own call, once per step. The increment id `-` puts
// the step in `run.steps`, which is where the steps that sit between increments
// go — the opening cut, each close, the publish.
function record(backlogPath, incrementId, label, payloadFile) {
  const payload = readPayload(payloadFile, 'the step return')
  const backlog = loadBacklog(backlogPath)

  let steps
  if (incrementId === '-') {
    if (!backlog.run || !Array.isArray(backlog.run.steps)) backlog.run = { steps: [] }
    steps = backlog.run.steps
  } else {
    const increment = (backlog.increments || []).find((i) => i.id === incrementId)
    if (!increment) fail(`no increment "${incrementId}" in ${backlogPath}`, 1)
    if (!Array.isArray(increment.steps)) increment.steps = []
    steps = increment.steps
  }

  const entry = { label, at: new Date().toISOString(), return: payload }
  const at = steps.findIndex((step) => step.label === label)
  if (at >= 0) steps[at] = entry
  else steps.push(entry)

  writeBacklog(backlogPath, backlog)
  process.stdout.write(`recorded ${label}\n`)
}

// `close` is the planner's verdict call. Shedding the steps is the point as
// much as the status is: a closed increment's record is its status, its note,
// its criteria and the git history, and nobody downstream re-reads the returns
// that got it there. The run's own steps shed with it — the opening cut is the
// largest return of the run and belongs to no increment, so leaving it would
// keep the whole cut in the file for every close that follows.
//
// The shed drops each run step's `return` and keeps its `label` and `at`. A
// workflow resumes by asking whether a label is recorded, so the stub still
// skips its step; deleting the entry outright would re-dispatch the opening
// cut after every close.
function close(backlogPath, incrementId, status, note) {
  if (!STATUSES.includes(status)) {
    fail(`status must be one of ${STATUSES.join('|')}, not "${status}"`, 1)
  }
  const backlog = loadBacklog(backlogPath)
  const increment = (backlog.increments || []).find((i) => i.id === incrementId)
  if (!increment) fail(`no increment "${incrementId}" in ${backlogPath}`, 1)

  increment.status = status
  increment.note = note || ''
  increment.steps = []

  if (backlog.run && Array.isArray(backlog.run.steps)) {
    for (const step of backlog.run.steps) delete step.return
  }

  writeBacklog(backlogPath, backlog)
  process.stdout.write(`closed ${incrementId} as ${status}\n`)
}

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
    record(rest[0], rest[1], rest[2], rest[3])
    break
  case 'close':
    need(3)
    close(rest[0], rest[1], rest[2], rest[3])
    break
  case 'read':
    need(1)
    read(rest[0])
    break
  default:
    fail(command ? `unknown command "${command}"\n${USAGE}` : USAGE, 2)
}
