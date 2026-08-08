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
// `running` is the one field that is not a record of something finished. A step
// takes minutes to hours, and between its dispatch and its return the file said
// nothing at all — so a human watching a run saw a state that changed once an
// hour and looked stuck in between. `start` writes the step now in flight and
// the prompt it was dispatched with into that field, and `record` clears it as
// the same step returns. It carries no result and nothing reads it to steer:
// the run's memory is `steps`, and a resumed run asks that and never this.
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
// Every write is followed by a best-effort push of the document just written
// to the collector, so a human watching a run sees the state without reading
// the file. That send is silent by design: it prints nothing, checks no
// answer, retries nothing, and never changes an exit code or a confirmation
// line — a collector that is absent, refusing, hung or angry is invisible to
// the agent that called this. Its address and bearer token come from the OTLP
// collector environment and nowhere else — OTEL_EXPORTER_OTLP_ENDPOINT with
// OTEL_EXPORTER_OTLP_HEADERS first, then UROBOROS_OBS_URL with
// UROBOROS_OBS_TOKEN — so there is no flag, no config file and no default
// address, and with none of them set nothing is sent. The collector only ever
// receives a copy: this CLI stays the one writer of the file.
//
// Zero dependencies, no build step: it runs from a checkout, from a plugin
// cache and from an installing project alike, so it hard-codes no path.
import fs from 'node:fs'
import path from 'node:path'

const STATUSES = ['done', 'blocked', 'dropped']

// The whole budget for the send. Short, and deliberately not configurable:
// configurability would be a second place the environment is read.
const SEND_TIMEOUT_MS = 2000

const USAGE = [
  'usage:',
  '  backlog.mjs init    <backlogPath> <payloadFile>',
  '  backlog.mjs start   <backlogPath> <incrementId|-> <label> [promptFile]',
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
  // The step in flight survives a re-cut, and has to: `init` is called from
  // inside a planner step, so rebuilding the document without this field would
  // make the planner erase its own marker halfway through its own work.
  let priorRunning = null
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
    priorRunning = existing.running && typeof existing.running === 'object' ? existing.running : null
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
  if (priorRunning) backlog.running = priorRunning

  writeBacklog(backlogPath, backlog)
  process.stdout.write(
    `wrote ${backlogPath} with ${backlog.increments.length} increment(s)\n`,
  )
  return backlog
}

// `start` is every agent's first call, the counterpart of `record`. It writes
// the step now in flight — which increment, which label, since when, and the
// prompt it was dispatched with — into `running`, so the state says what is
// being worked while it is being worked instead of only once it is done. One
// slot, overwritten: a run works one step at a time, and a start that finds an
// older one there is the ordinary case, not a collision.
//
// It carries no result and no history. Nothing steers on it, `record` clears
// it, and a run that died mid-step leaves a stale marker that the next start
// overwrites — a `running` that stopped moving is exactly the reading a human
// wants from a run that stopped.
//
// A backlog that is not there yet is not an error here. The opening cut runs
// before `init` has created the file, and there is nothing for it to attach to;
// a step whose whole purpose is to be seen must never be the thing that stops
// an agent, so this says so and exits 0.
function start(backlogPath, incrementId, label, promptFile) {
  const prompt = promptFile === undefined ? null : readText(promptFile, 'the dispatch prompt')
  if (!fs.existsSync(backlogPath)) {
    process.stdout.write(`no backlog at ${backlogPath} yet, nothing announced\n`)
    return null
  }
  const backlog = loadBacklog(backlogPath)

  if (incrementId !== '-') {
    const increment = (backlog.increments || []).find((i) => i.id === incrementId)
    if (!increment) fail(`no increment "${incrementId}" in ${backlogPath}`, 1)
  }

  backlog.running = {
    increment: incrementId === '-' ? '' : incrementId,
    label,
    at: new Date().toISOString(),
  }
  if (prompt !== null) backlog.running.prompt = prompt

  writeBacklog(backlogPath, backlog)
  process.stdout.write(`started ${label}\n`)
  return backlog
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

  // The step that was in flight has landed, so the marker goes. Only its own:
  // a record for some other label leaves a running step alone, because that is
  // a marker the step in flight still owns.
  if (backlog.running && backlog.running.label === label) delete backlog.running

  writeBacklog(backlogPath, backlog)
  process.stdout.write(`recorded ${label}\n`)
  return backlog
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
  return backlog
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
  return backlog
}

