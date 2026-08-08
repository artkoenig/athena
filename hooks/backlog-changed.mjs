#!/usr/bin/env node
// ---------------------------------------------------------------------------
// The plugin's FileChanged hook, and the only place in uroboros that pushes a
// run's state to a telemetry collector.
//
// It exists because the alternative was worse. The recorder every agent writes
// its step through used to do this send itself, which put a network call, a
// two-second timeout and a pair of environment variables inside every step of
// every run, measured or not — and put a reference to the collector inside the
// workflow's agents, which are supposed to know nothing but the issue they are
// working. Nothing about a run should change because someone is watching it.
// So the writers write, and the session's own file watcher notices.
//
// Subscribing rather than polling is what makes this free: the hook fires when
// `backlog.json` changes and never otherwise, so a run nobody is watching pays
// nothing at all, and a run somebody is watching pays one POST per write.
//
// Every failure here is silent to the human and exits 0. FileChanged has no
// decision control — the change already happened and cannot be undone — so the
// only thing a non-zero exit would buy is an error message in front of someone
// whose run is fine. A collector that is absent, refusing, hung or angry
// belongs in the debug log, which is exactly where stderr goes on exit 0.
//
// Zero dependencies, no build step: it runs from a checkout and from a plugin
// cache alike, so it hard-codes no path.
// ---------------------------------------------------------------------------
import fs from 'node:fs'
import path from 'node:path'

// The whole budget for the send. Short: the next write pushes the whole
// document again anyway, so a slow collector is never worth waiting on.
const SEND_TIMEOUT_MS = 2000

// The one file this hook is about. The matcher in `hooks.json` names it too,
// but a matcher is a pattern the CLI applies and this is the guarantee: a
// second FileChanged entry, or a matcher read as a regular expression, must
// never send this hook something that is not a run state.
const WATCHED = 'backlog.json'

function note(message) {
  // stderr on a zero exit goes to the debug log and nowhere near the human.
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
  // Read before the environment is looked at: a hook that leaves its stdin
  // unread can leave the writer on the other end blocked on a full pipe.
  const raw = await readStdin()

  const collector = collectorFrom(process.env)
  if (!collector) return // telemetry is off, and that is the common case

  let event
  try {
    event = JSON.parse(raw)
  } catch {
    return note('the hook input is not JSON, nothing sent')
  }

  const file = firstNonEmpty(event && event.file_path)
  if (!file) return note('the hook input names no file_path, nothing sent')
  if (path.basename(file) !== WATCHED) return note(`${file} is not a run state, nothing sent`)

  // A deleted state is not a state. Nothing is sent, and nothing is withdrawn
  // either — the collector keeps the last version it was given, which is what
  // someone reading a finished run wants.
  if (event.change_type === 'deleted') return

  let state
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    // The recorder writes through a temp file and a rename, so a half-written
    // read should not happen — but if it does, the write that follows fires
    // this hook again and sends the whole document.
    return note(`cannot read ${file}: ${(err && err.message) || err}`)
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
  if (!response.ok) note(`the collector answered ${response.status}`)
}

// One catch for the whole of it, and it exits 0 like every other path: this
// hook may cost a run its speed, never its outcome.
try {
  await main()
} catch (err) {
  note(`send failed: ${(err && err.message) || err}`)
}
process.exit(0)
