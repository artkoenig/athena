# Implementer handoff — `argus --version`

## 1. Summary

The dispatcher's plan was implemented exactly as written, in all four places it
named, and nothing beyond them. `argus --version` and `argus -V` now print the
bare `version` field of `tools/argus/package.json` to stdout and return with
exit code 0, before `resolveConfig` is called, before any positional command is
read, before a port is chosen and before a collector is started.

All 13 cases in the test author's `tools/argus/test/version.test.mjs` pass. The
whole `tools/argus` package suite (134 cases) passes, and `bash ./test.sh` (all
6 repository suites) passes. No test file was edited.

## 2. Changes Made

### 2.1 `tools/argus/src/config.mjs` — the `-V` alias

One line added to `FLAG_ALIASES`:

```js
const FLAG_ALIASES = {
  '-p': '--port',
  '-h': '--host',
  '-t': '--token',
  '-V': '--version',
  '-?': '--help',
};
```

This is load-bearing, not cosmetic. `parseArgs` does

```js
arg = FLAG_ALIASES[arg] ?? arg;
if (!arg.startsWith('--')) throw new Error(`unknown flag: ${arg}`);
```

so before this entry `-V` threw, the top-level `.catch` in `bin/argus.mjs`
printed `argus: unknown flag: -V` and the process exited 1 — which is exactly
how test cases 3 and 10 failed beforehand.

