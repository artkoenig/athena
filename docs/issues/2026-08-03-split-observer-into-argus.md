---
status: waiting
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

- [x] 1. Remove session naming
- [x] 2. Rename to `tools/argus`
- [x] 3. Split the interface into `tools/argus-ui`
- [x] 4. Persist by default
- [x] 5. Reachable and backgroundable

## Decisions

- Parked: re-applying the Render blueprint would move the deployment's URL,
  because step 2 renamed the blueprint's service to `argus`. That is outward-facing,
  so it is the human's call. Nothing in this change re-applies the blueprint; the
  rename stays in the file, unapplied. Source: the human.
- The port probe keeps asking for twelve seconds before it gives up on a busy
  collector. It stays at twelve. Reason: with the fix below, giving up no longer
  produces a false claim, so the window stops being load-bearing. Revisit only if the
  human says otherwise. Source: default, unanswered.
- Refusal and silence share one expectation on the probe's banner. Neither may claim
  nothing is kept, and nothing requires them to read as two different sentences. The
  wording of the replacement sentence is left to the implementer — the tests assert
  the absence of the false claim, not any particular phrasing. Source: test-author,
  no question needed.
- A JSON 200 that is not an object makes the second start attach rather than refuse.
  Reason: `/api/health` has already identified a collector, and a body that says
  nothing about persistence says nothing about the port being held by a stranger
  either, so refusing would discard a fact the probe already has. Source: implementer,
  the tests deliberately left this open.
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
- **Corrected — this record was wrong.** It said `argus-ui --token` gates `/api/*`
  only and leaves `/v1/*` open to relayed ingest. The reviewer refuted it from the
  code and reproduced the opposite: `PROXIED` covers `/api/` and `/v1/` alike and
  the token check sits inside that branch, so an unauthenticated `POST /v1/metrics`,
  `/v1/traces` and `/api/config` all answer 401. There is no hole. What is true is
  only the second half: no test covers the `/v1/` gate.
- Also on this branch, and outside this issue's criteria: two findings were filed as
  their own issues — `docs/issues/2026-08-03-commit-signing-unverifiable.md` and
  `docs/issues/2026-08-03-licence-check-misses-and-overreaches.md` — and the closed
  issue `2026-08-02-workflow-tool-call-efficiency.md` had its frontmatter corrected
  from `active` with no pull request to `done` with `pr: 22`, which its merged branch
  had made true. Without that a session orienting itself would have resumed the
  wrong issue.
- Criteria 3 and 7 conflict when 3 is read literally: 3 forbids anything outside the
  interface from referencing it, 7 requires the collector's 404 to name it. The
  reading that holds, and that the shell case encodes, is the distribution surface —
  `bin/`, `.claude-plugin/`, `skills/`, `agents/`, `hooks/`. Documentation and the
  404 may name the interface. Recorded rather than reinterpreted: the criteria are
  fixed, and this says which of two readings was always the coherent one.

- **Review round 1**, fresh context, whole diff `99ce318..86daf95`. Suite established
  independently: `bash test.sh`, five suites — repository 6, plugin 39, worktrees 9,
  argus 112, argus-ui 14 — exit 0, nothing skipped. No static analysis exists;
  confirmed by a wider search than the implementer's, adding `prettier.config*`,
  `biome.json` and `tsconfig.json`, all absent, and no root package.

  | criterion | findings |
  | --- | ---: |
  | 6 — a second start does not create a second collector | 1 |
  | 14 — the documentation mirrors the result | 1 |
  | violates none | 5 |
  | every other criterion | 0 |

  Triage:
  - **Criterion 6, fix now.** `inspectPort` classifies the port by fetching
    `/api/health` with a 3 s timeout, and *any* failure of that fetch returns
    "free". A listener that accepts the connection and never answers is therefore
    diagnosed as an empty port: the start proceeds, the child dies, exit 1 comes
    after ~3.3 s with the wrong message, a stray measurement directory is left
    behind, and the intended "held by something that is not a collector" is buried
    in `collector.log`. The existing case uses an HTTP squatter, which is why the
    silent one was never exercised. Reproduction handed to the test-author as a
    spec.
  - **Criterion 14, fix now.** Write-only `--persist` was corrected in the README's
    Docker paragraph but not its Render one, which still argues for the paid plan
    because the disk preserves history across a restart. With a write-only
    `--persist` the disk keeps the files while the running collector no longer
    replays them, and nothing in a deployment can reach them.
  - **`render.yaml`'s header comment, fix now.** It makes the same claim as the
    Render paragraph and this diff made it false. It violates no criterion —
    criterion 14 enumerates the READMEs and the `CLAUDE.md`s — but the rulebook's
    exception covers exactly a documentation statement this diff falsified.
  - **The interface's page title, fix now, bounded.** `public/index.html` and
    `public/styles.css` still name "athena · observe". Pre-existing text, but this
    diff is what renamed the product, so the page now titles itself after something
    that no longer exists. Same exception; bounded to the title, the header and the
    file comment.
  - **The false `/v1/` note, fixed in the record** — see the corrected entry above.
    A tracker-only fix, so this round is not repeated for it.
  - **Two out-of-scope traps, filed for their own run**: a bare `--open` or
    `--persist` with no value parses to `true`, resolves to no directory and
    silently starts an ordinary default-persist collector instead of refusing; and
    `start --background --tunnel` lets the child generate a tunnel token that never
    reaches the caller, because the parent prints its own null token. Neither
    violates a criterion here.

