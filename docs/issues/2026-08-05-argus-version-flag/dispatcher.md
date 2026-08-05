# Dispatcher handoff — `argus --version`

## 1. What is being built

`argus --version` and `argus -V` print the bare `version` field of
`tools/argus/package.json` to stdout and exit 0, before any configuration is
resolved, any collector is started or any socket is touched. The flag is listed
in the CLI's help block. A test in `tools/argus/test/` covers both spellings and
compares the printed string against `package.json` read at test time.

## 2. Module map — every file this touches

| Path | What it holds | Role in this change |
| --- | --- | --- |
| `/home/user/uroboros/tools/argus/bin/argus.mjs` | The CLI entry point. `HELP` string (lines 28–75), `main(argv)` (line 342 ff.), top-level `main(process.argv.slice(2)).catch(...)` (line 567). | Gets the `--version` branch and the new help line. |
| `/home/user/uroboros/tools/argus/src/config.mjs` | `FLAG_ALIASES` (line 47), `parseArgs` (line 55), `resolveConfig` (line 87), `endpointFor`. | Gets the `-V` → `--version` alias. |
| `/home/user/uroboros/tools/argus/package.json` | `"version": "0.1.0"`, `"files": ["bin", "src"]`, `"test": "node --test \"test/*.test.mjs\""`. | The single source of the version. Not edited. |
| `/home/user/uroboros/tools/argus/test/version.test.mjs` | New file. | The test for both spellings, the help listing and the "nothing else ran" guarantee. |
| `/home/user/uroboros/tools/argus/test/config.test.mjs` | Unit tests for `parseArgs` / `resolveConfig` / `endpointFor`. | Optional one-liner for the `-V` alias at the parser level. |
| `/home/user/uroboros/tools/argus/README.md` | User-facing page; the `## Options` table starts at line 429. | One new table row (project convention: the README table mirrors the help block). |
| `/home/user/uroboros/test.sh` | Runs `npm --prefix tools/argus test` among the suites. | Not edited — the new test file is picked up by the existing glob. |

Entry points, for orientation:

- `node tools/argus/bin/argus.mjs …` — direct.
- `/home/user/uroboros/bin/argus` — POSIX shim on the plugin PATH; `exec node "$collector" "$@"`, so it inherits the flag for free. Not edited.
- `tools/argus/Dockerfile` — `COPY . .` then `CMD ["node", "bin/argus.mjs"]`, so `package.json` sits next to `bin/` in the image too. Not edited.

## 3. Research results that constrain the implementation

**`parseArgs` rejects `-V` today.** In `src/config.mjs`:

```js
arg = FLAG_ALIASES[arg] ?? arg;
if (!arg.startsWith('--')) throw new Error(`unknown flag: ${arg}`);
```

