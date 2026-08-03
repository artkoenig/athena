---
status: active
branch: claude/athena-observer-background-04t663
pr:
---

# Split the observer into argus and argus-ui

## Intent

`tools/observability` is one process doing two jobs: it receives OpenTelemetry from
Claude Code sessions, and it serves the web page that shows the numbers. It is
started by hand, in the foreground, from an athena checkout. Nothing in the plugin
manifest points at it, so a session in another project cannot reach it at all, even
though the plugin cache already carries the files.

Wanted: measure token usage in *other* projects. That needs a command that exists in
any session, a start that returns to the caller instead of holding a terminal, and
measurements that survive on disk so two runs can be compared. The tool is taken
apart into two projects side by side under `tools/`:

- **`tools/argus`** — the collector. Receives OTLP, aggregates, persists, serves a
  JSON API. No web page. This is what other projects use, and the only half that is
  deployed or distributed.
- **`tools/argus-ui`** — the interface. Serves the page and reaches a running
  collector over HTTP. Local only: not shipped to other projects, not deployed, and
  destined to leave athena later as a project of its own, so it must never grow a
  dependency on anything inside this repository.

Acceptance criteria:

1. **Two projects.** `tools/argus` and `tools/argus-ui` each have their own
   `package.json`, `README.md`, `CLAUDE.md` and `test/`, and each suite runs on its
   own: `npm --prefix tools/argus test` and `npm --prefix tools/argus-ui test` both
   exit 0. Neither imports a file from the other; `argus-ui` knows the collector
   only through its HTTP API, so it can be lifted out of this repository unchanged.
2. **The collector is reachable from any project.** With the athena plugin enabled,
   `argus --help` runs from a session whose working directory is not an athena
   checkout, exit 0, and a user-invocable `argus` skill carries the procedure —
   including that Claude Code reads its telemetry configuration at process start, so
   a session started without the environment block cannot be measured after the
   fact.
3. **The interface is not distributed.** `argus-ui` has no entry on the `PATH`, no
   skill and no mention in the plugin manifest; it is started from an athena
   checkout. Nothing outside `tools/argus-ui` references it except the root README.
4. **Started in the background on demand.** `argus start --background` returns to
   its caller with exit 0 while the collector keeps listening, and prints the
   endpoint, the token if there is one, the absolute measurement directory and the
   process id.
5. **It ends with the session.** When the Claude Code process the background start
   was launched from disappears, the collector shuts itself down within seconds. No
   pidfile, no `stop` command, no registry.
6. **A second start does not create a second collector.** When the port already
   holds a collector, `start --background` exits 0 and names the directory that
   collector is writing to. When the port holds something else, it exits 1 and says
   so.
7. **The collector serves no interface.** `GET /` on the collector port answers a
   JSON 404 naming `argus-ui`. No file from `tools/argus-ui` is reachable through
   the collector's port.
8. **The interface is its own process.** `argus-ui` serves the page on its own port
   and shows a running collector's data including the live stream. It supplies the
   collector's token itself, so on loopback the browser never handles one.
9. **Persistence is on by default, one directory per measurement.** A `start`
   without a persist flag creates `<cwd>/.athena-telemetry/<YYYY-MM-DDTHH-MM-SS>/`.
   Two starts in the same second get two distinct directories.
10. **The measured project stays clean.** Creating the `.athena-telemetry` root also
    writes a `.gitignore` inside it that hides it. No file outside that directory is
    created or modified in the measured project.
11. **Reopening is its own option.** `argus start --open <dir>` loads an existing
    measurement and the interface shows its sessions however old they are; it writes
    nothing into that directory. `--persist <dir>` only ever writes and never
    replays. Passing both is refused.
12. **No session naming, no hook.** The naming hook, its route, the hook block in
    the setup dialog and the name records in persistence are gone; `argus env
    --format settings` emits only the environment block. Naming through the OTel
    resource attribute still works.
13. **Remote operation deploys the collector alone.** `Dockerfile`, `compose.yaml`,
    `render.yaml` and the Cloudflare tunnel run `argus` and nothing else; the
    interface is run locally and pointed at it with `argus-ui --collector <url>`.
