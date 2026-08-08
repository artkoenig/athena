# skills/agent-brief/assets

Tests for `backlog.mjs`, the CLI that is the only writer of a run's `backlog.json`.

## What the suite covers

`backlog.test.mjs` exercises all five CLI commands — `init`, `record`, `branch`, `close`, `read` — end to end: the init merge rules (kept increments keep steps and their branch, dropped ones vanish, `run.steps` and the codemap survive a re-cut, a payload cannot set a branch), record's replace-on-same-label and `-` routing into `run.steps`, branch's record-and-replace as the one writer of an increment's branch, close's status validation and shedding of step returns while codemap and branch stand, read's byte-exact output, exit codes with untouched files on failure, and the atomic `.tmp`-rename write.

## Helpers and fixtures

All defined at the top of `backlog.test.mjs`; every case reuses them.

- `cli` — absolute path to `backlog.mjs`, resolved relative to the test file.
- `tmpDir()` — fresh `mkdtemp` directory under the OS tmpdir; one per case, never cleaned up.
- `writeJson(dir, name, value)` — writes a JSON payload file and returns its path.
- `run(args)` — spawns the real CLI synchronously, returns its stdout; throws on non-zero exit.
- `runFails(args)` — runs the CLI expecting non-zero exit, returns the error (`status`, `stdout`, `stderr`); an unexpected success is itself the failure.
- `backlogTemplate(increments)` — minimal valid init payload (`issue`, `workflow`, `increments`).
- `incrementPayload(id, title, extra)` — one well-formed increment; spread `extra` to override fields.

## Where a new case belongs

The file is helpers first, then flat top-level `test(...)` calls grouped by command in CLI order: init (including codemap and close-vs-codemap interplay), record, branch, close, read, and a final atomic-write case. Insert a new case inside the block for the command it exercises; a shared-mechanics case (like the `.tmp` one) goes at the end.

## Naming

Lowercase declarative sentences stating the guaranteed behavior, usually leading with the command name: `'record appends a step to the named increment and prints only the confirmation, nothing from the file'`. No "should", no numbering. Assertion messages carry the why.

## Faked vs real

Nothing is mocked. Every case spawns the actual `backlog.mjs` as a child process (`execFileSync(process.execPath, [cli, ...])`) against real files in a fresh temp directory, and asserts on real stdout, stderr, exit codes and file bytes. The suite has no dependencies beyond `node:test` and `node:assert/strict`.

## Running it

From the repository root:

    node --test skills/agent-brief/assets/backlog.test.mjs
