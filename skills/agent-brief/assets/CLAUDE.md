# skills/agent-brief/assets

Tests for `backlog.mjs`, the CLI that is the only writer of a run's `backlog.json`.

## What the suite covers

`backlog.test.mjs` exercises all eight CLI commands — `init`, `record`, `branch`, `close`, `index`, `steps`, `codemap`, `read` — end to end: the init merge rules (kept increments keep steps, their branch and their archived attempts, dropped ones vanish, `run.steps` and the codemap survive a re-cut, a payload cannot set a branch), record's supersede-with-history on a repeated label, its `-` routing into `run.steps` and its verbatim storage of the dispatch prompt, branch's record-and-replace as the one writer of an increment's branch, close's status validation and its archiving of the attempt (the increment's steps plus the run-level steps of that increment, with the run's own steps and the codemap left standing), the index's steering projection (small values survive, content and the codemap never appear, `asked` is computed so a long question still marks the step), `steps` with and without `--fields`, `codemap`'s isolated output, read's byte-exact output, exit codes with untouched files on failure, and the atomic `.tmp`-rename write.

The line the whole suite defends is that nothing is deleted and nothing leaks: a close and a re-record keep what they replace, and a read returns only what its caller named.

It also covers the best-effort send to a collector that follows every write: `init`, `record`, `branch` and `close` each push the document they just wrote, identified by the issue, to the collector named by the OTLP collector environment; `read` sends nothing, since it never writes. The address and bearer token come from that environment's two name pairs (`OTEL_EXPORTER_OTLP_ENDPOINT`/`OTEL_EXPORTER_OTLP_HEADERS` and `UROBOROS_OBS_URL`/`UROBOROS_OBS_TOKEN`) and nowhere else; with none of the four set, nothing is sent. A collector that refuses the connection, never answers or answers with an error status costs the caller neither its exit code nor its one confirmation line — the send is invisible whichever way it fails.

## Helpers and fixtures

All defined at the top of `backlog.test.mjs`; every case reuses them.

- `cli` — absolute path to `backlog.mjs`, resolved relative to the test file.
- `tmpDir()` — fresh `mkdtemp` directory under the OS tmpdir; one per case, never cleaned up.
- `writeJson(dir, name, value)` — writes a JSON payload file and returns its path.
- `cleanEnv(extra)` — a copy of `process.env` with `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `UROBOROS_OBS_URL` and `UROBOROS_OBS_TOKEN` removed, then `extra` merged over it. `run()` and `runFails()` always pass `cleanEnv()` as the child's environment, so no pre-existing case can reach a developer's real collector even when their shell already carries argus's env block.
- `run(args)` — spawns the real CLI synchronously (`execFileSync`) with `cleanEnv()`, returns its stdout; throws on non-zero exit.
- `runFails(args)` — runs the CLI expecting non-zero exit, returns the error (`status`, `stdout`, `stderr`); an unexpected success is itself the failure.
- `runAsync(args, env, options)` — promisified `execFile` of the CLI with the given `env` and a 10000 ms child timeout, resolving to `{ stdout, stderr }`. Every case that talks to a `collectorStub` uses this, never `run()`: `execFileSync` blocks the very event loop the in-process stub answers requests on, so a synchronous spawn would make every send hit its own timeout and the success path would never be exercised.
- `collectorStub(options)` — starts a real `node:http` server on `127.0.0.1:0` and resolves to `{ url, requests, close() }`. `requests` collects every request as `{ method, url, headers, body }` (`body` as the raw string); by default it answers `200 {"ok":true}`, and `options.status`/`options.body`/`options.headers` answer something else while `options.hang: true` never answers at all. `close()` calls `server.closeAllConnections()` before `server.close()` — the never-answering case leaves a socket open, and a plain `close()` would hang the suite at exit.
- `backlogTemplate(increments)` — minimal valid init payload (`issue`, `workflow`, `increments`).
- `incrementPayload(id, title, extra)` — one well-formed increment; spread `extra` to override fields.
- `researchReturn` — a realistic step return, defined just above the `index` cases: two `MARKER-…`-prefixed strings long enough to be content, a list of objects, and the small steering values beside them. Reuse it wherever a case has to tell content from steering; the markers are what the negative assertions look for.

## Where a new case belongs

The file is helpers first, then flat top-level `test(...)` calls grouped by command in CLI order: init (including codemap and close-vs-codemap interplay), record (including the prompt file and the supersede-with-history rule), branch, close (including the attempt archive across a re-cut), index, steps, codemap, read, the atomic-write case, and finally the collector-send cases. Insert a new case inside the block for the command it exercises; a shared-mechanics case (like the `.tmp` one, or the send that follows every write) goes at the end.

A case about what a read must *not* return asserts on the raw stdout string, not on the parsed object — a field dropped from the projection and a field present but empty look the same after `JSON.parse`, and only the string catches content that leaked under a different key.

## Naming

Lowercase declarative sentences stating the guaranteed behavior, usually leading with the command name: `'record appends a step to the named increment and prints only the confirmation, nothing from the file'`. No "should", no numbering. Assertion messages carry the why.

## Faked vs real

Nothing is mocked. Every case spawns the actual `backlog.mjs` as a child process against real files in a fresh temp directory, and asserts on real stdout, stderr, exit codes and file bytes. Most cases spawn synchronously (`execFileSync`, via `run`/`runFails`); the collector-send cases spawn asynchronously instead (`execFile`, via `runAsync`), because a synchronous spawn blocks the event loop that the in-process `collectorStub` needs free to answer the child's request on. The collector itself is a real `node:http` server on a real port in the test process — nothing about it is mocked either — and `run()`/`runFails()` scrub the four collector-environment names from every child so a developer with argus's env block evaluated in their shell never has this suite talking to their real collector. The suite has no dependencies beyond `node:test`, `node:assert/strict` and `node:http`.

## Running it

From the repository root:

    node --test skills/agent-brief/assets/backlog.test.mjs