14. **The documentation mirrors the result.** Every statement in the two project
    READMEs, the two project `CLAUDE.md`s and the root `README.md` that this change
    makes false is corrected, bounded to what it falsified. Nothing in the
    repository still *instructs* a reader to use `tools/observability` — the
    reproduce command in `docs/2026-08-02-workflow-token-measurement.md` included.
    Records of what already happened keep the path they were written with: a closed
    tracker entry and this issue's own map are accounts of the past, not claims
    about the present.
15. **The suite is green.** `bash test.sh` exits 0 and runs five suites, the two new
    projects among them.

## Map

Taken at `99ce318`, the tip of the branch at the start of this run, which contains
`origin/main`.

Everything under `tools/observability/` unless noted.

- `bin/athena-observe.mjs` (260) — the only entry; commands `start` (default,
  blocks), `env`, `check`. `EADDRINUSE` branch at `:167-177`; `shutdown()` at `:244`
  with a 2 s unref'd timer because open SSE streams hold the process.
- `src/server.mjs` (453) — **the single coupling point**. `createServer()` mounts
  OTLP ingest (`:384`), the JSON/SSE API (`:396-419`) and `serveStatic()` from
  `PUBLIC_DIR = ../public/` (`:20`, `:189-208`, called at `:443`) on one
  `http.Server`. Browser auth is a token→cookie redirect (`:430-441`), gated by
  `needsAuth` at `:377`. `GET /api/config` (`:241-255`) returns `env: otelEnvFor(...)`
  and `hooks: sessionNameHook()`.
- `src/store.mjs` (1076) — in-memory store and all token aggregation. `mergeUsage()`
  (`:993-1004`): metrics win when non-zero, events are the fallback, never summed.
  `#evict` (`:710`) cuts on `Date.now() - retentionMs`. Imports nothing from
  `server.mjs`.
- `src/persist.mjs` (163) — optional append-only JSONL per signal plus
  `names.jsonl`, rotates at 64 MB, replays on next start. `load()` does
  `mkdirSync(recursive)`.
- `src/config.mjs` (102) — flags/env → config; default persist dir
  `.athena-telemetry` (`:76`).
- `src/claude.mjs` (288) — metric/event names, token typing, `otelEnvFor()` (pins
  the three export intervals to 1000 ms, `:280-286`), `sessionNameHook()`
  (`:247-252`, embeds an absolute path via `fileURLToPath`). Imported by **both**
  `store.mjs` and `server.mjs`.
- `src/probe.mjs` (211) — the `check` command; naming is step 5 (`:178-208`);
  multi-instance detection at `:112-136`.
- `src/otlp/{protobuf,schema,decode}.mjs` — hand-rolled wire codec, unchanged by
  this work.
- `src/tunnel.mjs` (208) — spawns `cloudflared`. Unchanged.
- `hooks/session-name.mjs` (149) — the SessionStart hook to be removed.
- `public/index.html` (77), `public/app.js` (1127), `public/styles.css` (1002) —
  **zero imports**; only `fetch('/api/…')` and `EventSource('/api/stream')`. The
  Setup dialog renders from `/api/config` (`app.js:798-840`); the hook block is
  `app.js:816` and `:834-846`.
- `test/` — 10 files, one per `src/` module. `node --test test/*.test.mjs`; tests
  bind to port 0. `npm --prefix tools/observability test` → 113 cases, exit 0.

Outside the tool: `test.sh:38`, `test-repo.sh:21` (licence assertion on the
package), `render.yaml` (`rootDir: tools/observability`), root `README.md:91,94`,
`.gitignore` (`.athena-telemetry/`), `.worktreeinclude`,
`docs/2026-08-02-workflow-token-measurement.md`.

Plugin surface: `.claude-plugin/plugin.json` declares `skills: ["./skills/",
"./agents/tracker/skills/"]` and `agents: [five .md]`, no `version`.
`hooks/hooks.json` is auto-discovered and holds one SessionStart hook.
`test-plugin.sh` fails on an undeclared skill directory (`:126-144`), on a
manifest/tree disagreement for agents (`:146-161`), on unknown manifest fields
(`:117`), and gates `claude plugin validate --strict` on exactly two warnings
(`:189-214`).

## Plan

Five commits, each green under `test.sh`.

