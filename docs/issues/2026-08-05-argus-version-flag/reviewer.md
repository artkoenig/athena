# Reviewer — round 0

Issue: `docs/issues/2026-08-05-argus-version-flag/issue.md` — `argus --version` prints the version.
Branch under review: `claude/workflow-test-issue-c556o4`, diffed against `main`.

## Review Status

**Accepted — 0 findings that require a correction.**

Every acceptance criterion is met and covered by a test that would go red if the
behaviour broke. The suite is green by exit code. Two observations that need no
correction are recorded at the end, so the next reader does not have to
rediscover them.

## Facts established by running things

### The test suite

```
bash ./test.sh
```

Exit code **0**. Final line: `PASS: all 6 suites`. The six suites are the ones
`test.sh` lists: the repository itself (`test-repo.sh`), the plugin
(`test-plugin.sh`), worktrees (`test-worktree.sh`), `tools/argus`,
`tools/argus-ui`, `tools/log-parser`. Nothing was skipped or excluded; no suite
reported a skip.

### The package suite that carries the change

```
npm --prefix /home/user/uroboros/tools/argus test --silent
```

Exit code **0**, `# tests 134 / # pass 134 / # fail 0 / # cancelled 0 /
# skipped 0 / # todo 0`, duration ~77 s. This is `node --test "test/*.test.mjs"`
as declared by `tools/argus/package.json`, i.e. it includes the new
`test/version.test.mjs` (13 cases).

### Static analysis

There is none to run. I looked for a lint configuration with

```
find . -maxdepth 3 -name ".eslintrc*" -o -maxdepth 3 -name "eslint.config.*"
```

which found nothing, and there is no repository-root `package.json`
(`cat /home/user/uroboros/package.json` → *No such file or directory*), so no
`npm run lint` exists. `tools/argus/package.json` declares only `start`, `dev`,
`test`, `demo` and has no devDependencies — consistent with the
"zero-dependency, no build step" convention in `tools/argus/CLAUDE.md`. Reported
as the fact: **no static analysis exists in this repository**.

### Direct observation of the CLI (read-only, run from a scratch directory)

```
node /home/user/uroboros/tools/argus/bin/argus.mjs --version   → "0.1.0", exit 0
node /home/user/uroboros/tools/argus/bin/argus.mjs -V          → "0.1.0", exit 0
… | od -c                                                      → 0 . 1 . 0 \n   (6 bytes, nothing else)
```

`tools/argus/package.json` says `"version": "0.1.0"`. The run left the working
directory untouched (no `.uroboros-telemetry`, no files). `git status --short`
is empty after all runs: nothing I did mutated the checkout.

## The diff against the intent

Files changed against `main` (handoff files of other agents — `dispatcher.md`,
`test-author.md`, `implementer.md` — deliberately not judged):

| File | Verdict |
| --- | --- |
| `docs/issues/2026-08-05-argus-version-flag/issue.md` | the issue itself, in scope |
| `tools/argus/bin/argus.mjs` | in scope, correct |
| `tools/argus/src/config.mjs` | in scope, correct |
| `tools/argus/README.md` | supporting documentation of the same flag, see observation 1 |
| `tools/argus/test/version.test.mjs` | in scope, correct |
| `.claude/workflows/uroboros-loop.js` | outside the criteria, see observation 2 |

### Criterion by criterion

- **`argus --version` prints the `version` field from `tools/argus/package.json`
  and exits 0.** Met. `bin/argus.mjs:359-362` branches on `flags.version`,
  prints `readVersion()` via `console.log` and returns from `main` without
  setting `process.exitCode`, so the process ends at 0. Observed directly:
  `0.1.0`, exit 0. Covered by `version.test.mjs:146` and by
  `assertPrintsVersion` (killed=false, code=0, stdout trimmed equals the
  manifest version).
- **`argus -V` does the same.** Met. `src/config.mjs:51` adds `'-V':
  '--version'` to `FLAG_ALIASES`; without it `parseArgs` would throw
  `unknown flag: -V`, because it rejects any single-dash argument that no alias
  maps to (`config.mjs:65`). Observed directly: `0.1.0`, exit 0. Covered by
  `version.test.mjs:155` and, byte for byte against the long spelling, by
  `version.test.mjs:164` (same stdout *and* same stderr).
- **Read from `package.json`, not a literal in the source.** Met.
  `readVersion()` (`bin/argus.mjs:349-354`) reads
  `new URL('../package.json', import.meta.url)` — the program's own manifest,
  resolved from the module URL, not from `process.cwd()`. The test does not take
  this on faith: `version.test.mjs:226` copies `bin/` and `src/` into a temp
  directory with a rewritten manifest (`9.99.99-test`, `0.0.0`,
  `1.2.3-rc.1+build.5`) and asserts the copy prints the copy's version — a
  hard-coded literal in the source goes red there. `version.test.mjs:245` adds
  the mirror case: a decoy `package.json` with version `6.6.6` in the *working
  directory* must be ignored.
- **Bare version string on one line, no prefix, no banner.** Met.
  `version.test.mjs:185` asserts exactly one non-empty stdout line equal to the
  manifest version, no leading whitespace, no `argus` in the output, no `v`
  prefix, and empty stderr — for both spellings. Confirmed independently by
  `od -c`: `0.1.0\n` and nothing more.