- Round 1's four fixes landed as `248a3ab`, after the test-author pinned the defect
  in `3e6fab5`. `inspectPort` now classifies the port from a TCP connect rather than
  from the health request: refused means free and answers immediately, so the
  ordinary case pays no timeout; accepted means held, and only then is
  `/api/health` asked, on a 1000 ms budget, with any failure now meaning *stranger*
  instead of *free*. The stray directory goes with the misclassification, because
  free now means nothing accepted a connection. `node --test
  test/background.test.mjs` 9 cases exit 0, the new case at 1360 ms against its
  2000 ms bound. `bash test.sh` five suites — repository 6, plugin 39, worktrees 9,
  argus 113, argus-ui 14 — exit 0.
- Regression during that commit, caused and corrected inside it: renaming the page
  to `argus · ui` turned a green case red. `tools/argus-ui/test/server.test.mjs`
  asserts the served HTML matches `/athena/i` as its proof that the page came back
  at all. Tests are not the implementer's to edit, so the page became `athena ·
  argus` instead; only "observe" is gone. Worth naming because that assertion pins
  the word "athena" into a project whose own `CLAUDE.md` says it must be liftable
  out of this repository unchanged — a future rename has to go through the
  test-author. Out of scope here.
- Two more of the same falsehood were left standing, both outside the triage:
  `render.yaml`'s inline plan comment makes a weaker version of the replay claim,
  and `tools/argus/compose.yaml` still names its service `observe`. Handed to review
  round 2 rather than fixed unasked.

- **Review round 2**, same reviewer context continuing, diff `99ce318..53f2efb`.
  Suite established independently: `bash test.sh`, five suites — repository 6,
  plugin 39, worktrees 9, argus 113, argus-ui 14 — exit 0, nothing skipped. Still no
  static analysis.

  | criterion | R1 | R2 |
  | --- | ---: | ---: |
  | 6 — a second start does not create a second collector | 1 | 1 |
  | 14 — the documentation mirrors the result | 1 | 0 |
  | violates none | 5 | 1 |
  | every other criterion | 0 | 0 |

  Round 1's other findings are confirmed fixed: the silent squatter now exits 1 with
  the right message in 1147 ms and creates no directory; both falsified
  documentation statements are true and complete; the page carries no `observe`
  anywhere. `render.yaml`'s inline plan comment and `compose.yaml`'s service key
  were examined and are **not** falsified — the first speaks only about the free
  tier, the second is a key rather than a statement — so both correctly stayed. The
  `/athena/i` assertion does not violate criterion 1: it is neither an import nor
  knowledge of the collector, and it lives inside the interface project, so the
  project lifts out with page and test together.

- **Stop signal: Repetition.** Criterion 6 has now been missed in two consecutive
  rounds by two different defects, in opposite directions. Recorded as the rulebook
  requires, and the decision is to change approach rather than adjust the same
  number again.

  The round 2 finding: cutting the health budget to 1000 ms and treating any failure
  of that request as *stranger* turns a live collector under load into a squatter.
  Reproduced end to end with four concurrent 19.8 MB OTLP exports — under the 32 MB
  cap — while `handleIngest` decodes synchronously and blocks the event loop: the
  second start exits 1 with "port … is held by something that is not a collector",
  names no directory, and tells the human to stop their own collector, while
  `/api/health` on that port answers `{"ok":true,…}` moments later. Both budgets
  probed at the same instant under the same load: 1000 ms → stranger, 3000 ms →
  collector. Measured health latencies under that shape of load ranged 481 ms to
  3051 ms, so the misclassified band sits inside the operating range. It is a
  regression: this was classified correctly at `86daf95`.

  **The approach that was wrong**: a single deadline as the discriminator. It cannot
  separate "a collector whose event loop is busy" from "a listener that will never
  answer" — moving the number only chooses which of the two is misread. Round 1
  chose one direction, round 2 the other.

  **The approach now**: ask repeatedly over a generous total window with a short
  budget per attempt, and call it a stranger only when the window expires. A
  collector whose loop frees up between chunks answers on some attempt; a silent
  listener never does. The free case is untouched and stays instant, because a free
  port refuses the connection rather than accepting it — the rare, slow path is the
  held one, which is the right place to spend seconds. Asymmetry of cost decides the
  window: a wrong *stranger* tells the human to kill a collector that is working,
  a slow correct answer costs a few seconds. Source: default, unanswered.

- Second round 2 finding, violating no criterion and fixed with the above: the new
  case's `took < 2000` bound measures the wall clock of a whole `execFile` of node
  — spawn, module load, connect, exit — so it measures machine speed. The reviewer
  reproduced two failures in eight runs on a loaded four-CPU box, at 2135 ms, 3375
  ms and 4589 ms, against 1147–1465 ms unloaded. It is the one thing in the diff
  that can turn criterion 15 red with no code changing, and its message would point
  the next reader at a classification defect that is not there. It also contradicts
  the new approach, whose stranger path is deliberately slower. The test-author
  rewrites it to assert the outcome rather than the wall clock.

- Not reduced to a reproduction, so not a finding, but recorded: a collector bound
  to a specific non-loopback interface, with a second start using `--host 0.0.0.0`,
  would probe `localhost`, be refused, be called free, and fall through to the
  `EADDRINUSE` backstop with the old wrong message. The reviewer could not bind a
  second interface in this environment to demonstrate it.

- Round 2's fix landed as `57596f6` (the cases) and `d28f0b0` (the change). The
  connect probe is untouched — refused still means free, instantly. Once something
  accepts, `/api/health` is asked repeatedly across a 12 s window, 250 ms apart,
  each attempt getting twice the budget of the one before it starting at 1000 ms and
  clamped to what is left. Only an expired window means *stranger*.
  `bash test.sh`, five suites — repository 6, plugin 39, worktrees 9, argus 114,
  argus-ui 14 — exit 0. `node --test test/background.test.mjs` three times: 10 cases,
  exit 0 each, 28.5 / 28.4 / 28.7 s. Stable.
- **The implementer deviated from the brief and was right to.** The brief asked for
  a short fixed budget per attempt. A fixed budget does not fix the defect: health
  answered between 481 ms and 3051 ms under load, so a collector whose loop stays
  blocked across the window fails a 1000 ms attempt every time and is called a
  stranger again — the same defect one timescale up. Doubling means the first
  attempt is all a healthy collector ever needs, while two later attempts each
  exceed the slowest answer ever measured, at zero cost on the common path.
- Decided here rather than by a test, because criterion 6 does not decide it: when
  the window expires the tool cannot tell a stranger from a collector that never
  freed its loop, so the message no longer asserts the false half — "port N is held
  and nothing on it answered in 12s: it is not a collector, or it is one too busy to
  answer. Stop it, or start on another port with `--port`." A completed answer that
  is not a collector's keeps the old, certain sentence.
- Recorded, out of scope: the mute path now spends 12.4 s of the test helper's 25 s
  deadline. Anyone shortening that helper or widening the window turns that case red
  for a reason that is not a classification defect. And the foreground `start` still
  prints the older `EADDRINUSE` message from its own code path — a different
  sentence, not another production of this one, and where the reviewer's
  unreproduced `--host 0.0.0.0` note would land.

- **Review round 3**, same reviewer context, diff `99ce318..e0f41d5`. `bash test.sh`
  five suites — repository 6, plugin 39, worktrees 9, argus 114, argus-ui 14 — exit
  0, nothing skipped, 46 s. Still no static analysis.

  | criterion | R1 | R2 | R3 |
  | --- | ---: | ---: | ---: |
  | 6 — a second start does not create a second collector | 1 | 1 | 2 |
  | 14 — the documentation mirrors the result | 1 | 0 | 0 |
  | violates none | 5 | 1 | 0 |
  | every other criterion | 0 | 0 | 0 |

  Rounds 1 and 2 are confirmed closed. The reviewer repeated its own round-2 load —
  four concurrent 15.4 MB exports — and got exit 0 naming the directory in 2262 ms,
  8 of 8 correct at moderate sustained load. The retimed case is no longer flaky:
  under the same 24-way contention on four CPUs that failed it 2 in 8 before, 3 of 3
  pass at 12.7–13.4 s against the helper's 25 s. The doubling budget's arithmetic
  was checked and holds: 1000, 2000, 4000, then 4250 of the remaining window, four
  250 ms gaps, 12 250 ms total, two attempts exceeding the 3051 ms slowest measured
  answer.

- **Finding, fix now — criterion 6.** The retry was applied to `/api/health` and not
  to the step after it. `bin/argus.mjs` still fetches `/api/config` once, on a 3 s
  budget, with no retry — so health can survive a blocked loop across 12 s of
  patient retries, return `collector`, and the very next request on that same
  blocked loop falls into the catch and leaves `persist` null. The second start then
  exits 0 and prints **"this collector keeps nothing on disk"** while it is
  recording. Reproduced under real load — five concurrent 29 MB exports, one run in
  eight — and deterministically: `SIGSTOP` the collector, `SIGCONT` for a 15 ms blip
  after the first attempt expires, `SIGSTOP` again; a 40 ms blip lets both requests
  through and the directory is named, which isolates the cause. Worse than silence:
  it asserts the opposite of the truth, and it makes `tools/argus/README.md` and
  `skills/argus/SKILL.md` conditionally false where both promise the directory is
  named.

- **Finding — criterion 6, put to the human.** The 12 s window can still expire
  against a live collector under sustained saturation: one run in six, five
  concurrent 29 MB exports, exit 1 with the window-expired message while the
  collector is ingesting. Its limits, stated by the reviewer: not reproducible at
  moderate load (0 of 8 with three concurrent 15 MB exports), needs a collector
  saturated far beyond what a Claude Code session produces, and the message is
  honest — it names "or it is one too busy to answer" rather than asserting a
  stranger.

- **Stop signal: Repetition, second firing.** Criterion 6 has carried a finding in
  all three rounds, from three distinct defects — one deadline too generous, one too
  tight, and one step that never got the treatment at all. Finding counts 7 → 2 → 2:
  decreasing, then flat. The decision this time is split rather than another single
  approach change: the root of both round-3 findings is one shape — *a multi-step
  probe where only the first step was made patient* — so the fix makes the whole
  probe patient rather than patching a second timeout, and the question of how long
  "long enough" should be goes to the human, because it trades a rare wrong answer
  against how long a second start may block.

- Observation, not a finding, recorded rather than fixed: in the window-expired
  message the destructive remedy comes first ("Stop it") and the safe one second
  ("or start on another port"), while the clause a skimming reader meets first is
  the stranger reading. If the busy-collector case is the common one, the order
  works against it. It violates no criterion and has no reproduction of harm.

- Round 3's first finding was fixed at the root, as `0018243` (the case) and
  `849d256` (the change). The patience moved off the health question and onto the
  probe: `askOnce(url, budget)` puts one question, `askPatiently(url, deadline)`
  repeats it with the doubling budget until answered or the deadline passes, and
  `inspectPort` opens **one** deadline the moment the connect probe says the port is
  held, running both questions against it. A third step added later calls the same
  function and inherits the same window. The constants were renamed `HEALTH_*` →
  `PROBE_*` because they are no longer the health question's. `bash test.sh` five
  suites — repository 6, plugin 39, worktrees 9, argus 115, argus-ui 14 — exit 0;
  `node --test test/background.test.mjs` three times, 11 cases exit 0 each, 34.9 /
  34.7 / 34.9 s, the three timing-shaped cases steady to the hundredth: 3.91, 6.30,
  12.39 s. The mute path did not grow — it never reaches the second question.
- Verified rather than assumed: `tools/argus/README.md` and `skills/argus/SKILL.md`
  both promise the directory is named and state no timing anywhere, so the fix
  restores what they already say and neither needed an edit.
- **Raised by the implementer, handed to review round 4 rather than fixed unasked.**
  The message cannot tell "this collector keeps nothing on disk" from "I could not
  find out what it keeps", and it asserts the first. The message is reachable
  deterministically, with no load and no timing involved, whenever `/api/config`
  yields no usable body — including a plain 401, because a second `start --background`
  does not carry the first collector's token while `/api/health` is ungated by design.
  Three distinct states currently collapse into one null at
  `tools/argus/bin/argus.mjs:216`: the collector really persists nothing, the
  collector refused the question, the collector never answered. A message that
  distinguished these would remove the falsehood without changing a number. It is the
  same principle already applied to the window-expired message, which is why it is
  worth a verdict rather than a shrug.

- **Review round 4**, same reviewer context, diff `99ce318..d08e0a7`. `bash test.sh`
  five suites — repository 6, plugin 39, worktrees 9, argus 115, argus-ui 14 — exit
  0, 54 s. Still no static analysis.

  | criterion | R1 | R2 | R3 | R4 |
  | --- | ---: | ---: | ---: | ---: |
  | 6 — a second start does not create a second collector | 1 | 1 | 2 | 2 |
  | 14 — the documentation mirrors the result | 1 | 0 | 0 | 0 |
  | violates none | 5 | 1 | 0 | 0 |
  | every other criterion | 0 | 0 | 0 | 0 |

- **Stop signal: Hard number.** Finding counts 7 → 2 → 2 → 2. The count has not
  decreased across three consecutive rounds, so the run stopped and put the state in
  front of the human. The human did not answer the two checkpoint questions; the run
  continues under the rulebook's away clause.

- **State.** Working tree clean, branch in sync with origin at `d08e0a7`. `bash
  test.sh` at that commit: five suites — repository 6 cases, plugin 39, worktrees 9,
  argus 119, argus-ui 14 — exit 0, 54 s.

- **Next step.** The criterion-6 defect goes test-author → implementer → review
  round 5 → checkpoint 2 → commit, push, PR → retro.

- **Test-author produced:** `tools/argus/test/background.test.mjs`, new file.
  Four new tests, plus four helpers and one shared regex. All four are against
  criterion 6: a 401 refusal (the reviewer's exact reproduction — two starts,
  different tokens); a 404 where the route answered but said nothing about
  persistence; a `/api/config` that never answers inside the probe window; and one
  case asserting that the three states read as three different sentences while a
  known directory is still named. Committed as `3c99cb7`, pushed together with the
  round-4 record at `eb031ac`. Proof they fail: `cd tools/argus && npm test --silent`
  → 119 tests, 115 pass, 4 fail, exit 1. Exactly the four new ones fail, no
  pre-existing test changed verdict. All four are assertion failures on the printed
  banner, not setup errors.

- **Decision recorded by test-author, no question needed:** refusal and silence
  share one expectation. Neither may claim nothing is kept, and nothing requires them
  to read as two different sentences. The wording of the replacement sentence is left
  to the implementer — the tests assert the absence of the false claim, not any
  particular phrasing.

- **Assumption recorded:** states a and e (genuine no-persistence, and a named
  directory) are pinned inside the fourth test rather than as tests of their own,
  because on their own they pass today. The defect is the collapse, so the assertion
  that carries it is pairwise distinctness.

- **Convention to record in `tools/argus/CLAUDE.md`:** a case that needs a collector
  to answer `/api/health` normally but `/api/config` abnormally puts a front server
  on the probed port that proxies everything through to a real backgrounded collector
  and overrides only `/api/config`. This keeps the health exchange real — the
  objection recorded against a full stub in the older cases — while making 404 and
  never-answers deterministic, which no real collector can be made to produce on
  demand.

- **Implementer produced:** `tools/argus/bin/argus.mjs` and `tools/argus/CLAUDE.md`.
  `inspectPort` no longer collapses "the collector said it keeps nothing" into "the
  question was not answered": it returns `persistKnown`, decided by the presence of
  the `persist` field in an ok config body rather than by its value, so a 401, a 404,
  a non-JSON 200 and a spent window all leave it false. A new `describePersistence`
  turns the three states into three lines where the banner is printed — the absolute
  directory when known, "keeps nothing on disk" only when the collector said so, and
  "not known — its configuration could not be read; it may well be recording" for
  refusal and silence alike. The probe window, the connect probe and `askPatiently`
  are untouched. `CLAUDE.md` gained the front-server pattern under "Tests". Commits:
  test-author record `bcf9560`, implementation `c9f03ee`, both pushed.

- **Facts.** Before the change, `node --test test/background.test.mjs` in
  `tools/argus`: 15 cases, 11 pass, 4 fail, exit 1. After: same command 15 cases
  exit 0 in 66 s; `cd tools/argus && npm test` 119 cases exit 0; `bash test.sh` from
  the root, five suites — repository 6, plugin 39, worktrees 9, argus 119, argus-ui
  14 — exit 0, run twice, exit 0 both times. Static analysis: none exists, established
  by a `find` for eslint, prettier, biome, tsconfig and editorconfig configurations
  outside `node_modules` (zero hits) and by `tools/argus/package.json` having scripts
  start, dev, test, demo and no lint.

- **Assumptions.** The wording of the third sentence in `describePersistence` is the
  implementer's, since the tests deliberately do not pin it; the clause "it may well be
  recording" is there because the caller's wrong move is to conclude nothing is being
  recorded. A real collector's `/api/config` always carries the `persist` key
  (`src/server.mjs:172` emits `persist: persist ?? null` unconditionally), so keying
  "known" on the field's presence keeps a genuine `--no-persist` collector reporting
  that it keeps nothing.

- **Surprise.** The argus suite is 119 cases, not the 115 in the state entry written
  before the implementer ran. The four new cases account for the difference; nothing
  regressed. The state entry is corrected above.

- **Refuted — no user-facing document falsified.** At commit `c9f03ee`, both
  `tools/argus/README.md:45-47` and `skills/argus/SKILL.md` promised the directory
  unconditionally. Round 5's triage ordered both fixed as false. Commit `2e7fd0a`
  fixed them: both now name the directory conditionally, on being able to read the
  collector's configuration.

- **Filed for later, violating no criterion — file as its own issue.** The
  `Measurement` label already introduces a parenthetical from "keeps nothing on disk".
  The scalar-body fix introduces a third shape: a parenthetical wrapping an
  informational sentence about configuration. It reads fine for humans, but anything
  that machine-parses this banner has three distinct shapes to handle rather than
  two.

- **Review round 5**, fresh reviewer context, diff `99ce318..7129448`, HEAD at `c9f03ee`.
  `bash test.sh` five suites — repository 6, plugin 39, worktrees 9, argus 119
  (0 failed, 0 skipped, 66.4 s), argus-ui 14 — exit 0. Static analysis: none exists,
  established by `ls` for eslint, prettier, biome, tsconfig and root `package.json`
  (all absent) and `git ls-tree -r --name-only | grep -iE
  "eslint|prettier|biome|tsconfig|editorconfig|lint"` with no match, exit 1.
  `9862a22` is a later record-only commit holding the implementer-stage entry and the
  filed banner issue, neither of which this round saw.

  | criterion | R1 | R2 | R3 | R4 | R5 |
  | --- | ---: | ---: | ---: | ---: | ---: |
  | 6 — a second start does not create a second collector | 1 | 1 | 2 | 2 | 2 |
  | 14 — the documentation mirrors the result | 1 | 0 | 0 | 0 | 1 |
  | violates none | 5 | 1 | 0 | 0 | 2 |
  | every other criterion | 0 | 0 | 0 | 0 | 0 |

  Triage:
  - **Criterion 6, PARKED for the human, not fixed here.** A second `start --background`
    still does not name the collector's directory when it does not carry that
    collector's token. Reproduction: project A starts a collector on port 4718 with
    `--token secretA`, recording into a real directory; project B runs `argus start
    --background --port 4718`, with no token or with a different one. Actual: exit 0
    and "not known — its configuration could not be read; it may well be recording".
    Criterion 6 asks it to exit 0 and name the directory. Deterministic, no load and
    no timing: `/api/health` is ungated by design and identifies the collector,
    `/api/config` is gated, and `tools/argus/bin/argus.mjs:227` can only learn
    `persist` from that gated route. Reachable in the ordinary flow — a session that
    has not run `eval "$(argus env)"` carries no token. Parked because every way to
    close it is material and outward-facing: either the ungated health route starts
    carrying a filesystem path, or the collector writes a discoverable record outside
    its own directory. That is the human's call.
  - **Criterion 14, fix now, bounded to what became false.** Two documents state the
    naming unconditionally and are false in the first finding's state:
    `tools/argus/README.md:45-47` and `skills/argus/SKILL.md`. Both get qualified to
    match what the code does today. If the human later decides the first finding, these
    change back.
  - **Criterion 6, fix now.** `tools/argus/bin/argus.mjs:227` tests `'persist' in
    config.body`; `in` throws on a primitive, so a `/api/config` answering 200 with a
    non-object JSON body crashes the probe with `argus: Cannot use 'in' operator to
    search for 'persist' in nope`, exit 1, no run directory. Criterion 6 allows exit 0
    with a sentence about persistence, or exit 1 saying the port is held by a stranger;
    a type error is neither. Not reachable through a real collector — `tools/argus/src/server.mjs:164-178`
    always answers with an object. The test-author is writing the case now.
  - **Violates no criterion, tracker record only.** `## Tasks` holds five unchecked
    boxes over five steps the Log records as landed (`70e5b23`, `06ac6e1`, `e53da1b`,
    `3f204d8`, `646519a`). Check them.
  - **Violates no criterion, already fixed.** The record named `3cda471`, unreachable
    from the branch. Corrected to `3c99cb7` in `9862a22`, after the reviewer took its
    snapshot at `c9f03ee`. Record it as fixed, and note that the same slip recurred
    with `c9f03ee` — a commit hash written into the record before the signature amend
    is stale by the time it is read.