1. **Remove session naming**, still under the old path. Delete
   `hooks/session-name.mjs`, `sessionNameHook()` and the now-unused `fileURLToPath`
   import, `handleSetSessionName` and its route, the `hooks` field of
   `/api/config`, `setSessionName`/`assignedName` in the store (only callers are
   those two), the `names.jsonl` handling, the naming step in `probe.mjs` and its
   verdict branch in the entry, and the hook block in `app.js`. `--format settings`
   emits `{ env }` only. `sessionNameOf` stays: the OTel resource attribute remains
   a working way to name a session and is now the only one. Delete
   `test/hook.test.mjs`; drop the naming cases from five other test files.
2. **Rename to `tools/argus`** with `git mv`, entry to `bin/argus.mjs`, package to
   `@athena/argus`. Every path reference follows: `test.sh`, `test-repo.sh`,
   `render.yaml`, the root README, the project's own `CLAUDE.md` and README. A pure
   move — the case count must not change.
3. **Split the interface into `tools/argus-ui`.** In `argus`: `server.mjs` loses
   `PUBLIC_DIR`, `MIME`, `serveStatic` and its call, and the whole browser-cookie
   path; `authorized()` keeps `Bearer` and `?token=` (`probe.mjs` uses the latter);
   `needsAuth` collapses to "everything but `GET /api/health`"; unknown paths answer
   a JSON 404 naming `argus-ui`; `/api/config` gains `persist`, the absolute run
   directory. `public/` moves out with `git mv`. New project `argus-ui`, zero
   runtime dependencies like its sibling: `bin/argus-ui.mjs`; `src/config.mjs`
   (`--collector`, default `ATHENA_OBS_URL` then `http://127.0.0.1:4318`;
   `--collector-token`, default `ATHENA_OBS_TOKEN`; `--port` 4319; `--host`
   127.0.0.1; `--token`, required for a non-loopback bind); `src/server.mjs`, which
   serves `public/` with the moved `serveStatic`/`MIME` and reverse-proxies
   `/api/*` and `/v1/*` over `node:http`, adding the collector's `Authorization`
   header server-side, stripping the browser cookie upstream, and mapping an
   upstream 401 to a 502 that names the cause; `public/`; `test/config.test.mjs`
   and `test/server.test.mjs` against a fake collector, both on port 0; `README.md`;
   and a `CLAUDE.md` whose load-bearing rule is that this project never imports from
   `tools/argus` and never reads its files — it knows the collector only through the
   HTTP API, so it can be moved out of athena unchanged. `test.sh` gains the fifth
   suite.

   Why a proxy and not CORS on the collector: `EventSource` cannot set an
   `Authorization` header, so a cross-origin interface would have to put the token
   in the query string of every request — the secret in the address bar, which is
   exactly what the current cookie redirect exists to avoid.
4. **Persist by default, open explicitly.** `runDirName(date)` in `config.mjs` →
   `2026-08-03T14-22-05` from local time, suffixed `-2`, `-3` when the directory
   exists. Default on, under `<cwd>/.athena-telemetry/<name>/`. `--persist <dir>`
   means exactly that directory, no nesting, write-only — which keeps `Dockerfile`'s
   `ATHENA_OBS_PERSIST=/data` behaving as today. `--no-persist` turns it off.
   `--open <dir>` is the read direction: it replays that directory, turns retention
   off so nothing is evicted by age, and opens nothing for writing. Without the
   retention escape criterion 11 fails silently. `--persist` and `--open` together
   are refused with a message saying which does what. `load()` writes
   `.athena-telemetry/.gitignore` containing `*` when it creates the root — a
   self-ignoring directory, no `git` subprocess, nothing of the measured project
   touched.
5. **Reachable and backgroundable.** `bin/argus` at the repository root: POSIX `sh`,
   executable bit committed, self-locating from `$0`. No shim for `argus-ui` —
   criterion 3. No `bin` key in `plugin.json` — the validator warns on it and
   `test-plugin.sh` rejects unknown fields; the directory alone is what the PATH
   mechanism uses. `skills/argus/SKILL.md`, user-invocable, opening with the trap
   rather than the command; it names `argus-ui` in one sentence as the local way to
   look at the data and does not offer to start it. New
   `argus/src/background.mjs` with `spawnBackground({argv,
   readyTimeoutMs})` and `exitWhenGone(pid, onGone)`: `start --background` spawns
   the same script with `--ready-fd 3 --exit-with <pid>`, stdio to `<run
   dir>/collector.log`; the child writes one JSON line on fd 3 from inside the
   listen callback and closes it, so the caller's shell is not held by an open
   pipe; the parent prints the banner and exits. `--exit-with` defaults to
   `CLAUDE_PID`; the collector polls `process.kill(pid, 0)` every 5 s on an
   `unref`'d timer and runs `shutdown()` on `ESRCH`. New `test/background.test.mjs`;
   new `test-plugin.sh` cases that run the shim out of the scratch install's plugin
   cache and assert that no `argus-ui` entry exists in `bin/`.

