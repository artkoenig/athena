# skills/agent-brief/assets

Tests for `backlog.mjs`, the CLI that is the only writer of a run's `backlog.json`.

## What the suite covers

`backlog.test.mjs` exercises all nine CLI commands — `init`, `start`, `record`, `branch`, `close`, `index`, `steps`, `codemap`, `read` — end to end: the init merge rules (kept increments keep steps, their branch and their archived attempts, dropped ones vanish, `run.steps`, the codemap and the step in flight survive a re-cut, a payload cannot set a branch), start's one-slot `running` marker (what it writes, its verbatim prompt, its `-` scope naming no increment, a start replacing the one before it, an unknown increment exiting 1, and a start before `init` exiting 0 without creating the file), record's supersede-with-history on a repeated label, its `-` routing into `run.steps`, its verbatim storage of the dispatch prompt and its clearing of its own running marker but never another step's, branch's record-and-replace as the one writer of an increment's branch, close's status validation and its archiving of the attempt (the increment's steps plus the run-level steps of that increment, with the run's own steps and the codemap left standing), the index's steering projection (small values survive, content and the codemap never appear, `asked` is computed so a long question still marks the step), `steps` with and without `--fields`, `codemap`'s isolated output, read's byte-exact output, exit codes with untouched files on failure, and the atomic `.tmp`-rename write.

The line the whole suite defends is that nothing is deleted and nothing leaks: a close and a re-record keep what they replace, and a read returns only what its caller named.

One case at the end is about what the recorder does *not* do. It used to push every document it wrote to a telemetry collector, which put a network call, a two-second timeout and a pair of environment variables inside every step of every run; that job belongs to the `FileChanged` hook on `backlog.json` now (`hooks/backlog-changed.mjs`, with its own suite). So the case runs the whole sequence of writing subcommands with a real, listening, correctly named collector in the environment under all four variable names — and asserts it receives nothing at all, while every write still lands on disk.

## Helpers and fixtures

All defined at the top of `backlog.test.mjs`; every case reuses them.

- `cli` — absolute path to `backlog.mjs`, resolved relative to the test file.
- `tmpDir()` — fresh `mkdtemp` directory under the OS tmpdir; one per case, never cleaned up.
- `writeJson(dir, name, value)` — writes a JSON payload file and returns its path.
- `cleanEnv(extra)` — a copy of `process.env` with `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `UROBOROS_OBS_URL` and `UROBOROS_OBS_TOKEN` removed, then `extra` merged over it. Every child gets one, so a developer whose shell already exports to a real collector cannot have this suite talking to it — and the last case sets all four deliberately, which is the only place they belong.
- `run(args)` — spawns the real CLI synchronously (`execFileSync`) with `cleanEnv()`, returns its stdout; throws on non-zero exit.
- `runFails(args)` — runs the CLI expecting non-zero exit, returns the error (`status`, `stdout`, `stderr`); an unexpected success is itself the failure.
- `runAsync(args, env, options)` — promisified `execFile` of the CLI with the given `env` and a 10000 ms child timeout, resolving to `{ stdout, stderr }`. The last case uses this and never `run()`: `execFileSync` blocks the very event loop the in-process stub answers requests on, and a request the stub never got round to recording would look exactly like the silence that case is asserting.
- `collectorStub()` — starts a real `node:http` server on `127.0.0.1:0` and resolves to `{ url, requests, close() }`. `requests` collects every request as `{ method, url, headers, body }` (`body` as the raw string) and it answers `200 {"ok":true}`. It exists for one case: a collector that is genuinely there, genuinely reachable and genuinely listening, and that the recorder still never contacts.
- `backlogTemplate(increments)` — minimal valid init payload (`issue`, `workflow`, `increments`).
- `incrementPayload(id, title, extra)` — one well-formed increment; spread `extra` to override fields.
- `researchReturn` — a realistic step return, defined just above the `index` cases: two `MARKER-…`-prefixed strings long enough to be content, a list of objects, and the small steering values beside them. Reuse it wherever a case has to tell content from steering; the markers are what the negative assertions look for.

## Where a new case belongs

The file is helpers first, then flat top-level `test(...)` calls grouped by command in CLI order: init (including codemap and close-vs-codemap interplay), start (including its interplay with record and with a re-cut), record (including the prompt file and the supersede-with-history rule), branch, close (including the attempt archive across a re-cut), index, steps, codemap, read, the atomic-write case, and finally the case that pins the decoupling. Insert a new case inside the block for the command it exercises; a shared-mechanics case, like the `.tmp` one, goes at the end.

A case about what a read must *not* return asserts on the raw stdout string, not on the parsed object — a field dropped from the projection and a field present but empty look the same after `JSON.parse`, and only the string catches content that leaked under a different key.

## Naming

Lowercase declarative sentences stating the guaranteed behavior, usually leading with the command name: `'record appends a step to the named increment and prints only the confirmation, nothing from the file'`. No "should", no numbering. Assertion messages carry the why.

## Faked vs real

Nothing is mocked. Every case spawns the actual `backlog.mjs` as a child process against real files in a fresh temp directory, and asserts on real stdout, stderr, exit codes and file bytes. Most cases spawn synchronously (`execFileSync`, via `run`/`runFails`); the last one spawns asynchronously instead (`execFile`, via `runAsync`) for the reason given above. The collector it asserts the silence against is a real `node:http` server on a real port in the test process — nothing about it is mocked either. The suite has no dependencies beyond `node:test`, `node:assert/strict` and `node:http`.

## Running it

From the repository root:

    node --test skills/agent-brief/assets/backlog.test.mjs
