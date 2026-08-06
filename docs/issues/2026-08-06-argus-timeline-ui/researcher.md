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

