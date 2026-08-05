# Test author handoff — `argus --version`

## 1. What was written

One new file, and nothing else touched:

- `/home/user/uroboros/tools/argus/test/version.test.mjs` — 13 cases, `node:test`
  + `node:assert/strict`, zero dependencies, in the style of
  `test/background.test.mjs` (binary resolved with
  `fileURLToPath(new URL('../bin/argus.mjs', import.meta.url))`, run through
  `promisify(execFile)`, per-command `timeout: 10_000` as the only clock —
  `tools/argus/CLAUDE.md` forbids wall-clock assertions on a probe path).

The file is picked up by the package's existing glob
(`"test": "node --test \"test/*.test.mjs\""`), so `npm --prefix tools/argus test`
and `./test.sh` run it without either being edited.

No production file, no other test file, no `package.json` was touched.

### Why nothing was added to `test/config.test.mjs`

The dispatcher offered an optional parser-level guard
(`parseArgs(['-V']).flags.version === true`). It was deliberately **not**
written. That assertion pins *how* `-V` is recognised — an alias table inside
`src/config.mjs` — and an implementation that answers `-V` before `parseArgs`
ever runs would satisfy every acceptance criterion while going red on it. The
criteria are about what the command does, so the tests stay at the command.

## 2. The expected version is never a literal

```js
const VERSION = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')).version;
```

read from `tools/argus/package.json` at test time. `0.1.0` appears nowhere in
the test file. A version bump keeps the suite green without an edit; a version
welded into `bin/argus.mjs` is caught by case 6 below.

## 3. Case-by-case, mapped to the acceptance criteria

| # | Test name | Criterion it pins |
| --- | --- | --- |
| 1 | the manifest carries a version at all, so nothing below can pass vacuously | vacuity guard (see 5) |
| 2 | argus --version prints the version from package.json and exits 0 | AC 1 |
| 3 | argus -V prints the very same thing | AC 2 |
| 4 | the two spellings are indistinguishable in their output | AC 2 |
| 5 | the output is the bare version on one line: no prefix, no banner, nothing on stderr | AC 4 |
| 6 | the printed version follows package.json rather than a literal in the source | AC 3 |
| 7 | the manifest that is read is the program's own, not one lying in the working directory | AC 3 |
| 8 | --version is answered although the environment would make configuration throw | AC 5 |
| 9 | --version is answered although the flags beside it would make configuration throw | AC 5 |
| 10 | -V too is answered ahead of an unusable configuration | AC 2 + AC 5 |
| 11 | no collector is started and no port is taken by a --version run | AC 5 |
| 12 | asking three times in the same directory says the same thing three times and leaves nothing | AC 1/5, the repeat |
| 13 | the help output lists the flag in both spellings | AC 6 |