Nothing else in `config.mjs` changed. `resolveConfig` got **no** `version` key:
the flag never reaches configuration, which is the point of the whole ordering.
The alias is the capital `-V` only; `-v` was deliberately left untouched (see
section 6.1 — this is the reviewer's open item from the test-author handoff).

### 2.2 `tools/argus/bin/argus.mjs` — `readVersion()`

A helper added directly above `main`, reading lazily rather than at module load:

```js
/**
 * The version, from the manifest rather than from a literal here: two places
 * saying which argus this is means one of them is eventually wrong. Read on
 * demand, so an ordinary start pays neither the file read nor the risk that a
 * damaged manifest keeps the collector from running at all.
 */
function readVersion() {
  const manifest = JSON.parse(
    fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  return manifest.version;
}
```

Deliberate details:

- **`new URL('../package.json', import.meta.url)`**, not `'package.json'` and
  not anything relative to `process.cwd()`. This resolves the *program's own*
  manifest, which is what test case 7 pins by running the binary from a `cwd`
  that contains a decoy `package.json` with `"version": "6.6.6"`.
- **`fs.readFileSync` with a `file:` URL**, not
  `import pkg from '../package.json' with { type: 'json' }`. JSON module imports
  still print an `ExperimentalWarning` to stderr on the supported Node range,
  and test case 5 asserts `stderr === ''` for a `--version` run. `node:fs` was
  already imported at line 13; `fileURLToPath` is not needed because
  `readFileSync` accepts a `file:` URL directly.
- **Not cached in a module-level `const`**, as the plan required — a start pays
  no file read, and a damaged manifest cannot take the collector down on a path
  that never asked for the version.
- The dispatcher offered "next to `renderEnv` or immediately above `main`"; I
  took immediately above `main`, so the reader meets the helper and its only
  caller together.

### 2.3 `tools/argus/bin/argus.mjs` — the branch in `main`

First statement after `parseArgs`, ahead of the `help` branch:

```js
async function main(argv) {
  const { flags, positional } = parseArgs(argv);
  // Before anything is resolved, started or dialled: which argus is this?
  if (flags.version) {
    console.log(readVersion());
    return;
  }
  if (flags.help) {
    console.log(HELP);
    return;
  }

  const command = positional[0] ?? 'start';
  const config = resolveConfig(flags);
  …
```

- Truthiness (`if (flags.version)`), not `=== true`, matching how `flags.help`
  is handled. `parseArgs` sets `flags[key] = true` for a bare flag, so both
  spellings land as `true`, but the CLI does not depend on that.
- `console.log`, i.e. stdout, one line, no prefix, no banner.
- `return` rather than `process.exit` — returning is already the exit-0 path
  `--help` and `env` use, and the test author's `assertPrintsVersion` also
  asserts the command was not killed and left nothing behind.
- No `process.exitCode` assignment.
- Placed ahead of `help`, per the plan. That makes `--version --help` print the
  version; the plan calls this arbitrary in the degenerate case and no test pins
  it — confirmed, the test author explicitly left it untested.
- Because the branch sits before `positional[0]` is read, `argus env --version`
  also prints the version. That falls out of the required ordering; left as is,
  untested by design on both sides.

### 2.4 `tools/argus/bin/argus.mjs` — the help block

One line in the `Options` section of the `HELP` template literal, directly after
the `--help` line, keeping the existing column layout (short-alias lines start
at two spaces, the description column starts at column 33):

```
      --help                    Show this message
  -V, --version                 Print the version and exit
```

Verified against the neighbouring `-p, --port` / `-h, --host` / `-t, --token`
lines: same two-space indent, same description column. Test case 13 only asserts
that the help output contains the substrings `--version` and `-V`, so the
wording and the position are mine; the layout choice is for the human reader.

### 2.5 `tools/argus/README.md` — the options table

One row at the end of the `## Options` table, after `--max-sessions`, matching
the existing pipe-table column widths:

```
| `-V, --version`         | –                            | –              | Print the version and exit                       |
```

The project convention is that this table mirrors the help block. No test
asserts on the README (the test author says so explicitly); this is the
dispatcher's plan item 4.5.

### 2.6 What was deliberately not changed

Exactly the dispatcher's 4.6 list, verified untouched by `git status`:

- `skills/argus/SKILL.md` — recorded as a decision, not an oversight. The skill
  is the measuring procedure (start, point a session at it, check); a version
  flag is not a step in it.
- `bin/argus` (the POSIX shim) — `exec node "$collector" "$@"` passes the flag
  through for free.
- `tools/argus/Dockerfile`, `compose.yaml`, `render.yaml` — `COPY . .` already
  puts `package.json` next to `bin/` in the image, so `readVersion` resolves
  there too.
- `test.sh` — the new test file is picked up by the package's existing glob
  `node --test "test/*.test.mjs"`.
- `tools/argus/package.json` — the single source of the version, not edited.
  `"version"` is still `0.1.0`.
- `tools/argus/test/config.test.mjs` — the dispatcher's optional parser-level
  guard (5.5). The test author declined it with a reason I agree with (it would
  pin *how* `-V` is recognised rather than what the command does), and I do not
  write tests in this role, so nothing was added there either.
- No new module under `src/`, no new dependency, no `process.exit` in the
  branch, no `version` key in any config object.

## 3. Files Modified

| Path | Change | Size of change |
| --- | --- | --- |
| `/home/user/uroboros/tools/argus/src/config.mjs` | `'-V': '--version'` in `FLAG_ALIASES` | +1 line |
| `/home/user/uroboros/tools/argus/bin/argus.mjs` | `readVersion()` helper, the `flags.version` branch in `main`, one `HELP` line | +18 lines |
| `/home/user/uroboros/tools/argus/README.md` | one row in the `## Options` table | +1 line |
| `/home/user/uroboros/docs/issues/2026-08-05-argus-version-flag/implementer.md` | this handoff | new file |

Not modified: `tools/argus/test/version.test.mjs` (the test author's, and off
limits to me), every other test file, `tools/argus/package.json`, `test.sh`,
`bin/argus`, `skills/argus/SKILL.md`, `Dockerfile`, `compose.yaml`,
`render.yaml`.

## 4. Test Results

Every line below is a command and its exit code, taken from the shell, not an
impression.

### 4.1 Red before the change — the handed-over tests, run first

```
$ cd /home/user/uroboros/tools/argus && node --test test/version.test.mjs
# tests 13
# pass 1
# fail 12
# duration_ms 70774.497447
exit code: 1
```

This reproduces the test author's proof of failure exactly: 12 red, and the one
green is case 1, the declared vacuity guard (`tools/argus/package.json` carries
a non-empty string `version`). I checked the failure reasons before touching
anything, and they are the missing behaviour, not import errors:

- cases 2, 4, 5, 6, 7, 11, 12 — `--version` was not a flag, so `main` fell
  through to `start`, the collector banner went to stderr and stdout carried no
  version;
- cases 3, 10 — `argus: unknown flag: -V`, exit 1, from `parseArgs`;
- cases 8, 9 — `argus: invalid duration: not-a-duration`, exit 1: configuration
  *was* resolved, which is precisely what those cases forbid;
- case 13 — the assertion failure printed the whole current help block, which
  contained neither `--version` nor `-V` (the tail of that output is what the
  first run above showed).

The ~71 s duration is itself the symptom the test author predicted: six cases
sat out their 10 s per-command timeout waiting for a collector nobody wanted.

### 4.2 Green after the change — the same file

```
$ cd /home/user/uroboros/tools/argus && node --test test/version.test.mjs
1..13
# tests 13
# suites 0
# pass 13
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1938.265374
exit code: 0
```

Covers: both spellings printing the version and exiting 0; byte-identical output
between the spellings; the bare one-line output with empty stderr; the version
following a *substituted* manifest in a copied package (`9.99.99-test`, `0.0.0`,
`1.2.3-rc.1+build.5`); the program's own manifest winning over a decoy
`package.json` in the `cwd`; the flag being answered although
`UROBOROS_OBS_RETENTION=not-a-duration` in the environment and
`--retention not-a-duration` on the command line would both make `resolveConfig`
throw; no `.uroboros-telemetry` left behind; the `--port` handed to a
`--version` run still bindable afterwards; three repeats leaving an empty
directory; and both spellings appearing in `--help`.

1.9 s against 71 s before is the test author's own detector for "something is
still starting" — nothing is.

### 4.3 The package's full suite

```
$ npm --prefix tools/argus test
> @uroboros/argus@0.1.0 test
> node --test "test/*.test.mjs"
1..134
# tests 134
# suites 0
# pass 134
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 77320.637577
exit code: 0
```

Covers every `test/*.test.mjs` in `tools/argus`, including `config.test.mjs`
(the parser I touched), `background.test.mjs`, the OTLP decoder, the store, the
server and persistence. Nothing regressed from the alias entry.

### 4.4 The repository suite — the fact behind "green"

```
$ bash ./test.sh
=== the repository itself
=== the plugin: manifests, session-start hook, push guard
=== parallel runs: worktrees
=== tools/argus
=== tools/argus-ui
=== tools/log-parser
PASS: all 6 suites
exit code: 0
```

Note for whoever runs it next: `./test.sh` is not executable in this checkout
(`timeout ./test.sh` returned 126, "Permission denied"), so it has to be invoked
as `bash ./test.sh`. That is how `test.sh` invokes its own sub-scripts too
(`bash "$root/test-repo.sh"`), so it is the intended entry, not a workaround. I
did not `chmod` anything — outside the brief.

`test-repo.sh` is the suite that checks `tools/argus/package.json`'s `files`
field does not ship `public/`; it passed, and the manifest was not edited.

### 4.5 Static analysis

There is none configured in this repository, and here is how I looked:

```
$ find . -maxdepth 3 \( -name ".eslintrc*" -o -name "eslint.config.*" \
    -o -name ".prettierrc*" -o -name "tsconfig.json" \) | grep -v node_modules
(no output)
$ grep -rl '"lint"' --include=package.json . | grep -v node_modules
(no output)
$ ls .github/workflows
ls: cannot access '.github/workflows': No such file or directory   (exit 2)
$ ls -d node_modules
(no output — nothing installed at the root)
```

No ESLint, no Prettier, no TypeScript config, no `lint` script in any
`package.json`, no CI workflow directory. Consistent with
`tools/argus/CLAUDE.md`: zero dependencies, no build step, "use what the
platform ships".

The nearest thing the platform offers is the parser itself, which I ran on both
modified modules:

```
$ node --check tools/argus/bin/argus.mjs && node --check tools/argus/src/config.mjs
exit code: 0
```

Beyond that, `test-repo.sh` (suite 1 of `test.sh`, exit 0 above) is the
repository's own structural check — manifest fields, file layout, push guard —
and it is green.

### 4.6 Manual smoke check, for the record

Run from an unrelated empty directory, against the real binary:

```
$ node /home/user/uroboros/tools/argus/bin/argus.mjs --version
0.1.0
exit=0
$ node /home/user/uroboros/tools/argus/bin/argus.mjs -V
0.1.0
exit=0
$ node /home/user/uroboros/tools/argus/bin/argus.mjs -v
argus: unknown flag: -v
exit=1
```

The third line is the evidence for the reviewer's open item in 6.1.

## 5. Challenges and Problems

**None that changed the plan.** The dispatcher's research was accurate on every
point I depended on: `parseArgs` really does reject any unknown single-dash
argument; a bare `--version` really does land as `true`; `resolveConfig` really
is the first thing that reads the environment and the first thing that can
throw; `fs` really was already imported. Three smaller things worth recording:

1. **`./test.sh` is not executable.** Running it directly exits 126
   (Permission denied). `bash ./test.sh` works and is how the script calls its
   own members. I left the file mode alone — changing it is outside the brief,
   but it is worth a line here because the dispatcher's 5.6 says "`./test.sh`
   from the repository root", and taken literally that command fails for a
   reason that has nothing to do with this change.
2. **The pre-change red run takes 71 s** and looks alarming while it runs: six
   cases start a real collector and wait out their 10 s timeout. That is the
   expected shape of the failure, not a hang. After the change the same file is
   1.9 s.
3. **Empty stderr for `--version`** (test case 5) is stricter than the issue's
   literal words, as the test author flagged in their open questions. The
   obvious implementation meets it — `console.log` writes to stdout only, and
   the `readFileSync` route emits no `ExperimentalWarning`. It cost nothing, and
   I agree with the reasoning: it is the assertion that rules out the JSON
   module import. No change requested.

**Nothing in the test file looked wrong to me.** I had no reason to want an edit
there, and made none.

## 6. Notes for the reviewer

1. **The `-v` open item, answered by the diff.** The test author asked the
   reviewer to confirm that only `-V` was wired and `-v` was left alone. The
   diff in `src/config.mjs` is one line, `'-V': '--version'`, and `-v` appears
   nowhere in it. Behaviourally: `argus -v` still exits 1 with
   `argus: unknown flag: -v` (section 4.6). No test covers this, by the test
   author's rule that a case which passes today cannot be handed over as a
   failing test — so the diff is the proof.
2. **`argus env --version` prints the version** rather than the env block, and
   `argus --version --help` prints the version rather than the help. Both fall
   out of the required ordering (the branch sits before `positional[0]` is read
   and before the `help` branch); both are explicitly unpinned on the dispatcher
   side and untested on the test-author side. If either is unwanted, that is a
   new decision, not a defect in this implementation.
3. **A manifest with no `version` field** would make `--version` print
   `undefined`. Undecided by the issue, untested by design (test author's open
   question 3). Not handled, deliberately: handling it would be inventing a
   behaviour nobody asked for.
4. **Out of scope, noticed while working:** the README options table lists no
   row for `--traces`, `--format`, `--max-spans`, `--max-logs` or
   `--max-metrics` either — the table has drifted from the help block in places
   that predate this change. Not touched; a note, not an edit.
