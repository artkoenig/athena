# Researcher handoff — argus timeline UI

## Increment 1 — content flows from the CLI through the collector to the JSON API

### Findings first: what a live capture proved

The two questions the issue put on this increment are answered by measurement,
not by reading. Claude Code 2.1.223 is installed in this environment, so I ran
three throwaway sessions against a throwaway collector
(`node tools/argus/bin/argus.mjs start --port <free> --persist <tmpdir>`) with the
content flags set, and read the persisted JSONL. Nothing was written inside the
repository. The captures are the exception to "the researcher runs nothing" and
they are the reason every number below is a fact rather than a guess.

**1. The body events are emittable. `OTEL_LOG_RAW_API_BODIES=1` is the flag.**
Both `claude_code.api_request_body` and `claude_code.api_response_body` arrived,
inline, over `http/protobuf`, and the collector ingested them unchanged. The
attributes that arrived on a request body event:

```
event.name=api_request_body, event.sequence=5, event.timestamp=<ISO>,
prompt.id=<uuid>, body=<string>, body_length="106251", body_truncated="true",
model="claude-sonnet-5", query_source="sdk"
```

and on a response body event the same plus `request_id="req_011Cdm…"`. Note
`body_length` and `body_truncated` arrive as **strings**, so they go through
`num()` / `bool()` from `claude.mjs`, never through `Number()` or truthiness.
`body_ref` appears only in `file:<dir>` mode, which we do not set; carry it
through as metadata and read no file.

**2. The 60 KB default truncation destroys the context view, and raising it
works.** The very first request body of a trivial one-prompt session was 106,251
characters and arrived cut to exactly 61,440 with `body_truncated="true"`. With
`CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH=2000000` set, the same body arrived whole
(106,163 chars, no `body_truncated`), decoded fine, and was stored and served.
So the env block sets that variable too: without it the "exact full text"
promise of the later context view is broken on the first request of every real
session.

**3. Subagent traffic on the body events is attributed by `query_source`, not by
`agent.name`.** Measured values: `"sdk"` for the main session under `-p`
(the docs give `"repl_main_thread"` for an interactive session, and `"compact"`
for compaction traffic), `"agent:builtin:general-purpose"` for a built-in
subagent, `"agent:custom:probe-bot"` for a user-defined one. The grammar is
`agent:<source>:<name>`. `agent.name` was **absent** from every body event in
every capture.

**4. `OTEL_LOG_TOOL_DETAILS=1` is what un-redacts the subagent name — and on the
body events it works better than on the documented ones.** For a user-defined
agent the sibling `claude_code.api_request` event carried the redacted
`query_source="agent:custom"` and `agent.name="custom"`, while the body events of
the same request carried the full `query_source="agent:custom:probe-bot"`. The
content events are therefore the *best* attributed records we have, not the
worst. This asymmetry looks like a CLI inconsistency and may disappear in a later
version, which is why the parsing rule below tolerates a missing name segment.

**5. Two concurrent subagents of the same type are distinguishable only by
`spanId`.** Two `probe-bot` agents launched in one message produced identical
`query_source` values and two distinct `spanId`s. Measured span placement of
body events:

- main-session body events carry the `spanId` of the `claude_code.interaction`
  span of that turn;
- a subagent's body events carry the `spanId` of *its* `claude_code.tool.execution`
  span, whose parent `claude_code.tool` span carries `subagent_type` and
  `tool_use_id`, and whose child `claude_code.llm_request` span carries a unique
  `agent_id`.

So a lane is a `spanId`, and a name is a label on it. This binds the later lane
increments: **do not group lanes by `query_source` alone** — that would merge two
parallel agents of one type into one lane. The content API below therefore
filters by `span` as well as by `agent`.

**6. Adjacent facts worth having, so nobody re-measures them.** With
`OTEL_LOG_USER_PROMPTS=1` alone the `claude_code.assistant_response` event
already carried its `response` text — the documented fallback of
`OTEL_LOG_ASSISTANT_RESPONSES` to `OTEL_LOG_USER_PROMPTS` holds, so that variable
is deliberately **not** added to the env block. `claude_code.tool_result` carried
`tool_input`, `tool_input_size_bytes` and `tool_result_size_bytes`. A
`claude_code.subagent_completed` event (attributes `agent_type`, `total_tokens`,
`total_tool_uses`, `duration_ms`) is emitted on the subagent's span when it ends —
unknown to `claude.mjs` today, and the natural end marker for a lane's lifetime
in a later increment. It is not part of this increment.

### Implementation plan

Five files change, all in `tools/argus`. Nothing in `tools/argus-ui` changes.

**A. `src/claude.mjs` — the env block and the content vocabulary.**

Add to the `env` object in `otelEnvFor()`, unconditionally (not inside the
`if (traces)` branch), as one commented group:

```js
OTEL_LOG_USER_PROMPTS: '1',
OTEL_LOG_TOOL_DETAILS: '1',
OTEL_LOG_TOOL_CONTENT: '1',
OTEL_LOG_RAW_API_BODIES: '1',
CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH: '2000000',
```

`OTEL_LOG_TOOL_CONTENT` only takes effect when tracing is on (it rides on span
events); it is still set with `--traces false`, where it is inert. Say that in
the comment. No opt-out option is added to `otelEnvFor()` — the issue decided
content is the default and an untested opt-out is surface for nothing.

Add, next to `attributionOf`:

- `export const CONTENT_EVENTS = new Set([EVENT.apiRequestBody, EVENT.apiResponseBody]);`
  — "content-bearing" means "carries a full API body". User prompts, assistant
  responses and tool results already flow through `/api/events` and now carry
  their text because of the flags; they need no new plumbing.
- `export function agentOf(attrs)` — derive the subagent label from
  `query_source`: return `null` when the value is missing or does not start with
  `agent:`; otherwise return the name segment (`agent:custom:probe-bot` →
  `probe-bot`), falling back to the source segment when the name is redacted away
  (`agent:custom` → `custom`) so a subagent record is never mistaken for main
  traffic. A name containing a colon keeps everything after the second colon.
- `export function isSubagentSource(attrs)` — `true` when `query_source` starts
  with `agent:`.
- `export function contentMetaOf(log)` — the metadata projection of a content
  record, body excluded:
  ```
  { seq, timeMs, sessionId, traceId, spanId, eventName,
    querySource, agent, isSubagent, model, requestId, promptId, eventSequence,
    bodyLength, bodyChars, truncated, bodyRef }
  ```
  with `bodyLength = num(attrs.body_length, 0)` (untruncated, string on the
  wire), `bodyChars` the length of the delivered `attrs.body` (0 when absent),
  `truncated = bool(attrs.body_truncated)`, `bodyRef = attrs.body_ref ?? null`,
  `promptId = attrs['prompt.id'] ?? null`,
  `eventSequence = num(attrs['event.sequence'], 0)`, `model`/`requestId`/
  `querySource` from the attributes or `null`.
- Two cases in `describeEvent` for the body events: a summary naming model,
  direction, size and `query_source` — and never the body text.

**B. `src/store.mjs` — index, bound, query.**

- New option in `DEFAULTS`: `maxContentChars: 128 * 1024 * 1024`. Chars, not
  bytes: the size is measured as `attrs.body.length`, which is what we can get
  in O(1).
- New state: `this.contentLogs = []` (references to the same log records, in
  ingest order) and `this.contentChars = 0`. Reset both in `clear()`.
- In `#applyLog`, when `CONTENT_EVENTS.has(log.eventName)`: push the record onto
  `contentLogs` and add its body length to `contentChars`. Content records stay
  in `this.logs` as well — they are ordinary log events that happen to be heavy.
- Keep the index consistent with every existing eviction path, or the byte
  counter leaks and the index serves records nobody can reach:
  - `#trim('logs', …)` must unindex what it removed, the way `#trim('spans', …)`
    calls `#unindexSpans`: add a `#unindexContent(removed)` that drops those
    records from `contentLogs` and subtracts their chars.
  - `#dropSession(id)` must drop that session's records from `contentLogs` and
    subtract their chars, alongside the existing `this.logs` filter.
- New `#trimContent()`, called from `#evict()`: while
  `contentChars > maxContentChars` **and** `contentLogs.length > 1`, shift the
  oldest content record, subtract its chars, and collect it; then remove the
  collected records from `this.logs` in one `filter` pass. The `> 1` guard is
  deliberate: a single body larger than the whole budget is still kept, because
  "the newest context" is the one thing this store must always be able to answer.
  Evicting whole records (rather than gutting `attrs.body` in place) is what
  keeps this consistent with the module's existing "bounded windows, records
  evicted whole" contract and leaves the persisted copy on disk untouched.
- Two queries, in the style of `queryEvents`:
  - `listContent({ sessionId = null, agent = null, mainOnly = false, spanId = null, eventName = null, limit = 200 })`
    — walk `contentLogs` newest-first, collect matches up to `limit`, reverse to
    ascending, and return `contentMetaOf(log)` for each. **No body.** `agent`
    matches the derived name exactly; `mainOnly` matches records with
    `isSubagent === false`; `spanId` matches exactly. Filters are ANDed.
  - `contentAt({ sessionId, agent = null, mainOnly = false, spanId = null, eventName = EVENT.apiRequestBody, atMs })`
    — the newest matching record with `timeMs <= atMs` (inclusive), returned as
    `{ ...contentMetaOf(log), body: attrs.body ?? null }`, or `null` when there
    is none.
- Add `contentRecords` to the per-session `counts` object in `newSession()` and
  bump it in `#applyLog`, so a session card can answer "does this recording carry
  content" without a second request. No test in any suite asserts a whole
  `counts` object, so the added key breaks nothing.

**C. `src/server.mjs` — two routes, and stop shipping bodies in the tail.**

- `GET /api/content` → `{ items: [ …contentMetaOf ] }`. Params: `session`,
  `agent`, `main=1`, `span`, `event`, `limit` (default 200, max 2000 via
  `intParam`). This is the cheap index the timeline will read.
- `GET /api/content/at` → `{ item: {…, body} | null }`, status 200 in both
  cases: scrubbing to a moment before the first request is a normal state, not
  an error. Params: `session` (**required** — answer `400 {error: 'session
  required'}` without it, since a nearest-in-time answer across sessions is
  meaningless), `agent`, `main=1`, `span`, `event` (default
  `claude_code.api_request_body`), `at` (epoch ms, default `Date.now()`, via
  `intParam`).
- `/api/events`: for records in `CONTENT_EVENTS`, the served item's `attrs` is a
  **copy without `body`**, plus `content: contentMetaOf(event)`. Copy, never
  delete on the stored record — the store keeps the body, `/api/content/at`
  serves it, and persistence has already written it. Without this the event tail
  would ship megabytes per poll the moment the flags are on, which is a
  regression this increment would otherwise introduce.
- `/api/config`: add `contentChars: store.options.maxContentChars` to `limits`.
  The `env` block gains the new variables for free through `otelEnvFor`.
- The SSE frame needs no change: it already projects named fields plus
  `describeEvent`, so no body can leak into it.

**D. `README.md` (in `tools/argus`) — four edits, no more.**

1. The sample env block under "Wiring up an agent" (around lines 71–83) gains the
   five new lines, so the page shows what `argus env` now prints.
2. "Sensitive data" (around lines 503–513) is rewritten: `argus env` now sets
   these by default, why (argus is a local measurement tool and the content *is*
   the measurement), and what that means — prompts, tool arguments and whole
   conversation bodies live in the collector's memory and, with `--persist`, in
   the gitignored measurement directory. Keep the sentence about
   `user.email`/`user.account_uuid`/`organization.id`.
3. The HTTP API table (around lines 536–548) gains `GET /api/content` and
   `GET /api/content/at`.
4. The "Limits" bullet about task ids (around lines 573–577) says the id "only
   `OTEL_LOG_TOOL_CONTENT=1` exports"; the flag is now on, so the sentence must
   say instead that the id rides in span events, which the store does not read —
   the limit stands, its reason is no longer "the flag is off".

`skills/argus/SKILL.md` needs no change: what a user types is unchanged.
`tools/argus/CLAUDE.md` needs no change: no new convention.

### Decisions I rejected

- **`OTEL_LOG_RAW_API_BODIES=file:<dir>`** (untruncated bodies as files) — the
  env block is a static string pasted into any environment, so it has no
  directory to name, and `body_ref` is a path in the *agent's* filesystem, which
  a collector behind a tunnel cannot open. Inline plus a raised content limit
  gets whole bodies over the wire, measured. `body_ref` is still carried as
  metadata for whoever sets file mode by hand.
- **`OTEL_LOG_ASSISTANT_RESPONSES=1`** — measured redundant (finding 6).
- **Gutting `attrs.body` in place instead of evicting the record** — it would
  mutate a record that `persist.mjs` may not have written yet (persistence
  subscribes to the change stream, which is emitted *after* `#evict()`), and it
  would leave half-records in the tail.
- **No memory bound at all** — with the flags on by default, a 50,000-record log
  window at ~100 KB per body is gigabytes. Bounding it is part of "the collector
  stores" and not gold plating.
- **A `--content` / `--no-content` CLI flag** — the issue decided content is the
  default; an opt-out is scope nobody asked for.
- **Parsing the body into a message list here** — that is the later
  context-inspector increment. This increment serves the body as it arrived.

### Module map

| Path | What it holds | Entry points that change |
| --- | --- | --- |
| `tools/argus/src/claude.mjs` | Claude Code domain constants and helpers | `otelEnvFor` (env block), `describeEvent`; new `CONTENT_EVENTS`, `agentOf`, `isSubagentSource`, `contentMetaOf` |
| `tools/argus/src/store.mjs` | In-memory store: ingest, aggregates, eviction, queries | `#applyLog`, `#evict`, `#trim`, `#dropSession`, `clear`, `DEFAULTS`, `newSession`; new `listContent`, `contentAt`, `#trimContent`, `#unindexContent` |
| `tools/argus/src/server.mjs` | OTLP ingest and the JSON API | `handleApi` (new `/api/content`, `/api/content/at`; changed `/api/events`, `/api/config`) |
| `tools/argus/bin/argus.mjs` | CLI; `env` renders `otelEnvFor` in four formats | nothing — it already prints whatever `otelEnvFor` returns |
| `tools/argus/README.md` | User-facing page | the four edits above |

Unchanged and worth knowing: `src/persist.mjs` writes every normalized record as
JSONL and replays it through the same `ingest`, so content records persist and
survive `--open` with no work; `src/otlp/decode.mjs` already carries arbitrary
string attributes of any length; `src/server.mjs` accepts request bodies up to
32 MB, comfortably above a 2 M-char body.

### Environment

- Node v22.22.2 at `/opt/node22/bin/node`; the package requires ≥ 20.11.
- `tools/argus` has **zero runtime and zero dev dependencies**; `npm install` is
  not needed and must not become needed. Tests are `node --test` over
  `test/*.test.mjs`.
- The test command for the package, from the repository root:
  `npm --prefix tools/argus test`.
- A single file, from the repository root:
  `node --test tools/argus/test/store.test.mjs` (same shape for the other files).
- **There is no linter and no formatter in this repository** — nothing to run,
  nothing to configure.
- `./test.sh` runs every suite in the repository. It is *not* on this
  increment's list: the closing increment owns it, and the suites outside
  `tools/argus` are untouched here.

### Test plan

Tests are needed. Framework: `node:test` with `node:assert/strict`, the only
thing these files use. Conventions to follow, taken from the files themselves:
a test name is a full lowercase sentence stating the fact
(`test('the env block carries the collector address under its own stable name', …)`),
fixtures are built by the small local factory helpers at the top of each file,
nothing is mocked beyond those fixtures, and — from `tools/argus/CLAUDE.md` — **a
message is asserted as an absence, never as a wording**: assert that a summary
does not contain the body text, never that it equals a sentence.

#### Criterion 1 — `argus env` (both formats) includes the content flags