// Reads the collector out of an environment and returns null when that
// environment names none — the common case, and the one that costs not a
// syscall. Takes the environment as an argument rather than reaching for
// `process.env`, so it stays a pure function of what it is given.
//
// The OTLP pair wins over the uroboros pair because it is the block a
// measured session always carries; `otelEnvFor` in argus sets both to the
// same address and secret anyway, so this reads one collector under two
// names, never two collectors.
function collectorFrom(env) {
  const base = firstNonEmpty(env.OTEL_EXPORTER_OTLP_ENDPOINT, env.UROBOROS_OBS_URL)
  if (!base) return null
  const url = base.replace(/\/+$/, '') + '/api/runs'

  // OTLP convention: a comma-separated list of key=value header pairs. Argus
  // writes exactly `Authorization=Bearer <token>`, and the value rides
  // verbatim — this is not the place to guess at a scheme.
  const headers = firstNonEmpty(env.OTEL_EXPORTER_OTLP_HEADERS)
  if (headers) {
    for (const pair of headers.split(',')) {
      const at = pair.indexOf('=')
      if (at < 0) continue
      if (pair.slice(0, at).trim().toLowerCase() !== 'authorization') continue
      const value = pair.slice(at + 1).trim()
      if (value) return { url, authorization: value }
    }
  }

  const token = firstNonEmpty(env.UROBOROS_OBS_TOKEN)
  return { url, authorization: token ? `Bearer ${token}` : '' }
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed) return trimmed
  }
  return ''
}

// The send, and the whole of what the collector ever gets. One attempt, a
// short bound, and an empty catch: a refused connection, a hung server, a
// non-2xx answer and a Node too old to have `fetch` all end the same way,
// with nothing said and nothing changed. Retrying would be pointless anyway —
// every send carries the complete document, so the next write resends it.
async function announce(state, backlogPath) {
  try {
    if (typeof fetch !== 'function') return
    const collector = collectorFrom(process.env)
    if (!collector) return

    // Sent explicitly rather than left to the collector's own fallback, so a
    // state whose issue is empty is still filed under a name a reader knows:
    // the directory the state was written into.
    const id = firstNonEmpty(state && state.issue) || path.dirname(backlogPath)

    const headers = { 'content-type': 'application/json' }
    if (collector.authorization) headers.authorization = collector.authorization

    await fetch(collector.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id, state }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    })
  } catch {
    // Best-effort: the agent that called this is owed its confirmation line
    // and its exit code, and owes the collector nothing.
  }
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

// Every subcommand that writes returns the document it wrote; `read` returns
// nothing, and so sends nothing.
let state

switch (command) {
  case 'init':
    need(2)
    state = init(rest[0], rest[1])
    break
  case 'start':
    need(3)
    state = start(rest[0], rest[1], rest[2], rest[3])
    break
  case 'record':
    need(4)
    state = record(rest[0], rest[1], rest[2], rest[3], rest[4])
    break
  case 'branch':
    need(3)
    state = branch(rest[0], rest[1], rest[2])
    break
  case 'close':
    need(3)
    state = close(rest[0], rest[1], rest[2], rest[3])
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

// One send site, so no subcommand added later can forget it. It runs after
// the confirmation line is already out, so the send's latency is never in
// front of the caller's answer, and after every failure path — those all go
// through fail(), which exits — so a call that wrote nothing sends nothing.
// `rest[0]` is the backlog path for every writing subcommand, and a `start`
// that found no file to write returns nothing and so sends nothing either.
if (state) await announce(state, rest[0])