## Tasks

- [ ] 1. Remove session naming
- [ ] 2. Rename to `tools/argus`
- [ ] 3. Split the interface into `tools/argus-ui`
- [ ] 4. Persist by default
- [ ] 5. Reachable and backgroundable

## Decisions

- Two projects under `tools/`: `argus` for the collector, `argus-ui` for the
  interface. Source: the human.
- Other projects reach the collector through a `PATH` command plus a user-invocable
  skill. A subagent was considered and rejected: measuring is a process to start,
  not a task to delegate — the agent would issue one shell command and its context
  would die while the collector kept running. The command alone was rejected too:
  it cannot carry the trap that telemetry configuration is read at process start.
  Source: the human, on that argument.
- The interface is local only. No `PATH` entry, no skill, no manifest mention, and
  never deployed; it leaves athena later as its own project, which is why its
  `CLAUDE.md` forbids it from importing anything in this repository. Source: the
  human.
- Reopening a measurement is `--open <dir>`, separate from `--persist <dir>`, which
  only ever writes. Source: the human.
- The collector is started on demand, never automatically. Source: the human — "der
  observer soll auf zuruf gestartet werden".
- The user exports the `OTEL_*` block themselves at session start; athena writes no
  settings file anywhere. Source: the human — "der nutzer setzt die otel
  konfiguration über environment variablen beim start der session".
- The collector dies with the session. Source: the human.
- Persistence on by default, into the measured project's `.athena-telemetry/`, one
  subdirectory per measurement named by timestamp. Source: the human.
- The interface always attaches to a running collector; an old measurement is viewed
  by starting the collector on its directory. The rejected alternative — the
  interface reading the files itself — would duplicate the token aggregation that
  lives in the store, and two implementations of one calculation drift apart.
  Source: the human, on that argument.
- No session naming, no hooks. Source: the human — "keine Namen, keine Hooks".
- Remove only what these decisions falsify; tunnel, Docker and Render stay. Source:
  the human.
- A deployed collector no longer serves a page; the interface is always run locally
  against it. Accepted knowing an public address alone then shows nothing, and that
  the token no longer has to reach a browser over the network. Source: the human.
- The commands are named after the projects: `argus` and `argus-ui`, replacing
  `athena-observe`. Source: default, unanswered.
- Delivery is two `bin/` shims plus a user-invocable `argus` skill. Source: default,
  unanswered.
- The move is done with `git mv` so each file's history survives. Source: default,
  unanswered.
- This session wrote the tracker record directly. Source: default, unanswered — the
  installed plugin in this environment predates `agents/tracker.md`, so no `tracker`
  agent type is registered here.

Facts established by measurement, which the criteria rest on:

- A plugin's `bin/` is appended to the Bash `PATH` — observed in this session's own
  `PATH` — but this is undocumented; anthropics/claude-code#42872 is open about the
  gap. Criterion 2 therefore gets a test that runs both shims out of an installed
  plugin cache.
- `CLAUDE_PLUGIN_ROOT` is **not** set for Bash commands, only for hook and MCP
  commands. The shims resolve their own location from `$0`.
- Each Bash tool call is a fresh `bash -c` parented directly to `claude`; a
  backgrounded child is orphaned when that shell exits and would outlive the
  session. `CLAUDE_PID` is exported and is the `claude` process — that is what
  criterion 4 watches. Without the watchdog the decision "dies with the session" is
  not implemented.
- Telemetry exported to a closed port costs nothing: exit 0, no stderr, no log
  without debug mode, no measurable shutdown delay. A collector started mid-session
  is picked up within ~107 ms, but nothing emitted before it came up is backfilled —
  so "on demand" measures from the moment of the demand.
- `TelemetryStore#evict` drops records older than the retention window during
  replay, sessions included, so criterion 10 is unreachable without a retention
  escape.