| # | Case | File | Level |
| --- | --- | --- | --- |
| 1 | `otelEnvFor('http://localhost:4318')` sets `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_TOOL_DETAILS`, `OTEL_LOG_TOOL_CONTENT` and `OTEL_LOG_RAW_API_BODIES` to `'1'`, and `Number(env.CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH) > 61440` (the CLI's own default ceiling, which a real first request already exceeds) | `tools/argus/test/claude.test.mjs` | unit |
| 2 | The same five are present with `{ traces: false }` — content is not a tracing feature and must not ride in the traces branch | `tools/argus/test/claude.test.mjs` | unit |
| 3 | `node bin/argus.mjs env` (shell format, default) prints a line for each of the four `OTEL_LOG_*` flags | `tools/argus/test/config.test.mjs` | integration (spawns the CLI) |
| 4 | `node bin/argus.mjs env --format settings` nests the same four flags under `env` | `tools/argus/test/config.test.mjs` | integration |

Cases 3 and 4 are the "both formats" half of the criterion; use the existing
`execFile` + `promisify` harness in that file (see the case at line 95, which
already spawns `bin/argus.mjs env --format settings` and parses stdout). The
other two formats (`json`, `dotenv`) render the same object through the same
`renderEnv` switch and get no case of their own.

#### Criterion 2 — the collector stores and serves the content-bearing records

Store cases, in `tools/argus/test/store.test.mjs`, built with the existing
`log(eventName, attributes, timeMs)` helper (add a small `bodyLog(...)` wrapper
next to it if it helps; keep `session.id` in the attributes as the helpers do):

| # | Case | Expected |
| --- | --- | --- |
| 5 | An `claude_code.api_request_body` event is ingested, then `listContent({ sessionId })` is asked | one item, carrying `querySource`, `agent`, `isSubagent`, `model`, `bodyLength` as a **number** parsed from the string `"106251"`, `truncated === true` parsed from the string `"true"`, and **no `body` key at all** |
| 6 | Same store, `contentAt({ sessionId, atMs: <time of the record> })` | the item *with* `body`, the exact string that was ingested — an at-or-before boundary that is exactly equal counts as included |
| 7 | Two request bodies at t and t+1000, `contentAt` asked at t+500 | the earlier one; asked at t−1, `null` |
| 8 | A main record (`query_source: 'sdk'`) and a subagent record (`query_source: 'agent:custom:probe-bot'`) | `listContent({ agent: 'probe-bot' })` returns only the subagent record; `listContent({ mainOnly: true })` returns only the main record; `agentOf` on a redacted `'agent:custom'` returns `'custom'` and never `null` |
| 9 | Two records with the same `query_source: 'agent:custom:probe-bot'` and different `spanId` — the measured parallel-subagent case | `listContent({ spanId })` returns only that instance's record |
| 10 | `new TelemetryStore({ maxContentChars: <small> })`, then several bodies whose total exceeds it | the oldest content records are gone from `listContent` **and** from `queryEvents` (evicted whole), the newest survive, and a non-content log ingested alongside is untouched |
| 11 | Limit edge: a single body longer than `maxContentChars` on its own | still returned by `contentAt` — the newest context is never the thing that gets dropped |
| 12 | Bookkeeping edge: `clear()` on a store holding content, then ingest one body again | `listContent` returns exactly that one record (proves `contentChars` was reset, not left negative or inflated) |
| 13 | Session eviction: `new TelemetryStore({ maxSessions: 1 })`, a body in session A, then a record in session B | A's content is gone from `listContent`, B's is served |

Server cases, in `tools/argus/test/server.test.mjs`, using the existing
`withServer` helper and a logs payload built like `logsPayloadJson` (add a body
record to a copy of it — OTLP/JSON is the cheaper fixture and the decoder treats
both transports identically):

| # | Case | Expected |
| --- | --- | --- |
| 14 | POST an OTLP logs export containing an `api_request_body` record, then `GET /api/content?session=…` | 200, `items[0]` carries the metadata and has no `body` |
| 15 | `GET /api/content/at?session=…&at=<record time>` | 200, `item.body` is the full string |
| 16 | `GET /api/content/at?session=…&at=<before everything>` | 200 and `item === null`, **not** 404 |
| 17 | `GET /api/content/at` without `session` | 400 |
| 18 | `GET /api/events?session=…` for the same session, then `/api/content/at` again | the event item has no `attrs.body` but does carry its length in `content`, and the following `/api/content/at` still returns the whole body — proving the API projection did not mutate the stored record |
| 19 | `GET /api/config` | `env.OTEL_LOG_RAW_API_BODIES === '1'` (extend the existing `/api/config` case rather than adding a new one) |

One tail case, in `tools/argus/test/claude.test.mjs`:

| # | Case | Expected |
| --- | --- | --- |
| 20 | `describeEvent` on an `api_request_body` record whose body contains a recognisable secret string | the summary contains the size and does **not** contain that string — asserted as an absence, per the file's convention |

#### Deliberately untested, and why

- **Recordings made without the content flags** — out of contract by the issue's
  own decision; no case may pin any behaviour for them, in this increment or any
  later one.
- **`OTEL_LOG_RAW_API_BODIES=file:<dir>`** — not set by `argus env`; `body_ref`
  is passed through as an opaque string and no code reads the file.
- **The CLI's own truncation ceiling and redaction rules** — measured above, not
  ours to test; case 1 pins only that our value is above the default.
- **`json` and `dotenv` env formats** — same object through the same renderer as
  cases 3 and 4.
- **Persistence and replay of content records** — they travel the same
  `ingest`/JSONL path as every other log record; no new code, no new case.
- **`tools/argus-ui`** — untouched by this increment.

#### What counts as done

```
npm --prefix tools/argus test
```

That one command, from the repository root, is the whole list. It runs every
file this increment touches (claude, store, server, config) plus the rest of the
package, costs seconds, and needs no install. `./test.sh` and the `argus-ui`
suite are deliberately off the list: nothing outside `tools/argus` changes here,
and the closing increment owns the full-suite run.

#### What is already red

I did not run this list, not even as a baseline — a run buys no fact I could not
state from reading, and the first run belongs to whoever runs it downstream. I
expect nothing red before the change: no existing case asserts the shape of the
env block as a whole (the closest, `test/claude.test.mjs`, asserts the *absence*
of `OTEL_RESOURCE_ATTRIBUTES` and the presence of `UROBOROS_OBS_URL`, and
`test/config.test.mjs` asserts only that the `settings` format has exactly one
top-level key `env`), and no case asserts a whole `counts` or `limits` object, so
the added keys collide with nothing.

The only commands I ran were the three live captures described at the top of this
section, against a throwaway collector on a free port, and they exist because the
issue asked for two questions to be settled that no file in this repository can
answer.

## Increment 1 — Round 1

The reviewer raised one finding, and it is a coverage gap, not a defect: nothing
in the suite touches `claude_code.api_response_body`, and the `eventName` filter
of `listContent`/`contentAt` — reachable over the API only as `event=` — is never
passed a value at any level. So the whole of this round is new test cases plus the
two fixture helpers they need. I read `src/claude.mjs`, `src/store.mjs`,
`src/server.mjs` and the three test files again to settle exactly that, and I ran
nothing.

### Implementation plan

**No production file changes in this round.** The implementation already handles
response bodies on every path the finding names, and I confirmed each by reading:

- `CONTENT_EVENTS` holds both events (`src/claude.mjs:175`), so `#applyLog`
  indexes a response body (`src/store.mjs:484`) and `/api/events` strips its
  `body` (`src/server.mjs:240`);
- `contentMetaOf` maps `request_id` → `requestId` (`src/claude.mjs:223`), which is
  the attribute the live capture found on response bodies and only on them;
- `describeEvent` has its own `EVENT.apiResponseBody` case
  (`src/claude.mjs:286-287`) that names the size and never the text;
- `matchesContent` compares `log.eventName` exactly (`src/store.mjs:199`), and the
  routes pass `searchParams.get('event')` through — `null` means "no filter" on
  `/api/content`, and `?? EVENT.apiRequestBody` supplies the documented default on
  `/api/content/at` (`src/server.mjs:257`, `src/server.mjs:278`).

The new cases are therefore regression pins that hold against the code as it
stands: they are expected to pass on their first run, and their value is that
deleting `EVENT.apiResponseBody` from `CONTENT_EVENTS` — the reviewer's own
reproduction — turns three of them red at once. The implementer's work this round
is to run the list and fix only what it reports; if every case is green with no
production edit, that is the correct outcome and not a skipped correction.

Two fixture helpers change, both in test files, both additive so no existing case
is touched:

1. `tools/argus/test/store.test.mjs` — `bodyLog` (lines 38-52) builds a
   `claude_code.api_request_body` record. Add a sibling below it that reuses it:
   ```js
   // A response body as measured: same shape as a request body, plus request_id.
   const responseBodyLog = (attributes = {}, timeMs = Date.now()) => ({
     ...bodyLog({ request_id: 'req_011Cdm', ...attributes }, timeMs),
     eventName: 'claude_code.api_response_body',
   });
   ```
   Overriding a field on a spread of `bodyLog` is how the file already builds a
   variant record (`{ ...bodyLog(...), spanId: 'span-a' }`, line 539).
2. `tools/argus/test/server.test.mjs` — `contentLogsPayloadJson` (lines 73-103)
   hardcodes `eventName: 'claude_code.api_request_body'` at line 85. Read it from
   the overrides instead: `overrides.eventName ?? 'claude_code.api_request_body'`,
   and append a `request_id` attribute when `overrides.requestId` is given. Both
   defaults keep every existing caller byte-identical in behaviour.

### Decisions I rejected

- **Adding an `event=` case for `/api/content` on the request body as well.** The
  request path is already covered end to end by the round-0 cases; what is
  unverified is that the filter *discriminates*, and case 1 below proves that with
  both event names in one store.
- **Acting on the reviewer's two "beyond the criteria" notes** (span-carried tool
  content is unstripped and unbudgeted; `/api/events?search=` stringifies bodies).
  Neither violates a criterion of this increment and the reviewer filed neither as
  a correction. They stay out of this round; the span/search surfaces are not to
  be edited here.
- **A case for the `contentAt` ordering note** ("last ingested at or before"
  rather than "newest by timestamp"). The reviewer recorded it explicitly as not a
  finding and could construct no real out-of-order arrival; pinning the current
  order would freeze an accident.

### Module map

| Path | What it holds | What this round touches |
| --- | --- | --- |
| `tools/argus/test/store.test.mjs` | Store unit suite; fixture helpers `log`/`bodyLog` at the top | new `responseBodyLog` helper, two new cases |
| `tools/argus/test/server.test.mjs` | HTTP API suite over `withServer`; fixture `contentLogsPayloadJson` | `eventName`/`requestId` overrides in the fixture, two new cases |
| `tools/argus/test/claude.test.mjs` | Pure-function suite for `otelEnvFor`/`describeEvent` | one new case |
| `tools/argus/src/claude.mjs` | `CONTENT_EVENTS`, `contentMetaOf`, `describeEvent` | read only — no change expected |
| `tools/argus/src/store.mjs` | Content index, `listContent`, `contentAt` | read only — no change expected |
| `tools/argus/src/server.mjs` | `/api/content`, `/api/content/at`, `/api/events` | read only — no change expected |

### Environment

- Node v22.22.2 at `/opt/node22/bin/node`; the package requires ≥ 20.11.
- `tools/argus` has zero runtime and zero dev dependencies; `npm install` is not
  needed and must not become needed.
- Whole package, from the repository root: `npm --prefix tools/argus test`
  (`node --test test/*.test.mjs`).
- A single file, from the repository root:
  `node --test tools/argus/test/store.test.mjs`, and the same shape for
  `server.test.mjs` and `claude.test.mjs`.
- There is no linter and no formatter in this repository — nothing to run.
- `./test.sh` runs every suite in the repository and is not on this round's list;
  the closing increment owns it.

### Test plan

Tests are needed: the finding is that a case is missing, so the correction *is*
the case. Framework: `node:test` with `node:assert/strict`. Conventions, taken
from the files themselves: a test name is a full lowercase sentence stating the
fact; fixtures come from the local factory helpers at the top of each file;
nothing is mocked beyond those fixtures; every `assert` that could be ambiguous
carries a message argument saying what the fact is; and — from
`tools/argus/CLAUDE.md` — a message is asserted as an absence, never as a
wording.

#### The cases

| # | Case | File | Level |
| --- | --- | --- | --- |
| 1 | Ingest one `bodyLog()` and one `responseBodyLog({ 'prompt.id': 'p-resp' })` into one store. `listContent({ sessionId: SESSION, eventName: 'claude_code.api_response_body' })` returns exactly one item, whose `eventName` is the response event, whose `requestId` is `'req_011Cdm'`, and which has no `body` key. `listContent({ sessionId: SESSION, eventName: 'claude_code.api_request_body' })` returns exactly one item and it is the request record. Both together prove the response record is indexed *and* that the filter discriminates. | `tools/argus/test/store.test.mjs` | unit |
| 2 | Ingest `bodyLog({ body: '<request text>' }, t)` and `responseBodyLog({ body: '<response text>' }, t + 10)`. `contentAt({ sessionId: SESSION, atMs: t + 100, eventName: 'claude_code.api_response_body' })` returns the exact response text; `contentAt({ sessionId: SESSION, atMs: t + 100 })` with no `eventName` returns the exact request text — the documented default, and proof the newer response record does not bleed into it. | `tools/argus/test/store.test.mjs` | unit |
| 3 | POST `contentLogsPayloadJson('s-response', { eventName: 'claude_code.api_response_body', body: <a string distinct from the fixture default>, requestId: 'req_011Cdm' })` to `/v1/logs`. Then: `GET /api/content?session=s-response&event=claude_code.api_response_body` is 200 with one item carrying that `eventName` and no `body` key; `GET /api/content/at?session=s-response&at=<Number(T0/1000000n)>&event=claude_code.api_response_body` is 200 and `item.body` is that exact string; `GET /api/content/at?session=s-response&at=<same>` without `event=` is 200 with `item === null`, because the session holds no request body and the route defaults to that event. | `tools/argus/test/server.test.mjs` | integration (HTTP over `withServer`) |
| 4 | POST the same fixture to its own session `s-response-tail`, then `GET /api/events?session=s-response-tail`: the single item's `attrs` has no `body` key, `item.content` is present, and `item.content.bodyChars` equals the posted body's length. A response body must not ship through the polled tail any more than a request body does. | `tools/argus/test/server.test.mjs` | integration |
| 5 | `describeEvent` on a `claude_code.api_response_body` record whose body contains a recognisable secret string returns a summary that does not contain that string and does match the body length — the same absence assertion the request-body case at line 71 makes, for the other event. | `tools/argus/test/claude.test.mjs` | unit |

Cases 1, 3 and 4 are the three the reviewer's reproduction turns red: removing
`EVENT.apiResponseBody` from `CONTENT_EVENTS` stops the record being indexed
(1, 3) and stops the tail stripping its body (4).

#### Deliberately untested, and why

- **The `event=` parameter with a value that is not a content event** (say
  `claude_code.user_prompt`): it can only ever match nothing, since the index holds
  content records alone, and no route promises otherwise.
- **`limit`, `agent`, `main` and `span` on a response body**: those filters are
  shared code (`matchesContent`), already pinned on the request body, and are not
  event-specific.
- **Recordings made without the content flags**: out of contract by the issue's
  own decision — no case in this round or any later one may pin behaviour for
  them.
- **The two "beyond the criteria" notes in the review** (span-carried tool content,
  search latency): not findings, not corrections, and no case is written for
  either.
- **Everything the round-0 plan covered**: it is already in the suite and is not
  re-specified here; this section adds cases and removes none.

#### What counts as done

```
npm --prefix tools/argus test
```

That one command, from the repository root, is the whole list. It runs the three
files this round touches plus the rest of the package, costs seconds, and needs
no install. `./test.sh` and the `argus-ui` suite are off the list: nothing outside
`tools/argus/test` changes here.

#### What is already red