- **Breakage risk outside the criteria, worth recording.** The new "`/api/config` never
  answers" case takes 15.3 s inside `runBackground`'s 25 s per-command timeout — the
  largest consumer in the suite, most of it the twelve-second probe window. Widening
  that window or shortening the helper turns the case red for a reason that is not a
  defect, and the failure would read "start --background never returned to its caller".
  Round 2 recorded this shape for the mute-stranger case; the new one sits nearer the
  bound.

- **Test-author produced for findings 2 and 3:** Two new cases in
  `tools/argus/test/background.test.mjs`, committed as `dcec322`. One is the
  reviewer's exact reproduction, a `/api/config` answering 200 with the body `"nope"`.
  The other walks eight bodies against one held port — `"nope"`, `""`, `42`, `0`,
  `true`, `null`, `[]`, `[{"persist":"/somewhere"}]` — and afterwards asserts the
  collector still holds its one measurement directory. Proof they failed: `node --test
  test/background.test.mjs` → 17 tests, 15 pass, 2 fail, 77 s; exactly the two new
  ones, all pre-existing cases keeping their verdict.

- **Assumption recorded by test-author, confirmed by implementer measurement:** Five
  of the eight bodies already reached an allowed outcome before the fix, because the
  old code short-circuited on the falsy ones and `'persist' in []` is merely false.
  Exactly three — `"nope"`, `42`, `true` — produced the crash. `null` is the
  load-bearing one: the obvious guard keyed on `typeof` alone throws on it exactly as
  the old code threw on a string, so a fix that looked right would have turned a
  passing shape red.

