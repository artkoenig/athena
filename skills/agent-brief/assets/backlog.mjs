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
  '  backlog.mjs init   <backlogPath> <payloadFile>',
  '  backlog.mjs record <backlogPath> <incrementId|-> <label> <payloadFile>',
  '  backlog.mjs branch <backlogPath> <incrementId> <branchName>',
  '  backlog.mjs close  <backlogPath> <incrementId> <status> [note]',
  '  backlog.mjs read   <backlogPath>',
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

function shapeIncrement(raw, steps, branch) {
  return {
    id: String(raw.id),
    title: raw.title || '',
    goal: raw.goal || '',
    criteria: Array.isArray(raw.criteria) ? raw.criteria : [],
    status: raw.status || 'todo',
    note: raw.note || '',
    branch: branch || '',
    steps,
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
// writer, so the payload cannot set or erase it.
function init(backlogPath, payloadFile) {
  const payload = readJson(payloadFile, 'the init payload')
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.increments)) {
    fail('the init payload needs { issue, workflow, increments: [...] }, codemap optional', 2)
  }

  let priorSteps = new Map()
  let priorBranches = new Map()
  let runSteps = []
  let priorCodemap = ''
  if (fs.existsSync(backlogPath)) {
    const existing = loadBacklog(backlogPath)
    for (const increment of existing.increments || []) {
      priorSteps.set(increment.id, Array.isArray(increment.steps) ? increment.steps : [])
      priorBranches.set(increment.id, typeof increment.branch === 'string' ? increment.branch : '')
    }
    runSteps = (existing.run && Array.isArray(existing.run.steps) && existing.run.steps) || []
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
      ),
    ),
    run: { steps: runSteps },
  }

  writeBacklog(backlogPath, backlog)
  process.stdout.write(
    `wrote ${backlogPath} with ${backlog.increments.length} increment(s)\n`,
  )
  return backlog
}

// `record` is every agent's own call, once per step. The increment id `-` puts
// the step in `run.steps`, which is where the steps that sit between increments
// go — the opening cut, each close, the publish.
function record(backlogPath, incrementId, label, payloadFile) {
  const payload = readJson(payloadFile, 'the step return')
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
  case 'record':
    need(4)
    state = record(rest[0], rest[1], rest[2], rest[3])
    break
  case 'branch':
    need(3)
    state = branch(rest[0], rest[1], rest[2])
    break
  case 'close':
    need(3)
    state = close(rest[0], rest[1], rest[2], rest[3])
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
// `rest[0]` is the backlog path for all four writing subcommands.
if (state) await announce(state, rest[0])