- `public/app.js` has zero imports and speaks only HTTP to the collector, which is
  why two genuinely separate projects are possible rather than two directories
  sharing a library.

## Log

- The idea arrived vague and was grilled: three researcher dispatches (the code, the
  project's documentation and packaging, the platform's background mechanisms), one
  more to verify what a session does when telemetry is exported to a closed port,
  and eight questions to the human. Every answer is under Decisions.
- Two designs were rejected on the human's own decisions: an automatically started
  background process (Claude Code's plugin monitors would fit, but the human wants
  it on demand), and a switch that lets a deployed collector keep serving the page
  (it would leave half the coupling in place).
- The human amended the intent before step 3 was implemented: reopening gets its own
  option instead of overloading `--persist`; the interface is never distributed and
  will leave athena later; other projects use the collector through the `PATH`
  command and the skill. Criteria 1, 2, 3, 11, 13 carry the amendment; steps 1 and 2
  are untouched by it. The old numbering shifted by one from criterion 3 onward.
- Criterion 14 was corrected on the implementer's objection before it was
  implemented: it demanded that no `tools/observability` path survive *anywhere*,
  which would have rewritten a closed tracker entry and this issue's own map — both
  accounts of what was actually run at `99ce318`. It now binds instructions only.
- The first implementer dispatch could not edit: the session was in plan mode. It
  returned a read-only analysis and one blocking question, which is the criterion 14
  correction above. It also established that no static analysis exists in this
  repository — no lint script in the package, and no `.eslintrc*`,
  `eslint.config*`, `.prettierrc*` or `.editorconfig` anywhere — so `test.sh` is the
  whole of what a tool checks here.

- Step 1 landed as `70e5b23`, "Remove session naming and its hook". `npm --prefix
  tools/observability test`, 93 cases (was 113), exit 0; `bash test.sh`, four suites
  — repository 5, plugin 31, worktrees 9, collector 93 — exit 0. Twenty cases went:
  six with `test/hook.test.mjs`, five in `store`, four in `server`, two in
  `persist`, one each in `claude` and `probe`; `config` and the surviving
  `claude`/`probe` cases were rewritten in place.
- Step 2 landed as `06ac6e1`, "Rename the collector to tools/argus". `npm --prefix
  tools/argus test`, 93 cases — unchanged, which is the move's own proof — exit 0;
  `bash test.sh` exit 0. Thirty-one files moved with `git mv`, twelve of them also
  changed content; outside the project `.gitignore`, `README.md`, `render.yaml`,
  `test-repo.sh`, `test.sh`, and line 296 only of
  `docs/2026-08-02-workflow-token-measurement.md` — the live reproduce command, not
  the account of the measurement.
- Recorded as a default in step 2: the command name follows its file, so every
  `athena-observe` string in help text, log prefixes and `check` output became
  `argus` in the same commit. That also renamed the probe's synthetic service and
  span, and the Render **service name**, which is the one outward-facing item in
  these two commits — re-applying the blueprint would move the deployment's URL.
  Raised with the human.
- `ATHENA_OBS_*`, the `athena_obs_token` cookie and `.athena-telemetry` keep their
  names; nothing in these two steps falsifies them. The tool README keeps two
  mentions of a SessionStart hook, in the paragraph explaining why a hook *cannot*
  set the resource attribute — still true, and it stops the hook being reinvented.
- Surprise, out of scope: the lockfile's `license` field names a permissive licence
  rather than the copyleft one `package.json` declares. Pre-existing.
  `test-repo.sh`'s licence block only inspects `package.json`, so the lockfile
  slipped through the check written to catch exactly this. Violates no criterion
  here; filed for its own run.
- Regression caused by this issue's own record, and fixed in it: the sentence above
  first quoted the lockfile's licence name verbatim, which made `test-repo.sh`'s
  "no file claims that licence" case fail — it greps the whole repository for the
  name, and a record *reporting* a licence reads the same as a file *claiming* one.
  The record now describes the drift without naming it. That the check cannot tell
  the two apart is a second finding, out of scope here.
- Not session naming and untouched: `SPAN.hook`, `session.counts.hooks` and
  `.span-bar[data-kind="hook"]` are the `claude_code.hook` telemetry span kind.