Any single-dash argument that is not in `FLAG_ALIASES` throws, the top-level
`.catch` in `bin/argus.mjs` prints `argus: unknown flag: -V` and exits 1. So the
alias entry is not cosmetic — without it `-V` fails. `-h` is already taken by
`--host` and `-v` is deliberately left alone (issue's own default), so the alias
is the capital `-V` and nothing else.

**A bare `--version` lands as `true`.** `parseArgs` sets `flags[key] = true` when
the next argv item is absent or starts with `--`. So `argus --version` and
`argus -V` both produce `flags.version === true`. Test it as truthy, exactly the
way `flags.help` is tested at line 344 — do not compare against `true` in the
CLI branch.

**Ordering inside `main`.** Today `main` does: `parseArgs` → `if (flags.help)` →
`const command = positional[0] ?? 'start'` → `resolveConfig(flags)` →
`endpointFor(config)` → command dispatch. `resolveConfig` is the first thing that
reads the environment and the first thing that can throw; `endpointFor` and
everything after it is the run. The version branch therefore goes between
`parseArgs` and `resolveConfig`. That placement is what the acceptance criterion
"no config is loaded, no collector is started, no network is touched" means in
this file, and it is directly testable (see 5.3).

**Zero dependencies, no build step, ESM only, Node ≥ 20.11** (`tools/argus/CLAUDE.md`).
So: no `import pkg from '../package.json' with { type: 'json' }` — JSON module
imports are still flagged experimental on the supported Node range and print an
`ExperimentalWarning` to stderr, which would put noise next to output that is
specified as one bare line. Read the file instead:
`fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')`.
`node:fs` is already imported at line 13 of `bin/argus.mjs`; `fileURLToPath` is
not needed, `readFileSync` accepts a `file:` URL.

**No existing test asserts anything about `--help` or the help text**, so the new
help line breaks nothing. `test-repo.sh` touches `tools/argus/package.json` only
to check that `files` does not ship `public/` — untouched by this change.

## 4. Implementation plan

### 4.1 `src/config.mjs`

Add one entry to `FLAG_ALIASES`:

```js
const FLAG_ALIASES = {
  '-p': '--port',
  '-h': '--host',
  '-t': '--token',
  '-V': '--version',
  '-?': '--help',
};
```

Nothing else in this file changes. In particular `resolveConfig` gets no
`version` key: the flag never reaches configuration.

### 4.2 `bin/argus.mjs` — reading the version

Add a small helper next to `renderEnv` (or immediately above `main`), reading
lazily rather than at module load, so an ordinary start does not pay a file read
and a damaged `package.json` cannot break the collector:

```js
/**
 * The version, from the manifest rather than from a literal here: two places
 * saying which argus this is means one of them is eventually wrong.
 */
function readVersion() {
  const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  return manifest.version;
}
```

Do not cache it in a module-level `const`, and do not add a `version` field to
any config object.

### 4.3 `bin/argus.mjs` — the branch

First statement of the body after `parseArgs`, ahead of the `help` branch:

```js
async function main(argv) {
  const { flags, positional } = parseArgs(argv);
  // Before anything is resolved, started or dialled: which argus is this?
  if (flags.version) {
    console.log(readVersion());
    return;
  }
  if (flags.help) {
    …
```

- `console.log`, i.e. stdout, one line, no prefix and no banner.
- Return, do not `process.exit` — the function returning is already the exit-0
  path used by `--help` and `env`.
- No `process.exitCode` assignment.
- Placing it ahead of `help` is deliberate but arbitrary in the degenerate case
  where both flags are given; no test may pin `--version --help`.
- Because the branch sits before `positional[0]` is read, `argus env --version`
  also prints the version. That falls out of the required ordering; leave it,
  and do not pin it in a test either.

### 4.4 `bin/argus.mjs` — the help block

In the `Options` section of the `HELP` template literal, directly after the
`--help` line at line 69, keeping the existing column layout (short-alias lines
start at two spaces, the description column starts at column 33):

```
  -V, --version                 Print the version and exit
```

### 4.5 `README.md`

One row at the end of the `## Options` table (after `--max-sessions`, line 448),
matching the existing pipe-table style:

```
| `-V, --version`         | –                            | –              | Print the version and exit                       |
```

### 4.6 What is explicitly *not* changed

- **`skills/argus/SKILL.md`** stays as it is. `tools/argus/CLAUDE.md` asks for a
  skill update when a CLI change changes what a user types *to do the job*; the
  skill is the measuring procedure (start, point a session at it, check), and
  a version flag is not a step in it. Recorded as a decision, not an oversight.
- **`bin/argus`** (the shim), **`Dockerfile`**, **`compose.yaml`**,
  **`render.yaml`**, **`test.sh`**: no edits needed, see the module map.
- No new module under `src/`, no new dependency, no `process.exit` in the branch.

## 5. Test plan — for the test author

New file `/home/user/uroboros/tools/argus/test/version.test.mjs`, `node:test` +
`node:assert/strict`, in the style of `test/background.test.mjs`: resolve the
binary with

```js
const BIN = fileURLToPath(new URL('../bin/argus.mjs', import.meta.url));
```

run it with `promisify(execFile)` and a `timeout` of ~10 s per command (the
per-command timeout is the only clock allowed here — `tools/argus/CLAUDE.md`
forbids asserting wall-clock durations). Read the expected version in the test
from `tools/argus/package.json`, never as a literal:

```js
const VERSION = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;
```

### 5.1 Both spellings print the version

For each of `['--version']` and `['-V']`: exit code 0 (a rejected promise from
`execFile` is the failure — assert the run resolved) and
`stdout.trim() === VERSION`.

### 5.2 The bare string, one line, no banner

From the same runs: `stdout` split on `\n` has exactly one non-empty line, and
that line has no prefix — `stdout.trim()` equals `VERSION` exactly, so
`argus 0.1.0` or `v0.1.0` fails. Also assert `VERSION` is a non-empty string, so
a manifest without the field cannot make the test pass vacuously against
`undefined`.

### 5.3 Handled before any other work

One run in a fresh empty temp directory as `cwd`
(`fs.mkdtempSync(path.join(os.tmpdir(), 'argus-version-'))`, `realpathSync` it
like `background.test.mjs` does), with the environment carrying
`UROBOROS_OBS_RETENTION: 'not-a-duration'` on top of `process.env`. That value
makes `resolveConfig` throw `invalid duration: not-a-duration`, which the
top-level catch would turn into exit code 1. Assert:

- exit 0 and `stdout.trim() === VERSION` — proof that configuration was never
  resolved;
- no `.uroboros-telemetry` directory was created in that `cwd` — proof that no
  measurement was started;
- `stderr` carries none of `argus:`, `listening`, `persisting` — proof that
  neither an error path nor a collector start ran.

Assert these as absences, per `tools/argus/CLAUDE.md`; do not pin any wording.
The command returning at all, without a port ever being chosen, is the "no
network" half — do not attempt to assert on sockets.

### 5.4 The flag is in the help output

Run `--help`; assert the output contains `--version` and contains `-V`. Assert
substrings only — not the description text, not the column positions, not the
line's position in the block.

### 5.5 Parser-level guard (optional, in `test/config.test.mjs`)

`parseArgs(['-V']).flags.version === true`, and `parseArgs(['--version']).flags.version === true`.
Cheap, and it pins the alias that the CLI branch depends on.

### 5.6 Green bar

`npm --prefix tools/argus test` and then `./test.sh` from the repository root
must both pass. `./test.sh` is the fact; an impression is not.
