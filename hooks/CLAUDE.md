# hooks/

The plugin's two hooks, declared in `hooks.json` and shipped by `plugin.json`.

`session-start.sh` puts the rulebook in front of a starting session and warns a
cloud session running an outdated plugin. `backlog-changed.mjs` follows
`backlog.json` and pushes a run's state to the telemetry collector as the run
writes it.

That second one is the only place in uroboros that talks to a collector. The
recorder every agent writes its step through used to do the send itself, which
put a network call and a pair of environment variables inside every step of
every run and gave the workflow's agents a reference to something they must
know nothing about. The hook is what replaced it: the writers write, and this
watches from outside.

It hangs off `PostToolUse` on `Bash` rather than the `FileChanged` event that
describes exactly what it does, because `FileChanged` is not in every Claude
Code that runs this plugin yet and a hook that silently never fires is worse
than one that fires often. The recorder is always run as a Bash call, and tool
events fire inside a subagent the same as in the main conversation — which
matters, because every write of a run state is made by a subagent.

Firing often is paid for by the order of the gates: no collector in the
environment first, then the tool, then a command that never mentions a run
state, then a document identical to the one already sent. A run reads its state
several times for every write, and that last gate — a digest of the last
accepted document, kept per file in the temp directory — is what keeps the
reads off the wire.

## Tests for `backlog-changed.mjs`

`backlog-changed.test.mjs` spawns the real hook as a child process — the event
as JSON on stdin, exactly as Claude Code delivers it — against real files and a
real HTTP server.

### What the suite covers

The environment gate (no collector named means nothing sent and not a word
said); the send itself (`POST /api/runs`, a JSON content-type, the whole
document, and the run identified by the `issue` the state names); the fallback
id for a state that names none; a relative path resolved against the event's
`cwd` and not this process's; the unchanged-document gate, with the three reads
a run makes between two writes sending nothing and the next real write sending
again; a refused send retried by the next call rather than remembered as
delivered; a Bash call that never mentions a run state dropped without a word;
`backlog.json.tmp` not mistaken for `backlog.json`; a tool that is not Bash
refused however the matcher was read; an input that is not JSON; a state that
is not there and one that does not parse, with the write that follows sending
it whole; both environment name pairs
(`OTEL_EXPORTER_OTLP_ENDPOINT`/`OTEL_EXPORTER_OTLP_HEADERS` and
`UROBOROS_OBS_URL`/`UROBOROS_OBS_TOKEN`) configuring the address and the bearer
header; a collector that answers 500, one that refuses the connection and one
that never answers, all three exiting 0; and stdout staying empty on every
path.

The line the whole suite defends is that this hook cannot cost a run anything.
`PostToolUse` cannot block — the tool already ran — and a non-zero exit only
puts stderr in front of the agent as feedback, which would turn a collector's
bad day into something an agent has to reason about. So every failure exits 0
and says why on stderr, which on a zero exit goes to the debug log.

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
- `event(command, extra)` — a well-formed `PostToolUse` payload for a Bash call
  running `command`, common fields included. It carries `agent_id` and
  `agent_type` because every write of a run state is made by a subagent, and
  that is the shape the hook actually meets; spread `extra` to change the tool,
  the `cwd` or the input.
- `recordCall(file)` — the command line the recorder is actually invoked with,
  so a case exercises the string the hook has to find a path in rather than a
  convenient one.

### Where a new case belongs

Flat top-level `test(...)` calls after the helpers, in the order the hook's own
gates run: the environment, the send, the ids, the unchanged-document gate and
its retry, the calls it drops, the inputs it refuses, the file states it
tolerates, the two environment name pairs, the collector answers it tolerates,
and the stdout guarantee last.

A case about something *not* being sent asserts on `stub.requests.length`
against a stub that is genuinely listening — a stub that was never started
would pass the same assertion for the wrong reason.

A case about the unchanged-document gate needs its own temp directory: the
digest is remembered per absolute path across processes, so two cases sharing a
directory would share a memo.

### Faked vs real

Nothing is mocked. Every case spawns the actual hook against real files in a
fresh temp directory, and the collector is a real `node:http` server on a real
port in the test process. No dependencies beyond `node:test`,
`node:assert/strict`, `node:child_process`, `node:http`, `node:fs`, `node:os`
and `node:path`.

### Running it

From the repository root:

    node --test hooks/backlog-changed.test.mjs