- Tests for steps 3 to 5 landed as `fadcdf4`, written from the intent alone before
  any of it existed: `npm --prefix tools/argus test` 105 cases 15 fail exit 1, `npm
  --prefix tools/argus-ui test` 4 cases 4 fail exit 1, `bash test-plugin.sh` 39
  cases 8 fail, `bash test-repo.sh` 6 cases 1 fail, `bash test.sh` four of five
  suites red, exit 1.
- The test-author returned six questions rather than guessing. Five confirmed what
  it had encoded; one was undecided and is now settled: `--open` on a directory that
  is not there is an error, exits non-zero promptly, names the absolute path it
  could not find, and does not create it. Silently starting an empty collector would
  make a typo indistinguishable from a measurement that recorded nothing.
- Step 3 landed as `e53da1b`: the interface's own suite 14 cases exit 0, the
  collector 105 cases 95 pass exit 1 (the ten red belong to the next two commits),
  `test-repo.sh` 6 cases exit 0.
- Step 4 landed as `3f204d8`: the collector 105 cases 104 pass exit 1, only
  `test/background.test.mjs` left.
- Step 5 landed as `646519a`: the collector 112 cases exit 0 — 105 to 112 because
  `background.test.mjs`'s eight cases now run instead of counting as one failed
  file — the interface 14 cases exit 0, `test-plugin.sh` 39 cases exit 0,
  `test-repo.sh` 6 cases exit 0, and `bash test.sh` all five suites (repository 6,
  plugin 39, worktrees 9, argus 112, argus-ui 14), exit 0.
- Surprise, and the plan was wrong: it claimed `--persist` would keep the container's
  `ATHENA_OBS_PERSIST=/data` behaving as before. It does not. Today that replays on
  restart; criterion 11 makes `--persist` write-only, so a restarted container now
  begins a fresh measurement in the same directory and reads the old one back with
  `--open`. The Docker paragraph of the collector's README was corrected rather than
  the behaviour, because the behaviour is what the criterion asks for.
- Surprise, and the plan lost to the test: step 5 said the skill would name
  `argus-ui` in one sentence, while criterion 3 says nothing outside the interface
  may reference it and the shell case encodes exactly that over `skills/`, `agents/`,
  `hooks/` and the manifest. The implementer followed the criterion; the skill points
  at the JSON API instead.
- Criterion 3 read absolutely conflicts with criterion 7, which requires the
  collector's 404 to name `argus-ui`, and with documenting the split at all. Read as
  the distribution surface the test encodes, both hold: the collector's README,
  `CLAUDE.md` and 404 do name the interface.
- Open, raised with the human and unanswered: step 2 renamed the Render **service**,
  so re-applying the blueprint would move the deployment's URL. The only
  outward-facing item in this change.
- Recorded as a default and worth a reviewer's eye: `argus-ui --token` gates `/api/*`
  only, exactly as decided, which leaves `/v1/*` ungated. Harmless on a loopback
  bind; on a token-protected non-loopback bind it means OTLP ingest can be relayed
  through the interface without the interface's token. No test covers it and the
  implementer did not widen the gate beyond the decision.

## Checkpoints

### Before implementation

- **Does this match what was asked?** The human asked for three things: the observer
  becomes a background part of athena, the interface is separated and stays a tool
  of its own, and the whole thing serves measuring token usage in other projects.
  Every one of the fourteen criteria serves one of those. Two things they did *not*
  ask for are deliberately absent: an automatic start (Claude Code's plugin monitors
  would fit, but they chose on demand) and any writing into another project's
  settings (they export the environment block themselves). The two-project layout is
  their own late correction and is criterion 1.
- **What surprised me?** Three things, each of which changed the design. The
  observer's files already ship inside the installed plugin — the gap was
  reachability, not packaging. "Dies with the session" does not happen by itself: a
  backgrounded child is orphaned as soon as its short-lived shell exits and would
  outlive the session, so it needs a watchdog on the session's process id. And
  reopening an old measurement returns an empty interface today, because replay
  evicts by wall clock against the retention window.
- **What am I assuming without having verified it?** That the `bin/`-on-PATH
  mechanism keeps working — it is measured here and documented nowhere, which is why
  criterion 2 gets a test that runs the shims out of an installed plugin cache. That
  a single JSON line on a third file descriptor releases the calling shell as
  intended; that is designed, not yet run. And that removing session naming costs
  the human nothing they use, since the OTel resource attribute route stays.

### Before the PR

## Retro