- **Implementer produced for findings 2 and 3:** Committed as `2e7fd0a`:
  `tools/argus/bin/argus.mjs` (the `persistKnown` guard alone), `tools/argus/README.md`
  (the one sentence), `skills/argus/SKILL.md` (the one paragraph),
  `tools/argus/CLAUDE.md` (two paragraphs under "Tests"). The body is shape-tested
  before the field lookup; both documents now name the directory conditionally, on
  being able to read the collector's configuration, with the token as the named reason
  otherwise. `tools/argus/README.md:45-47` and `skills/argus/SKILL.md` promised the
  directory unconditionally, which the token-gated configuration made false; both were
  bounded to the statement that broke.

- **Decision recorded for finding 3.** A JSON 200 that is not an object makes the
  second start attach rather than refuse. Reason: `/api/health` has already identified
  a collector, and a body that says nothing about persistence says nothing about the
  port being held by a stranger either, so refusing would discard a fact the probe
  already has. The tests deliberately left this open. Source: implementer, on the code
  path.

- **Assumption recorded for finding 3.** The guard treats arrays as objects. It does
  not matter today, since no array carries a `persist` own key, and narrowing it
  further would be a rule the tests do not ask for.

- **Facts.** `cd tools/argus && npm test` → 121 tests, 121 pass, 0 fail, 0 skipped,
  exit 0, 77 s. `bash test.sh` → exit 0, five suites: repository 6, plugin 39,
  worktrees 9, argus 121, argus-ui 14. The suite went 119 → 121 for exactly the two
  new cases. Static analysis: none exists, established by `git ls-files | grep -iE
  "eslint|prettier|biome|tsconfig|editorconfig|golangci|ruff|stylelint"` with no
  match, exit 1, no root `package.json`, and `tools/argus/package.json` declaring
  scripts start, dev, test, demo with no lint.

