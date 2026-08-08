#!/usr/bin/env node
// ---------------------------------------------------------------------------
// The plugin's PostToolUse hook, and the only place in uroboros that pushes a
// run's state to a telemetry collector.
//
// It exists because the alternative was worse. The recorder every agent writes
// its step through used to do this send itself, which put a network call, a
// two-second timeout and a pair of environment variables inside every step of
// every run, measured or not — and put a reference to the collector inside the
// workflow's agents, which are supposed to know nothing but the issue they are
// working. Nothing about a run should change because someone is watching it.
// So the writers write, and this watches from outside.
//
// PostToolUse rather than FileChanged, which is the event this describes and
// would be the obvious one: FileChanged is not in every Claude Code that runs
// this plugin yet, and a hook that silently never fires is worse than one that
// fires often. This one fires after every Bash call — the recorder is always
// run as one — and the gates below throw away everything else. It also reaches
// where it has to: tool events fire the same hooks inside a subagent as in the
// main conversation, and every write of a run state is made by a subagent.
//
// The cost of firing often is one node start per Bash call, and the gates are
// ordered by how much they reject for how little: no collector in the
// environment first, then the tool, then a command that never mentions a run
// state, then a document identical to the one already sent. That last gate is
// what keeps the reads off the wire — a run reads its state far more often
// than it writes it, and only a write is worth a send.
//
// Every failure here is silent to the human and exits 0. PostToolUse cannot
// block — the tool already ran — and a non-zero exit only puts stderr in front
// of the agent as feedback, which would turn a collector's bad day into
// something an agent has to reason about. On exit 0 stderr goes to the debug
// log, which is where a diagnosis belongs.
//
// Zero dependencies, no build step: it runs from a checkout and from a plugin
// cache alike, so it hard-codes no path.
// ---------------------------------------------------------------------------
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The whole budget for the send. Short: the next write pushes the whole
// document again anyway, so a slow collector is never worth waiting on.
const SEND_TIMEOUT_MS = 2000

// The one file this hook is about. The `hooks.json` matcher can only name a
// tool, so every narrowing beyond "a Bash call happened" is here.
const WATCHED = 'backlog.json'

// A path ending in the watched filename, as it appears inside a shell command:
// bounded on both sides so a quoted argument is caught and `backlog.json.tmp`,
// the half-written file the recorder renames away, is not.
const PATH_IN_COMMAND = /(?:^|[\s"'=])([^\s"'=]*backlog\.json)(?=$|[\s"'])/

function note(message) {
  // stderr on a zero exit goes to the debug log and nowhere near the human or
  // the agent.
  process.stderr.write(message + '\n')
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed) return trimmed
  }
  return ''
}

// Reads the collector out of an environment and returns null when that
// environment names none — the ordinary case, and the one that costs nothing.
// Takes the environment as an argument rather than reaching for `process.env`,
// so it stays a pure function of what it is given.
//
// The OTLP pair wins over the uroboros pair because it is the block a measured
// session always carries; argus sets both to the same address and secret
// anyway, so this reads one collector under two names, never two collectors.
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

// What was last accepted by the collector for this file, remembered across
// invocations because each one is its own process. Keyed on the absolute path
// and kept in the temp directory, never in the repository: nothing this hook
// does may show up in a diff.
function memoPathFor(target) {
  const key = crypto.createHash('sha1').update(target).digest('hex').slice(0, 16)
  return path.join(os.tmpdir(), `uroboros-run-state-${key}.sent`)
}

function digest(text) {
  return crypto.createHash('sha256').update(text).digest('hex')
}

function readStdin() {
  return new Promise((resolve) => {
    let text = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      text += chunk
    })
    process.stdin.on('end', () => resolve(text))
    process.stdin.on('error', () => resolve(text))
  })
}

async function main() {
  // Read before anything else: a hook that leaves its stdin unread can leave
  // the writer on the other end blocked on a full pipe.
  const raw = await readStdin()

  const collector = collectorFrom(process.env)
  if (!collector) return // telemetry is off, and that is the common case

  let event
  try {
    event = JSON.parse(raw)
  } catch {
    return note('the hook input is not JSON, nothing sent')
  }

  // The matcher is a pattern the CLI applies; this is the guarantee.
  if (event.tool_name !== 'Bash') return

  const command = firstNonEmpty(event.tool_input && event.tool_input.command)
  const found = command && PATH_IN_COMMAND.exec(command)
  if (!found) return // the overwhelming majority of Bash calls end here

  // Relative as the agent typed it, resolved against the directory the tool
  // ran in — which the event carries, and which is not this process's own.
  const file = path.resolve(firstNonEmpty(event.cwd) || process.cwd(), found[1])
  if (path.basename(file) !== WATCHED) return

  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    // A command that names the state without the state existing — a read that
    // exited 1, the opening cut's own announcement before `init` has written
    // anything. Nothing to send, and nothing wrong.
    return note(`cannot read ${file}: ${(err && err.message) || err}`)
  }

  let state
  try {
    state = JSON.parse(text)
  } catch (err) {
    // The recorder writes through a temp file and a rename, so a half-written
    // read should not happen — but if it does, the write that follows fires
    // this hook again and sends the whole document.
    return note(`${file} does not parse: ${(err && err.message) || err}`)
  }

  // Unchanged since the last send: this was a read, not a write. A run runs
  // several reads for every write, so this is the gate that decides what the
  // hook actually costs a collector.
  const memo = memoPathFor(file)
  const stamp = digest(text)
  try {
    if (fs.readFileSync(memo, 'utf8').trim() === stamp) return
  } catch {
    // No memo yet, or an unreadable one. Send, and write a fresh one.
  }

  // The run this state belongs to, by the name a reader knows it under: the
  // state's own `issue` where it has one, and the directory it lives in
  // otherwise. An empty id would file the run under nothing.
  const id = firstNonEmpty(state && state.issue) || path.dirname(file)

  const headers = { 'content-type': 'application/json' }
  if (collector.authorization) headers.authorization = collector.authorization

  const response = await fetch(collector.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ id, state }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  })
  if (!response.ok) return note(`the collector answered ${response.status}`)

  // Written only once the collector has taken it, so a send that failed is
  // retried by the next tool call rather than being remembered as delivered.
  try {
    fs.writeFileSync(memo, stamp)
  } catch (err) {
    note(`cannot remember what was sent: ${(err && err.message) || err}`)
  }
}

// One catch for the whole of it, and it exits 0 like every other path: this
// hook may cost a run its speed, never its outcome.
try {
  await main()
} catch (err) {
  note(`send failed: ${(err && err.message) || err}`)
}
process.exit(0)