I did not run the list, not once and not as a baseline. I expect nothing red
before the change and nothing red after it: the five cases assert behaviour the
current implementation already has, and the two fixture edits are additive with
defaults that leave every existing caller unchanged.

## Increment 2 — the timeline is the central session view, one lane per agent

Everything below changes `tools/argus-ui` only. The collector is not touched:
increment 1 already serves every fact a lane needs, and adding an endpoint for
data the UI can derive in one request would be a second implementation of the
same grouping. I ran no command except `node --version` (v22.22.2 at
`/opt/node22/bin/node`) — no capture was needed, because the two questions this
increment turns on are answered by increment 1's measurements and by reading the
collector's query code.

### Finding: what marks a lane's start and end

The backlog asks this increment to settle it. **A lane is a span, and its start
and end are the first and last content record carrying that span**, read off
`GET /api/content?session=<id>&limit=2000`. The main lane is the exception: it
spans the session's own `firstSeenMs`…`lastSeenMs` from
`GET /api/sessions/<id>`, because the main session exists before its first API
request and after its last one.

Why not the alternatives:

- **Spans (`claude_code.tool` with `subagent_type`, or `tool.execution`)** give
  the exact tool-call lifetime, but the collector serves spans only through
  `GET /api/traces/<traceId>`, one request per trace, and a session has one trace
  per interaction. That is N requests and N whole span trees per refresh for two
  timestamps per lane, against one request for the content index. The store has
  no per-session span query and adding one is collector work this increment does
  not need.
- **`claude_code.subagent_completed`** — increment 1 measured that the CLI emits
  it (attributes `agent_type`, `total_tokens`, `total_tool_uses`, `duration_ms`)
  but did not record whether it arrives as a log record (and so reaches
  `/api/events` today, unnamed by `claude.mjs` but stored like any other log) or
  as a span event (in which case only the trace routes carry it). Nothing in this
  repository answers that, and settling it costs a live capture. The plan does not
  depend on it, so the question stays open: a later increment that wants an exact
  lane end must measure it first.

Consequences to know, and to accept rather than paper over:

- A lane's end is its last API body, so the agent's last few seconds — handing
  the final result back through the Task tool — fall outside the bar.
- A subagent that never called the model gets no lane. This does not occur: a
  Task subagent's first act is a model call, which is a request body.
- `/api/content` returns the newest 2000 records when a session has more (the
  store walks newest-first, then reverses). A session past that cap loses its
  oldest lanes, the same window every other list in this UI has.
- Increment 1 measured that two concurrent subagents of one type share a
  `query_source` and differ only by `spanId`. Keying the lane on the span is
  therefore not a detail: it is the whole of criterion 3.

### Implementation plan

Two new files under `public/`, three edited, plus the README. `src/` and `bin/`
are untouched.

**A. `public/format.js` — new. The formatting section, moved verbatim.**

Cut `public/app.js` lines 30–88 (the block between the `formatting` banner
comment and the `api` banner comment: `esc`, `fmtNum`, `fmtCost`, `fmtDur`,
`fmtClock`, `fmtAgo`, `isLive`, `shortId`) into this file and `export` each one.
No body changes. `app.js` gains
`import { esc, fmtNum, fmtCost, fmtDur, fmtClock, fmtAgo, isLive, shortId } from './format.js';`
at the top. The move exists so `timeline.js` can escape and format without a
second copy of `esc`; it is a move, not a rewrite, and nothing else about those
functions changes.

**B. `public/timeline.js` — new. The timeline view: pure functions, no DOM.**

It imports `esc`, `fmtClock` and `fmtDur` from `./format.js` and touches
`document`, `fetch` and `location` nowhere — that is what makes it testable under
`node --test`. Exports:

- `buildLanes({ session, content })` → `{ startMs, endMs, durationMs, lanes }`.
  `session` is the `/api/sessions/<id>` payload, `content` the `items` array of
  `/api/content`. Algorithm, exactly:
  1. `records` = the entries of `content` with a finite `timeMs > 0`.
  2. Main lane: `startMs` is `session.firstSeenMs` when it is a finite number
     above 0, otherwise the earliest main record's `timeMs`, otherwise 0; `endMs`
     is the largest of `session.lastSeenMs`, that `startMs`, and the latest main
     record's `timeMs`. A main record is one with `isSubagent !== true`.
  3. Agent lanes: for every record with `isSubagent === true`, the key is
     `` `agent:${record.spanId ?? ''}:${record.agent ?? ''}` `` — one rule, no
     branch, so a record with no span groups by name and a record with a span
     never merges with another span. Accumulate `startMs` = min `timeMs`,
     `endMs` = max `timeMs`, `records` = count.
  4. Sort agent lanes by `startMs`, ties broken by `key`, so the order is
     deterministic whatever order the API returned.
  5. Labels: `record.agent || 'subagent'`. When two or more lanes end up with the
     same label, suffix each with ` #1`, ` #2` … in that sorted order, so two
     concurrent `general-purpose` agents are told apart on screen and not only in
     the DOM.
  6. Window: `startMs` = the smallest lane start, `endMs` = the largest lane end,
     `durationMs = Math.max(0, endMs - startMs)`.
  7. Return the main lane first, then the agent lanes. Each lane is
     `{ key, kind: 'main' | 'agent', agent, spanId, label, startMs, endMs, records }`;
     the main lane has `key: 'main'`, `agent: null`, `spanId: null`,
     `label: 'main session'`.
  Never use truthiness on `isSubagent` or `agent`: the API sends real booleans and
  a `null` agent, and `agent` may legitimately be the string `custom`.
- `laneGeometry(lane, window)` → `{ leftPct, widthPct }`, with
  `span = Math.max(1, window.endMs - window.startMs)`,
  `leftPct` = `(lane.startMs - window.startMs) / span * 100` clamped to 0…100,
  and `widthPct` = `(lane.endMs - lane.startMs) / span * 100` raised to at least
  `MIN_LANE_WIDTH_PCT = 0.6` and then capped at `Math.max(0.6, 100 - leftPct)`.
  The `Math.max(1, …)` is what keeps a session with one instant of data from
  dividing by zero and painting `NaN%` into the style attribute.
- `renderTimeline({ window, lanes })` → the markup, as a string like every other
  renderer in this project:
  ```html
  <div class="panel timeline-panel">
    <div class="timeline">
      <div class="timeline-axis"><span></span><span class="axis-ticks">…5 ticks…</span></div>
      <div class="lane" data-lane="main" data-kind="main">
        <span class="lane-label" title="main session">main session</span>
        <span class="lane-track">
          <span class="lane-bar" data-kind="main" style="left:0.000%;width:100.000%"></span>
        </span>
        <span class="lane-meta">1m 20s</span>
      </div>
      …one .lane per agent lane, data-lane="<key>" data-kind="agent"…
    </div>
  </div>
  ```
  Ticks are the waterfall's pattern (`0, .25, .5, .75, 1` of the window, absolute
  positions in percent, labelled with `fmtClock` of the wall time at that
  fraction). `lane-meta` is `fmtDur(lane.endMs - lane.startMs)`. Every label and
  key goes through `esc`.
- `DETAIL_VIEWS` — the six existing views, moved from `app.js`'s `TABS` constant
  unchanged: `overview/Overview`, `todos/Tasks`, `traces/Traces`,
  `events/Events`, `metrics/Metrics`, `raw/Attributes`.
- `renderDetailViews({ selected, counts })` → the existing `.tabs` / `.tab`
  markup, wrapped in `<nav class="tabs" role="tablist" aria-label="Technical
  views">`, with `aria-selected="true"` on the view whose id equals `selected`
  and `"false"` on every other — so `selected: null` renders every view reachable
  and none open.

**C. `public/app.js` — the landing view, the loader, the wiring, the advisories.**

- State: `tab: null` instead of `'overview'`; add `content: []`. `null` is what
  makes opening a session land on the timeline with no technical view open.
- `TABS` and its inline nav markup in `renderDetail` are gone, replaced by
  `renderDetailViews` from the new module.
- `renderDetail` renders, in this order: the existing `.detail-head`, then
  `renderTimeline(buildLanes({ session: state.session, content: state.content }))`,
  then `renderDetailViews({ selected: state.tab, counts })`, then
  `<div id="tab-body"></div>`. The timeline is not behind a tab and is never
  hidden; the technical views hang below it. That is the whole of "central, and
  the others subordinate to it".
- `renderTabBody` gains a `state.tab === null` case that writes the empty string,
  and keeps `overview` as the `default` branch for when a view is selected.
- New `loadTimeline()`: when a session is selected, `state.content = (await
  api('/api/content', { session: state.selectedSessionId, limit: 2000 })).items`,
  and `[]` on a rejection or with no session, so a failing content request costs
  the lanes and not the page. Call it from `refresh()` inside the existing `try`,
  after `loadSession()` and before `loadTabData()`.
- `selectSession` resets `state.tab = null` and `state.content = []` alongside the
  resets it already does, so every session opens on the timeline.
- The tab click handler toggles: `state.tab = state.tab === tab.dataset.tab ? null
  : tab.dataset.tab`, so a reader can close a technical view and be back at the
  timeline alone.
- Advisories for flags `argus env` now sets, all four sites (criterion 4):
  - `renderTodosTab`, the `todos.callsSeen > 0` placeholder: drop the
    `OTEL_LOG_TOOL_DETAILS=1` sentence. The branch stays — it now means "the calls
    carried no parameters we could read" and says only that.
  - `renderTracesTab`, the no-spans placeholder: drop
    `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1` and `OTEL_TRACES_EXPORTER=otlp`; say
    that spans come with the environment block under Setup and that a session
    recorded without it has none.
  - `renderEmptyState`, the muted paragraph under the env block: drop the
    `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1` mention; say the block already carries
    what spans and content need, and keep the sentence about 1s export intervals.
  - `index.html`, the static empty state's muted paragraph: the same edit, same
    wording. It is markup the page replaces on first render, but it is what a
    reader sees before the first response arrives.
  Left alone deliberately: `OTEL_RESOURCE_ATTRIBUTES` in the setup dialog and
  `CLAUDE_CODE_OTEL_DIAG_STDERR=1` under the SDK block. `argus env` sets neither,
  so advising them is still true.

**D. `public/styles.css` — lane styles, appended near the waterfall block.**