- **Also record, without acting on it.** The scalar-body path now reaches the
  `Measurement` banner label by a fourth route — that label is already filed as its
  own issue. And the eight-body case runs ~5.3 s inside `runBackground`'s 25 s
  per-command timeout, well clear of it, but that bound now has two consumers whose
  costs move for different reasons; the "never answers" case sits at 15.3 s.

- **Review round 6**, continuing round 5's context, diff `99ce318..2e7fd0a`. `bash
  test.sh` five suites — repository 6, plugin 39, worktrees 9, argus 121 (0 failed,
  0 skipped, 77.3 s), argus-ui 14 (0.29 s) — exit 0. Static analysis still none.
  `git diff --name-only c9f03ee..2e7fd0a -- tools/argus/src tools/argus-ui` → zero
  files, so the token gate and `/api/health` were not moved under the parked question.

  | criterion | R1 | R2 | R3 | R4 | R5 | R6 |
  | --- | ---: | ---: | ---: | ---: | ---: | ---: |
  | 6 — a second start does not create a second collector | 1 | 1 | 2 | 2 | 2 | 1 |
  | 14 — the documentation mirrors the result | 1 | 0 | 0 | 0 | 1 | 0 |
  | violates none | 5 | 1 | 0 | 0 | 2 | 0 |
  | every other criterion | 0 | 0 | 0 | 0 | 0 | 0 |

  Triage:
  - **Criterion 6, PARKED with the human, second parked state on the same criterion.**
    A listener that impersonates `/api/health` is attached instead of refused.
    Reproduction, run by the reviewer: a plain HTTP server answering `GET /api/health`
    with `{"ok":true,"instance":"abc123"}` and `GET /api/config` with 200 and body
    `"nope"`, with no collector behind it at all. `argus start --background --port
    <p>` prints "argus is already listening on …", the "not known" persistence
    sentence, "Nothing was started", and exits 0. Criterion 6's second branch asks
    for exit 1 saying the port holds something else; instead nothing is measuring
    afterwards while the caller has been told a collector is. An impostor answering
    `/api/config` with `{"persist":"/x"}` gets exit 0 and a named directory. This is
    the identification rule at `bin/argus.mjs:203-207`, where health alone decides
    "one of ours" — not the scalar branch, which only changed which wrong outcome the
    impostor gets. Not introduced by this change: present throughout the range, and
    rounds 1 to 5 did not raise it. Closing it needs a stronger identifying exchange,
    which is a design decision, so it parks with the same human decision as the token
    state.

- **Verified fixed in round 6:** the crash, checked by hand over seven body shapes,
  every one exit 0 with the port named and no runtime error; both documents, with the
  mechanism checked rather than trusted — `otelEnvFor` exports the token at
  `src/claude.mjs:261` and `resolveConfig` defaults from it at `src/config.mjs:123`,
  so a session without `eval "$(argus env)"` is exactly the "could not be read" case;
  the five task boxes; the stale hash. The two new `CLAUDE.md` paragraphs are accurate,
  and the four remaining wall-clock bounds in the project are all off the probe path.

- **Breakage notes for round 6:** Nothing machine-reads the new sentence — `git grep`
  at `2e7fd0a` finds it in `bin/argus.mjs` and the issue records only. The argus
  suite went 66.4 s to 77.3 s; the two new cases cost 5.24 s and 5.40 s, both far
  from the 25 s per-command bound, while the "never answers" case at ~15 s remains
  the near one. `inspectPort` still has one caller, so `probe.mjs`, `check`, the
  foreground `start` and the interface cannot be reached by this change.

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
