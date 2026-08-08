# hooks/

The plugin's two hooks, declared in `hooks.json` and shipped by `plugin.json`.

`session-start.sh` puts the rulebook in front of a starting session and warns a
cloud session running an outdated plugin. `backlog-changed.mjs` is the
`FileChanged` subscription on `backlog.json`: it pushes a run's state to the
telemetry collector as the run writes it.

That second one is the only place in uroboros that talks to a collector. The
recorder every agent writes its step through used to do the send itself, which
put a network call and a pair of environment variables inside every step of
every run and gave the workflow's agents a reference to something they must
know nothing about. The hook is what replaced it: the writers write, and the
session's own file watcher notices. A run nobody is watching pays nothing,
because the hook fires on a change and never otherwise.

## Tests for `backlog-changed.mjs`

`backlog-changed.test.mjs` spawns the real hook as a child process — the event
as JSON on stdin, exactly as Claude Code delivers it — against real files and a
real HTTP server.

### What the suite covers

The environment gate (no collector named means nothing sent and not a word
said); the send itself (`POST /api/runs`, a JSON content-type, the whole
document, and the run identified by the `issue` the state names); the fallback
id for a state that names none; `created` sent like `modified` and `deleted`
sent not at all; a `file_path` whose basename is not `backlog.json` refused
however the matcher was read; an input that is not JSON and one that names no
file; a state that is gone or half-written skipped, with the write that follows
sending it whole; both environment name pairs
(`OTEL_EXPORTER_OTLP_ENDPOINT`/`OTEL_EXPORTER_OTLP_HEADERS` and
`UROBOROS_OBS_URL`/`UROBOROS_OBS_TOKEN`) configuring the address and the bearer
header; a collector that answers 500, one that refuses the connection and one
that never answers, all three exiting 0; and stdout staying empty on every
path.

The line the whole suite defends is that this hook cannot cost a run anything.
`FileChanged` has no decision control — the change already happened — so every
failure exits 0 and says why on stderr, which on a zero exit goes to the debug
log and never in front of the human.

### Helpers and fixtures

All defined at the top of the file; every case reuses them.

- `hook` — absolute path to `backlog-changed.mjs`, resolved relative to the
  test file.
- `cleanEnv(extra)` — a copy of `process.env` with the four collector variables
  removed, then `extra` merged over it. Every child gets one, so a developer
  whose shell already exports to a real collector cannot have this suite
  talking to it.
- `tmpDir()` — fresh `mkdtemp` directory under the OS tmpdir; one per case,
  never cleaned up.
- `stateOf(extra)` — a minimal valid run state; spread `extra` to override
  fields.
- `writeState(dir, state)` — writes it the way the recorder does, through a
  temp file and a rename, and returns the path.
- `collectorStub(options)` — a real `node:http` server on `127.0.0.1:0`
  resolving to `{ url, requests, close() }`. `requests` collects every request
  as `{ method, url, headers, body }`; `options.status` answers something other
  than 200 and `options.hang: true` never answers at all.
- `runHook(input, env)` — spawns the hook with `input` on stdin (verbatim when
  it is a string, so a case can hand it something that is not JSON) and
  resolves to `{ code, stdout, stderr }`.
- `event(file, extra)` — a well-formed `FileChanged` payload, common fields
  included; spread `extra` to change `change_type` or drop a field.

### Where a new case belongs

Flat top-level `test(...)` calls after the helpers, in the order the hook's own
concerns run: the environment gate, the send, the ids, the change types, the
inputs it refuses, the file states it tolerates, the two environment name
pairs, the collector answers it tolerates, and the stdout guarantee last.

A case about something *not* being sent asserts on `stub.requests.length`
against a stub that is genuinely listening — a stub that was never started
would pass the same assertion for the wrong reason.

### Faked vs real

Nothing is mocked. Every case spawns the actual hook against real files in a
fresh temp directory, and the collector is a real `node:http` server on a real
port in the test process. No dependencies beyond `node:test`,
`node:assert/strict`, `node:child_process`, `node:http`, `node:fs`, `node:os`
and `node:path`.

### Running it

From the repository root:

    node --test hooks/backlog-changed.test.mjs