AC 7 ("a test in `tools/argus/test/` covers both spellings and asserts the
printed string matches `package.json`") is the file itself: cases 2, 3, 4 and 10
cover both spellings, and every one of them compares against `VERSION` read from
the manifest.

AC 8 (`./test.sh` green) is the implementer's bar, not a case here.

### The details worth knowing

**Case 1 — the vacuity guard.** `typeof VERSION === 'string'`, non-empty,
untrimmed-equal-to-trimmed. Without it, a manifest that lost its `version` field
would make `stdout.trim() === undefined`-style comparisons meaningless. This is
the one case that passes today, by design — see section 5.

**Case 2 / 3 — the two spellings.** Both run in a fresh empty temp directory as
`cwd`. Shared helper `assertPrintsVersion` asserts three things at once: the
command was not killed by the timeout (it has to return by itself), exit code 0,
and `stdout.trim() === VERSION`.

**Case 4 — the two spellings are the same flag.** Byte-for-byte equality of
`stdout` between `--version` and `-V`, and of `stderr`. Catches an
implementation that answers `-V` through a different path with a different shape
(a trailing banner on one, say).

**Case 5 — the bare line.** For each spelling: `stdout` split on `\n`, empty
lines dropped, must `deepEqual([VERSION])` — so exactly one non-empty line and
that line is the version. Plus: no leading whitespace, no `argus` anywhere in
stdout (kills `argus 0.1.0`), no leading `v` (kills `v0.1.0`), and
`stderr === ''`. The empty-stderr assertion is deliberate and checked to be
achievable: `argus --help` today produces 0 bytes on stderr, so a clean
implementation produces none either. It is also what forbids the JSON-module
import (`with { type: 'json' }`), whose `ExperimentalWarning` would land next to
an output that is specified as one bare line.

**Case 6 — read from the manifest, not welded in.** A runnable copy of the
package is built in a temp directory (`bin/`, `src/`, and a `package.json` whose
`version` is replaced); the copy is run from an unrelated empty `cwd`. Three
stand-ins, chosen to span the shapes a version string takes: `9.99.99-test`,
`0.0.0` (the falsy-looking boundary), `1.2.3-rc.1+build.5` (pre-release and
build metadata). Each must be printed back. A literal in `bin/argus.mjs` prints
`0.1.0` and goes red three times over. This works because the tool has zero
runtime dependencies — verified: the copy runs `--help` fine.

**Case 7 — which manifest.** The real binary is run from a `cwd` that contains a
decoy `package.json` with `"version": "6.6.6"`. The real version must come out.
This is what makes "read from `package.json`" mean *the program's own manifest*,
resolved from `import.meta.url` and not from the caller's directory — and it is
the case that catches a `readFileSync('package.json')`.

**Cases 8 / 9 / 10 — before any other work.** `resolveConfig` is the first thing
that reads the environment and the first thing that can throw. Both routes into
it are poisoned:

- case 8: `UROBOROS_OBS_RETENTION=not-a-duration` in the child's environment;
- case 9: `argus --retention not-a-duration --version` on the command line;
- case 10: the environment route again, through `-V`.

Confirmed against the current code: both routes reach
`parseDuration` and produce `argus: invalid duration: not-a-duration`, exit 1.
Coming back with exit 0 and the version is therefore proof that configuration
was never resolved. Cases 8–10 also assert `.uroboros-telemetry` stayed absent
in the `cwd`, and case 8 additionally asserts stderr carries none of `argus:`,
`listening`, `persisting` — asserted as **absences**, per `tools/argus/CLAUDE.md`;
no wording is pinned.

**Case 11 — nothing started, no port taken.** A free port is obtained from the
OS (bind to 0, read it back, release — never a hard-coded port), passed as
`--port <n> --version`, and after the command returns the test binds that port
itself. If anything is listening there, the bind fails and the case goes red.
That is the "no collector is started, no network is touched" half stated as an
observable fact rather than as a claim about sockets during the run.

**Case 12 — the repeat.** `--version`, `-V`, `--version` in the *same* directory.
All three print the version, the three outputs collapse to one distinct string,
and `fs.readdirSync(cwd)` is still `[]` — a version question writes nothing at
all, not even a `.uroboros-telemetry` skeleton.

**Case 13 — the help.** `argus --help` exits 0 and its output contains the
substrings `--version` and `-V`. Substrings only: no description text, no column
position, no line position. Whatever wording the implementer chooses is theirs.

## 4. What is deliberately not tested

- **`--version` together with `--help`.** The issue does not say which wins. Any
  order is defensible, so nothing is pinned.
- **`argus env --version` / a subcommand next to the flag.** The issue does not
  decide whether the flag outranks the positional command. Nothing is pinned.
- **`-v` (lowercase).** The issue's own default says it is "left alone". A test
  asserting that `-v` does *not* print the version would pass today (it is an
  unknown flag, exit 1) and so cannot be handed over as a failing test under this
  role's rules. **Open item for the reviewer:** confirm by reading the diff that
  the implementer wired only `-V` and left `-v` untouched — no test covers it.
- **Sockets during the run.** Only the after-the-fact port bind (case 11); the
  dispatcher is right that anything finer would be timing-dependent.
- **Wall-clock durations.** None, anywhere, per `tools/argus/CLAUDE.md`.
- **`README.md`.** The dispatcher's plan adds a row to the options table. No
  criterion mentions the README, so no test asserts on it.

## 5. Open questions for the caller

1. **Case 1 passes today.** It is a vacuity guard, not a behaviour case: it
   asserts that `tools/argus/package.json` has a non-empty string `version`, so
   that the twelve red cases cannot later go green against `undefined`. Every
   other case in the file fails now. If a strictly all-red file is required,
   case 1 is the one to delete — at the cost of that protection.
2. **Empty stderr for `--version`** is my reading of "no banner". It is stricter
   than the issue's literal words (which only govern the output). It is met by
   the obvious implementation and was checked to be met by `--help` today, so it
   should cost the implementer nothing — but it is an interpretation, and it is
   the assertion that rules out the experimental JSON-module import.
3. **`--version` printing something for a manifest without a `version` field** is
   undecided by the issue (print nothing? `undefined`? an error?). Untested.

## 6. Proof of failure — run before implementation

```
$ cd /home/user/uroboros/tools/argus && node --test test/version.test.mjs
ok 1 - the manifest carries a version at all, so nothing below can pass vacuously
not ok 2 - argus --version prints the version from package.json and exits 0
not ok 3 - argus -V prints the very same thing
not ok 4 - the two spellings are indistinguishable in their output
not ok 5 - the output is the bare version on one line: no prefix, no banner, nothing on stderr
not ok 6 - the printed version follows package.json rather than a literal in the source
not ok 7 - the manifest that is read is the program’s own, not one lying in the working directory
not ok 8 - --version is answered although the environment would make configuration throw
not ok 9 - --version is answered although the flags beside it would make configuration throw
not ok 10 - -V too is answered ahead of an unusable configuration
not ok 11 - no collector is started and no port is taken by a --version run
not ok 12 - asking three times in the same directory says the same thing three times and leaves nothing
not ok 13 - the help output lists the flag in both spellings
# tests 13
# pass 1
# fail 12
```

Every failure is the missing behaviour, not an import error and not a typo. The
actual messages, one per case:

- **2, 4, 6, 7, 11, 12** — `--version` is not a flag today, so `main` falls
  through to `start`: the run prints the collector banner and stdout carries no
  version, e.g.

  ```
  argus --version: stdout has to be the bare version "0.1.0" — exit 0, stdout: "",
  stderr: "argus: persisting to /tmp/argus-version-YtxUAd/.uroboros-telemetry/…
           argus listening on http://127.0.0.1:4318 …"
  ```

  Case 6 fails the same way against its stand-in: `a copy whose manifest says
  9.99.99-test: stdout has to be the bare version "9.99.99-test" — … stdout: ""`.

- **3, 10** — `-V` is rejected by the argument parser:

  ```
  argus -V: has to exit 0 — exit 1, stdout: "", stderr: "argus: unknown flag: -V"
  ```

- **5** — same as 2 (the one-line assertion never gets a line to look at).

- **8, 9** — configuration *is* resolved today, so the poisoned value ends the
  run:

  ```
  argus --version with an unusable UROBOROS_OBS_RETENTION: has to exit 0 — exit 1,
  stdout: "", stderr: "argus: invalid duration: not-a-duration"
  argus --retention not-a-duration --version: has to exit 0 — exit 1, stdout: "",
  stderr: "argus: invalid duration: not-a-duration"
  ```

- **13** — the help block, printed in full in the failure message, contains
  neither `--version` nor `-V`:

  ```
  --version has to appear in the help — got:
  argus — monitor Claude Agent SDK / Claude Code sessions over OpenTelemetry …
  ```

## 7. Notes for the implementer

- The suite currently takes ~70 s because six cases wait out the 10 s
  per-command timeout while a collector they never wanted keeps running. Once
  `--version` returns immediately, the whole file runs in a couple of seconds.
  A file that still takes a minute means something is still starting.
- `assertPrintsVersion` also asserts the command was not killed. Do not
  `process.exit` in the branch if that makes the process leave output behind —
  returning from `main` is the exit-0 path `--help` already uses.
- Nothing in the tests reads `FLAG_ALIASES`, `parseArgs` or any module of
  `src/`. How `-V` becomes `--version` is entirely yours; that it does is not.
- You may not edit `test/version.test.mjs`. If a case looks wrong, say so in
  your handoff instead of changing it.