- **Handled before any other work: no config loaded, no collector started, no
  network touched.** Met. The branch sits between `parseArgs` and both
  `resolveConfig`/`endpointFor` (`bin/argus.mjs:357-369`), and even before the
  `--help` branch. Three tests prove it from the outside rather than by reading
  the source: `version.test.mjs:262` sets `UROBOROS_OBS_RETENTION=not-a-duration`
  (which makes `resolveConfig` throw via `parseDuration`, `config.mjs:33`) and
  still expects exit 0 with the version — resolving the configuration at all
  would end the run at exit 1; `version.test.mjs:290` does the same through a
  `--retention not-a-duration` flag; `version.test.mjs:312` asks the OS for a
  free port, passes `--port <n> --version` and asserts afterwards that the port
  is still bindable, i.e. nothing listened. All of them also assert that no
  `.uroboros-telemetry` directory was created, and `version.test.mjs:330`
  asserts the working directory is completely empty after three runs.
- **The flag appears in the CLI's help output.** Met. `bin/argus.mjs:70` adds
  `  -V, --version                 Print the version and exit` to the `HELP`
  block, in the same column layout as the surrounding options. Covered by
  `version.test.mjs:353`, which runs `--help` and requires both spellings to
  appear and exit 0.
- **A test in `tools/argus/test/` covers both spellings and asserts the printed
  string matches `package.json`.** Met: `tools/argus/test/version.test.mjs`, 13
  cases, expected value read from the manifest at test time
  (`version.test.mjs:31`), never written down as a literal. `version.test.mjs:138`
  is the anti-vacuity guard: it fails if the manifest has no non-empty, untrimmed
  `version`, so none of the other cases can pass against an empty expectation.
- **`./test.sh` is green.** Met, by exit code 0 as recorded above.

### Tests judged against the intent, not against the code

The cases assert externally observable behaviour of a spawned process (stdout,
stderr, exit code, port occupancy, files left behind) rather than internal
structure, so they do not merely re-describe the implementation. Two of them
would fail against plausible wrong implementations that still satisfy a naive
reading:

- a version literal in the source survives "prints 0.1.0" but dies at
  `version.test.mjs:226`;
- a `readFileSync('package.json')` relative to the cwd survives every other case
  but dies at `version.test.mjs:245`.

The file also honours the local conventions in `tools/argus/CLAUDE.md`: no
wall-clock assertions (the 10 s `execFile` timeout is the only clock, and
`killed` is asserted rather than a duration), no hard-coded port (port 0 +
`freePort()`), `node:test` only, zero dependencies.

Weak spot worth naming, below the threshold of a finding: the help case uses
`help.includes('-V')`, which would also be satisfied by a `-V` appearing
anywhere else in the help text. Today the only `-V` in `HELP` is the new line,
and the criterion ("the flag appears in the help output") is satisfied either
way, so this needs no correction.

## Beyond the criteria — blast radius

- **`FLAG_ALIASES` is shared by every argus command** (`start`, `env`, `check`),
  so `-V` is now consumed everywhere. I searched the whole repository for a
  competing `-V` (`grep -rn -- "'-V'|\"-V\"|argus -V" …`, excluding
  `docs/issues` and `.git`): the only occurrences are the new alias and the new
  test. Nothing previously passed `-V` to argus, so nothing changed meaning.
  `-v` is untouched, as the issue's assumptions require.
- **`bin/argus` (the plugin shim at the repository root)** ends in
  `exec node "$collector" "$@"` — it forwards arguments unchanged and interprets
  none, so `argus --version` and `argus -V` behave identically through the shim.
  No change needed there.
- **`skills/argus/SKILL.md`** is task-oriented (start / env / check / read the
  numbers) and carries no flag table; adding an optional flag makes nothing in
  it wrong or stale. `tools/argus/CLAUDE.md` asks for the skill to follow a CLI
  change "that changes what a user types" — no existing procedure in the skill
  changed, so I do not read that as unmet. Not a finding.
- **`src/background.mjs` (`withoutFlags`, respawn)** is unreachable from the
  version path: `main` returns before `flags.background` is even looked at.
- **Pre-existing `parseArgs` quirk, not introduced here:** a flag that takes a
  value swallows a following single-dash token, so `argus --port -V` sets
  `port` to `"-V"` instead of asking for the version. This is true of every
  alias already (`--port -p`, `--host -t`, …) because the value check tests for
  `--` (`config.mjs:76`), and `main` never reaches the port anyway in the
  documented `-V` positions. No criterion touches it; not a finding, recorded
  only so it is not rediscovered as new.
- **A manifest without a `version` field** would make `argus --version` print
  `undefined`, and a corrupt manifest would throw. Both are outside the criteria,
  and `readVersion` is deliberately lazy so an ordinary start never reads the
  file at all — the risk is confined to the version path itself. Not a finding.
- **Suite runtime:** the argus package suite takes ~77 s and the new file spawns
  ~16 node processes; nothing in it binds a fixed port, and every temp directory
  is removed in a `finally`. No interference with the parallel-run/worktree
  suites was observed — `./test.sh` ran all six clean.

## Findings

**None that require a correction.**

## Observations (no correction required, recorded for the caller)

1. **`tools/argus/README.md:449` adds an options-table row for `-V, --version`.**
   No criterion asked for a README change — criterion 6 speaks only of the CLI's
   help output. It is documentation of exactly the flag the issue introduces, in
   the table that documents every other flag, and it is accurate (`Print the
   version and exit`). Leaving the tool's user-facing page contradicting its own
   `--help` would be the worse outcome, so I do not ask for it to be removed.
2. **`.claude/workflows/uroboros-loop.js` accepts a stringified `args`
   (commit `59f72ae`).** This is outside every acceptance criterion of this
   issue: it parses a JSON string or a bare path into `{ issueDir }` so the loop
   does not bail with "missing args.issueDir". It landed before the dispatcher
   handoff, i.e. it is the harness fix that made this very run possible, and it
   touches no argus code and no behaviour any criterion covers. I read the code:
   the object path is unchanged (`typeof args === 'string'` guards the whole
   new branch), so no previously working call changes behaviour. Reported as
   out-of-scope, not as a defect to correct.