`.timeline` (with its own `--label-w`, narrower than the waterfall's 320px),
`.timeline-axis` and `.lane` reuse the waterfall's two-column grid;
`.lane-track` is the `.span-track` pattern; `.lane-bar[data-kind="main"]` uses
`var(--accent)` and `[data-kind="agent"]` `var(--violet)`, both already defined
in `:root` and in the light-mode block. No new custom property, no new colour.

**E. `README.md` (in `tools/argus-ui`) — two edits.**

"What it shows" gains **Timeline** as its first bullet after Sessions ("one lane
for the main session and one per subagent, each spanning that agent's lifetime;
the views below it are reachable from there"), and the **Events** bullet loses
the word "timeline" so the two names stop colliding ("filterable event tail,
every row expandable"). `CLAUDE.md` needs no change: no convention changes.

### Decisions I rejected

- **A `timeline` tab next to the others.** The issue's decision 2 rejects "an
  additional tab" by name; a first tab among equals is exactly that, and it makes
  the timeline subordinate to the tab strip rather than the other way round.
- **Deleting the technical views.** The same decision keeps them reachable.
- **Building lanes in the collector** (a `/api/agents` or `/api/lanes` route).
  Everything the grouping needs is already on the content index, one request; a
  collector route would put the same `spanId`-keyed grouping in a second place and
  the UI would still need the geometry. Kept in reserve for the day a session
  outgrows the 2000-record window.
- **Lanes from spans.** Exact lifetimes, N requests per refresh, and it fails
  entirely when traces are off. Recorded above as the finding.
- **Grouping lanes by `agent` name.** It merges two concurrent same-type agents
  into one lane, which is precisely what criterion 3 forbids.
- **A DOM test harness (jsdom or similar).** A dependency, and this project's
  first rule is zero of them. The way out is the one taken above: the derivation
  and the markup are pure functions in a module `node --test` can import, and only
  the wiring in `app.js` stays unpinned.
- **Scrub cursor, live-mode control, activity blocks, context curves, per-lane
  selection.** All named as later increments; a lane here is a bar with a label.
- **Touching `/api/events?search=` or the span-carried tool content** — the two
  notes the round-1 reviewer filed as "beyond the criteria". Still beyond them.

### Module map

| Path | What it holds | Entry points |
| --- | --- | --- |
| `tools/argus-ui/public/format.js` | **New.** `esc`, `fmtNum`, `fmtCost`, `fmtDur`, `fmtClock`, `fmtAgo`, `isLive`, `shortId`, moved verbatim out of `app.js` | all exports; no behaviour change |
| `tools/argus-ui/public/timeline.js` | **New.** Lane derivation and the timeline markup; pure, no DOM | `buildLanes`, `laneGeometry`, `renderTimeline`, `DETAIL_VIEWS`, `renderDetailViews` |
| `tools/argus-ui/public/app.js` | The page: state, fetching, rendering, wiring | `state` defaults, `renderDetail`, `renderTabBody`, new `loadTimeline`, `refresh`, `selectSession`, the click handler, `renderTodosTab`, `renderTracesTab`, `renderEmptyState` |
| `tools/argus-ui/public/index.html` | The shell: topbar, sidebar, detail pane, setup dialog | the static empty state's muted paragraph |
| `tools/argus-ui/public/styles.css` | Every style; dark-first with a light-mode `:root` | new `.timeline*` / `.lane*` rules |
| `tools/argus-ui/README.md` | User-facing page | "What it shows" |
| `tools/argus-ui/src/server.mjs` | Static files plus a proxy for `/api/*` and `/v1/*` | none — it serves any file under `public/`, so the new modules need no route |

Facts about the collector's API that the plan rests on, so nobody has to open
that project: `GET /api/sessions/<id>` returns `id`, `name`, `firstSeenMs`,
`lastSeenMs`, `durationMs`, `counts`, `traceCount`, `traces[]`;
`GET /api/content?session=&agent=&main=1&span=&event=&limit=` returns
`{ items: [...] }` ascending by time, each item
`{ seq, timeMs, sessionId, traceId, spanId, eventName, querySource, agent,
isSubagent, model, requestId, promptId, eventSequence, bodyLength, bodyChars,
truncated, bodyRef }` and never a body; `limit` is capped at 2000 and the walk is
newest-first, so an over-long session yields its newest 2000 records. `agent` is
the subagent's name or `null` for main traffic, `isSubagent` a real boolean.

### Environment

- Node v22.22.2 at `/opt/node22/bin/node`, on the `PATH`; the package requires
  ≥ 20.11.
- `tools/argus-ui` has **zero runtime and zero dev dependencies**; `npm install`
  is not needed and must not become needed. Adding a dependency is not a coding
  decision — it goes to the human.
- Whole package, from the repository root: `npm --prefix tools/argus-ui test`
  (`node --test "test/*.test.mjs"`).
- A single file, from the repository root:
  `node --test tools/argus-ui/test/timeline.test.mjs`, same shape for
  `page.test.mjs`, `server.test.mjs`, `config.test.mjs`, `independence.test.mjs`.
- `public/*.js` is importable by `node --test` because the package is
  `"type": "module"`: `import { buildLanes } from '../public/timeline.js';` works
  with no loader flag.
- **There is no linter and no formatter in this repository** — nothing to run,
  nothing to configure.
- `./test.sh` runs every suite in the repository. It is **not** on this
  increment's list: the closing increment (`tool-usage`) owns it, and nothing
  outside `tools/argus-ui` changes here.

### Test plan

Tests are needed. Framework: `node:test` with `node:assert/strict`, the only
thing this project uses. Conventions, taken from the files themselves: a test
name is a full lowercase sentence stating the fact ('the interface serves the
page on its own port'); fixtures are local factory helpers at the top of the file
(`startFakeCollector`, `withUi` in `server.test.mjs`; `walk` in
`independence.test.mjs`); nothing is mocked beyond those; an assertion that could
be read two ways carries a message saying what the fact is; and — from
`tools/argus/CLAUDE.md`, which this project follows in style — a message is
asserted as an absence, never as a wording.

Two new files, plus two additions to an existing one:

- `tools/argus-ui/test/timeline.test.mjs` — **new**, unit level, imports
  `../public/timeline.js`. Two local factories at the top:
  `const session = (over = {}) => ({ id: 's1', name: null, firstSeenMs: 1000, lastSeenMs: 5000, ...over });`
  and
  `const record = (over = {}) => ({ seq: 1, timeMs: 1000, sessionId: 's1', traceId: 't', spanId: '', eventName: 'claude_code.api_request_body', querySource: 'sdk', agent: null, isSubagent: false, model: 'claude-sonnet-5', bodyLength: 10, bodyChars: 10, truncated: false, ...over });`
  Every case builds its input from those two and nothing else.
- `tools/argus-ui/test/page.test.mjs` — **new**, source level, reads the files
  under `public/` with `fs.readFileSync` and a `walk` helper copied in the shape
  of `independence.test.mjs`'s.
- `tools/argus-ui/test/independence.test.mjs` — **edited**: add
  `'public/timeline.js'` and `'public/format.js'` to the existence list in the
  first case and to the `owned` list in the second, so the new modules are inside
  the import scan rather than beside it.

#### Criterion 1 — opening a session lands on the timeline, the technical views stay reachable and subordinate

| # | Case | File | Level |
| --- | --- | --- | --- |
| 1 | `DETAIL_VIEWS` carries exactly the six ids `overview`, `todos`, `traces`, `events`, `metrics`, `raw`, each with a non-empty label — the timeline took the landing spot and dropped none of them | `test/timeline.test.mjs` | unit |
| 2 | `renderDetailViews({ selected: null })` renders one `data-tab="<id>"` button per entry of `DETAIL_VIEWS` and no `aria-selected="true"` anywhere: a freshly opened session offers every technical view and opens none | `test/timeline.test.mjs` | unit |
| 3 | `renderDetailViews({ selected: 'events' })` marks exactly one button selected and it is the events one (assert the count of `aria-selected="true"` is 1 and that the events button carries it) | `test/timeline.test.mjs` | unit |
| 4 | `public/app.js` imports `./timeline.js` and `public/index.html` loads `/app.js` as a module — the timeline module is reached by the page and is not a tested island | `test/page.test.mjs` | source |

Case 4 is deliberately the only source-level claim about `app.js`'s structure.

#### Criterion 2 — one lane for the main session, one per subagent, each spanning its lifetime

| # | Case | Expected | File |
| --- | --- | --- | --- |
| 5 | `buildLanes({ session: session(), content: [] })` | exactly one lane; `kind === 'main'`, `key === 'main'`, `startMs === 1000`, `endMs === 5000`, `label === 'main session'`; `window.startMs`/`window.endMs` are 1000/5000 | `test/timeline.test.mjs` |
| 6 | A main record plus three subagent records for one span (`spanId: 'sp-a'`, `agent: 'code-reviewer'`, `isSubagent: true`) at 2000, 2500, 3000 | two lanes; the main lane is first and still spans 1000…5000; the agent lane has `startMs === 2000`, `endMs === 3000`, `label === 'code-reviewer'`, `spanId === 'sp-a'`, `records === 3` | `test/timeline.test.mjs` |
| 7 | The same records passed newest-first | `deepEqual` to the result of case 6 — the lanes do not depend on the order the API returned | `test/timeline.test.mjs` |
| 8 | Two subagent records on one span at 6000 and 7000, i.e. past `session.lastSeenMs` | `window.endMs === 7000`; the main lane still ends at 5000 — the window covers every lane, and the main lane is not stretched to cover a subagent | `test/timeline.test.mjs` |
| 9 | Records with `timeMs: 0` (and one with a missing `timeMs`) mixed into case 6's input | identical lanes to case 6 — a record with no usable time widens nothing | `test/timeline.test.mjs` |
| 10 | `laneGeometry` for a lane covering the whole window, and for one covering the second half (window 0…1000, lane 500…1000) | `{ leftPct: 0, widthPct: 100 }` and `{ leftPct: 50, widthPct: 50 }` — exact, the arithmetic is exact at these values | `test/timeline.test.mjs` |
| 11 | `laneGeometry` for a single-record lane (`startMs === endMs`) inside a real window | `widthPct >= 0.6` and `leftPct + widthPct <= 100`: an instant is still a visible bar and never overflows the track | `test/timeline.test.mjs` |
| 12 | `laneGeometry` against a zero-length window (`startMs === endMs`) | both numbers are finite (`Number.isFinite`) and inside 0…100 — the division-by-zero edge of a session with one instant of data | `test/timeline.test.mjs` |
| 13 | `renderTimeline(buildLanes(…))` for case 6's input | the markup carries exactly two `data-lane="` occurrences, one `data-lane="main"`, one whose value contains `sp-a`, and each bar's `style` carries a `left:` and a `width:` with no `NaN` | `test/timeline.test.mjs` |
| 14 | A subagent whose `agent` is `<img src=x onerror=alert(1)>` | `renderTimeline` output contains no `<img` and does contain the escaped form — every label goes through `esc` | `test/timeline.test.mjs` |

#### Criterion 3 — two concurrent subagents of one type get two lanes

| # | Case | Expected | File |
| --- | --- | --- | --- |
| 15 | Four subagent records, all `agent: 'general-purpose'`, two on `spanId: 'sp-a'` (2000, 3000) and two on `spanId: 'sp-b'` (2200, 3400) — the overlapping same-type pair increment 1 measured | three lanes (main plus two); the two agent lanes have different `key`s carrying `sp-a` and `sp-b`, bounds 2000…3000 and 2200…3400, and labels `general-purpose #1` and `general-purpose #2` so they are told apart on screen | `test/timeline.test.mjs` |
| 16 | The same four records through `renderTimeline` | three `data-lane="` occurrences, and both `sp-a` and `sp-b` appear — the merge is impossible in the markup too | `test/timeline.test.mjs` |
| 17 | Two records on one span, same agent, at 2000 and 3000 | exactly two lanes: a lane is a span, not a record, and one agent is not split per request | `test/timeline.test.mjs` |
| 18 | Two subagent records with different `agent` names on different spans | two agent lanes, labels `alpha` and `beta` with **no** `#1`/`#2` suffix — the disambiguation fires only where labels actually collide | `test/timeline.test.mjs` |

#### Criterion 4 — the UI no longer advises a flag `argus env` sets

| # | Case | Expected | File |
| --- | --- | --- | --- |
| 19 | Walk every file under `public/` and assert none of them contains any of these names: `CLAUDE_CODE_ENABLE_TELEMETRY`, `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA`, `CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH`, `OTEL_METRICS_EXPORTER`, `OTEL_LOGS_EXPORTER`, `OTEL_TRACES_EXPORTER`, `OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_TOOL_DETAILS`, `OTEL_LOG_TOOL_CONTENT`, `OTEL_LOG_RAW_API_BODIES`, `OTEL_METRIC_EXPORT_INTERVAL`, `OTEL_LOGS_EXPORT_INTERVAL`, `OTEL_TRACES_EXPORT_INTERVAL` — the failure message names the file and the flag | `test/page.test.mjs` | source |
| 20 | The same walk finds `OTEL_RESOURCE_ATTRIBUTES` and `CLAUDE_CODE_OTEL_DIAG_STDERR` still present in `public/app.js` | advice about flags `argus env` does *not* set is not collateral damage of case 19 | `test/page.test.mjs` | source |

Case 19 is an absence assertion by design: the page still shows every flag,
because the setup dialog and the empty state render the block that
`GET /api/config` hands them at runtime. What may not be there is a flag name
written into the markup as something the reader should go and set. That is why
the rule is "no such name in `public/`" rather than a match on a sentence — a
wording test would fail on a better sentence, and this one only fails on the
thing the criterion forbids.

Case 19 also spans `styles.css` and `index.html` for free, which is where two of
the four advisory sites live.

#### Deliberately untested, and why

- **That `renderDetail` puts the timeline above the nav, and that `state.tab`
  starts as `null`.** Both are DOM wiring in `app.js`, which this project has no
  harness for and will not grow one for (jsdom is a dependency, and the project's
  first rule is zero). Cases 1–4 pin what the landing view is made of and that the
  module is wired in; the arrangement itself is a reading, and the review is
  where it is read.
- **Whether a lane bar is visually where it should be.** Geometry is pinned as
  numbers (cases 10–12); pixels are not a thing `node --test` can see.
- **The `/api/content` fetch itself** — `loadTimeline` is three lines of the same
  `api()` helper every other loader uses, and `server.test.mjs` already proves the
  proxy forwards `/api/*` with its query string intact.
- **The 2000-record window.** It is the collector's cap, pinned in that project's
  suite; re-asserting it here would pin someone else's number.
- **A subagent record with an empty `spanId`.** `argus env` sets the trace flags,
  so under contract every content record carries a span; the key rule handles the
  case without a branch and nothing promises behaviour for it.
- **Recordings made without the content flags** — out of contract by the issue's
  own decision; no case in this increment may pin any behaviour for them.
- **`format.js`** — a verbatim move of functions no case asserts today; moving
  code is not a reason to grow coverage for it.
- **Everything increment 1 covered** — untouched here, and `tools/argus` is not on
  this increment's command list.

#### What counts as done

```
npm --prefix tools/argus-ui test
```

That one command, from the repository root, is the whole list. It runs the two
new files, the edited `independence.test.mjs`, and the rest of the package,
costs seconds, and needs no install. `tools/argus` and `./test.sh` are off the
list on purpose: nothing outside `tools/argus-ui` changes in this increment, and
the closing increment owns the full-suite run.

#### What is already red

I did not run the list, not once and not as a baseline. From reading, I expect
`independence.test.mjs` to be the only existing case this increment can turn red,
and only if `public/timeline.js` or `public/format.js` imports something outside
the project — which the plan does not do. No existing case asserts anything about
`state.tab`, the tab strip, or the text of any placeholder, so the four advisory
edits and the new landing view collide with nothing already in the suite.

## Increment 2 — Round 1

The reviewer filed one finding, and it is a coverage gap, not a behaviour bug:
criterion 1's landing behaviour is correct in `public/app.js` but nothing in the
suite fails when it is removed. **This round changes no production file.** The
whole correction is three new cases in `tools/argus-ui/test/page.test.mjs`,
plus the helper they need.

I ran no command this round. Reading `public/app.js`, `public/timeline.js` and
`test/page.test.mjs` answered every question the finding raises; a run would
have bought no fact I could not state from the source.

### What the finding asks for, and what already holds

The reviewer's reproduction is two edits to `public/app.js`: put `tab: 'overview'`
back into the state literal (line 23) and delete the
`${renderTimeline(buildLanes({ session, content: state.content }))}` line from
`renderDetail` (line 165). Both are green today. So the three facts a case has to
pin are exactly:

1. The initial state opens no technical view — `tab: null` in the `const state = {`
   literal, and no string default.
2. `selectSession` returns to that state — `state.tab = null` in its body, so a
   second session opens on the timeline whatever view the first one was left on.
3. `renderDetail` renders the timeline *above* the technical views — `renderTimeline(`
   appears in its body before `renderDetailViews(`, which appears before the
   `id="tab-body"` container.

All three are true in the current `public/app.js` (lines 23, 913, 165/167/169).
Nothing has to move for the cases to pass.

### Implementation plan

**Production: nothing.** No file under `tools/argus-ui/public/`, `src/` or `bin/`
changes, and neither does `tools/argus`. If the suite is green after the new
cases land, this increment is done.

Two things the reviewer raised that are deliberately not acted on, so nobody
picks them up as work:

- **The empty-`spanId` merge** the reviewer recorded under "beyond the criteria".
  It is an observation, not a finding; `argus env` sets the trace flags, so under
  contract every content record carries a span. No code and no test changes for it.
- **`renderTimeline`'s prose signature**, which the test-author flagged as loose.
  The shipped `renderTimeline(view)` takes the flat result of `buildLanes` and the
  call site composes them directly, which is what the earlier plan's own wiring
  line and cases assumed. The prose was imprecise; the code is right. No change.

### Technique, and what I rejected

**Chosen: source-level assertions over `public/app.js`, scoped to one function
body at a time.** `app.js` reads `location` at module scope, so no test can import
it, and `test/page.test.mjs` already answers exactly this class of question by
reading the file (its existing three cases do nothing else). Scoping each
assertion to a sliced function body is what keeps it from matching a coincidence
elsewhere in a 1074-line file.

Rejected:

- **A DOM harness (jsdom or similar).** A dependency, and `tools/argus-ui/CLAUDE.md`
  makes zero dependencies the project's first rule. Adding one is a decision for
  the human, not for a correction round.
- **Refactoring `renderDetail`'s composition into a pure `renderSessionView` in
  `timeline.js` so the ordering could be unit-tested.** It would move the ordering
  under test, but it would leave facts 1 and 2 (the state literal, `selectSession`)
  still only checkable at source level, so it buys one of three facts at the price
  of reshaping working production code in a correction round.
- **A whole-file regex for `tab: null`.** `state.tab = null` occurs in
  `selectSession` too; an unscoped match would pass with the state literal broken.
  Hence the slicing helper.
- **Asserting the exact argument of `renderTimeline(...)`.** Pinning the string
  `state.content` would break on a rename that keeps the behaviour. The order of
  the three calls is the criterion; the argument is not.

### Module map

| Path | What it holds | Entry points |
| --- | --- | --- |
| `tools/argus-ui/test/page.test.mjs` | **Edited.** Source-level cases over `public/`: the existing import/module case, the flag-absence case and its guard | new `functionSource` helper plus cases 1–3 below |
| `tools/argus-ui/public/app.js` | **Read only, not edited.** The page: state literal at lines 15–34 (`tab: null` at 23), `renderDetail` at 130–172 (`renderTimeline` 165, `renderDetailViews` 167, `<div id="tab-body">` 169), `selectSession` at 904–917 (`state.tab = null` at 913) | none — no change |
| `tools/argus-ui/public/timeline.js` | **Read only, not edited.** `MIN_LANE_WIDTH_PCT`, `DETAIL_VIEWS`, `buildLanes`, `laneGeometry`, `renderTimeline(view)`, `renderDetailViews({ selected, counts })` | none — no change |

Facts about `page.test.mjs`'s existing shape, so the new cases sit inside it
rather than beside it: it imports `node:test`, `node:assert/strict`, `node:fs`,
`node:path` and `fileURLToPath`; `const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));`
is the only module-level constant besides `FLAGS_ARGUS_ENV_NOW_SETS`; a `walk(dir, found = [])`
helper sits under a JSDoc one-liner; banner comments (`// Criterion 1 — …`)
separate the criteria; every test name is a full lowercase sentence and every
assertion carries a message stating the fact.

### Environment

- Node v22.22.2 at `/opt/node22/bin/node`, on the `PATH`; the package requires ≥ 20.11.
- `tools/argus-ui` has zero runtime and zero dev dependencies. `npm install` is not
  needed and must not become needed.
- Whole package, from the repository root: `npm --prefix tools/argus-ui test`
  (`node --test "test/*.test.mjs"`).
- The single file, from the repository root: `node --test tools/argus-ui/test/page.test.mjs`.
- There is no linter and no formatter in this repository — nothing to run, nothing
  to configure.
- `./test.sh` runs every suite in the repository and is **not** on this round's
  list: no production file changes here, and the closing increment owns the
  full-suite run.

### Test Plan

Tests are needed: the finding is precisely that a criterion has no case behind it.
Framework: `node:test` with `node:assert/strict`, source level, all three cases in
the existing `tools/argus-ui/test/page.test.mjs`, under its `// Criterion 1` banner
and after the existing import/module case. Nothing from the earlier sections'
test plans is asked for again here; those cases stay in the tree untouched, and
no case in `timeline.test.mjs`, `independence.test.mjs`, `server.test.mjs` or
`config.test.mjs` changes.

**The helper**, added next to `walk` in the same file:

```js
/** The source of one top-level function declaration, up to the next one. */
function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `app.js must still declare ${name}()`);
  const body = source.slice(start + 1);
  const next = body.search(/\nfunction \w+\(/);
  return next === -1 ? body : body.slice(0, next);
}
```

It works because `renderDetail` is followed by `function renderTabBody(` and
`selectSession` by `function copyFrom(`, both plain top-level declarations at
column 0, and neither body nests a declaration at column 0.

#### Criterion 1 — opening a session lands on the timeline, the technical views stay subordinate

| # | Case | Input / state | Expected | Level |
| --- | --- | --- | --- | --- |
| 1 | the page loads with no technical view open | the `const state = {` … `\n};` slice of `public/app.js` | matches `/\btab:\s*null\b/`, and does **not** match `/\btab:\s*['"]/` — a string default would open a view on load | source |
| 2 | selecting a session returns to the timeline | `functionSource(appJs, 'selectSession')` | matches `/state\.tab\s*=\s*null/`, message: every session opens on its timeline, whatever view the previous one was on | source |
| 3 | the timeline is rendered above the technical views | `functionSource(appJs, 'renderDetail')` | `indexOf('renderTimeline(') >= 0`, `indexOf('renderDetailViews(') >= 0`, and `renderTimeline(` < `renderDetailViews(` < `id="tab-body"`, each index asserted `>= 0` first so a missing call fails on its own message rather than on an index comparison | source |

Case 1 takes the state slice as `appJs.slice(appJs.indexOf('const state = {'), …)` up to the
first `'\n};'` after it, with an `assert.ok` that both anchors were found.

Together the three fail under either half of the reviewer's reproduction: putting
`tab: 'overview'` back turns case 1 red on both of its assertions, and deleting the
`renderTimeline(...)` line from `renderDetail` turns case 3 red on its first
assertion.

**These three cases pass against the current `public/app.js`.** That is expected
and is not a defect to fix: the finding was a missing guard, not broken behaviour.
The test-author writes them, runs the file, and reports them as passing on write,
naming per case which of the reviewer's two mutations turns it red — a reading,
not a run. No production edit is asked for, and the implementer's work this round
is to confirm the command below is green and change nothing.

#### Deliberately untested, and why

- **That the lanes are visually above the nav on screen.** Pixels are not a thing
  `node --test` can see; the call order in `renderDetail` is the checkable fact.
- **The argument passed to `renderTimeline`.** See the rejected list above.
- **`renderTabBody`'s `case null:` branch.** It writes the empty string; case 3
  already pins that the container sits below the nav, and pinning the switch as
  source text would break on any restructuring that keeps the behaviour.
- **Everything the other three criteria cover.** They are met and covered per the
  reviewer; their cases stay as written and are re-run by the command below.
- **`tools/argus` and the collector.** Untouched this round.

#### What counts as done

```
npm --prefix tools/argus-ui test
```

That one command, from the repository root, is the whole list. It runs the three
new cases with the rest of `page.test.mjs` and the other four files, costs
seconds, and needs no install. `tools/argus` and `./test.sh` are off the list on
purpose: no production file changes in this round.

#### What is already red

I did not run the list, not once and not as a baseline. From reading: the suite
was 34 cases, 0 failed at the reviewer's run, and nothing has changed since, so
the three new cases are the only ones whose first result is unknown — and from the
source they will pass, because the behaviour they pin is already there.

## Increment 3 — activity and context growth on the lanes themselves

Everything below changes `tools/argus-ui` only. The collector is not touched: the
two routes it already serves (`/api/content`, `/api/events`) carry every fact a
lane needs, and no new aggregation belongs in a headless collector the UI can do
in one pass over data it already fetches.

### What I measured, and why

I ran one live capture, because the question this increment turns on — **what a
lane's activity is attributable by** — is answered by no file in this repository.
Increment 1 measured the *body* events; nothing measured `claude_code.tool_result`.
Commands, all outside the repository (throwaway collector on a free port,
persisting into the scratchpad):

- `node tools/argus/bin/argus.mjs start --port 4451 --persist <scratch>/tel` (background), `curl /api/health` → `{"ok":true,…}`.
- `node tools/argus/bin/argus.mjs env --port 4451 --format dotenv` → the block below was exported into the child process.
- `claude -p "…echo main-tool… Task → general-purpose subagent → echo sub-tool…" --allowedTools "Bash,Task" --max-turns 12`, Claude Code 2.1.223, **exit 0**. 29 log records, 15 spans, 27 metric points persisted.
- Two `node -e` dumps over the persisted JSONL (logs and spans), exit 0.
- The collector was stopped afterwards; nothing was written inside the repository.

I ran **no** test command, not even as a baseline.

**Finding 1 — `claude_code.tool_result` carries no attribution attributes at all.**
Its attributes are exactly `prompt.id`, `tool_name`, `tool_use_id`, `success`,
`duration_ms`, `tool_parameters`, `tool_input`, `tool_input_size_bytes`,
`tool_result_size_bytes` (plus the standard user/session/organization set). There
is **no `query_source` and no `agent.name`** on it, in either the main session's
tool calls or a subagent's. Name-based attribution of tool calls is therefore
impossible; the span is the only handle.

**Finding 2 — and the span is exactly the lane's span.** Measured, same session:

| record | `spanId` | span that id names |
| --- | --- | --- |
| main `api_request_body` (×3) | `03474d19d7dcc150` | `claude_code.interaction` |
| main `tool_result` (Bash, and the `Agent` call itself) | `03474d19d7dcc150` | the same interaction span |
| subagent `api_request_body` (×2), `query_source=agent:builtin:general-purpose` | `059b80bba5b73c6f` | `claude_code.tool.execution` under the `Agent` `claude_code.tool` span |
| subagent `tool_result` (Bash) | `059b80bba5b73c6f` | the same execution span |

So a `tool_result` is emitted on the *conversation* span that owns it, not on the
tool's own span — which is the span increment 2 keyed lanes on. **A tool call
belongs to the lane whose `spanId` it carries, and to the main lane otherwise.**
That is an exact rule with no name matching and no trace walk.

**Finding 3 — `claude_code.tool_decision` is useless for lanes.** Its `spanId`
was `d3ee3645022b7550` / `ba40464a21224882` / `0fe052f2b2dc57c6`, all
`claude_code.tool.blocked_on_user` spans (children of the per-tool span), never a
lane span. It also carries no `query_source`. Activity therefore comes from
`tool_result`, and `tool_decision` is not fetched.

**Finding 4 — `claude_code.api_request` would give real token counts.** It carries
`input_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `query_source` and,
for a subagent, even `agent.name`, on the lane span. Measured pair: a main request
with `body_length=107303` chars alongside `cache_read=36953 + cache_creation=126`
tokens. The two track each other (~2.9 chars per token). I still use `bodyLength`
for the curve — see the decisions — but the token route is now measured and
available to a later increment that wants it.

**Finding 5 (answering a question the run left open, not work for this
increment) — `claude_code.subagent_completed` arrives as a plain log record**, not
as a span event: it sat in `logs.jsonl` with `spanId` = the subagent's lane span
`059b80bba5b73c6f` and attributes `agent_type`, `agent.source`, `is_built_in`,
`is_async`, `total_tokens=19417`, `total_tool_uses=1`, `duration_ms=5727`,
`model`, `final_model`, `model_swapped`. It reaches `/api/events` today, unnamed
by `claude.mjs`. Increment 2 recorded that settling this costs a live capture;
the capture happened for another reason, so the answer is recorded here. **No
code in this increment uses it and no test may pin it** — lane ends stay as
increment 2 defined them. Also unnamed by `claude.mjs` and seen in the same
capture: `hook_execution_start`, `hook_registered`, `hook_execution_complete`.

**Finding 6 — the `tool_result` payload is not free.** `tool_input` is the whole
call parameters (for a `Write` that is the file's content), so refetching the
tool-event list on every SSE-driven refresh would ship megabytes per poll — the
regression increment 1 avoided for bodies. The plan therefore fetches tool events
**incrementally** (`sinceSeq`) and keeps only `{ seq, timeMs, spanId }`.

### The data behind the two visuals

- **Context size over time** = the `bodyLength` of each `claude_code.api_request_body`
  record on that lane, from the `/api/content` index the page already fetches for
  the lanes. A request body *is* the context at that moment, and `bodyLength` is
  the untruncated character count the CLI reported. Zero extra requests.
- **Activity over time** = those same request-body records (API requests) plus the
  `claude_code.tool_result` records (tool calls), each placed by `timeMs` and
  attributed by `spanId` per finding 2.

### Implementation plan

Four files change. No new file, no collector change, no dependency.

**A. `public/timeline.js` — new pure functions, and a richer `renderTimeline`.**

New exported constants:

```js
export const TOOL_EVENT = 'claude_code.tool_result';
export const REQUEST_EVENT = 'claude_code.api_request_body';
export const ACTIVITY_BUCKETS = 120;
export const MIN_CURVE_WIDTH_PCT = 0.6;
```

New exported functions:

- `laneKeyOf(record)` — the one lane-key rule, extracted from `buildLanes`'s body
  unchanged: `'main'` when `record.isSubagent !== true`, otherwise
  `` `agent:${record.spanId ?? ''}:${record.agent ?? ''}` ``. `buildLanes` calls it
  instead of inlining the template, so the key exists in one place only. No
  behaviour change; increment 2's cases stay green.
- `contextPoints(records, window, maxBodyLength)` → `[{ x, y }]`, both in 0…100:
  1. keep records with a finite `timeMs > 0`, sort ascending by `timeMs`;
  2. `span = Math.max(1, window.endMs - window.startMs)`;
  3. `x = clamp(((timeMs - window.startMs) / span) * 100, 0, 100)`;
  4. `y = maxBodyLength > 0 ? clamp(100 - (bodyLength / maxBodyLength) * 100, 0, 100) : 100`
     — `y` is an SVG coordinate, so 100 is the baseline and 0 the top;
  5. `[]` when no record qualifies. `bodyLength` is read with
     `Number.isFinite(record.bodyLength) ? record.bodyLength : 0`, never truthiness.
- `areaPolygon(points)` → the `points` attribute of an SVG polygon, or `''` for an
  empty array. It closes the area on the baseline and widens a single-point lane
  so one request is still a visible plateau:
  `x0,100`, then every `x,y`, then — when `xLast - x0 < MIN_CURVE_WIDTH_PCT` — a
  repeat of the last `y` at `xEnd = Math.min(100, x0 + MIN_CURVE_WIDTH_PCT)`, then
  `xEnd,100`. Every number is `toFixed(3)`, the same convention as the bar's style.
- `activityMarks(items, window)` → `[{ leftPct, kind, count }]`. `items` are
  `{ timeMs, kind: 'request' | 'tool' }`. Records are bucketed into
  `ACTIVITY_BUCKETS` columns over the window —
  `bucket = clamp(Math.floor(((timeMs - window.startMs) / span) * ACTIVITY_BUCKETS), 0, ACTIVITY_BUCKETS - 1)`
  with the same `span` guard — one entry per (bucket, kind) that has at least one
  record, `leftPct = (bucket / ACTIVITY_BUCKETS) * 100`, `count` the number of
  records in it. Sorted by `leftPct`, then `kind` alphabetically, so the output is
  deterministic whatever order the API returned. Bucketing is what keeps a
  2000-record session from painting 2000 elements.
- `buildDensity(view, { content = [], tools = [] } = {})` → a new view object,
  `{ ...view, maxBodyLength, lanes }`, leaving its argument untouched:
  1. `requests` = entries of `content` with `eventName === REQUEST_EVENT` and a
     finite `timeMs > 0`. Response bodies are ignored — see the decisions.
  2. `maxBodyLength` = the largest `bodyLength` among them, else `0`.
  3. `spanToLane` = a Map from `lane.spanId` to `lane.key`, built from the agent
     lanes of `view.lanes` in order, first one wins.
  4. Each request record goes to `laneKeyOf(record)`; each tool record goes to
     `spanToLane.get(tool.spanId) ?? 'main'`. A key that matches no lane is
     dropped rather than inventing a lane — `buildLanes` owns which lanes exist.
  5. Each lane gains `context` (`contextPoints` of its request records),
     `activity` (`activityMarks` of its request + tool records), `requests`,
     `toolCalls` and `peakBodyLength` (the largest `bodyLength` on that lane, `0`
     when it has none).
- `renderTimeline(view)` — additions inside `.lane-track`, in this order, so the
  curve is literally behind the bar:
  ```html
  <span class="lane-track">
    <svg class="lane-curve" data-kind="agent" viewBox="0 0 100 100"
         preserveAspectRatio="none" aria-hidden="true"><polygon points="…"></polygon></svg>
    <span class="lane-bar" data-kind="agent" style="left:…%;width:…%"></span>
    <span class="lane-mark" data-kind="request" style="left:12.500%" title="2 API requests"></span>
    <span class="lane-mark" data-kind="tool" style="left:25.000%" title="1 tool call"></span>
  </span>
  ```
  The `<svg>` block is omitted entirely when `areaPolygon` returns `''`; a lane
  with no activity renders no `.lane-mark`. `.lane-meta` becomes
  `<span class="lane-meta" data-peak="<peakBodyLength>" data-requests="<n>" data-tools="<n>" title="…">
  <duration> · <fmtNum(peak)></span>` — the numbers live in data attributes so a
  test can pin the fact without pinning the implementer's sentence. A legend row
  goes above the axis:
  `<div class="timeline-legend"><span data-kind="context">context size</span><span data-kind="request">API request</span><span data-kind="tool">tool call</span></div>`.
  **`renderTimeline` must keep working on a bare `buildLanes` view**: read
  `lane.activity ?? []`, `lane.context ?? []`, `lane.peakBodyLength ?? 0`,
  `lane.requests ?? 0`, `lane.toolCalls ?? 0`. Increment 2's cases call
  `renderTimeline(buildLanes(…))` directly and must stay green untouched.

**B. `public/app.js` — one more loader, incremental, and the composition.**

- State: add `toolMarks: []` and `toolSeq: 0` next to `content`. `toolMarks` holds
  `{ seq, timeMs, spanId }` and nothing else — the tool parameters are a later
  increment's business and keeping them would hold megabytes in the page.
- `loadTimeline()` keeps its `/api/content` request and gains, in the same
  function, a second one issued in parallel with its own `.catch`, so either
  failure costs only its own half:
  ```js
  const [content, tools] = await Promise.all([
    api('/api/content', { session: id, limit: 2000 }).catch(() => null),
    api('/api/events', { session: id, event: TOOL_EVENT, sinceSeq: state.toolSeq, limit: 2000 }).catch(() => null),
  ]);
  ```
  `content` replaces `state.content` (or `[]` on failure, as today); the tool items
  are **appended**: for each item push `{ seq: item.seq, timeMs: item.timeMs, spanId: item.spanId }`
  and raise `state.toolSeq` to the largest `seq` seen. `sinceSeq` is why the
  refresh that fires on every SSE ingest ships nothing it already has.
- `selectSession` resets `state.toolMarks = []` and `state.toolSeq = 0` next to
  `state.content = []`; without it a second session inherits the first's marks.
- `renderDetail` composes:
  ```js
  ${renderTimeline(buildDensity(buildLanes({ session, content: state.content }),
    { content: state.content, tools: state.toolMarks }))}
  ```
  and imports `buildDensity` and `TOOL_EVENT` alongside the existing imports.

**C. `public/styles.css` — appended to the existing timeline block (lines 786–865).**

- `.timeline` gains `--meta-w: 120px`; `.timeline-axis` and `.lane` use
  `grid-template-columns: var(--label-w) 1fr var(--meta-w)` instead of the literal
  `64px`, and the responsive block at line ~1080 sets `--meta-w: 84px` beside the
  `--label-w` it already overrides.
- `.lane-track` height 16px → 26px, so a curve fits behind the bar.
- `.lane-bar` moves to the bottom of the track (`top: auto; bottom: 0; height: 5px`)
  and keeps its colours.
- `.lane-curve { position: absolute; inset: 0; width: 100%; height: 100%; }` with
  `.lane-curve polygon { fill: var(--accent-soft); }` and
  `.lane-curve[data-kind="agent"] polygon { fill: color-mix(in srgb, var(--violet) 20%, transparent); }`
  — `color-mix` is already used in this file (line 319), so this adds no custom
  property and no new colour.
- `.lane-mark { position: absolute; top: 2px; bottom: 7px; width: 2px; margin-left: -1px; border-radius: 1px; }`,
  `[data-kind="request"]` → `var(--teal)`, `[data-kind="tool"]` → `var(--warn)`.
  Both exist in `:root` and in the light-mode block, and neither collides with the
  lane bars' accent/violet.
- `.timeline-legend` — a small flex row of muted labels with a colour swatch each
  (`::before`), reusing the same three colours.

**D. `tools/argus-ui/README.md` — one edit.** The **Timeline** bullet (line 62)
gains what the lanes now carry: activity marks for API requests and tool calls,
and the context size behind each lane as a shaded area. `CLAUDE.md` needs no
change: no convention changes.

### Decisions I rejected

- **Token counts from `claude_code.api_request` for the curve.** Measured and
  real (finding 4), but it costs a second event fetch per refresh and a second
  attribution path, and the planner already settled the curve on the content
  index's `bodyLength` after increment 1. Chars are the served context itself,
  exact, and already in hand. The label says "context" and never "tokens", so
  nothing on screen claims a token count it does not have.
- **`claude_code.tool_decision` as the tool-call signal.** Its span is a
  `blocked_on_user` span, never a lane span (finding 3).
- **Attributing tool calls by agent name or `query_source`.** The attributes are
  simply not on the record (finding 1), and even if they were, two concurrent
  same-type agents share the name — the merge increment 2's criterion forbids.
- **Walking the trace tree to map a tool span to its agent.** One
  `/api/traces/<id>` request per trace per refresh, whole span trees, to recover a
  parent link the log record already carries. Rejected on cost and on need.
- **Refetching the whole tool-event list every refresh.** Megabytes per poll
  (finding 6); `sinceSeq` exists precisely for this.
- **Keeping the tool events' `attrs` in page state.** Same reason. Increment 6
  wants tool names and parameters for *one* lane at *one* moment and can ask for
  exactly that.
- **Counting `api_response_body` records as activity or context.** A response
  arrives within a millisecond of its request and would double every mark with no
  information; and the response is not the context. They are ignored on the lane.
- **A per-lane y-scale for the curve.** It makes every lane's curve fill its
  track, which hides the very thing the criterion asks for: *where* consumption
  grows. One scale across the session (`maxBodyLength`) is what makes a subagent's
  hill visibly smaller than the main session's mountain, and the per-lane
  `data-peak` plus the meta number is what keeps a small lane readable anyway.
- **A `<canvas>` or a charting dependency.** Zero dependencies is this project's
  first rule, and a canvas would need DOM code where the rest of this module is a
  pure string renderer.
- **A step curve** (hold the value until the next request) instead of a linear
  polygon. More faithful to how context actually changes, twice the vertices, and
  the criterion asks for "a curve or area". Linear, and recorded here so the
  choice is visible.
- **A collector route that aggregates lane density.** The UI has both inputs in
  hand; a route would be a second implementation of the same grouping in a
  headless process.
- **Scrub cursor, live-mode control, per-lane selection, tool names and
  parameters on screen.** All named as later increments.

### Consequences to accept, not paper over

- A tool call that was **rejected** (a `tool_decision` with `decision: reject` and
  no `tool_result`) leaves no mark. A call that never ran is not activity.
- A subagent that made **no API request** gets no lane from `buildLanes`, so its
  tool calls fall to the main lane. A Task subagent's first act is a model call,
  so this does not occur in practice.
- The main lane collects every tool call whose span is not an agent lane's,
  including a multi-turn session's several `claude_code.interaction` spans. That
  is the intended reading: everything that is not a subagent is the main session.
- More than 2000 tool results between two refreshes would advance the watermark
  past the oldest of that batch. Refreshes are seconds apart; a batch that size is
  not a real session.
- The oldest lanes of a session past the content index's 2000-record window are
  already absent (increment 2's recorded consequence); their density is absent
  with them.

### Module map

| Path | What it holds | Entry points |
| --- | --- | --- |
| `tools/argus-ui/public/timeline.js` | Lane derivation, density and the timeline markup; pure, no DOM | **new** `TOOL_EVENT`, `REQUEST_EVENT`, `ACTIVITY_BUCKETS`, `MIN_CURVE_WIDTH_PCT`, `laneKeyOf`, `contextPoints`, `areaPolygon`, `activityMarks`, `buildDensity`; **changed** `renderTimeline`, `buildLanes` (calls `laneKeyOf`) |
| `tools/argus-ui/public/app.js` | The page: state, fetching, rendering, wiring | `state` (`toolMarks`, `toolSeq`), `loadTimeline`, `selectSession`, `renderDetail`, the import line |
| `tools/argus-ui/public/styles.css` | Every style; dark-first with a light-mode `:root` | the timeline block at lines 786–865 and the responsive block near line 1080 |
| `tools/argus-ui/README.md` | User-facing page | the **Timeline** bullet, line 62 |
| `tools/argus-ui/public/format.js` | `esc`, `fmtNum`, `fmtDur`, `fmtClock`, … | unchanged; `fmtNum(108204) === '108.2k'` is what the meta prints |
| `tools/argus-ui/test/independence.test.mjs` | The no-outside-imports rule | **unchanged** — no new file under `public/`, so nothing to add |

Facts about the collector's API this plan rests on, so nobody has to open that
project:

- `GET /api/content?session=&agent=&main=1&span=&event=&limit=` → `{ items: [...] }`,
  ascending by time, `limit` capped at 2000, walked newest-first. Each item:
  `{ seq, timeMs, sessionId, traceId, spanId, eventName, querySource, agent,
  isSubagent, model, requestId, promptId, eventSequence, bodyLength, bodyChars,
  truncated, bodyRef }` — never a body. `bodyLength` is a number (the collector
  parses the CLI's string), `isSubagent` a real boolean, `agent` a string or `null`.
- `GET /api/events?session=&event=&trace=&search=&errors=&sinceSeq=&limit=` →
  `{ items: [...] }`, ascending by time, `limit` capped at 2000, `sinceSeq`
  returning only records newer than that `seq`. Each item is the stored log record
  plus `summary` and `attribution`: `{ seq, timeMs, observedMs, severity,
  eventName, body, attrs, traceId, spanId, sessionId, isError, … }`. `spanId` is a
  lower-case hex string, `''` when the record carried none.
- The UI's own server forwards `/api/*` to the collector with the query string
  intact and adds the collector's token server-side.

### Environment

- Node v22.22.2 at `/opt/node22/bin/node`, on the `PATH`; the package requires ≥ 20.11.
- `tools/argus-ui` has **zero runtime and zero dev dependencies**; `npm install` is
  not needed and must not become needed. Adding a dependency is not a coding
  decision — it goes to the human.
- Whole package, from the repository root: `npm --prefix tools/argus-ui test`
  (`node --test "test/*.test.mjs"`).
- A single file, from the repository root:
  `node --test tools/argus-ui/test/timeline.test.mjs`, same shape for
  `page.test.mjs`, `server.test.mjs`, `config.test.mjs`, `independence.test.mjs`.
- `public/*.js` is importable by `node --test` because the package is
  `"type": "module"`: `import { buildDensity } from '../public/timeline.js';`
  works with no loader flag.
- **There is no linter and no formatter in this repository** — nothing to run,
  nothing to configure.
- `./test.sh` runs every suite in the repository. It is **not** on this
  increment's list: the closing increment (`tool-usage`) owns it, and nothing
  outside `tools/argus-ui` changes here.

### Test plan

Tests are needed. Framework: `node:test` with `node:assert/strict`, the only thing
this project uses. Conventions, taken from the two files the cases land in: every
test name is a full lowercase sentence stating the fact ('a tool call lands on the
lane whose span it carries'); fixtures are local factory helpers at the top of the
file (`session()`, `record()`, `threeRecordContent()` in `timeline.test.mjs`;
`walk()`, `functionSource()` in `page.test.mjs`); nothing is mocked beyond those;
every assertion that could be read two ways carries a message saying what the fact
is; banner comments (`// Criterion 1 — …`) separate the criteria; and a message is
asserted as an absence, never as a wording — which is why the lane meta's numbers
go into `data-*` attributes and no case asserts a title's sentence.

Two files are edited; no test file is created:

- `tools/argus-ui/test/timeline.test.mjs` — the new unit cases, under a new banner
  `// Criterion 5 — activity and context growth on the lanes themselves`, appended
  after the existing cases, which stay exactly as they are. Two new local
  factories next to the existing ones:
  ```js
  const toolMark = (over = {}) => ({ seq: 1, timeMs: 2000, spanId: 'sp-a', ...over });
  const density = (over = {}) => buildDensity(buildLanes({ session: session(), content: [], ...over.lanes }), { content: [], tools: [], ...over });
  ```
  (the implementer may inline `buildDensity(buildLanes(…), …)` per case instead if
  that reads better; the factories for `session()` and `record()` are the ones
  already in the file and every case builds from those.)
- `tools/argus-ui/test/page.test.mjs` — three source-level cases under a new
  banner, using the existing `functionSource` helper.

`window` below means `{ startMs: 1000, endMs: 5000 }` unless a case says otherwise.

#### The criterion — each lane shows its activity over time, and the context size behind it

| # | Case | Input / state | Expected | File | Level |
| --- | --- | --- | --- | --- | --- |
| 1 | every lane comes back with a density, even an empty session | `buildDensity(buildLanes({ session: session(), content: [] }), {})` | one lane; `context` and `activity` are `[]`, `requests === 0`, `toolCalls === 0`, `peakBodyLength === 0`, `maxBodyLength === 0` | `timeline.test.mjs` | unit |
| 2 | requests land on the lane that made them | `threeRecordContent()` as both lanes input and `content` | main lane `requests === 1`, agent lane `requests === 3`; each lane's `context` has that many points | `timeline.test.mjs` | unit |
| 3 | a tool call lands on the lane whose span it carries | `threeRecordContent()` plus `tools: [toolMark({ spanId: 'sp-a', timeMs: 2200 })]` | the `sp-a` lane has `toolCalls === 1`, the main lane `toolCalls === 0` | `timeline.test.mjs` | unit |
| 4 | a tool call on a span no lane owns belongs to the main session | same content, `tools: [toolMark({ spanId: 'interaction-1' }), toolMark({ seq: 2, spanId: '' })]` | main lane `toolCalls === 2`, agent lane `0` — the measured main-session case, where the span is the interaction's | `timeline.test.mjs` | unit |
| 5 | two concurrent agents of one type keep their own tool calls | the four-record `sp-a`/`sp-b` `general-purpose` fixture of criterion 3 (increment 2), plus one tool mark per span | each agent lane has `toolCalls === 1`; neither has 2 | `timeline.test.mjs` | unit |
| 6 | a response body is neither activity nor context | one main request record and one `record({ eventName: 'claude_code.api_response_body', timeMs: 2600, bodyLength: 900 })` | main lane `requests === 1`, `context.length === 1`, and `activity` totals one record | `timeline.test.mjs` | unit |
| 7 | the curve is scaled across the whole session, not per lane | a main record `bodyLength: 100000` and a subagent record `bodyLength: 25000` | `maxBodyLength === 100000`; the main point's `y === 0`, the agent point's `y === 75`; `peakBodyLength` is 100000 and 25000 respectively | `timeline.test.mjs` | unit |
| 8 | a session whose requests all report no size still yields a drawable curve | records with `bodyLength: 0` | every point's `y === 100`, every `x` finite — no division by zero | `timeline.test.mjs` | unit |
| 9 | `contextPoints` places a record by time inside the window | records at 1000, 3000, 5000 with `bodyLength` 10/20/20, window 1000…5000, max 20 | `x` values 0, 50, 100 and `y` values 50, 0, 0 — exact, the arithmetic is exact here | `timeline.test.mjs` | unit |
| 10 | `contextPoints` survives a zero-length window | window `{ startMs: 1000, endMs: 1000 }`, two records | both `x` and `y` finite (`Number.isFinite`) and inside 0…100 | `timeline.test.mjs` | unit |
| 11 | the area closes on the baseline | `areaPolygon` of two points | the string starts with `<x0>,100.000` and ends with `,100.000`, contains both `y` values, and matches no `NaN` | `timeline.test.mjs` | unit |
| 12 | a single request is still a visible area | `areaPolygon` of one point at `x: 10` | four vertices; the last `x` is at least `10 + MIN_CURVE_WIDTH_PCT` and at most 100 | `timeline.test.mjs` | unit |
| 13 | no requests, no polygon | `areaPolygon([])` | `''` | `timeline.test.mjs` | unit |
| 14 | activity in one bucket is one mark carrying its count | two request items 1 ms apart inside a 4000 ms window | one mark, `kind === 'request'`, `count === 2` | `timeline.test.mjs` | unit |
| 15 | a tool call and an API request at the same moment stay two marks | one `request` and one `tool` item at the same `timeMs` | two marks, same `leftPct`, kinds `request` and `tool` | `timeline.test.mjs` | unit |
| 16 | the marks are bounded however many records arrive | 500 request items spread over the window | `marks.length <= ACTIVITY_BUCKETS`, and the summed `count` is 500 — bucketing loses no record | `timeline.test.mjs` | unit |
| 17 | a mark never leaves the track | items at `window.startMs`, `window.endMs`, and one past `endMs` | every `leftPct` is `>= 0` and `< 100`; and against a zero-length window every `leftPct` is finite | `timeline.test.mjs` | unit |
| 18 | the density is rendered behind the bar, not instead of it | `renderTimeline` of the case-3 view | for the agent lane's row: an `<svg class="lane-curve"` occurs before its `<span class="lane-bar`, the `points` attribute is non-empty and matches no `NaN`, and the row carries `data-kind="request"` and `data-kind="tool"` marks | `timeline.test.mjs` | unit |
| 19 | a lane with nothing on it renders as a bare lane | `renderTimeline` of the case-1 view | the markup contains one `data-lane="` and no `lane-curve`, no `lane-mark`, and no `NaN` | `timeline.test.mjs` | unit |
| 20 | the lane meta reports the size and the counts as data | `renderTimeline` of the case-3 view | the agent lane's `.lane-meta` carries `data-peak="10"` (the fixture's `bodyLength`), `data-requests="3"`, `data-tools="1"`; assert the attribute values, never the title's wording | `timeline.test.mjs` | unit |
| 21 | the timeline still renders from lanes alone | `renderTimeline(buildLanes({ session: session(), content: threeRecordContent() }))` — no `buildDensity` | two `data-lane="` occurrences, no `NaN`, no throw: the density is additive and the increment-2 call shape keeps working | `timeline.test.mjs` | unit |
| 22 | the page asks the collector for the tool calls | `functionSource(appJs, 'loadTimeline')` | contains `/api/events`, `TOOL_EVENT` and `sinceSeq` — the tool events are fetched, and incrementally | `page.test.mjs` | source |
| 23 | selecting a session forgets the previous session's tool calls | `functionSource(appJs, 'selectSession')` | matches `/state\.toolMarks\s*=\s*\[\]/` and `/state\.toolSeq\s*=\s*0/` | `page.test.mjs` | source |
| 24 | the timeline is rendered with its density | `functionSource(appJs, 'renderDetail')` | contains `buildDensity(`, and its index is below that of `renderTimeline(`'s opening call — the lanes reach the renderer through the density, not around it | `page.test.mjs` | source |

Case 24's index check is `renderDetail.indexOf('renderTimeline(') < renderDetail.indexOf('buildDensity(')`,
because `renderTimeline(buildDensity(…))` is the composition; assert both indices
are `>= 0` first, each with its own message, so a missing call fails on its own
name rather than on an index comparison.

#### Deliberately untested, and why

- **Colours, pixel positions and whether the curve reads well.** `node --test` sees
  strings; the numbers behind the drawing are pinned in cases 7–17 and the look is
  what the review is for.
- **`TOOL_EVENT`'s value as a contract with the collector.** The name comes from
  the CLI and is measured above; pinning the string in a UI case would restate the
  constant, and `server.test.mjs` already proves the proxy forwards `/api/*` with
  its query string intact.
- **The incremental fetch actually skipping records it has** — that is the
  collector's `sinceSeq`, pinned in that project's suite; re-asserting it here
  would pin someone else's behaviour. Case 22 pins that the UI asks for it.
- **`state.toolMarks` growing across refreshes.** It is loader wiring in `app.js`,
  which this project has no DOM harness for and will not grow one for (jsdom is a
  dependency, and zero dependencies is the project's first rule).
- **`claude_code.subagent_completed`, `tool_decision`, `api_request` tokens.**
  Measured above, used by nothing here; no case may pin behaviour for them.
- **Lane derivation, geometry, labels, escaping and the landing view.** Increment
  2's cases own them, they stay untouched, and the command below re-runs them.
- **Recordings made without the content flags** — out of contract by the issue's
  own decision.
- **`tools/argus`** — not touched by this increment.

#### What counts as done

```
npm --prefix tools/argus-ui test
```

That one command, from the repository root, is the whole list. It runs the new
cases with the rest of `timeline.test.mjs` and `page.test.mjs` and the other three
files, costs seconds, and needs no install. `tools/argus` and `./test.sh` are off
the list on purpose: nothing outside `tools/argus-ui` changes here, and the
closing increment owns the full-suite run.

#### What is already red

I did not run the list, not once and not as a baseline; the first run belongs to
whoever runs it downstream. From reading, nothing is red before the change and
nothing existing should turn red by it: the increment-2 cases assert lane
structure, geometry, labels and the tab strip, none of which this plan alters, and
case 21 exists precisely to keep `renderTimeline(buildLanes(…))` — the shape those
cases call — working while the density is optional. `independence.test.mjs` adds
no file to guard, and `page.test.mjs`'s flag-absence case is untouched by anything
this increment writes (`claude_code.tool_result` is an event name, not a flag).

## Increment 3 — Round 1

The reviewer's `## Increment 3` section raises **one finding**, and this section
plans that fix and nothing else. Everything the earlier sections asked for is
built and pinned; no case or command from them carries over. What binds now is
below.

### The finding, restated as the defect to remove

`tools/argus-ui/public/app.js:839–857`. `loadTimeline` captures
`const id = state.selectedSessionId`, awaits two fetches, and then writes the
answer into shared page state without asking whether that session is still the
selected one:

```js
  state.content = content?.items ?? [];
  for (const item of tools?.items ?? []) {
    state.toolMarks.push({ seq: item.seq, timeMs: item.timeMs, spanId: item.spanId });
    if (item.seq > state.toolSeq) state.toolSeq = item.seq;
  }
```

Two refreshes can be in flight at once — `scheduleRefresh` (`app.js:958`) guards
only a pending timer, while `selectSession` (`app.js:939`) calls `refresh()`
directly. Two consequences, both real:

1. **Cross-session contamination that never recovers.** A response for session A
   landing after the user selected session B appends A's tool marks to B's array
   and raises `state.toolSeq` to A's highest `seq`. Because `seq` is one global
   counter in the collector, every later fetch for B asks
   `sinceSeq=<A's max seq>` and gets nothing: B's lanes show A's tool calls and
   none of B's, for the life of the page.
2. **Double counting within one session.** Two overlapping refreshes read the
   same `state.toolSeq`, fetch the same events and both append them, so a
   bucket's `count` — the "N tool calls" in the mark's tooltip — is inflated.

Both are the criterion's own words failing: a lane must show *its* activity over
time.

### Implementation plan

Two production files change. No new file, no collector change, no dependency, no
style or README edit.

**A. `public/timeline.js` — one new exported pure function.**

The accumulation is the half that carries the bug and the half a `node --test`
process can actually execute, so it moves out of `app.js` into the pure module
next to the functions that consume its result:

```js
/**
 * Merge a page of tool events into the marks already held.
 *
 * The watermark comes back as the highest `seq` *held*, never as the highest
 * seen: a record that was not kept can then never be skipped as already seen,
 * which is what turns a stale or duplicated response into a no-op instead of a
 * permanent hole. Duplicates are dropped by `seq`, and the input array is left
 * untouched.
 *
 * @param {{ seq: number, timeMs: number, spanId: string|null }[]} marks
 * @param {object[]} items
 * @returns {{ marks: object[], seq: number }}
 */
export function mergeToolMarks(marks, items) {
  const held = Array.isArray(marks) ? marks : [];
  const merged = held.slice();
  const seen = new Set(held.map((mark) => mark?.seq));
  let seq = 0;
  for (const mark of held) if (Number.isFinite(mark?.seq) && mark.seq > seq) seq = mark.seq;
  for (const item of Array.isArray(items) ? items : []) {
    if (!Number.isFinite(item?.seq) || seen.has(item.seq)) continue;
    seen.add(item.seq);
    merged.push({ seq: item.seq, timeMs: item.timeMs, spanId: item.spanId ?? null });
    if (item.seq > seq) seq = item.seq;
  }
  return { marks: merged, seq };
}
```

Rules it fixes in one place: only `{ seq, timeMs, spanId }` is kept (a
`tool_result` carries its whole `tool_input`, which must never reach page
state); an item without a finite `seq` is dropped, because a record that cannot
be de-duplicated cannot be held safely; nothing is mutated in place. The module
header comment says its inputs are the payloads of `/api/sessions/<id>` and
`/api/content` — extend that sentence to name `/api/events` too, so the doc
stays true.

**B. `public/app.js` — the guard and the delegation.**

- Add `mergeToolMarks` to the existing
  `import { … } from './timeline.js';` line (`app.js:11`).
- `loadTimeline` keeps its two parallel fetches exactly as they are, and
  replaces the write block with a guard first and a merge second:

  ```js
    const [content, tools] = await Promise.all([ /* unchanged */ ]);
    // A second refresh can start while these are in flight — selectSession calls
    // refresh() directly. An answer for a session that is no longer selected must
    // be dropped whole: appending it would put another session's tool calls on
    // these lanes and push the watermark past this session's own records.
    if (state.selectedSessionId !== id) return;
    state.content = content?.items ?? [];
    const merged = mergeToolMarks(state.toolMarks, tools?.items ?? []);
    state.toolMarks = merged.marks;
    state.toolSeq = merged.seq;
  ```

- `selectSession` keeps `state.toolMarks = []` and `state.toolSeq = 0`
  unchanged: with the watermark derived from what is held, the reset stays
  self-consistent, and the existing case pins it.
- Nothing else in `app.js` changes. The guard also removes increment 2's milder
  stale write on `state.content`; that is the same line, not extra scope.

### Decisions I rejected

- **A source-level assertion alone, leaving the loop in `app.js`.** It pins the
  words of a fix, never its behaviour, and it is exactly what the hole fell
  through last round. Moving the accumulation into the pure module is what buys
  a case that fails on the defect and passes on the fix.
- **Keying page state by session (`state.toolMarksBySession`).** It removes the
  race by construction, but grows unbounded as a user browses sessions and adds
  a second lookup to every render, to solve what one comparison solves.
- **A monotonically increasing request token (`state.timelineSeq`) instead of
  comparing the session id.** The only thing that invalidates the accumulation is
  a selection change, and the id already says that. A token would additionally
  discard a same-session overlap that the `seq` de-duplication now makes
  harmless.
- **Serialising refreshes (an in-flight promise the next refresh awaits).** It
  fixes this symptom by making every ingest event queue behind the last fetch,
  which is a page-wide behaviour change for a two-line bug, and it leaves the
  cross-session write possible on the very next tick anyway.
- **De-duplicating inside `buildDensity` instead.** That hides double counting in
  the drawing while page state stays wrong, and it re-does the work on every
  render rather than once per response.
- **Keeping items with no `seq` and de-duplicating by `timeMs`+`spanId`.** Two
  tool calls in one millisecond on one span are indistinguishable that way, and
  the collector puts a `seq` on every stored log record — so the case does not
  arise, and guessing costs correctness where it does.
- **Any change to `styles.css`, `README.md` or the collector.** The finding is
  wiring; the drawing the reviewer accepted stays byte-identical.

### Consequences to accept

- A tool event whose `seq` the page already holds is never re-read, so an event
  the collector *rewrote* under the same `seq` would keep its first
  `timeMs`/`spanId`. The collector's `seq` is an append-only counter; it does not
  rewrite.
- Dropping an item with no finite `seq` means such an item never paints a mark.
  Nothing observed emits one.
- A response discarded by the guard is simply refetched by the next refresh,
  which is at most one SSE tick away.

### Module map

| Path | What it holds | Entry points |
| --- | --- | --- |
| `tools/argus-ui/public/timeline.js` | Lane derivation, density and the timeline markup; pure, no DOM, no `fetch` | **new** `mergeToolMarks`; header comment extended to name `/api/events`; everything else unchanged |
| `tools/argus-ui/public/app.js` | The page: state, fetching, rendering, wiring | `loadTimeline` (`:839`, the guard and the merge), the `./timeline.js` import line (`:11`); `selectSession` and `renderDetail` unchanged |
| `tools/argus-ui/test/timeline.test.mjs` | Unit cases over the pure module; factories `session()`, `record()`, `threeRecordContent()`, `toolMark()` at the top | new cases appended under a new banner |
| `tools/argus-ui/test/page.test.mjs` | Source-level cases over `public/`; helpers `walk()`, `functionSource()` | `functionSource` tightened, new cases appended |
| `tools/argus-ui/public/styles.css`, `tools/argus-ui/README.md`, `tools/argus/**` | — | **untouched this round** |

Facts nobody has to open another project for: `GET /api/events` items are the
stored log record, which always carries a numeric `seq`, a `timeMs` and a
`spanId` (`''` when the record had none); `seq` is a single global counter across
all sessions in the collector's store, which is why a foreign watermark is
poison rather than merely wrong; `sinceSeq` returns only records with a strictly
greater `seq`, walking newest-first and stopping at the first record at or below
it.

### Environment

- Node v22.22.2 at `/opt/node22/bin/node`, on the `PATH`; the package requires
  ≥ 20.11.
- `tools/argus-ui` has zero runtime and zero dev dependencies. `npm install` is
  not needed and must not become needed; adding a dependency goes to the human.
- Whole package, from the repository root: `npm --prefix tools/argus-ui test`
  (`node --test "test/*.test.mjs"`).
- A single file, from the repository root:
  `node --test tools/argus-ui/test/timeline.test.mjs`, and the same shape for
  `page.test.mjs`.
- `public/timeline.js` is importable by `node --test` because the package is
  `"type": "module"`: `import { mergeToolMarks } from '../public/timeline.js';`
  needs no loader flag. `public/app.js` is **not** importable — it reads
  `location` at module scope — which is why cases about it are source-level.
- There is no linter and no formatter in this repository: nothing to run.

### Test Plan

Tests are needed: the finding is a behaviour defect, and the de-duplication half
is directly executable. Framework: `node:test` with `node:assert/strict`, the
only thing this project uses.

Conventions for both files, taken from the files themselves: every test name is a
full lowercase sentence stating the fact; fixtures are the local factories
already at the top of the file (`session()`, `record()`, `threeRecordContent()`,
`toolMark()` in `timeline.test.mjs`; `walk()`, `functionSource()` in
`page.test.mjs`); nothing is mocked beyond those — no DOM, no `fetch`, no fake
timers; each assertion that could be read two ways carries a message saying what
the fact is; banner comments separate the groups; and no case asserts a
user-visible sentence, only structure and numbers.

**A helper change first.** `functionSource` in `page.test.mjs` ends a function at
`/\nfunction \w+\(/`, which does not stop at an `async function` — so today its
`loadTimeline` slice runs on through `loadTabData` and `refresh`. Change that
regex to `/\n(?:async )?function \w+\(/`. Checked against the current `app.js`:
the only slice it shortens is `loadTimeline`'s; `renderDetail` (next plain
function `renderTabBody`) and `selectSession` (next plain function `copyFrom`)
are unaffected, and every existing assertion targets text genuinely inside its
function, so no existing case changes result.

Two files are edited; no test file is created, and every existing case stays
exactly as it is.

#### Cases — the tool-mark index accumulates without duplicating or skipping

New banner in `tools/argus-ui/test/timeline.test.mjs`, appended after the
existing cases:
`// Criterion 5, round 1 — the tool-mark index survives an overlapping refresh.`
Add `mergeToolMarks` to the import list at the top of that file.

| # | Case | Input / state | Expected | File | Level |
| --- | --- | --- | --- | --- | --- |
| 1 | merging into an empty index keeps every item, and only the three fields a mark needs | `mergeToolMarks([], [{ seq: 4, timeMs: 2000, spanId: 'sp-a', attrs: { tool_input: 'x'.repeat(100) } }, { seq: 7, timeMs: 3000, spanId: 'sp-b' }])` | `assert.deepEqual(result.marks, [{ seq: 4, timeMs: 2000, spanId: 'sp-a' }, { seq: 7, timeMs: 3000, spanId: 'sp-b' }])` and `result.seq === 7` — the payload is dropped, not carried into page state | `timeline.test.mjs` | unit |
| 2 | an event already held is not counted twice | held `[{ seq: 4, timeMs: 2000, spanId: 'sp-a' }]`, items `[{ seq: 4, timeMs: 2000, spanId: 'sp-a' }, { seq: 5, timeMs: 2100, spanId: 'sp-a' }]` | `marks.length === 2`, exactly one mark with `seq === 4`, `seq === 5` — the overlapping-refresh double count | `timeline.test.mjs` | unit |
| 3 | merging the same response twice changes nothing the second time | `const first = mergeToolMarks([], items); const second = mergeToolMarks(first.marks, items);` with the two items of case 1 | `assert.deepEqual(second.marks, first.marks)` and `second.seq === first.seq` | `timeline.test.mjs` | unit |
| 4 | the watermark is what is held, never what was seen | `mergeToolMarks([], [])` and `mergeToolMarks([{ seq: 9, timeMs: 4000, spanId: 'sp-a' }], [])` | `{ marks: [], seq: 0 }` for the first; `seq === 9` and `marks.length === 1` for the second — a watermark can never run ahead of the records behind it, which is what made the finding permanent | `timeline.test.mjs` | unit |
| 5 | an item with no usable seq is dropped rather than held un-deduplicable | items `[{ timeMs: 2000, spanId: 'sp-a' }, { seq: null, timeMs: 2100, spanId: 'sp-a' }, { seq: 'x', timeMs: 2200, spanId: 'sp-a' }]` into an empty index | `marks` is `[]` and `seq === 0` | `timeline.test.mjs` | unit |
| 6 | merging does not mutate the index it was given | held array of one mark, items of two new marks | the held array still has `length === 1` afterwards, and `result.marks !== held` | `timeline.test.mjs` | unit |
| 7 | out-of-order items still leave the highest seq as the watermark | items `[{ seq: 9, … }, { seq: 4, … }]` into an empty index | both held, `seq === 9` (the maximum, not the last) | `timeline.test.mjs` | unit |
| 8 | a missing spanId becomes null rather than undefined | item `{ seq: 3, timeMs: 2000 }` | the mark is `{ seq: 3, timeMs: 2000, spanId: null }` | `timeline.test.mjs` | unit |
| 9 | the merged index is what the density reads | `buildDensity(buildLanes({ session: session(), content: threeRecordContent() }), { content: threeRecordContent(), tools: mergeToolMarks([], [toolMark({ seq: 5, timeMs: 2200, spanId: 'sp-a' })]).marks })` | the `sp-a` agent lane has `toolCalls === 1` and one `activity` mark of `kind === 'tool'` | `timeline.test.mjs` | unit |

#### Cases — the loader drops an answer whose session is gone

New banner in `tools/argus-ui/test/page.test.mjs`:
`// Criterion 5, round 1 — a refresh answer for another session never reaches these lanes.`
All three use the tightened `functionSource`.

| # | Case | Input / state | Expected | File | Level |
| --- | --- | --- | --- | --- | --- |
| 10 | the timeline loader drops an answer that arrived after the selection moved on | `functionSource(appJs, 'loadTimeline')` | matches `/state\.selectedSessionId\s*!==\s*id/`; the index of that guard is greater than `indexOf('await')` and smaller than `indexOf('state.content =')` — assert each index `>= 0` first, with its own message, so a missing piece fails on its own name | `page.test.mjs` | source |
| 11 | the timeline loader merges tool events instead of appending them blind | `functionSource(appJs, 'loadTimeline')` | matches `/mergeToolMarks\(/`, and `assert.doesNotMatch(…, /state\.toolMarks\.push\(/)` — the de-duplicating merge is the only way in | `page.test.mjs` | source |
| 12 | app.js takes the merge from the timeline module | the whole `app.js` source | the `from './timeline.js'` import statement names `mergeToolMarks` (match `/import\s*\{[^}]*\bmergeToolMarks\b[^}]*\}\s*from\s*['"]\.\/timeline\.js['"]/`) — so the tested function is the one the page runs | `page.test.mjs` | source |

#### Deliberately untested, and why

- **The race itself, end to end** (two overlapping `refresh()` calls against a
  fake collector). It needs a DOM and a fetch harness; jsdom is a dependency, and
  zero dependencies is this project's first rule. Cases 1–9 pin the state
  transition that made the race destructive, and cases 10–12 pin that
  `loadTimeline` is wired to it — which is as close as this project reaches.
- **The collector's `sinceSeq` semantics.** Owned by `tools/argus`' suite;
  re-asserting them here would pin someone else's behaviour.
- **`state.content`'s stale write.** Fixed by the same guard, and case 10 pins
  that the guard precedes the `state.content` write, so it needs no case of its
  own.
- **Everything increment 3's earlier round already pins** — buckets, curve
  scaling, geometry, escaping, the composition — is untouched by this change and
  re-run by the command below.
- **`tools/argus`, `styles.css`, `README.md`, the landing view, scrubbing, live
  mode and per-lane selection.** Not touched, or not this increment's.

#### What counts as done

```
npm --prefix tools/argus-ui test
```

That one command, from the repository root, is the whole list. It runs the new
cases together with all five existing test files, costs seconds and needs no
install. `tools/argus` and `./test.sh` stay off the list: nothing outside
`tools/argus-ui` changes, and the closing increment owns the full-suite run.

#### What is already red

I did not run the list, not once and not as a baseline; the first run belongs to
whoever runs it downstream. From reading: the reviewer's run was 61 cases, 0
failed, and nothing has changed since, so the twelve new cases are the only ones
whose first result is unknown — and before the fix they are red by construction
(`mergeToolMarks` does not exist, and `loadTimeline` carries neither the guard
nor the merge). The `functionSource` change turns no existing case red, per the
check above.

## Increment 3 — Round 2

The reviewer's `## Increment 3 — Round 1` section raises **one finding**, and
this section plans that fix and nothing else. No case, command or instruction
from any earlier section carries over; what binds now is below.

### The finding, restated

`tools/argus-ui/public/timeline.js:203–225`, `activityMarks`. The function maps
an item's `timeMs` to a bucket and the bucket to a `leftPct`, and the rendered
`<span class="lane-mark" style="left:…%">` carries that value — but no case in
the suite constrains it. Replace the body's `bucket` with the constant `0` and
every mark of every lane paints at the left edge whatever moment it happened at;
`npm --prefix tools/argus-ui test` still passes 73/73. The reviewer walked each
assertion that touches the marks and showed why: the count/kind cases assert
count and kind only, the same-moment case asserts the two `leftPct` are equal
*to each other* (`0 === 0` passes), the bounding case asserts `0 <= leftPct <
100` (0 passes), and the render cases assert only that `data-kind="request"` and
`data-kind="tool"` appear. "Activity **over time**" is therefore the one half of
this increment's criterion that nothing verifies.

**The production code is correct; only the tests are missing.** I read
`activityMarks` and `renderTimeline` line by line and, to settle the exact
numbers this plan pins rather than guess them, ran one throwaway import of
`public/timeline.js` (not the suite, not `node --test`) — reported under
"Numbers I verified" below, with why. So this round adds cases and changes no
production file.

### Implementation plan

One file is edited: `tools/argus-ui/test/timeline.test.mjs`. Append a new banner
and four cases after the existing last case (`the merged index is what the
density reads`, `:654–665`). Every existing case stays byte-for-byte as it is,
and the import list at the top of the file already names everything the new
cases need (`activityMarks`, `ACTIVITY_BUCKETS`, `buildLanes`, `buildDensity`,
`renderTimeline`, `record`-style factories) — no import line changes.

No change to `public/timeline.js`, `public/app.js`, `public/styles.css`,
`test/page.test.mjs`, any README, or anything under `tools/argus`. If a new case
comes out red, the fault is in the case's arithmetic, not in `activityMarks`:
compare it against the verified numbers below before touching production code,
and if `activityMarks` genuinely disagrees with them, say so rather than
loosening the assertion.

### Numbers I verified, so nobody has to re-derive them

Run once, deliberately, because a pinned constant that is wrong by a bucket
turns into a loosened assertion downstream and the finding comes back. Window
`{ startMs: 1000, endMs: 5000 }`, so a span of 4000 ms and
`ACTIVITY_BUCKETS === 120`, one bucket = 33⅓ ms of time and
`100 / 120 = 0.8333…` percent of track.

- `activityMarks([{timeMs:1000},{timeMs:2000},{timeMs:3000},{timeMs:4000}]` all
  `kind:'request'`, window`)` returns four marks with `leftPct` exactly
  `[0, 25, 50, 75]` — the fractions 0, ¼, ½, ¾ are whole multiples of 1/120, so
  these are exact equalities, not approximations. Do not add ± tolerance here;
  the point of the case is the exact mapping.
- An item at `1000 + 4000/3` (fraction ⅓) lands at `leftPct === 32.5`, not
  33.333: `(1333.333…/4000)*120` is `39.999…` in floating point and floors to
  bucket 39. The error is one bucket low, which is the documented resolution —
  so any non-round-fraction assertion must be "at or below the ideal, by at most
  one bucket width", never an equality and never a symmetric tolerance.
- Rendered: `buildDensity(buildLanes({ session: session(), content }), {
  content, tools: [...] })` with main-session requests at `timeMs` 2000 and 4000
  and one tool mark at 3000 produces, in document order, exactly three
  `lane-mark` spans: `request` at `left:25.000%`, `tool` at `left:50.000%`,
  `request` at `left:75.000%`. A tool mark whose `spanId` matches no agent lane
  falls to `main`, which is why a `spanId: null` tool lands on the only lane.
- The regex that reads them, checked against the real markup (the attribute sits
  on the next source line, so `[\s\S]*?` is required and `\s+` alone is
  brittle):
  `/<span class="lane-mark" data-kind="([a-z]+)"[\s\S]*?style="left:([0-9.]+)%"/g`.
  The `.lane-bar` also carries a `left:`, which is why the class must be part of
  the pattern.

### Decisions I rejected

- **Changing `activityMarks` to round instead of floor**, so fraction ⅓ lands on
  33.333. It would make one assertion prettier and shift every mark up to half a
  bucket to the right of the moment it belongs to; the finding asks for a test,
  not for different behaviour, and a production change here would be scope I was
  not given.
- **A DOM-level case that measures a mark's computed position.** Needs jsdom;
  zero runtime and dev dependencies is this project's first rule
  (`tools/argus-ui/CLAUDE.md`). The render case reads the `style` attribute out
  of the markup string instead, which is what this project can do and what every
  other render case here already does.
- **Asserting the pixel relationship between a mark and the curve** (that a
  mark at time *t* sits over the curve vertex at time *t*). `contextPoints` maps
  time exactly and `activityMarks` maps it to bucket resolution, so they legally
  differ by up to one bucket; a case pinning them together would pin an
  approximation as if it were a contract.
- **A property-style case over random times.** A failure would report a random
  input and read as flaky; four fixed cases with stated arithmetic fail with the
  same information every time.
- **Re-asserting the count, kind, bounding and bucketing facts** the existing
  cases already own. They are green and untouched; the new cases add only the
  position half.

### Module map

| Path | What it holds | Entry points |
| --- | --- | --- |
| `tools/argus-ui/test/timeline.test.mjs` | 665 lines, unit cases over the pure module; factories `session()` (`:20`), `record()` (`:21`), `threeRecordContent()` (`:39`), `toolMark()` (`:70`) at the top; banner comments separate the groups; the import list at `:4–17` already names every export the new cases use | **the only file edited**: four cases appended after `:665` under a new banner |
| `tools/argus-ui/public/timeline.js` | `activityMarks` (`:203`) buckets an item's `timeMs` into `ACTIVITY_BUCKETS` (`:27`) columns and returns `{ leftPct, kind, count }` sorted by `leftPct` then `kind`; `renderTimeline` (`:321`) writes `leftPct.toFixed(3)` into `style="left:…%"` on `<span class="lane-mark">` (`:346–351`); `buildDensity` (`:239`) feeds it one `request` item per `api_request_body` record and one `tool` item per tool event, a tool on an unowned span falling to `main` (`:260`) | **untouched** — read only |
| `tools/argus-ui/public/app.js`, `public/styles.css`, `test/page.test.mjs`, both READMEs, `tools/argus/**` | — | **untouched this round** |

### Environment

- Node v22.22.2 at `/opt/node22/bin/node`, on the `PATH`; the package requires
  ≥ 20.11.
- `tools/argus-ui` has zero runtime and zero dev dependencies. `npm install` is
  not needed and must not become needed.
- Whole package, from the repository root: `npm --prefix tools/argus-ui test`
  (`node --test "test/*.test.mjs"`).
- The one edited file alone, from the repository root:
  `node --test tools/argus-ui/test/timeline.test.mjs`.
- `public/timeline.js` is importable by `node --test` because the package is
  `"type": "module"`; no loader flag.
- There is no linter and no formatter in this repository: nothing to run.

### Test Plan

Tests are needed, and they are the whole of this round's work: the finding is a
missing constraint, so the correction *is* the cases. Framework: `node:test`
with `node:assert/strict`, the only thing this project uses.

Conventions, taken from `test/timeline.test.mjs` itself: every test name is a
full lowercase sentence stating the fact it pins; fixtures are the local
factories at the top of the file and nothing else — no mocks, no DOM, no
`fetch`, no fake timers; an assertion that could be read two ways carries a
message saying what the fact is; a banner comment introduces each group; and no
case asserts a user-visible sentence, only structure and numbers.

New banner, appended at the end of the file:
`// Criterion 5, round 2 — a mark sits where its moment sits, not merely somewhere on the track.`

#### Cases

| # | Case name | Input / state | Expected | File | Level |
| --- | --- | --- | --- | --- | --- |
| 1 | `a mark sits at the fraction of the track its moment sits at in the window` | `activityMarks([{ timeMs: 1000, kind: 'request' }, { timeMs: 2000, kind: 'request' }, { timeMs: 3000, kind: 'request' }, { timeMs: 4000, kind: 'request' }], { startMs: 1000, endMs: 5000 })` | `assert.deepEqual(marks.map((mark) => mark.leftPct), [0, 25, 50, 75])` with a message naming that these are quarters of the window; exact equality, no tolerance. This is the case the finding's mutation (`const bucket = 0`) fails. | `tools/argus-ui/test/timeline.test.mjs` | unit |
| 2 | `a later moment always sits strictly right of an earlier one` | `activityMarks` over six `{ kind: 'tool' }` items at `timeMs` 1000, 1500, 2200, 3000, 3700, 4900 in the same window; marks come back sorted by `leftPct` | every consecutive pair satisfies `marks[i + 1].leftPct > marks[i].leftPct`, and for each mark `ideal - mark.leftPct` is `>= 0` and `<= 100 / ACTIVITY_BUCKETS + 1e-6`, where `ideal = ((timeMs - 1000) / 4000) * 100` for the item at the same index of the sorted input — assert with a message saying a mark may sit at most one bucket left of its moment and never right of it. Do **not** write an equality here: fraction ⅓-style inputs floor a bucket low (32.5 for 33.333), which the `>= 0` half deliberately allows. | `tools/argus-ui/test/timeline.test.mjs` | unit |
| 3 | `the rendered marks carry the positions their moments earned` | `const content = [record({ seq: 1, timeMs: 2000, bodyLength: 10 }), record({ seq: 2, timeMs: 4000, bodyLength: 20 })];` then `renderTimeline(buildDensity(buildLanes({ session: session(), content }), { content, tools: [toolMark({ seq: 9, timeMs: 3000, spanId: null })] }))` | collect `[...html.matchAll(/<span class="lane-mark" data-kind="([a-z]+)"[\s\S]*?style="left:([0-9.]+)%"/g)]` and assert `deepEqual` of `[kind, left]` pairs to `[['request', '25.000'], ['tool', '50.000'], ['request', '75.000']]`, plus `assert.doesNotMatch(html, /NaN/)`. This is the case that pins the value reaching the markup rather than only the value `activityMarks` returns. | `tools/argus-ui/test/timeline.test.mjs` | unit (render, string-level) |
| 4 | `a mark keeps following its moment when the window does not start at zero` | `activityMarks([{ timeMs: 1_700_000_000_000, kind: 'request' }, { timeMs: 1_700_000_002_000, kind: 'request' }], { startMs: 1_700_000_000_000, endMs: 1_700_000_008_000 })` — epoch-scale times, the real shape of the data | two marks with `leftPct` exactly `[0, 25]`, with a message that a mark's position is measured from the window start and not from the epoch. Fails if the `- startMs` subtraction is dropped. | `tools/argus-ui/test/timeline.test.mjs` | unit |

Case 3 needs `session()`, `record()` and `toolMark()` exactly as the file already
defines them; `session()` gives `firstSeenMs: 1000, lastSeenMs: 5000`, which is
what makes the window 1000…5000 and the three expected positions the ones above.
`toolMark({ spanId: null })` lands on `main` because no agent lane owns that
span — the fixture has no subagent record.

#### Deliberately untested, and why

- **Where a mark ends up in pixels, and whether it visually overlaps its bar.**
  Needs a DOM and therefore a dependency; the `style` attribute in the markup is
  the last thing this project can observe, and case 3 observes it.
- **Sub-bucket precision.** 120 buckets over the window is the chosen
  resolution; pinning finer would pin a number the design does not promise, which
  is why case 2 asserts a one-bucket band rather than an equality.
- **Count, kind, bucket bounding, the 500-record ceiling, curve scaling,
  geometry, `mergeToolMarks`, escaping and the composition of curve and bar.**
  All already pinned by cases the reviewer walked and found sound; they are
  re-run by the command below and need nothing new.
- **`app.js` wiring, `styles.css`, `tools/argus`, the landing view, scrubbing,
  live mode and per-lane selection.** Untouched by this round, or not this
  increment's.

#### What counts as done

```
npm --prefix tools/argus-ui test
```

That one command, from the repository root, is the whole list. It runs the four
new cases together with all five test files of the package, costs seconds and
needs no install. `tools/argus`' own suite and `./test.sh` stay off the list:
nothing outside `tools/argus-ui/test/timeline.test.mjs` changes this round, and
the closing increment owns the full-suite run.

#### What is already red

I did not run that command, not once and not as a baseline; the first run belongs
to whoever runs it downstream. From reading and from the reviewer's report: the
last run was 73 cases, 73 passing, exit 0, and no production file changes this
round, so all 73 stay green and the four new cases are the only ones whose first
result is unknown. Unlike the earlier rounds, they are expected to pass on the
first run — `activityMarks` already computes what they assert, and the numbers
they pin are the ones I verified above. A red new case means the case's
arithmetic is wrong, not the module.
