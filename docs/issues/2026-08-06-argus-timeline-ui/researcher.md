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

## Increment 4 — the timeline scrubs, and a live mode follows the head

This increment changes `tools/argus-ui` only, and inside it four files. The
collector is not touched: a time cursor is page state over data the page already
holds, and nothing about it belongs in a headless collector. No new file, no new
dependency, no change to any route.

I read the code and ran nothing — no test, no capture, no baseline. The
increment turns on no question about the telemetry: increments 1–3 already
settled what arrives and how it is attributed, and the window the cursor moves
in is `buildLanes`' own `startMs`…`endMs`, which is already in the page.

### What the criterion asks for, restated as the change

The timeline gains a **time cursor**: a `<input type="range">` whose value *is*
a timestamp in the session window, a vertical line drawn over the lanes at that
moment, a clock readout of it, and a **Live** control. The cursor has two modes,
held in one page-state object `state.cursor`:

- `{ live: true, timeMs: null }` — every render resolves the cursor to the
  window's `endMs`, so as new data extends the window the cursor moves with it.
  That is "follows the newest data as it arrives", and it rides the SSE refresh
  the page already does; no new polling, no timer.
- `{ live: false, timeMs: <ms> }` — the cursor is pinned to an absolute moment
  and stays on it while the session grows around it. Dragging the range produces
  exactly this, which is "scrubbing away from the head leaves live mode".

The **Live** button writes `{ live: true, timeMs: null }` back, which is the
control that returns to live mode.

Nothing is selected at the cursor yet — the two detail panels are increments 5
and 6. No code here may anticipate them and no case may pin them.

### Implementation plan

**A. `tools/argus-ui/public/timeline.js` — three pure functions and a second
argument to `renderTimeline`.**

New exported functions, next to the existing pure ones:

- `liveCursor()` → `{ live: true, timeMs: null }`, a **fresh object per call**.
  A shared frozen constant would be mutable-by-reference from the page; a
  factory keeps the shape in one place with no shared instance.
- `scrubCursor(timeMs, window)` → `{ live: false, timeMs: <clamped> }`. The
  clamp is into `window.startMs`…`window.endMs`; a non-finite `timeMs` falls back
  to `window.endMs`. It **always** returns `live: false`, including for a scrub
  that lands exactly on the head — see the decisions.
- `resolveCursor(cursor, window)` → `{ live, timeMs, leftPct }`, leaving its
  argument untouched:
  1. `startMs = window?.startMs ?? 0`, `endMs = Math.max(startMs, window?.endMs ?? startMs)`;
  2. `cursor?.live === false` is the only thing that is not live — so `null`,
     `undefined` and `{ live: true }` all resolve live, which is what keeps
     `renderTimeline(view)` (increments 2 and 3's call shape) working;
  3. live → `timeMs = endMs`;
  4. not live → `timeMs = clamp(Number.isFinite(cursor.timeMs) ? cursor.timeMs : endMs, startMs, endMs)`;
  5. `span = endMs - startMs`;
     `leftPct = span > 0 ? clamp(((timeMs - startMs) / span) * 100, 0, 100) : 100`.
     The `span > 0` branch is what stops a one-instant session dividing by zero,
     and it puts the cursor of such a session on the head rather than at 0, so
     both modes agree there.

`renderTimeline(view, cursor = null)` gains a second parameter and two blocks of
markup. It resolves once — `const active = resolveCursor(cursor, window)` — and
both blocks read that one result, so the thumb, the line and the readout can
never disagree. The markup, exactly:

```html
<div class="panel timeline-panel">
  <div class="timeline">
    <div class="timeline-legend">…unchanged…</div>
    <div class="timeline-scrub">
      <span class="scrub-time" id="timeline-cursor-time" data-time="<active.timeMs>"><fmtClock(active.timeMs)></span>
      <input type="range" id="timeline-scrub" class="scrub-range" min="<window.startMs>"
             max="<window.endMs>" step="1" value="<active.timeMs>" aria-label="Time cursor">
      <button type="button" class="ghost-button scrub-live" data-cursor-live
              aria-pressed="<active.live>">Live</button>
    </div>
    <div class="timeline-axis">…unchanged…</div>
    <div class="timeline-lanes">
      <div class="timeline-cursor" aria-hidden="true">
        <span class="timeline-ahead" data-cursor-pos style="left:<active.leftPct.toFixed(3)>%"></span>
        <span class="timeline-cursor-line" data-cursor-pos style="left:<active.leftPct.toFixed(3)>%"></span>
      </div>
      …the lane rows, each exactly as today…
    </div>
  </div>
</div>
```

Points that are load-bearing, not taste:

- The range's `min`/`max` **are** the window in milliseconds and its `value` is
  the cursor's own timestamp, so no fraction arithmetic sits between the control
  and the model — and the page can recover the window from the element itself.
- The lane rows move inside a new `<div class="timeline-lanes">`; that element is
  the positioning context the cursor overlay is absolutely placed in. The rows'
  own markup does not change.
- `data-cursor-pos` marks every element whose `left` is the cursor position, and
  `data-cursor-live` marks the control that returns to live. Both are the hooks
  the page wires and the tests read; neither collides with anything in the
  project (`#live-indicator` uses `data-state` and sits outside `#detail`).
- The interpolated values follow this file's convention: numbers through
  `.toFixed(3)` inside `style`, everything else through `esc(...)`.
- Class names avoid the substrings `lane-curve` and `lane-mark`, because
  increment 3's "a lane with nothing on it renders as a bare lane" case asserts
  those two strings are absent from the whole markup.

**B. `tools/argus-ui/public/app.js` — state, two small functions, three wirings.**

- State: `cursor: { live: true, timeMs: null }` next to `content`. A session
  opens live; that is the landing state the criterion's "follows the newest data"
  half describes.
- `selectSession` sets `state.cursor = liveCursor()` beside the existing
  `state.content = []` reset, so a new session never inherits a moment pinned in
  another one.
- `renderDetail` passes the cursor:
  `renderTimeline(buildDensity(buildLanes({ session, content: state.content }), { content: state.content, tools: state.toolMarks }), state.cursor)`.
- Two new top-level functions, so the wiring has a name a test can read:
  ```js
  /** The cursor's position, written straight into the DOM: a full re-render would
   *  replace the slider under the pointer and end the drag. */
  function paintCursor() {
    const input = document.getElementById('timeline-scrub');
    if (!input) return;
    const active = resolveCursor(state.cursor, { startMs: Number(input.min), endMs: Number(input.max) });
    for (const node of document.querySelectorAll('[data-cursor-pos]')) {
      node.style.left = `${active.leftPct.toFixed(3)}%`;
    }
    input.value = String(active.timeMs);
    const readout = document.getElementById('timeline-cursor-time');
    if (readout) {
      readout.textContent = fmtClock(active.timeMs);
      readout.dataset.time = String(active.timeMs);
    }
    const control = document.querySelector('[data-cursor-live]');
    if (control) control.setAttribute('aria-pressed', String(active.live));
  }

  /** A drag reads its window off the control it came from. */
  function scrubTo(input) {
    state.cursor = scrubCursor(Number(input.value), { startMs: Number(input.min), endMs: Number(input.max) });
    paintCursor();
  }
  ```
- Wiring in `wireEvents`, all three on the `#detail` element that already carries
  the delegated listeners:
  1. the existing `input` listener gains, **before** its
     `if (event.target.id !== 'event-search') return;` line:
     `if (event.target.id === 'timeline-scrub') { scrubTo(event.target); return; }`
     — this is what keyboard scrubbing (arrow keys on a range) goes through too;
  2. the existing `click` listener gains, after the `[data-copy]` branch:
     `const live = event.target.closest('[data-cursor-live]'); if (live) { state.cursor = liveCursor(); renderDetail(); return; }`
     — returning to live is a full re-render, which is safe: no drag is in flight;
  3. a `pointerdown` listener on `#detail` sets a module-level `let scrubbing = false;`
     to `true` when `event.target.id === 'timeline-scrub'`, and `pointerup` plus
     `pointercancel` on `window` set it back to `false` (the pointer is often
     released outside the slider).
- `scheduleRefresh` defers while a drag is in flight, or the SSE refresh that
  fires on every ingest replaces the slider mid-drag and the scrub dies under the
  pointer:
  ```js
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    if (scrubbing) { scheduleRefresh(delay); return; }
    refresh().catch(() => setLive('offline', 'error'));
  }, delay);
  ```
- Imports: `resolveCursor`, `scrubCursor`, `liveCursor` join the existing
  `./timeline.js` import list. `fmtClock` is already imported from `./format.js`.

**C. `tools/argus-ui/public/styles.css` — appended to the timeline block
(lines 786–933), plus nothing in the responsive block.**

```css
.timeline-scrub {
  display: grid;
  grid-template-columns: var(--label-w) 1fr var(--meta-w);
  gap: 8px;
  align-items: center;
  margin-bottom: 6px;
}

.scrub-time { font-family: var(--mono); font-size: 10px; color: var(--text-faint); }

.timeline-scrub input[type="range"] { width: 100%; margin: 0; accent-color: var(--accent); cursor: ew-resize; }

.scrub-live { justify-self: end; padding: 2px 8px; font-size: 10px; }
.scrub-live[aria-pressed="true"] { color: var(--accent); border-color: var(--accent); }

.timeline-lanes { position: relative; }

/* Exactly the track column: the lane grid is label | 1fr | meta with an 8px gap. */
.timeline-cursor {
  position: absolute;
  top: 0;
  bottom: 0;
  left: calc(var(--label-w) + 8px);
  right: calc(var(--meta-w) + 8px);
  pointer-events: none;
}

.timeline-cursor-line { position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px; background: var(--accent); }

/* Everything after the cursor is dimmed, so "as of this moment" reads at a glance. */
.timeline-ahead { position: absolute; top: 0; bottom: 0; right: 0; background: color-mix(in srgb, var(--bg) 55%, transparent); }
```

The responsive block at line ~1148 already overrides `--label-w` and `--meta-w`
on `.timeline`, and the `calc()`s above read them, so the overlay follows the
narrow layout with no second rule. `color-mix` is already used in this file, and
every colour named here exists in both `:root` and the light-mode block.

**D. `tools/argus-ui/README.md` — one edit.** The **Timeline** bullet (around
line 61) gains that the timeline carries a time cursor that can be dragged to any
moment of the session and a live mode, left by scrubbing and returned to with the
Live control. `CLAUDE.md` needs no change: no convention changes.

### Decisions, and what I rejected

- **A native `<input type="range">` as the scrub control**, rather than
  pointer-drag handling on the lane track. It gives dragging, keyboard scrubbing
  and focus behaviour for free in a project with zero dependencies and no DOM
  test harness, and its `min`/`max`/`value` carry the model so nothing has to be
  recomputed from pixel offsets. Rejected: `pointerdown`/`pointermove`/
  `pointercapture` on the track (more untestable DOM code, no keyboard, and
  `getBoundingClientRect` arithmetic that this project cannot test at all).
- **The range's value is a timestamp**, not a per-mille fraction. One less
  conversion, and the page can read the window back off the element instead of
  stashing it in state.
- **Any scrub leaves live mode, including a scrub that lands exactly on the
  head.** Live is a *following* mode; a cursor a human parked on the current head
  must not silently start moving when the next record arrives. The criterion asks
  for a control that returns to live, and that control is the only way back.
  Rejected: auto-resuming live when the thumb reaches the right edge (a
  video-player idiom that makes the mode change without the human asking).
- **A pinned cursor keeps its absolute moment while the window grows**, so its
  `leftPct` shrinks as the session lengthens. The alternative — holding the
  position and letting the moment drift — would silently rewrite what the human
  selected.
- **A one-instant window puts the cursor at the head (`leftPct` 100), not at 0.**
  The two modes then agree in the degenerate case, and no division by zero can
  reach a style attribute.
- **The overlay is drawn from one resolution.** `renderTimeline` calls
  `resolveCursor` once; `paintCursor` calls it once. Two call sites computing a
  position independently is how a thumb and a line drift apart.
- **A drag is answered by writing `style.left` directly, never by re-rendering.**
  `renderDetail` replaces `#detail.innerHTML` wholesale, which would destroy the
  slider the pointer is holding. Same reason `scheduleRefresh` defers while a
  drag is in flight rather than re-rendering behind it.
- **Rejected: zooming or windowing the timeline to the cursor.** The window is
  the whole recorded session; the criterion asks for a cursor in it, not a
  viewport over it.
- **Rejected: a playback speed, a play/pause pair, or stepping controls.** The
  issue's own assumptions say no playback machinery is asked for.
- **Rejected: putting the cursor in the collector or in a URL parameter.** The
  cursor is view state of one open page; the hash already carries the session.
- **Rejected: filtering the lanes, curves or marks to the left of the cursor.**
  What the cursor selects is increments 5 and 6; drawing less of the timeline
  than it draws today would be a regression against increment 3's criterion.
- **Rejected: a second cursor for a range selection.** Not asked for.

### Consequences to accept, not paper over

- A range input's thumb travels the track minus the thumb's own width, so at the
  extreme ends the thumb centre and the cursor line can differ by a few pixels.
  The line is the truth; the thumb is the grip.
- While a drag is in flight, the page stops refreshing (up to the drag's
  duration). The next scheduled refresh runs as soon as the pointer is released.
- A cursor pinned before the oldest record the 2000-record content window still
  holds points at a moment whose lanes are already absent — increment 2's
  recorded consequence, unchanged here.
- The `.timeline-ahead` shade dims the marks and curve to the right of the
  cursor. That is the intent (the future of the chosen moment), not a loss: the
  Live control restores the full-brightness head in one click.

### Module map

| Path | What it holds | Entry points |
| --- | --- | --- |
| `tools/argus-ui/public/timeline.js` | Lane derivation, density, cursor resolution and the timeline markup; pure, no DOM | **new** `liveCursor`, `scrubCursor`, `resolveCursor`; **changed** `renderTimeline(view, cursor = null)` |
| `tools/argus-ui/public/app.js` | The page: state, fetching, rendering, wiring | `state.cursor`, **new** `paintCursor`, `scrubTo`, module-level `scrubbing`; **changed** `selectSession`, `renderDetail`, `scheduleRefresh`, `wireEvents`, the `./timeline.js` import line |
| `tools/argus-ui/public/styles.css` | Every style; dark-first with a light-mode `:root` | the timeline block, lines 786–933 |
| `tools/argus-ui/README.md` | User-facing page | the **Timeline** bullet, around line 61 |
| `tools/argus-ui/public/format.js` | `esc`, `fmtNum`, `fmtDur`, `fmtClock`, … | unchanged; `fmtClock(ms)` prints `HH:MM:SS.mmm` and returns `–` for a falsy `ms` |
| `tools/argus-ui/test/timeline.test.mjs` | Unit cases over `public/timeline.js` | fixtures `session()`, `record()`, `threeRecordContent()`, `toolMark()` |
| `tools/argus-ui/test/page.test.mjs` | Source-level cases over `public/` | helpers `walk()`, `functionSource(source, name)` |
| `tools/argus-ui/test/independence.test.mjs` | The no-outside-imports rule and the project's file list | **unchanged** — no new file under `public/`, so nothing to add |

Facts about the code this plan rests on, so nobody has to go and read for them:

- `buildLanes(...)` returns `{ startMs, endMs, durationMs, lanes }`; `startMs`
  and `endMs` are the whole recorded session (the main lane is the session's own
  `firstSeenMs`…`lastSeenMs`, widened by any subagent record outside it).
  `buildDensity` passes both through untouched. That pair **is** the scrub
  window; nothing new has to be derived for it.
- `renderDetail` (`app.js:142`) replaces `#detail.innerHTML` wholesale and then
  calls `renderTabBody`; `refresh` (`app.js:906`) calls it after every load and
  restores scroll position and the focused element by `id`.
- `scheduleRefresh` (`app.js:975`) is the 400 ms debounce every SSE `ingest`
  event goes through; `connectStream` is its only caller besides itself.
- `#detail` already carries delegated `click`, `change` and `input` listeners;
  the `input` one currently returns early for anything that is not
  `#event-search`.
- The lane grid is `grid-template-columns: var(--label-w) 1fr var(--meta-w)` with
  `gap: 8px` (`styles.css:852`), which is why the overlay's inset is
  `calc(var(--label-w) + 8px)` / `calc(var(--meta-w) + 8px)`.

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
  `"type": "module"`: `import { resolveCursor } from '../public/timeline.js';`
  works with no loader flag.
- **There is no linter and no formatter in this repository** — nothing to run,
  nothing to configure.
- `./test.sh` runs every suite in the repository. It is **not** on this
  increment's list: the closing increment (`tool-usage`) owns it, and nothing
  outside `tools/argus-ui` changes here.

### Test plan

Tests are needed. Framework: `node:test` with `node:assert/strict`, the only
thing this project uses. Conventions, taken from the two files the cases land in:
every test name is a full lowercase sentence stating the fact ('scrubbing to the
head still leaves live mode'); fixtures are the local factories already at the
top of the file (`session()`, `record()`, `threeRecordContent()`, `toolMark()` in
`timeline.test.mjs`; `walk()`, `functionSource()` in `page.test.mjs`); nothing is
mocked beyond those; every assertion that could be read two ways carries a
message saying what the fact is; banner comments separate the criteria; and a
fact is asserted as a number or an attribute, never as a wording — which is why
the cursor's moment goes into `data-time` and no case asserts the readout's text.

Two files are edited; **no test file is created** and no new fixture is needed.
Both new blocks go under a new banner appended after the existing cases:

```js
// Criterion 6 — the timeline scrubs, and a live mode follows the head.
```

`window` below means `{ startMs: 1000, endMs: 5000 }` unless a case says
otherwise — the same window `session()` produces.

#### One existing case is edited, deliberately

`timeline.test.mjs`, the increment-2 case **'the rendered timeline carries one
bar for the main session and one for the subagent, each with valid geometry'**,
scans *every* `style="…"` in the markup and requires each to carry both `left:`
and `width:`. The cursor overlay adds two elements whose style is a `left:` only,
so that loop turns red on correct code. Narrow the scan to the elements whose
fact it is:

```js
const styles = [...html.matchAll(/<span class="lane-bar"[^>]*style="([^"]*)"/g)].map((m) => m[1]);
assert.equal(styles.length, 2, 'both lane bars must carry their geometry as a style');
```

keeping the existing per-style `left:` / `width:` / no-`NaN` assertions inside
the loop, and adding `assert.doesNotMatch(html, /NaN/)` after it so the whole
markup stays covered against `NaN`. The fact the case pins is unchanged and
sharper: two bars, each with valid geometry, and nothing anywhere prints `NaN`.
No other existing case changes — the new class names contain neither `lane-curve`
nor `lane-mark`, and the mark-position regex binds each `lane-mark` to its own
`style`.

#### The criterion — the timeline scrubs to any point, and a live mode follows the head

| # | Case | Input / state | Expected | File | Level |
| --- | --- | --- | --- | --- | --- |
| 1 | a session opens live, with the cursor on the newest data | `resolveCursor(liveCursor(), window)` | `deepEqual` `{ live: true, timeMs: 5000, leftPct: 100 }` | `timeline.test.mjs` | unit |
| 2 | live mode follows the head as new data arrives | one `liveCursor()` resolved against `{1000,5000}` then `{1000,9000}` | `timeMs` 5000 then 9000, `leftPct` 100 both times — the mode follows, it does not merely start at the end | `timeline.test.mjs` | unit |
| 3 | a scrubbed cursor stays on its moment while the session grows | `{ live: false, timeMs: 3000 }` against `{1000,5000}` then `{1000,9000}` | `timeMs` 3000 both times; `leftPct` 50 then 25 | `timeline.test.mjs` | unit |
| 4 | the cursor never leaves the recorded session | `{ live: false, timeMs: 0 }` and `{ live: false, timeMs: 99999 }` | `timeMs` 1000 / `leftPct` 0, and `timeMs` 5000 / `leftPct` 100 | `timeline.test.mjs` | unit |
| 5 | a pinned cursor with no usable time falls back to the head and stays out of live | `{ live: false, timeMs: null }` and `{ live: false }` | both `{ live: false, timeMs: 5000, leftPct: 100 }` | `timeline.test.mjs` | unit |
| 6 | no cursor at all is live | `resolveCursor(undefined, window)`, `resolveCursor(null, window)`, `resolveCursor({}, window)` | all three `live === true`, `timeMs === 5000` — this is what keeps `renderTimeline(view)` working | `timeline.test.mjs` | unit |
| 7 | a one-instant session resolves to a finite position at the head | window `{ startMs: 1000, endMs: 1000 }`, live cursor and `{ live: false, timeMs: 1000 }` | both `timeMs === 1000` and `leftPct === 100`, `Number.isFinite` on both numbers | `timeline.test.mjs` | unit |
| 8 | resolving does not mutate the cursor it was given | `const cursor = { live: false, timeMs: 99999 }`, resolve it | `deepEqual(cursor, { live: false, timeMs: 99999 })` afterwards | `timeline.test.mjs` | unit |
| 9 | scrubbing leaves live mode | `scrubCursor(3000, window)` | `deepEqual` `{ live: false, timeMs: 3000 }` | `timeline.test.mjs` | unit |
| 10 | scrubbing to the head still leaves live mode | `scrubCursor(5000, window)` | `{ live: false, timeMs: 5000 }` — landing on the head is not the same as following it | `timeline.test.mjs` | unit |
| 11 | a scrub past either end is pinned to the end it passed | `scrubCursor(-10, window)`, `scrubCursor(10_000_000, window)` | `timeMs` 1000 and 5000, `live === false` in both | `timeline.test.mjs` | unit |
| 12 | a scrub with no usable number lands on the head, never on NaN | `scrubCursor(Number.NaN, window)`, `scrubCursor(undefined, window)` | both `{ live: false, timeMs: 5000 }` | `timeline.test.mjs` | unit |
| 13 | the live cursor is a fresh object every call | `liveCursor()` twice | each `deepEqual` `{ live: true, timeMs: null }`; `assert.notEqual(a, b)` — no shared default a caller could pin | `timeline.test.mjs` | unit |
| 14 | the scrub control spans the whole recorded session | `renderTimeline(buildDensity(buildLanes({ session: session(), content: threeRecordContent() }), { content: threeRecordContent(), tools: [] }))` | the markup carries one `<input` with `type="range"`, `id="timeline-scrub"`, `min="1000"`, `max="5000"`, a `step=`, and `value="5000"` | `timeline.test.mjs` | unit |
| 15 | a scrubbed cursor puts the thumb, the line and the readout on one moment | same view, cursor `{ live: false, timeMs: 2500 }` | `value="2500"`; every `data-cursor-pos` element's style is `left:37.500%` (assert two of them, matched by regex); `data-time="2500"`; the `data-cursor-live` control carries `aria-pressed="false"` | `timeline.test.mjs` | unit |
| 16 | live puts all three on the head | same view, `liveCursor()` | `value="5000"`, every `data-cursor-pos` style is `left:100.000%`, `data-time="5000"`, `aria-pressed="true"` on the `data-cursor-live` control | `timeline.test.mjs` | unit |
| 17 | the timeline still renders from a bare view with no cursor given | `renderTimeline(buildLanes({ session: session(), content: threeRecordContent() }))` | two `data-lane="` occurrences, one `data-cursor-live` control with `aria-pressed="true"`, `left:100.000%` on the cursor, no `NaN` | `timeline.test.mjs` | unit |
| 18 | a one-instant session still renders a cursor inside the track | `renderTimeline(buildDensity(buildLanes({ session: session({ firstSeenMs: 1000, lastSeenMs: 1000 }), content: [] }), {}))` | `min="1000"`, `max="1000"`, `left:100.000%`, no `NaN` anywhere in the markup | `timeline.test.mjs` | unit |
| 19 | the page opens live | the `const state = {` … `\n};` slice of `app.js`, taken the way the existing landing case takes it | matches `/\bcursor:\s*\{\s*live:\s*true\b/` and does not match `/\bcursor:\s*\{\s*live:\s*false\b/` | `page.test.mjs` | source |
| 20 | the timeline is rendered with the page's cursor | `functionSource(appJs, 'renderDetail')` | contains `renderTimeline(` and `state.cursor`, with the `renderTimeline(` index the smaller of the two — the cursor reaches the renderer, not some other call | `page.test.mjs` | source |
| 21 | selecting a session returns to live | `functionSource(appJs, 'selectSession')` | matches `/state\.cursor\s*=\s*liveCursor\(\)/` — a new session never inherits a moment pinned in another one | `page.test.mjs` | source |
| 22 | a drag moves the cursor without re-rendering the page under the pointer | `functionSource(appJs, 'scrubTo')` | matches `/scrubCursor\(/` and `/paintCursor\(/`, and does **not** match `/renderDetail\(/` | `page.test.mjs` | source |
| 23 | the cursor is painted from one resolution, so the line and the readout cannot disagree | `functionSource(appJs, 'paintCursor')` | matches `/resolveCursor\(/` and `/data-cursor-pos/` | `page.test.mjs` | source |
| 24 | a control returns the page to live | `functionSource(appJs, 'wireEvents')` | matches `/data-cursor-live/` and `/state\.cursor\s*=\s*liveCursor\(\)/` — the control exists in the markup (cases 15–17) and the page acts on it | `page.test.mjs` | source |
| 25 | a refresh never yanks the slider out from under a drag | `functionSource(appJs, 'scheduleRefresh')` | matches `/scrubbing/` | `page.test.mjs` | source |
| 26 | app.js takes the cursor functions from the timeline module | the whole `app.js` source | matches `/import\s*\{[^}]*\bresolveCursor\b[^}]*\}\s*from\s*['"]\.\/timeline\.js['"]/`, and the same for `scrubCursor` and `liveCursor` — the tested functions are the ones the page runs | `page.test.mjs` | source |

Case 15's `left:37.500%` is exact: `(2500 - 1000) / (5000 - 1000) = 0.375`.
Case 3's `leftPct` values are exact for the same reason.

Commands that run just one of these files, from the repository root:

```
node --test tools/argus-ui/test/timeline.test.mjs
node --test tools/argus-ui/test/page.test.mjs
```

#### Deliberately untested, and why

- **The drag itself** — `pointerdown`, `pointerup`, thumb pixels, and whether the
  line lands under the thumb. This project has no DOM harness and will not grow
  one (jsdom is a dependency, and zero dependencies is the project's first rule).
  Case 22 pins that a drag does not re-render; the rest is what the review looks
  at.
- **That `scheduleRefresh` actually defers and then resumes.** Timing behaviour
  behind a `setTimeout` in a module with no seam; case 25 pins that the guard is
  in the code, and the cost of the alternative is a fake clock and an exported
  timer.
- **Colours, the dimming of the region after the cursor, and whether the overlay
  aligns with the lane tracks.** `node --test` sees strings; the geometry is CSS
  and the review is where it is judged.
- **Selecting a lane at the cursor, the context message list, tool names and
  parameters.** Increments 5 and 6 own them; no case here may pin behaviour for
  them.
- **Lane derivation, density, marks, the merge, labels, escaping and the landing
  view.** Increments 2 and 3's cases own them, they stay as they are apart from
  the one narrowing named above, and the command below re-runs them all.
- **`tools/argus`** — not touched by this increment.
- **Recordings made without the content flags** — out of contract by the issue's
  own decision.

#### What counts as done

```
npm --prefix tools/argus-ui test
```

That one command, from the repository root, is the whole list. It runs the new
cases together with every existing case in the package, costs seconds, and needs
no install. `tools/argus`' own suite and `./test.sh` are off the list on purpose:
nothing outside `tools/argus-ui` changes here, and the closing increment owns the
full-suite run.

#### What is already red

I did not run the list, not once and not as a baseline; the first run belongs to
whoever runs it downstream. From reading: nothing is red before the change, and
exactly one existing case would turn red if the markup were added without the
edit named above — the increment-2 geometry case, whose style scan is
deliberately narrowed as part of this increment's work. Every other existing case
is unaffected: `renderTimeline(view)` stays valid (case 6 makes a missing cursor
live), the lane rows' markup is unchanged inside its new wrapper, the new class
names contain neither `lane-curve` nor `lane-mark`, `independence.test.mjs` gets
no new file to guard, and `page.test.mjs`'s flag-absence case is untouched by
anything written here.

## Increment 4 — Round 1

The reviewer raised exactly one finding against increment 4, and it is a
coverage hole, not a behaviour defect: the scrub works, and nothing in the suite
notices when it stops working. This round adds three source-level cases to
`tools/argus-ui/test/page.test.mjs` and changes no production file.

### The finding, restated as the defect to remove

`tools/argus-ui/public/app.js` wires the slider in two places, and both are
unpinned:

1. The delegated `input` listener on `#detail` (`app.js:1113–1118`) routes the
   slider's `input` event to `scrubTo`. Delete those four lines and the suite is
   103/103 green while dragging or arrow-keying the slider changes nothing.
2. The delegated `pointerdown` listener on `#detail` (`app.js:1103–1105`) sets
   the module-level `scrubbing` flag. Delete it and the suite is green again,
   while the `scrubbing` guard inside `scheduleRefresh` — which
   `test/page.test.mjs:290` does pin — becomes dead code and a refresh mid-drag
   replaces the slider under the pointer.

The existing case at `test/page.test.mjs:260` ('a drag moves the cursor without
re-rendering the page under the pointer') reads `scrubTo`'s own body and passes
with `scrubTo` never called by anything. The return-to-live half of the
criterion is pinned at the page level (`test/page.test.mjs:279`); the scrub half
has no equivalent. That asymmetry is the whole of what this round closes.

The reviewer's second item — the in-flight `refresh()` that can still replace the
slider mid-drag — is recorded there as an observation and not a finding. **No
action, no test, no code change for it.** Do not widen the guard.

### Implementation plan

**No production file changes in this round.** `public/app.js`,
`public/timeline.js`, `public/styles.css`, `public/index.html` and
`tools/argus-ui/README.md` all stay exactly as they are; the wiring the finding
names is already correct, and the three new cases are written to pass against it
the moment they exist. Their worth is the mutation they catch, which the
reviewer already measured in a sandbox.

One file is edited: `tools/argus-ui/test/page.test.mjs`. It gains one helper and
three cases, described in the Test Plan below.

If a new case comes out red, the cause is that the helper's anchor string does
not match `app.js` character for character. Then fix the anchor to the real
source text; never weaken or delete an assertion, and never edit `app.js` to
suit a test.

### Decisions, and what I rejected

- **Source-level assertions over `wireEvents`, not a DOM harness.** This project
  has zero runtime and zero dev dependencies and that is its first rule
  (`tools/argus-ui/CLAUDE.md`), so jsdom or happy-dom is not on the table for a
  coverage gap. Every existing case in `page.test.mjs` reads `public/*.js` as
  text; the new ones do the same and are therefore judged by the same standard
  the reviewer already applied to the file.
- **A per-listener slice, not a `wireEvents`-wide regex.** Asserting only that
  `wireEvents` contains `scrubTo(` somewhere would pass if the call were moved
  into the wrong listener — into the `change` handler, say, where a range input
  fires only on release. Slicing the one delegated listener and asserting inside
  it pins the wire, not the token.
- **Rejected: a hand-rolled fake `document` that records listeners and lets the
  test dispatch a synthetic `input` event.** It would need `wireEvents` exported
  and `app.js` importable under Node — `app.js` runs `boot()` at load and
  touches `document`, `EventSource` and `location`, so importing it means faking
  four browser globals. That is a refactor of production code to serve a test,
  in an increment whose behaviour the reviewer already accepts as correct.
- **Rejected: asserting the listener's `type` string only** (that a
  `'pointerdown'` listener exists at all). It passes on an empty handler. The
  cases assert what the handler does with `timeline-scrub`.
- **Ordering is asserted where order is load-bearing.** Inside the `input`
  listener the `timeline-scrub` branch must come before the
  `event.target.id !== 'event-search'` early return, or the slider's events die
  at that return. An index comparison pins it, the way case 20 in the previous
  section already compares `renderTimeline(` against `state.cursor`.

### Module map

| Path | What it holds | Entry points |
| --- | --- | --- |
| `tools/argus-ui/test/page.test.mjs` | Source-level cases over `public/`; 303 lines today, banner comments per criterion | existing helpers `walk()`, `functionSource(source, name)`; **new** helper `detailListener(source, type)`; three new cases appended at the end |
| `tools/argus-ui/public/app.js` | The page: state, fetching, rendering, wiring | **read only this round.** `wireEvents` at line 1045; the `#detail` `pointerdown` listener at 1103–1105; the `window` `pointerup`/`pointercancel` loop at 1106–1110; the `#detail` `input` listener at 1113–1123; `let scrubbing = false` at 985; `scrubTo` at 1011 |

Facts about the two files this plan rests on, so nobody has to go and read for
them:

- `functionSource(source, name)` (`page.test.mjs:19–26`) finds
  `` `function ${name}(` ``, asserts it was found, and returns the slice up to the
  next top-level `function` declaration. It already returns the whole of
  `wireEvents`, both listeners included.
- Every delegated listener in `wireEvents` is registered with the literal text
  `document.getElementById('detail').addEventListener('<type>', (event) => {`,
  one per type, and the four types are `click` (1051), `change` (1091),
  `pointerdown` (1103) and `input` (1113). No other call in `app.js` matches that
  prefix for those types, so each anchor is unique.
- The registration that follows the `pointerdown` one is
  `window.addEventListener(name, () => {` inside a
  `for (const name of ['pointerup', 'pointercancel'])` loop; the one that follows
  the `input` one is
  `document.getElementById('session-search').addEventListener('input', …)`. Both
  contain the substring `.addEventListener(`, which is what bounds each slice.
- The pointer-release handlers sit on `window`, outside any `#detail` slice, so
  the case that pins them reads the whole of `wireEvents` instead.
- The current text of the two wires, verbatim:

  ```js
  document.getElementById('detail').addEventListener('pointerdown', (event) => {
    if (event.target.id === 'timeline-scrub') scrubbing = true;
  });
  ```

  ```js
  document.getElementById('detail').addEventListener('input', (event) => {
    // Keyboard scrubbing (arrow keys on a range) arrives here too.
    if (event.target.id === 'timeline-scrub') {
      scrubTo(event.target);
      return;
    }
    if (event.target.id !== 'event-search') return;
  ```

- `page.test.mjs` banner comments read
  `// Criterion 5, round 1 — a refresh answer for another session never reaches these lanes.`
  (line 182) and `// Criterion 6 — the timeline scrubs, and a live mode follows the head.`
  (line 219). The last case in the file ends at line 303.

### Environment

- Node v22.22.2 at `/opt/node22/bin/node`, on the `PATH`; the package requires
  ≥ 20.11.
- `tools/argus-ui` has **zero runtime and zero dev dependencies**. `npm install`
  is not needed, has never run, and must not become needed.
- Whole package, from the repository root: `npm --prefix tools/argus-ui test`
  (which is `node --test "test/*.test.mjs"`).
- The one edited file alone, from the repository root:
  `node --test tools/argus-ui/test/page.test.mjs`. The file resolves `public/`
  through `import.meta.url`, so it does not care what the working directory is.
- **There is no linter and no formatter in this repository** — nothing to run,
  nothing to configure.
- `./test.sh` and `tools/argus`' own suite are **not** on this round's list:
  nothing outside `tools/argus-ui/test/page.test.mjs` changes, and the closing
  increment owns the full-suite run.

### Test Plan

Tests are needed: the finding is precisely a missing test. Framework:
`node:test` with `node:assert/strict`, the only thing this project uses.

**Conventions of the file the cases land in** (`tools/argus-ui/test/page.test.mjs`):
every case is a `test('…', () => { … })` whose name is a full lowercase sentence
stating the fact it pins; each case re-reads the source itself with
`fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8')` — there is no shared
fixture and no `before` hook; slices are taken with the file's own helpers rather
than with inline `indexOf` where a helper fits; every assertion carries a message
saying what the fact is, in the same voice ('a full re-render would replace the
slider under the pointer and end the drag'); nothing is mocked, because nothing
is executed; and the cases are grouped under `// Criterion N — …` banner
comments in file order. Follow all of that.

**Nothing is red before this change**, and nothing is expected to be red after
it. These three cases pass against `app.js` as it stands — that is the intended
outcome, because the defect is the absence of the case and not the behaviour.
The proof that each case earns its place is the deletion it would catch, named
per case below; do not perform those deletions, and do not touch `app.js`.

#### The new helper

Add it directly after `functionSource` (`page.test.mjs:26`), in the same style —
a doc comment of one line, an `assert.ok` on the anchor, a slice to the next
registration:

```js
/** The body of one delegated listener on #detail, up to the next addEventListener. */
function detailListener(source, type) {
  const anchor = `document.getElementById('detail').addEventListener('${type}'`;
  const start = source.indexOf(anchor);
  assert.ok(start >= 0, `app.js must still delegate ${type} on #detail`);
  const rest = source.slice(start + anchor.length);
  const next = rest.indexOf('.addEventListener(');
  return next === -1 ? rest : rest.slice(0, next);
}
```

#### The cases

All three are appended at the end of the file, under one new banner in the
file's established form:

```js
// Criterion 6, round 1 — the scrub control is wired to the scrub, and a drag is registered.
```

| # | Case name | Input / state | Expected | Catches the deletion of |
| --- | --- | --- | --- | --- |
| 1 | `the scrub control's input reaches the scrub` | `detailListener(appJs, 'input')` | matches `/timeline-scrub/` and `/scrubTo\(/`; and `slice.indexOf('timeline-scrub') < slice.indexOf('event-search')`, asserted with `assert.ok` | `app.js:1113–1118`, the four-line branch; also a move of that branch below the `event-search` early return |
| 2 | `a drag is registered before the next refresh can fire` | `detailListener(appJs, 'pointerdown')` | matches `/timeline-scrub/` and `/scrubbing\s*=\s*true/`; and `slice.indexOf('timeline-scrub') < slice.search(/scrubbing\s*=\s*true/)` | `app.js:1103–1105`, the whole listener; also setting the flag for any pointer press rather than for the slider's |
| 3 | `releasing the pointer lets refreshes resume` | `functionSource(appJs, 'wireEvents')` | matches `/pointerup/`, `/pointercancel/` and `/scrubbing\s*=\s*false/` | `app.js:1106–1110`, whose loss leaves `scrubbing` true forever after the first drag and freezes every later refresh |

Assertion messages, to be used as written:

1. `'the slider must route its input event to the scrub, or dragging it does nothing'`,
   `'a drag must call scrubTo with the control it came from'`, and
   `'the slider branch must come before the event-search early return, which would otherwise swallow it'`.
2. `'a pointer press must be recognised as a drag on the scrub control specifically'`,
   `'a drag must set the scrubbing flag scheduleRefresh checks'`, and
   `'the flag must be set for the slider, not for every press in the detail pane'`.
3. `'a drag must end on pointerup'`, `'a cancelled drag must end too, or refreshes stop forever'`,
   and `'releasing the pointer must clear the scrubbing flag'`.

Each case reads the source itself, exactly as the neighbouring cases do:

```js
const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
```

Command that runs just this file, from the repository root:

```
node --test tools/argus-ui/test/page.test.mjs
```

#### Deliberately untested, and why

- **The drag as a browser performs it** — real `pointerdown`/`input` events,
  thumb pixels, whether the cursor line lands under the thumb. No DOM harness
  exists and none may be added; the project's first rule is zero dependencies.
  Cases 1–3 pin the wires, and the review judges the rest.
- **That `scheduleRefresh` actually defers and then resumes.** Timing behind a
  `setTimeout` with no seam; the existing case at `page.test.mjs:290` pins that
  the guard is read, and case 3 now pins that the flag it reads is cleared.
- **The in-flight `refresh()` that can still land mid-drag.** The reviewer
  recorded it as an observation, not a finding; nothing here may pin behaviour
  for it.
- **Everything increments 1–3 and 5–6 own.** No case written this round may
  touch lane derivation, density, the context message list or the tool list.
- **`tools/argus`.** Not touched.

#### What counts as done

```
npm --prefix tools/argus-ui test
```

That one command, from the repository root, is the whole list. It runs the three
new cases together with every existing case in the package, costs seconds, and
needs no install. Nothing else is to be run: `tools/argus`' suite and `./test.sh`
are off the list on purpose, since the only file that changes is a test file
inside `tools/argus-ui`.

#### What is already red

I did not run the list, not once and not as a baseline; the first run belongs to
whoever runs it downstream. From reading: nothing is red before this change. The
suite stands at 103 passing cases and grows to 106; no existing case is edited,
no existing case reads the helper being added, and no production file changes,
so no existing case can change its result.

## Increment 5 — selecting a lane at a time shows that agent's context as a message list

### Findings first: what a live capture proved about a request body

The parser at the heart of this increment has to match a real
`claude_code.api_request_body` body, so I captured one rather than assuming its
shape. Claude Code 2.1.223, a throwaway collector on a free port
(`node tools/argus/bin/argus.mjs start --port <free> --persist <scratchpad>`),
the env block `argus env` now prints, and a one-prompt session that wrote and
read a file. Nothing was written inside the repository; the collector was shut
down afterwards. This is the exception to "the researcher runs nothing", and it
is why every shape below is a fact.

**1. The top-level keys of a request body, in the order they arrive:**

```
model, messages, system, tools, betas, metadata, max_tokens, thinking,
context_management, output_config, diagnostics, stream
```

**2. `system` is an array of blocks, not a string.** Four entries, each
`{ type: 'text', text }`, the larger two also carrying `cache_control`. Sizes in
the capture: 134, 62, 10 676, 5 211 chars. A plain-string `system` is legal in
the API and must still parse, but it is not what this CLI sends.

**3. `messages` carries these shapes, all four seen in one capture:**

| Shape | Measured example |
| --- | --- |
| `{ role: 'user', content: [ {type:'text',text}, … ] }` | two text blocks, 367 and 94 chars |
| `{ role: 'system', content: '<string>' }` | **a string content on a `system`-role message**, 17 292 chars |
| `{ role: 'assistant', content: [ {type:'thinking',thinking,signature}, {type:'tool_use',id,name,input,caller} ] }` | thinking + a `Write` call |
| `{ role: 'user', content: [ {tool_use_id,type:'tool_result',content:'<string>',cache_control} ] }` | tool result, string content |

So `content` is a string on some messages and an array on others, a message role
can be `system`, and a `tool_result`'s `content` was a **string** here (the API
also allows an array of blocks). All four have to be handled; none may be
dropped.

**4. Two-thirds of the context is the `tools` array, which is not a message.**
Measured on the second request of a trivial session (`bodyLength` 107 461):

```
tools 70 901 · messages 19 222 · system 16 427 · betas 352 · metadata 212
· diagnostics 54 · context_management 59 · thinking 39 · model 17
· output_config 17 · max_tokens 5 · stream 4
```

A message list that renders only `system` + `messages` accounts for 36 KB of a
107 KB context and silently hides its single biggest consumer. That is why the
plan below gives every remaining top-level field a block of its own (decision 3).

**5. The API this increment needs already exists and needs no change.**
`GET /api/content/at?session=<id>&at=<epoch ms>` returns
`{ item: { …contentMetaOf, body } | null }`, 200 in both cases, filtered by
`main=1`, `span=<spanId>` or `agent=<name>`, defaulting to
`claude_code.api_request_body`, and "nearest at or before" is `log.timeMs <= atMs`
walked newest-first (`store.mjs`, `contentAt`). I confirmed it end to end against
the capture: `/api/content?session=…` listed four content records (two request,
two response bodies) and `/api/content/at?session=…&at=…` returned the request
body whole, `bodyLength === body.length === 107 461`, `truncated: false`. **No
file in `tools/argus` changes in this increment.**

**6. A body can still arrive unparseable.** `CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH`
is 2 000 000 in the env block, so a body past that arrives cut mid-JSON with
`body_truncated="true"` (`truncated: true`, and `bodyChars < bodyLength`).
`JSON.parse` then throws, and the parser must fall back rather than render
nothing.

### Implementation plan

Five files change, all in `tools/argus-ui`: one new module `public/context.js`,
plus `public/app.js`, `public/timeline.js`, `public/styles.css` and `README.md`.

**A. New module `tools/argus-ui/public/context.js` — two pure functions.**

Its header comment says what it is: pure functions over the payload of
`GET /api/content/at`, no `document`, no `fetch`, so `node --test` imports it
directly — the same contract as `timeline.js`. It imports `esc`, `fmtNum` and
`fmtClock` from `./format.js` and nothing else.

*A1. `export function contextBlocks(body)`* → `{ ok, chars, blocks }`.

- `chars` is `body.length` (0 when `body` is not a non-empty string).
- `ok` is `true` only when `JSON.parse(body)` yielded a non-null, non-array
  object.
- `body` missing, not a string, or empty → `{ ok: false, chars: 0, blocks: [] }`.
- `JSON.parse` throws, or yields anything but a plain object → one block:
  `{ index: 0, kind: 'raw', label: 'raw body', chars: body.length, text: body, preview }`.
  This is what a truncated body renders as: the exact text is still there.
- Otherwise the blocks are built in this order, and each block is
  `{ index, kind, label, chars, preview, text }` with `index` its 0-based
  position in the returned array:

  1. **`system`** — a string becomes one block; an array becomes one block per
     entry. `kind: 'system'`, `label: 'system prompt'`.
  2. **`messages`**, in order. For a message whose `content` is a string: one
     block, `kind` = the role when it is `user`/`assistant`/`system` and
     `'other'` otherwise, `label` = the role as written. For a message whose
     `content` is an array: one block per content block, by its `type`:

     | `type` | `kind` | `label` | `text` |
     | --- | --- | --- | --- |
     | `text` | the message's role (`user`/`assistant`/`system`, else `other`) | the role as written | `c.text` |
     | `thinking` | `thinking` | `thinking` | `c.thinking` |
     | `tool_use` | `tool_use` | `tool call · <c.name>`, or `tool call` with no name | the whole block as pretty JSON |
     | `tool_result` | `tool_result` | `tool result`, plus ` · error` when `c.is_error` is truthy, plus ` · <shortId(c.tool_use_id, 12)>` when present | `c.content` |
     | anything else, including a missing `type` | `other` | the `type` as written, or `block` when absent | the whole block as pretty JSON |

     A message with no usable `content` (absent, `null`, an empty array)
     contributes no block.
  3. **Every remaining top-level key** of the parsed object — everything except
     `system` and `messages` — in `Object.keys` order, one block each:
     `kind: 'field'`, `label` = the key.

- **The one text rule, stated once:** a block's `text` is its payload when that
  payload is a string, and `JSON.stringify(payload, null, 2)` otherwise; `chars`
  is `text.length`, so the size shown and the text shown are the same thing. A
  payload that is `undefined` yields `''`.
- `preview` is `text` with every run of whitespace collapsed to one space,
  trimmed, cut to 120 characters, with `…` appended when it was cut.

*A2. `export function renderContextPanel({ lane = null, item = null, pending = false, expanded = [] } = {})`* → an HTML string.

- `lane` falsy → return `''`. Nothing selected renders nothing at all.
- The root is
  `<div class="panel context-panel" data-state="…" data-context-lane="<lane.key>">`
  with `data-state` one of `pending` (a fetch is in flight for a lane whose
  context is not held yet), `empty` (`item` is null: no API request for this lane
  at or before this moment) or `ready`. `pending` and `empty` render a
  `<div class="placeholder">` and no `<details>`.
- **No attribute named `data-lane` may appear anywhere in this panel.** The
  page's click delegation binds `[data-lane]` to lane rows, so a `data-lane`
  here would make a click inside the panel toggle the lane selection. Hence
  `data-context-lane`.
- The `ready` head carries the lane label and the record it was built from:
  `<span class="context-meta" data-chars="<chars>" data-blocks="<n>" data-time="<item.timeMs>" data-model="<item.model>" data-truncated="<item.truncated === true>">`,
  with a human line inside it (`fmtClock(item.timeMs)`, the model,
  `fmtNum(chars)` chars, the block count). Numbers as data attributes, wording
  free — the convention the lane meta already follows.
- One block renders as:
  ```html
  <details class="ctx-block" data-kind="<kind>"[ open]>
    <summary data-block="<item.seq>:<index>">
      <span class="ctx-label">…</span><span class="ctx-preview">…</span>
      <span class="ctx-size" data-chars="<chars>">fmtNum(chars)</span>
    </summary>
    <pre class="ctx-text">…exact text…</pre>
  </details>
  ```
  `open` is written when `data-block`'s key is in `expanded`; build
  `new Set(expanded ?? [])` once so a caller may pass an array or a Set. `esc()`
  every interpolated value, the block text included.

**B. `public/timeline.js` — the lane row becomes selectable.**

- `renderTimeline(view, cursor = null, selectedKey = null)`: a third optional
  parameter, so the existing one- and two-argument call shapes keep working.
- The lane row changes from `<div class="lane" …>` to
  `<button type="button" class="lane" data-lane="…" data-kind="…" aria-current="${lane.key === selectedKey}">`,
  keeping its three children (`lane-label`, `lane-track`, `lane-meta`) and every
  attribute it already carries, byte for byte. `aria-current` as a boolean
  string is the convention `.span-row` and `.session-card` already use.
- Nothing else in the module changes.

**C. `public/app.js` — the selection mechanism.**

New state, added to the `state` literal:

```js
selectedLane: null,
// The record the panel is drawn from, tagged with the lane it was fetched for:
// an answer that arrives after the selection moved on must not be painted.
laneContext: { key: null, item: null },
// Block keys currently expanded, so a live refresh does not collapse what is open.
expanded: new Set(),
```

`selectSession()` resets all three (`selectedLane = null`,
`laneContext = { key: null, item: null }`, `expanded = new Set()`), next to the
resets already there.

New functions:

- `function laneView()` — `buildLanes({ session: state.session, content: state.content })`.
  The loader needs the session window and the selected lane's `spanId`; a second
  pure build over at most 2000 records costs nothing. **It must not be used
  inside `renderDetail`** — see the constraint at the end of this section.
- `async function loadLaneContext()` — captures `const id = state.selectedSessionId`
  and `const key = state.selectedLane` first; with either missing, writes
  `state.laneContext = { key: null, item: null }` and returns. Otherwise finds
  the lane in `laneView().lanes`, takes the moment from
  `resolveCursor(state.cursor, view).timeMs`, and calls
  `api('/api/content/at', params)` with `session: id`, `at: <that moment>`, and
  exactly one lane filter: `main: '1'` for `lane.kind === 'main'`, else
  `span: lane.spanId`, else `agent: lane.agent`. `.catch(() => null)` — a failed
  fetch costs the panel, not the page. After the await, **before writing state**,
  return early when `state.selectedSessionId !== id || state.selectedLane !== key`.
  Then `state.laneContext = { key, item: answer?.item ?? null }`.
- `function renderLanePanel()` — reads `document.getElementById('lane-panel')`,
  returns if absent, and writes `renderContextPanel({ lane, item, pending, expanded })`
  into it: `lane` from `laneView().lanes.find(…)` for `state.selectedLane`,
  `pending` = `state.laneContext.key !== state.selectedLane`, `item` =
  `state.laneContext.item` only when the keys match. It never calls
  `renderDetail()`: the panel repaints inside its own container, which is what
  keeps a repaint from replacing the scrub slider under a pointer.
- `function scheduleLaneContext(delay = 250)` — a trailing debounce
  (`clearTimeout` then `setTimeout`) around
  `loadLaneContext().then(renderLanePanel)`, so a drag across the slider fires
  one fetch and not one per pixel.

Wiring, all inside the existing delegated listeners:

- `renderDetail()` renders `<div id="lane-panel"></div>` between the timeline and
  `renderDetailViews(…)`, passes `state.selectedLane` as the third argument of
  `renderTimeline(…)`, and calls `renderLanePanel()` next to the existing
  `renderTabBody()` call.
- The `click` listener on `#detail` gains two branches. Immediately after the
  `[data-cursor-live]` branch:
  ```js
  const laneRow = event.target.closest('[data-lane]');
  if (laneRow) {
    state.selectedLane = state.selectedLane === laneRow.dataset.lane ? null : laneRow.dataset.lane;
    state.expanded = new Set();
    renderLanePanel();
    loadLaneContext().then(renderLanePanel);
    return;
  }
  ```
  and, anywhere after it, a branch on `event.target.closest('summary[data-block]')`
  that adds or removes `dataset.block` in `state.expanded` and returns without
  re-rendering — the browser opens and closes the `<details>` itself. Bind on
  `summary[data-block]`, never on `[data-block]`: a click inside an expanded
  `<pre>` (selecting text) would otherwise flip the remembered state without
  flipping the element.
- The `[data-cursor-live]` branch keeps its `renderDetail()` and gains
  `loadLaneContext().then(renderLanePanel)` after it: returning to live moves the
  moment, so the panel has to be refetched.
- `scrubTo(input)` gains a `scheduleLaneContext()` call after `paintCursor()`. It
  still must not call `renderDetail()`.
- `refresh()` calls `await loadLaneContext()` after `await loadTimeline()` inside
  the existing `try`, so live mode follows new requests into the panel; the
  `renderDetail()` that follows paints it.

**Constraint the existing suite already imposes on `renderDetail`.**
`page.test.mjs` asserts, on the source of `renderDetail` alone, that
`renderTimeline(` appears before `buildDensity(`, before `state.cursor`, before
`renderDetailViews(`, before `id="tab-body"`. So the
`renderTimeline(buildDensity(buildLanes({ session, content: state.content }), {…}), state.cursor, state.selectedLane)`
expression stays written out inline in `renderDetail`; extracting it into a
helper turns three existing cases red for no gain.

**D. `public/styles.css` — the panel, and the lane as a button.**

- `.lane` gains the button reset it now needs: `appearance: none`,
  `background: none`, `border: 0`, `color: inherit`, `font: inherit`,
  `width: 100%`, `text-align: left`, `cursor: pointer`, plus a
  `:hover` background, a `:focus-visible` outline and a
  `.lane[aria-current="true"]` highlight (a left accent border or a tinted
  background). The grid rules it already has stay as they are.
- A `context` section after the timeline section: `.context-panel`,
  `.context-head`, `.context-meta`, `.ctx-block` (a bottom hairline between
  blocks), `.ctx-block > summary` (a grid of label · preview · size, `cursor:
  pointer`, `list-style: none` plus a `::-webkit-details-marker` reset if the
  native triangle is dropped), `.ctx-label`, `.ctx-preview` (single line,
  `overflow: hidden`, `text-overflow: ellipsis`, faint), `.ctx-size`
  (`var(--mono)`, right-aligned), `.ctx-text` (`pre`, `white-space: pre-wrap`,
  `overflow: auto`, a `max-height` around `50vh` so one 70 KB block cannot bury
  the rest), and one colour per `.ctx-block[data-kind="…"]` label so the five
  named kinds are told apart at a glance. Reuse the existing custom properties
  (`--accent`, `--violet`, `--teal`, `--warn`, `--text-faint`); introduce no new
  palette.

**E. `tools/argus-ui/README.md` — one sentence.** The **Timeline** bullet
(lines 62–67) gains: clicking a lane opens that agent's context as of the
cursor's moment, as a list of blocks showing each one's size and expanding to
its full text. No other file's documentation changes.

### Decisions, including the ones rejected

1. **The panel is fed by `GET /api/content/at`, not by the content index the
   lanes already hold.** The index carries metadata only — deliberately, so the
   tail and the lanes never ship megabytes. `contentAt` is the route increment 1
   built for exactly this question and it answers "nearest at or before" in the
   store, where the records are. Rejected: fetching all bodies with the index
   (megabytes per poll), and adding a new route (nothing is missing).
2. **A new module `public/context.js` rather than growth in `timeline.js`.**
   `timeline.js` draws lanes over a whole session; this draws one record's
   content. Separate concerns, separate test file, and increment 6's panel can
   sit next to it. Rejected: appending ~180 lines to a 461-line module whose
   header promises it is about lanes.
3. **Every non-message top-level field gets a block too.** Finding 4 measured
   `tools` at 66% of a real context; a list that hides it answers "what fills the
   context" with the wrong two-thirds. The criterion names the kinds that must be
   in the list, not the ones that may not be. Rejected: only `system` +
   `messages` (dishonest sizes), and a size-threshold rule (an arbitrary constant
   nobody can defend).
4. **One text rule: string payload verbatim, anything else pretty JSON, and
   `chars = text.length`.** The number on the collapsed line is then the size of
   the text the expansion shows, with no second measure to explain. The cost is
   that a `text` block's `cache_control` marker is not shown; it is a caching
   hint, not context, and the panel head carries the whole body's wire size so
   the blocks are never mistaken for the total. Rejected: JSON-escaping every
   block (a 70 KB tool result becomes unreadable) and mixing wire size with
   payload text (two numbers that disagree).
5. **Expansion state lives in the page, keyed `"<seq>:<index>"`.** `renderDetail`
   replaces `#detail` wholesale on every ingest-triggered refresh, so a
   `<details>` the reader opened would snap shut every few hundred milliseconds.
   Keying by the record's `seq` means the set stops matching when the cursor
   lands on a different request, and everything collapses — which is right: it is
   a different context. Rejected: skipping the re-render when the record is
   unchanged (fragile the moment anything volatile enters the panel) and a DOM
   diff (no framework, by project rule).
6. **`<details>`/`<summary>` rather than a button plus a hidden `<pre>`.** Native
   expansion, native keyboard handling, no JS needed to open a block; the click
   listener only records what the browser already did.
7. **The lane row becomes a `<button>`.** Real keyboard and screen-reader
   behaviour for free, and `.span-row` in the waterfall is already exactly this
   pattern. Rejected: `role="button"` plus `tabindex` on the `<div>` (hand-rolled
   key handling for the same result).
8. **A trailing 250 ms debounce on scrub-driven fetches**, the interval the event
   search already uses. Rejected: fetching on every `input` event (one request
   per pixel of drag) and fetching only on `change` (a drag then shows nothing
   until release, and the criterion is about scrubbing *to* a moment).
9. **No change in `tools/argus`.** Verified end to end against the capture
   (finding 5).

### Module map

| Path | What it holds | Entry points |
| --- | --- | --- |
| `tools/argus-ui/public/context.js` | **new** — the context panel: parse a request body into blocks, render them | `contextBlocks(body)`, `renderContextPanel({lane,item,pending,expanded})` |
| `tools/argus-ui/public/timeline.js` | lanes, density, cursor; all pure | `renderTimeline(view, cursor, selectedKey)` gains the third parameter; `buildLanes`, `resolveCursor` are read by the new page code |
| `tools/argus-ui/public/app.js` | the page: state, fetches, delegated listeners | `state`, `renderDetail`, `renderTabBody`, `refresh`, `selectSession`, `scrubTo`, `paintCursor`, `wireEvents`; gains `laneView`, `loadLaneContext`, `renderLanePanel`, `scheduleLaneContext` |
| `tools/argus-ui/public/format.js` | `esc`, `fmtNum`, `fmtClock`, `fmtDur`, `shortId` — every string goes through one of these | imported by `context.js` |
| `tools/argus-ui/public/styles.css` | all styling; timeline section at lines 786–997 | `.lane` (852), `.timeline-cursor` (972) |
| `tools/argus-ui/README.md` | user-facing page; the **Timeline** bullet at lines 62–67 | — |
| `tools/argus/src/server.mjs` | the collector's routes — **read only** | `/api/content/at` at line 263: `session` (required), `at`, `main`, `span`, `agent`, `event` |
| `tools/argus/src/store.mjs` | the collector's store — **read only** | `contentAt` at line 953, `matchesContent` at line 197 |
| `tools/argus/src/claude.mjs` | content vocabulary — **read only** | `contentMetaOf` at line 210: the item shape `/api/content/at` returns |

The item `/api/content/at` returns, in full:
`{ seq, timeMs, sessionId, traceId, spanId, eventName, querySource, agent,
isSubagent, model, requestId, promptId, eventSequence, bodyLength, bodyChars,
truncated, bodyRef, body }`.

### Environment

Node ≥ 20.11, already installed. Zero runtime dependencies in both projects, so
**no install step is needed** — `npm --prefix tools/argus-ui test` runs from a
bare checkout. **There is no linter and no formatter in this repository**, and no
build step: `public/` is served exactly as written.

Commands, all from the repository root:

```
npm --prefix tools/argus-ui test           # the whole argus-ui suite
node --test tools/argus-ui/test/context.test.mjs
node --test tools/argus-ui/test/page.test.mjs
node --test tools/argus-ui/test/independence.test.mjs
```

To look at the result by hand (not part of any list below): start a collector
with `node tools/argus/bin/argus.mjs start`, the interface with
`node tools/argus-ui/bin/argus-ui.mjs` on http://127.0.0.1:4319, and feed it with
`node tools/argus/scripts/demo-emit.mjs` — note the demo emitter sends no
`api_request_body` events, so a real session with the `argus env` block is what
puts content on the lanes.

### Test plan

Tests are needed. Every case is a `node --test` case in `tools/argus-ui/test/`,
`node:test` + `node:assert/strict`, the style already in that directory: one
`test('sentence describing the fact', () => {…})` per fact, factory helpers at
the top of the file, a `// Criterion 7 — …` comment above each group, and an
assertion message on every non-obvious assert. Nothing is faked and nothing is
mocked: the module functions are pure and the page cases read source text.

#### The new file: `tools/argus-ui/test/context.test.mjs`

It imports `{ contextBlocks, renderContextPanel } from '../public/context.js'`
and builds every input from three factories, modelled on the captured body
(finding 3) and nothing else:

```js
const requestBody = (over = {}) =>
  JSON.stringify({
    model: 'claude-sonnet-5',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'ping' }] },
      { role: 'system', content: '<system-reminder>context</system-reminder>' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'thought', signature: 'sig' },
          { type: 'tool_use', id: 'toolu_01', name: 'Write', input: { file_path: '/tmp/notes.txt', content: 'hello' } },
        ],
      },
      { role: 'user', content: [{ tool_use_id: 'toolu_01', type: 'tool_result', content: 'File created' }] },
    ],
    system: [
      { type: 'text', text: 'You are a Claude agent.' },
      { type: 'text', text: 'Long instructions.', cache_control: { type: 'ephemeral' } },
    ],
    tools: [{ name: 'Read', description: 'Reads a file', input_schema: { type: 'object' } }],
    max_tokens: 64000,
    stream: true,
    ...over,
  });

const item = (over = {}) => ({
  seq: 12, timeMs: 4000, sessionId: 's1', spanId: 'sp-a',
  eventName: 'claude_code.api_request_body', model: 'claude-sonnet-5',
  truncated: false, body: requestBody(), ...over,
});

const lane = (over = {}) => ({ key: 'main', kind: 'main', label: 'main session', spanId: null, agent: null, ...over });
```

| # | Case | Input / state | Expected |
| --- | --- | --- | --- |
| 1 | the five kinds the criterion names all reach the list, system prompt first | `contextBlocks(requestBody())` | `blocks.map((b) => b.kind)` deep-equals `['system','system','user','system','thinking','tool_use','tool_result','field','field','field','field']` — two system-prompt entries, then the messages in order, then `model`, `tools`, `max_tokens`, `stream` as fields |
| 2 | a block's size is the size of the text it expands to | same | for the `'ping'` block, `text === 'ping'` and `chars === 4`; for every block, `chars === text.length` |
| 3 | the exact full text survives the parse, unescaped and uncut | body whose first system text is `` `<script>"x"</script>\nline two` `` | that block's `text` is that string character for character; escaping is the renderer's job, not the parser's |
| 4 | a tool call names its tool and keeps the whole call | same as case 1 | the `tool_use` block's `label` contains `Write`; its `text` parses back with `JSON.parse` to the whole block, `id`, `name` and `input` included |
| 5 | a tool result expands to the result text and is tied to its call | same | the `tool_result` block's `text === 'File created'`; its `label` contains `toolu_01` |
| 6 | a failed tool result says so on its one line | `is_error: true` on the tool_result block | that block's `label` contains `error` |
| 7 | a message whose content is a plain string is one block of that role | same as case 1 | the `role: 'system'` string message yields one block, `kind === 'system'`, `text === '<system-reminder>context</system-reminder>'` |
| 8 | thinking is its own block | same | `kind === 'thinking'`, `text === 'thought'` |
| 9 | an unknown content block is kept, labelled by its type | a message with `content: [{ type: 'image', source: { data: 'AAA' } }]` | one block, `kind === 'other'`, `label === 'image'`, `text` parses back to the whole block — no block is silently dropped |
| 10 | a `system` given as a plain string still parses | `requestBody({ system: 'be brief' })` | exactly one `kind === 'system'` block, `text === 'be brief'` |
| 11 | the fields that are not messages are accounted for, so the sizes tell the truth | same as case 1 | there is a `kind === 'field'` block with `label === 'tools'` whose `chars` equals `JSON.stringify(<the tools array>, null, 2).length`; no field block is labelled `system` or `messages` |
| 12 | the whole body's size is reported alongside the blocks | same | `chars === requestBody().length` and `ok === true` |
| 13 | a truncated body becomes one raw block carrying every character it has | `contextBlocks('{"messages":[{"role":"user","cont')` | `ok === false`, one block, `kind === 'raw'`, `text` is that exact string, `chars === text.length` |
| 14 | no body at all is no blocks, never a crash | `contextBlocks(null)`, `contextBlocks(undefined)`, `contextBlocks('')`, `contextBlocks(42)` | each `{ ok: false, chars: 0, blocks: [] }` |
| 15 | a body that parses to something other than an object is raw, not empty | `contextBlocks('[1,2]')`, `contextBlocks('"x"')` | one `kind === 'raw'` block each, `ok === false` |
| 16 | a message with no content contributes nothing | `requestBody({ messages: [{ role: 'user' }, { role: 'user', content: [] }, { role: 'user', content: 'x' }] })` | exactly one block comes from `messages`, the `'x'` one |
| 17 | the one line is a one-line preview | a text block whose text is `'a\n\n   b'` repeated past 120 chars | its `preview` has no `\n`, no double space, is at most 121 characters and ends with `…` |
| 18 | block indexes are their positions, in order | same as case 1 | `blocks.map((b) => b.index)` deep-equals `[0,1,2,…]` |
| 19 | nothing selected renders nothing | `renderContextPanel()`, `renderContextPanel({ lane: null, item: item() })` | both `''` — no empty panel sits under the timeline before a lane is picked |
| 20 | a selected lane at a moment renders one expandable block per block, each with its size | `renderContextPanel({ lane: lane(), item: item() })` | one `<details class="ctx-block"` per block from case 1, in that order; each carries a `data-kind`; each `<summary>` carries `data-block="12:<index>"` and a `<span class="ctx-size" data-chars="…">`; each `<details>` carries one `<pre class="ctx-text">` holding the escaped exact text |
| 21 | the head names the lane and the record the context came from | same | the markup contains the lane label, and a `data-chars="<body length>"`, `data-time="4000"`, `data-model="claude-sonnet-5"`, `data-truncated="false"`, `data-state="ready"` |
| 22 | every block is collapsed until it is asked for | same, `expanded` omitted | the markup contains no ` open` attribute at all |
| 23 | an expanded block stays expanded, and only that one | `expanded: ['12:2']` | exactly one `<details … open>`, and it is the one whose summary carries `data-block="12:2"`; passing a `Set(['12:2'])` gives byte-identical markup |
| 24 | a moment before this lane's first request says so, with no blocks | `renderContextPanel({ lane: lane(), item: null })` | `data-state="empty"`, one `.placeholder`, no `<details` |
| 25 | a fetch in flight does not claim there is nothing | `renderContextPanel({ lane: lane(), item: null, pending: true })` | `data-state="pending"`, no `<details` — asserted as a state, not as a wording |
| 26 | a truncated record is marked as one | `item({ truncated: true, body: '{"messages":[' })` | `data-truncated="true"` in the head, and the one `kind="raw"` block still renders its text |
| 27 | the panel escapes everything it prints | body whose user text is `<script>alert("x")</script>` and whose tool name is `<img>` | `&lt;script&gt;` appears; `<script>` and `<img>` do not appear anywhere in the markup |
| 28 | the panel carries no attribute the lane click handler would catch | `renderContextPanel({ lane: lane(), item: item() })` | `assert.doesNotMatch(html, /data-lane=/)` — a `data-lane` here would make every click inside the panel toggle the lane selection |
| 29 | the panel prints no NaN and no undefined | `renderContextPanel({ lane: lane({ label: 'agent #1', key: 'agent:sp-a:probe' }), item: item({ model: null, timeMs: 0 }) })` | no `NaN` and no `undefined` in the markup |

#### `tools/argus-ui/test/timeline.test.mjs` — the lane row is selectable

| # | Case | Input / state | Expected |
| --- | --- | --- | --- |
| 30 | a lane row is a control a human can click and a keyboard can reach | `renderTimeline(buildDensity(buildLanes({ session: session(), content: threeRecordContent() }), { content: threeRecordContent(), tools: [] }))` | every element carrying `data-lane="…"` is a `<button type="button"`, and there are two of them |
| 31 | the selected lane is marked as the current one | the same view, third argument `'main'` | the row whose `data-lane="main"` carries `aria-current="true"`, the agent row carries `aria-current="false"` |
| 32 | with nothing selected no lane claims to be current | the same view, no third argument | no `aria-current="true"` anywhere, and the markup is otherwise unchanged — the two-argument call shape of increment 4 keeps working |

#### `tools/argus-ui/test/page.test.mjs` — the wiring

Source-level, using the file's own `functionSource()` and `detailListener()`
helpers. Each case names the wire it pins, because deleting any one of them
leaves a page that looks right and does nothing.

| # | Case | Input / state | Expected |
| --- | --- | --- | --- |
| 33 | app.js takes the context panel from its module | the whole `app.js` source | matches `/import\s*\{[^}]*\brenderContextPanel\b[^}]*\}\s*from\s*['"]\.\/context\.js['"]/` |
| 34 | the context panel has a container of its own, between the timeline and the technical views | `functionSource(appJs, 'renderDetail')` | contains `id="lane-panel"`, with `renderTimeline(` before it and `renderDetailViews(` after it |
| 35 | a full render repaints the panel | same slice | contains `renderLanePanel(` |
| 36 | the timeline is told which lane is selected | same slice | contains `state.selectedLane`, at an index after `renderTimeline(` |
| 37 | clicking a lane selects it, and clicking it again lets go | `detailListener(appJs, 'click')` | contains `data-lane`, and a `state.selectedLane =` whose right-hand side is a `? null :` ternary on the current value |
| 38 | selecting a lane fetches its context | same slice | contains `loadLaneContext(` after the `data-lane` branch opens |
| 39 | the panel asks the collector for the nearest request at the cursor's moment, for that lane only | `functionSource(appJs, 'loadLaneContext')` | contains `/api/content/at`, `resolveCursor(`, and all three lane filters `main`, `span`, `agent` |
| 40 | an answer that arrived after the selection moved on is dropped | same slice | a guard matching `/state\.selectedLane\s*!==\s*key/` **and** one matching `/state\.selectedSessionId\s*!==\s*id/`, both after the first `await` and before the `state.laneContext =` write |
| 41 | the panel repaints in its own container, never by re-rendering the page | `functionSource(appJs, 'renderLanePanel')` | contains `lane-panel` and `renderContextPanel(`, and does **not** contain `renderDetail(` |
| 42 | scrubbing moves the context with the cursor | `functionSource(appJs, 'scrubTo')` | contains `scheduleLaneContext(`; the existing case that it must not call `renderDetail(` still stands |
| 43 | the scrub-driven fetch is debounced | `functionSource(appJs, 'scheduleLaneContext')` | contains `setTimeout` and `clearTimeout` — a drag must not fire one request per pixel |
| 44 | live mode follows new requests into the panel | `functionSource(appJs, 'refresh')` | contains `loadLaneContext(` |
| 45 | returning to live refetches the context | `detailListener(appJs, 'click')` | in the `data-cursor-live` branch, a `loadLaneContext(` — the moment moved, so the panel must too |
| 46 | expanding a block is remembered, so a live refresh does not collapse it | `detailListener(appJs, 'click')` and `functionSource(appJs, 'renderLanePanel')` | the listener matches `/summary\[data-block\]/` and writes to `state.expanded`; `renderLanePanel` passes `state.expanded` to `renderContextPanel` |
| 47 | selecting a session forgets the lane, its context and its expansions | `functionSource(appJs, 'selectSession')` | matches `/state\.selectedLane\s*=\s*null/` and writes both `state.laneContext` and `state.expanded` |
| 48 | the page opens with no lane selected | the `const state = {` … `\n};` slice, taken the way the existing landing cases take it | matches `/\bselectedLane:\s*null\b/` |

#### `tools/argus-ui/test/independence.test.mjs` — the new module is part of the project

| # | Case | Input / state | Expected |
| --- | --- | --- | --- |
| 49 | the new module is guarded like the others | the two existing lists in that file | `'public/context.js'` added to the "everything a project needs" list and to the "the scan does not cover" list, so it must exist and must never import outside the project |

#### What is deliberately untested, and why

- **The click, the drag and the expansion in a browser.** There is no DOM
  harness in this project and there will not be one: jsdom is a dependency, and
  zero dependencies is the project's first rule. Cases 37–48 pin every wire in
  the source; whether a pixel lands where it should is what the review looks at.
- **The fetch itself.** `loadLaneContext` calls `fetch` through `api()`; testing
  it would mean a fake `window`. The route it calls, its parameters and its
  stale-answer guard are pinned as source facts, and the route is already covered
  by `tools/argus`' own suite (`server.test.mjs`, `/api/content/at`).
- **`tools/argus`.** Nothing in it changes (finding 5), so nothing in its suite
  is re-run by this increment.
- **The debounce actually elapsing.** Timing behind a `setTimeout` with no seam;
  case 43 pins that the guard is in the code, and the alternative is a fake clock
  for a 250 ms constant.
- **Colours, the collapsed line's layout, the `max-height` of an expanded
  block.** `node --test` sees strings; CSS is judged in the review.
- **The tools an agent used up to the moment.** Increment 6 owns that criterion;
  no case here may pin behaviour for it.
- **Recordings made without the content flags.** Out of contract by the issue's
  own decision.

#### What counts as done

```
npm --prefix tools/argus-ui test
```

That one command, from the repository root, is the whole list. It runs the new
`context.test.mjs` together with every existing case in the package, costs
seconds and needs no install. `tools/argus`' suite and `./test.sh` are off the
list on purpose: no file outside `tools/argus-ui` changes here, and the closing
increment owns the full-suite run.

#### What is already red

I did not run the list, not once and not as a baseline; the first run belongs to
whoever runs it downstream. I did run a capture — a throwaway collector and one
`claude -p` session outside the repository — because the parser's whole design
depends on the real shape of a request body, and that is a fact no amount of
reading the repository produces; findings 1–6 are its output.

From reading, nothing is red before this change, and no existing case turns red
because of it:

- No case asserts that a lane row is a `<div>`; every lane assertion in
  `timeline.test.mjs` matches on `data-lane="`, on `lane-bar`, `lane-curve`,
  `lane-mark` or `lane-meta`, all of which survive the change to `<button>`
  unchanged.
- `renderTimeline`'s third parameter is optional, so the one- and two-argument
  calls in the existing cases keep resolving to `selectedKey = null`.
- The three ordering cases over `renderDetail` (`renderTimeline(` <
  `buildDensity(` and < `state.cursor`, and `renderTimeline(` <
  `renderDetailViews(` < `id="tab-body"`) stay satisfied by the plan above, which
  inserts `id="lane-panel"` between the timeline and the nav and keeps the
  composed expression inline.
- `page.test.mjs`'s flag-absence case scans every file under `public/`, the new
  `context.js` included; it names none of those flags.
- `independence.test.mjs` walks the whole project, so `context.js` is scanned for
  outside imports from the moment it exists; it imports only `./format.js`.

## Increment 5 — Round 1

The reviewer raised three findings, all of the same kind: the production code
satisfies the criterion, but three clauses of it are unpinned, each proven by a
measured mutation that the suite survived. Two of them are fixed by tests alone.
The third cannot be pinned by a test while the mapping it needs to check is
buried inside an `async` function that fetches — so one small production change
lifts that mapping into a pure function, and the test then reads it directly.

Nothing else in this section is scope. The reviewer's four "observation, not a
finding" entries are deliberately left alone: the panel's refetch on every live
refresh, the expansion set collapsing when the record changes, the wording of
the existing case at `page.test.mjs:474`, and the impossible `"agent:"` record.
The last of these is closed as a byproduct of the fix below, and that is
recorded as a decision rather than smuggled in.

### The findings, restated as the defects to remove

1. **`context.js:199` — "expandable to the exact full text" is unpinned.**
   Replacing `esc(block.text)` with `esc(block.preview)` inside
   `<pre class="ctx-text">` leaves the suite at 154 pass. The rendering cases
   count `<pre class="ctx-text">` tags; none reads what is between the tags.
2. **`app.js:927-933` — "that agent's (or the main session's) context" is
   unpinned.** Collapsing the whole lane filter to `{ main: '1' }` leaves the
   suite at 154 pass, because the only case over it (`page.test.mjs:404`) greps
   `loadLaneContext`'s source for the words `main`, `span` and `agent`, and the
   three-line comment above the filter contains all three on its own.
3. **`context.js:21` — the `assistant` kind is unpinned.** Removing
   `'assistant'` from `ROLE_KINDS` leaves the suite at 154 pass: every assistant
   message in every fixture carries only `thinking` and `tool_use` parts, whose
   kinds ignore the role, so no assertion ever observes an assistant text block.

### Implementation plan

Two production files change, `tools/argus-ui/public/context.js` and
`tools/argus-ui/public/app.js`, both for finding 2 only. Findings 1 and 3 need
no production change at all — the code already does the right thing and the
tests below are what stop it from silently stopping.

**A. `tools/argus-ui/public/context.js` — the lane→query mapping becomes a pure,
exported function.**

Add, next to `contextBlocks` and above `renderContextPanel`:

```js
/**
 * The one lane filter that goes on the wire for a lane's context.
 *
 * Main traffic for the main lane; an agent lane's own span — the only thing
 * that tells two concurrent agents of one type apart — and its name only when
 * it carries no span at all. A lane that offers neither gets no query rather
 * than an empty one: an unfiltered request would answer with the main
 * session's context under an agent's lane, which is the one thing this
 * mapping exists to prevent.
 *
 * @param {{ kind: string, spanId: string|null, agent: string|null }|null|undefined} lane
 * @returns {{ main: string }|{ span: string }|{ agent: string }|null}
 */
export function laneContentQuery(lane) {
  if (!lane) return null;
  if (lane.kind === 'main') return { main: '1' };
  if (lane.spanId) return { span: lane.spanId };
  if (lane.agent) return { agent: lane.agent };
  return null;
}
```

Extend the module header's first sentence so it still describes the whole
module: it holds pure functions over `GET /api/content/at` — which record a lane
asks for, how its body parses into blocks, and how those blocks render.

**B. `tools/argus-ui/public/app.js` — `loadLaneContext` delegates to it.**

- Line 11 becomes
  `import { laneContentQuery, renderContextPanel } from './context.js';`.
- Inside `loadLaneContext`, the six-line `const filter = !lane ? … : …` chain
  (lines 927-933) becomes
  `const filter = laneContentQuery(view.lanes.find((entry) => entry.key === key));`,
  and the `const lane = …` line above it goes away with it — `lane` has no other
  reader in that function. Everything else in `loadLaneContext` stays byte for
  byte: the id/key capture, `resolveCursor(state.cursor, view).timeMs`, the
  `.catch(() => null)`, the two staleness guards, the `state.laneContext` write.
- **Delete the three-line comment at lines 924-926 rather than keep it**: its
  text is the prose that made the old grep-based case pass by itself, and the
  same explanation now sits on `laneContentQuery`. Put nothing in its place that
  names `laneContentQuery` inside a comment — a comment naming the function
  would satisfy the new source assertion without the code calling anything.

That is the whole production change. `filter` keeps its meaning (an object or
`null`), the `filter ? await api(…) : null` expression is untouched, and a
`null` filter still lands the panel in its `empty` state instead of firing an
unfiltered request.

### Decisions, including the ones rejected

1. **`laneContentQuery` lives in `context.js`, not in `timeline.js`.** It is
   part of the panel's data path — which record this lane's context comes from —
   and `context.js` is already the module that owns `GET /api/content/at`.
   `timeline.js` builds the lane objects it consumes, but its header promises
   lanes, density and cursor drawing; an API query builder there widens a module
   that three increments already depend on. The test file follows the module,
   which keeps `test/context.test.mjs` as the single home of this increment's
   unit cases. Rejected: `timeline.js` (wrong concern), and a new third module
   for one four-line function (a file per function is not this project's grain).
2. **A pure function rather than a stronger source grep.** The reviewer's
   mutation shows why a grep cannot do this job: the words it looks for live in
   prose as easily as in code, and no regex over `loadLaneContext` can tell that
   an `agent` lane produces `span=sp-a` rather than `main=1`. Only a function
   that takes a lane and returns a query can be asked that question. Rejected:
   asserting the filter's exact source text (pins formatting, not behaviour) and
   a fake `window.fetch` harness around `loadLaneContext` (a DOM fake for one
   mapping, against the project's zero-dependency rule and its no-DOM test
   convention).
3. **The function is total: a lane with neither span nor agent gets `null`.**
   The reviewer recorded that case as an observation because the collector
   cannot currently produce such a record. A pure function still has to answer
   for every input it can be handed, and the honest answer is "no query" — the
   alternative, `{ agent: null }`, is dropped by `api()` and turns into an
   unfiltered request that answers with the main session's traffic under an
   agent's lane. One line, one test case, and the observation closes with it.
   Rejected: throwing (the panel would go down with it) and reproducing the old
   `{ agent: lane.agent }` unconditionally (keeps a known trap alive on purpose).
4. **Findings 1 and 3 get tests only.** The renderer already prints
   `esc(block.text)` and `ROLE_KINDS` already holds `'assistant'`. Changing
   working code to make it look tested is how a correction round adds risk;
   what was missing is the assertion, and that is all that is added.
5. **The assistant text part goes into the shared `requestBody` factory, not
   into a fixture of its own.** Every real assistant turn carries text, so a
   factory whose assistant message has only `thinking` and `tool_use` is the
   unrealistic one — the reviewer found the gap precisely because the fixture
   does not look like a captured body. Inserting the text part **between**
   `thinking` and `tool_use` keeps every existing block index stable, so the one
   case that names an index (`expanded: ['12:2']`) needs no edit. Rejected: a
   second factory (two bodies drift apart) and appending the text part after
   `tool_use` (shifts an index for nothing).

### Module map

| Path | What it holds | Entry points |
| --- | --- | --- |
| `tools/argus-ui/public/context.js` | the context panel, pure: block parsing at `contextBlocks` (line 64), rendering at `renderContextPanel` (line 153), `ROLE_KINDS` at line 21, `PREVIEW_CHARS` exported at line 18, the `<pre class="ctx-text">` at line 199 | gains `laneContentQuery(lane)` |
| `tools/argus-ui/public/app.js` | the page; `loadLaneContext` at lines 915-946, its import of `context.js` at line 11 | `loadLaneContext` keeps its name, signature and every other line |
| `tools/argus-ui/public/format.js` | `esc` (line 9), `fmtNum`, `fmtClock`, `shortId` | `esc` is what the new renderer case compares against |
| `tools/argus-ui/public/timeline.js` | `buildLanes` builds each lane as `{ key, kind: 'main'\|'agent', agent, spanId, label, … }` (lines 85-106) — **read only, unchanged** | — |
| `tools/argus-ui/test/context.test.mjs` | 29 cases; three factories at the top (`requestBody`, `item`, `lane`); the kind-sequence case at line 51 | the factory at line 9 gains one content part |
| `tools/argus-ui/test/page.test.mjs` | source-level page cases; helpers `functionSource` (line 20) and `detailListener` (line 29); increment 5's block starts at line 346 | the import case at line 349 and the query case at line 404 are rewritten |
| `tools/argus-ui/test/timeline.test.mjs` | lane-row cases — **unchanged this round** | — |
| `tools/argus-ui/test/independence.test.mjs` | the project-wide import rule; already lists `public/context.js` — **unchanged this round** | — |

No file in `tools/argus` changes, and no documentation changes: `README.md`'s
Timeline bullet already describes exactly the behaviour these tests pin, and no
behaviour visible to a reader of the page moves.

### Environment

Node ≥ 20.11, already installed. Zero runtime dependencies, no install step, no
build step, and **there is no linter and no formatter in this repository**.

The one command this round's test plan asks anyone to run, from the repository
root:

```
npm --prefix tools/argus-ui test
```

While working on a single file, `node --test tools/argus-ui/test/context.test.mjs`
and `node --test tools/argus-ui/test/page.test.mjs` run just that file; neither
is part of the closed list below.

### Test Plan

Tests are needed: all three findings are missing assertions, and finding 2's
assertion is the reason the production change exists. Everything is `node:test`
+ `node:assert/strict` in `tools/argus-ui/test/`, in the style already in those
files — one `test('a sentence stating the fact', () => {…})` per fact, factories
at the top, a message on every non-obvious assert, nothing mocked.

This section's list is the whole of what is asked for this round. Earlier
sections' cases are already in the files and stay as they are except where a
case below names an edit to one.

#### Fixture change in `tools/argus-ui/test/context.test.mjs` (finding 3)

In the `requestBody` factory (line 9), the `role: 'assistant'` message's
`content` array gains one part **between** the `thinking` part and the
`tool_use` part:

```js
{ type: 'text', text: 'the answer' },
```

Nothing else in the factory moves. The existing case
**'the five kinds the criterion names all reach the list, system prompt first'**
(line 51) then needs its expected array updated to

```js
['system', 'system', 'user', 'system', 'thinking', 'assistant', 'tool_use', 'tool_result', 'field', 'field', 'field', 'field']
```

and its assertion message extended to say the assistant's reply sits between its
thinking and its tool call. No other existing case in the file is touched: the
cases that override `messages` bring their own, and the only case naming a block
index (`expanded: ['12:2']`) still points at the `'ping'` block.

#### New cases in `tools/argus-ui/test/context.test.mjs`

The file gains two imports: `PREVIEW_CHARS` and `laneContentQuery` from
`../public/context.js` (added to the existing import), and
`import { esc } from '../public/format.js';` — the renderer's own escaper, so
the expected text is not a second hand-rolled implementation of it.

| # | Case | Input / state | Expected |
| --- | --- | --- | --- |
| R1 | an assistant reply reaches the list, and the panel marks it as the assistant's | `contextBlocks(requestBody())`, then `renderContextPanel({ lane: lane(), item: item() })` | exactly one block has `kind === 'assistant'`; its `text === 'the answer'`; the markup contains exactly one `<details class="ctx-block" data-kind="assistant"`, and the `<pre class="ctx-text">` inside that block holds `the answer` — the criterion names `assistant` as one of five kinds, and neither dropping the role from `ROLE_KINDS` nor dropping `case 'text'` for it may pass |
| R2 | an expanded block shows the exact full text, not the one line it collapsed to | a body from `requestBody({ messages: [{ role: 'user', content: [{ tool_use_id: 'toolu_01', type: 'tool_result', content: LONG }] }] })` where ``const LONG = '<line of output>\n'.repeat(40)``, rendered with `renderContextPanel({ lane: lane(), item: item({ body }) })` | collect `[...html.matchAll(/<pre class="ctx-text">([\s\S]*?)<\/pre>/g)]`; assert one per block of `contextBlocks(body)`, and for every index `i` the captured group equals `esc(blocks[i].text)` — byte for byte, not a substring test. Guard the case against going vacuous: assert first that the tool-result block's `text.length > PREVIEW_CHARS` and that its `preview !== its text`. `LONG` carries newlines and `<`/`>` so a preview substitution (whitespace collapsed, cut, ellipsis) and an unescaped print both fail here |
| R3 | every block expands to its own text, in the order the list shows them | `renderContextPanel({ lane: lane(), item: item() })` with the default factory | the same `<pre>` extraction, compared position by position against `esc(block.text)` for all twelve blocks — this is R2's rule applied to every kind at once, so a renderer that prints the right text for one kind and the label for another is caught |
| R4 | the main lane asks for the main session's own traffic | `laneContentQuery({ key: 'main', kind: 'main', spanId: null, agent: null })` | `assert.deepEqual(…, { main: '1' })` — exactly that one key |
| R5 | an agent lane asks for its own span, never for the main session | `laneContentQuery({ key: 'agent:sp-a:probe', kind: 'agent', spanId: 'sp-a', agent: 'probe' })` | `assert.deepEqual(…, { span: 'sp-a' })` — the span wins over the name, and the object carries no `main` key and nothing else, so an unfiltered or main-filtered query fails the case |
| R6 | an agent lane with no span falls back to its name | `laneContentQuery({ key: 'agent::probe', kind: 'agent', spanId: null, agent: 'probe' })` | `assert.deepEqual(…, { agent: 'probe' })` |
| R7 | a lane that identifies nothing gets no query at all, so no lane ever shows the main session's context by accident | `laneContentQuery({ key: 'agent::', kind: 'agent', spanId: null, agent: null })`, `laneContentQuery(null)`, `laneContentQuery(undefined)` | `null` for each — an empty filter would send an unfiltered request, which the collector answers with main traffic |

`lane()` in R4 is the file's own factory (`lane()` already is the main lane);
R5-R7 pass literals, since a lane's `kind`/`spanId`/`agent` triple is the whole
input and spelling it out is what makes the case readable.

#### Rewritten cases in `tools/argus-ui/test/page.test.mjs`

| # | Case | Input / state | Expected |
| --- | --- | --- | --- |
| R8 | **replaces** the case at line 404, `'the panel asks the collector for the nearest request at the cursor's moment, for that lane only'`, keeping that name | `functionSource(appJs, 'loadLaneContext')` | matches `/\/api\/content\/at/` and `/resolveCursor\(/` as before, and now matches `/laneContentQuery\(/` — the lane's filter must come from the function R4-R7 test. The three bare `\bmain\b` / `\bspan\b` / `\bagent\b` assertions are **deleted**: prose satisfied them, and the mapping they claimed to check is now pinned by value in `context.test.mjs` |
| R9 | **extends** the case at line 349, `'app.js takes the context panel from its module'` | the whole `app.js` source | keeps the `renderContextPanel` assertion and adds `assert.match(appJs, /import\s*\{[^}]*\blaneContentQuery\b[^}]*\}\s*from\s*['"]\.\/context\.js['"]/, …)`, so the function the unit cases test is the one the page runs |

Every other case in `page.test.mjs` stays exactly as it is, the staleness-guard
case at line 414 included — the guards, the `await` and the
`state.laneContext =` write all keep their relative order under this change.

#### What is deliberately left untested, and why

- **That `loadLaneContext` actually puts the returned filter on the wire.** It
  spreads `...filter` into an `api()` call behind `fetch`; pinning the spread
  would mean a fake `window`, which this project has ruled out. R8 pins that the
  filter comes from `laneContentQuery`, R4-R7 pin what that function returns,
  and the route itself is covered by `tools/argus`' own suite.
- **The reviewer's four observations.** None is a finding; no case here may pin
  behaviour for the refetch cadence, for what happens to expanded blocks when
  the record changes, or for the wording of an existing case name.
- **Everything increment 6 owns** — the tools an agent used up to the moment.
- **CSS, the click and the drag in a browser.** Unchanged this round, and
  unchanged in the code.

#### What counts as done

```
npm --prefix tools/argus-ui test
```

That one command, from the repository root, is the whole list. Only files under
`tools/argus-ui` change, the run costs seconds and needs no install; `tools/argus`'
suite and `./test.sh` stay off the list, as in the earlier rounds.

#### What is already red

I ran nothing this round — not the list, not a baseline. The reviewer's four
sandbox runs already establish that `HEAD` is green at 154 cases, and no run of
mine would add a fact to that.

From reading, two cases are red **during** this round by design, and both are
fixed by the edits named above rather than by anything else:

- `context.test.mjs`'s kind-sequence case (line 51) goes red the moment the
  factory gains the assistant text part, and green again with its expected array
  updated. Both edits belong to the same change.
- `page.test.mjs:404` goes red the moment the filter chain leaves
  `loadLaneContext`, because `\bmain\b`, `\bspan\b` and `\bagent\b` disappear
  from that function together with its comment. R8 is its replacement.

Nothing else turns red: `laneContentQuery` is a new export that no existing case
names, the import line stays a single `import { … } from './context.js'` and so
still matches the case at line 349, `independence.test.mjs` already covers
`public/context.js` and the new function imports nothing, and
`renderContextPanel`, `contextBlocks`, `renderLanePanel`, `scrubTo`, `refresh`
and the delegated listeners are untouched.

## Increment 5 — Round 2

The reviewer raised two findings, both of the same kind and both measured: the
production code still satisfies the criterion, but the wiring between the
cursor and the panel is checked only by grepping `loadLaneContext` for
identifiers, and a grep cannot see which value an identifier becomes. Deleting
the moment from the request (M1) and writing `item: null` instead of the fetched
record (M2) each leave the suite at 161 pass, exit 0 — with either one in place
the panel shows the head's context at every cursor position, or no context at
all.

The fix is not more grepping. The two hops the findings name move into
`context.js`, where `node --test` can execute them with values: one `async`
function that builds the request and fetches it through an **injected** api
function, and one pure function that turns what the page holds into what the
panel is drawn from. `loadLaneContext` and `renderLanePanel` keep only what
genuinely needs the page — reading `state`, the staleness guards, the DOM write
— and the source assertions that remain over them pin exactly one thing each:
that the page hands its own state to those functions and holds what they
return.

Nothing else in this section is scope. The reviewer's "beyond the criteria"
notes (the lane `<button>`, the third argument of `renderTimeline`, the fourth
module under `public/`, the extra request per refresh) are observations he
closed himself; no case below may pin behaviour for them. Increment 6 — the
tools an agent used up to the moment — is not touched.

### The findings, restated as the defects to remove

1. **`app.js:924-929` — "as of that moment" is unpinned.** Nothing asserts that
   a request carries an `at` parameter at all. With the line
   `at: resolveCursor(state.cursor, view).timeMs,` deleted, the page asks
   `GET /api/content/at?session=…&main=1`, the collector defaults the moment to
   `Date.now()` (`tools/argus/src/server.mjs:279`), and every cursor position
   shows the head's context. 161 pass.
2. **`app.js:935` and `app.js:942-956` — "shows that agent's context" is
   unpinned.** Nothing asserts that the fetched record reaches the panel, on
   either hop: not from the awaited answer into `state.laneContext`, and not
   from `state.laneContext` into `renderContextPanel`. With
   `state.laneContext = { key, item: null };` every lane at every moment renders
   the empty panel. 161 pass.

### Implementation plan

Two production files change: `tools/argus-ui/public/context.js` gains three
functions (two exported), and `tools/argus-ui/public/app.js` delegates to them.
No file in `tools/argus` changes, no markup, no CSS, no documentation: nothing a
reader of the page can see moves.

**A. `tools/argus-ui/public/context.js` — the data path becomes executable.**

Add a second import under the existing one at line 16:

```js
import { resolveCursor } from './timeline.js';
```

`timeline.js` imports only `format.js`, so this adds no cycle, and the
specifier resolves inside the project, so `independence.test.mjs` stays green.

Extend the module header (lines 1-14) so it still describes the whole module:
it holds everything the panel behind one lane needs — which record it asks for,
the one call that goes and gets it through an api function the caller injects,
and how the answer renders. Keep the "no `document`, no `fetch`, no `location`"
sentence: it is still true, and it is the reason `node --test` can import this.

Add, after `laneContentQuery` (which stays exactly as it is, export included):

```js
/**
 * The whole request behind one lane's context: which session, which moment,
 * which lane.
 *
 * The moment is resolved here and nowhere else, so "the nearest request at or
 * before the cursor" is one decision in one place: a live cursor asks for the
 * head of the window, a parked one for its own moment, and neither can ask for
 * a moment outside the recorded window. A lane the filter cannot identify gets
 * no request at all — an unfiltered one would answer with the main session's
 * context under an agent's lane.
 *
 * @param {{ session: string|null, key: string|null, view: object|null, cursor: object|null }} input
 * @returns {{ session: string, at: number }|null} plus exactly one of main/span/agent
 */
function laneContentRequest({ session = null, key = null, view = null, cursor = null } = {}) {
  if (!session || !key) return null;
  const filter = laneContentQuery((view?.lanes ?? []).find((lane) => lane.key === key));
  if (!filter) return null;
  return { session, at: resolveCursor(cursor, view).timeMs, ...filter };
}

/**
 * Fetch the record one lane's context is drawn from, through the api function
 * the caller hands in — this module reaches the network through nothing of its
 * own.
 *
 * The rejection is swallowed here: a failed fetch costs the panel and not the
 * page that is refreshing it. The record comes back tagged with the lane it was
 * fetched for, which is what lets the caller drop an answer for a lane the
 * reader has already left.
 *
 * @param {(path: string, params: object) => Promise<{ item?: object|null }>} api
 * @param {{ session: string|null, key: string|null, view: object|null, cursor: object|null }} input
 * @returns {Promise<{ key: string|null, item: object|null }>}
 */
export async function fetchLaneContext(api, { session = null, key = null, view = null, cursor = null } = {}) {
  const request = laneContentRequest({ session, key, view, cursor });
  const answer = request ? await api('/api/content/at', request).catch(() => null) : null;
  return { key, item: answer?.item ?? null };
}

/**
 * What the panel is drawn from, out of what the page holds.
 *
 * The held answer belongs to the lane it was fetched for; anything else means a
 * fetch is still in flight, which is not the same answer as "there is nothing
 * here". The two keys are the two fields `renderContextPanel` reads, so the
 * result spreads straight into its input.
 *
 * @param {string|null} key the lane the reader has open
 * @param {{ key: string|null, item: object|null }|null} held
 * @returns {{ item: object|null, pending: boolean }}
 */
export function laneContextInput(key, held) {
  const fresh = held?.key === key;
  return { item: fresh ? (held.item ?? null) : null, pending: !fresh };
}
```

`laneContentRequest` is **not** exported: every one of its decisions is observed
through `fetchLaneContext`, and an export nothing outside the module calls is
one more name for a reader to place.

**B. `tools/argus-ui/public/app.js` — the page hands its state over and holds
the answer.**

- Line 11 becomes
  `import { fetchLaneContext, laneContextInput, renderContextPanel } from './context.js';`.
  `laneContentQuery` leaves this import: the page no longer calls it.
- `resolveCursor` stays in the `./timeline.js` import — line 1088 still uses it.
- `loadLaneContext` (lines 915-936) keeps its name, its signature, its doc
  comment, its early return through `clearLaneContext()` and both staleness
  guards. Its middle becomes two lines:

```js
  const held = await fetchLaneContext(api, { session: id, key, view: laneView(), cursor: state.cursor });
  // The selection can move while this is in flight — a click, a scrub or a
  // session change. An answer for a lane the reader has left must never be
  // painted under the lane they are on now.
  if (state.selectedSessionId !== id || state.selectedLane !== key) return;
  state.laneContext = held;
```

  The `const view = laneView();`, `const filter = …`, `const answer = …` lines
  and the `at:`/`...filter` object all go away with it.
- `renderLanePanel` (lines 942-956) keeps the container lookup, the `if
  (!container) return;`, the `key` and `lane` lines. The `const held = …` line
  and the two-line comment above it go, and the call becomes:

```js
  container.innerHTML = renderContextPanel({
    lane,
    ...laneContextInput(key, state.laneContext),
    expanded: state.expanded,
  });
```

  Delete that comment rather than keep it: its text now sits on
  `laneContextInput`, and two wordings of one rule disagree after the first
  edit.
- `clearLaneContext` (line 905) and `selectSession`'s reset (line 1053) keep
  their `{ key: null, item: null }` literals untouched.

### Decisions, including the ones rejected

1. **An injected `api` rather than three more pure functions plus three more
   greps.** The finding is that a grep cannot see a value; the answer is to put
   the hop where a test can run it. `fetchLaneContext(api, …)` executes the real
   path — the URL, the parameters, the swallowed rejection, the record that
   comes back — against a fake function the test writes in four lines. Rejected:
   a pure `laneContentRequest`/`heldLaneContext` pair left in `app.js`'s hands,
   which pins the values but leaves "does the request actually go on the wire,
   with that object" and "is the awaited answer what gets written" as two more
   source assertions of exactly the kind that let M1 and M2 through.
2. **The injection does not break the module's contract.** `context.js` still
   names no `fetch`, no `document`, no `location`; it calls what it is handed.
   That is what keeps it importable under `node --test` and keeps the project's
   no-DOM test convention intact. Rejected: importing `app.js` in a test behind
   a fake `window`/`document` — `app.js:24` reads `location.search` at module
   top level, so the import throws before any test runs, and building a DOM fake
   large enough to change that means a dependency, which this project forbids
   (`tools/argus-ui/CLAUDE.md`, "Zero runtime dependencies").
3. **The moment is resolved inside `laneContentRequest`, not passed in.** If the
   caller passed `at`, deleting it at the call site would leave every unit case
   green and only a grep between the criterion and the head's context — M1 all
   over again. Resolving it inside means one deepEqual over the request pins the
   moment by value. The cost is one intra-project import, `context.js` →
   `timeline.js`; the direction is right (the panel's request is expressed in
   the timeline's cursor and lanes) and there is no cycle.
4. **`laneContentQuery` stays exported and unchanged although `app.js` no
   longer imports it.** Its four cases pin the lane→filter mapping at the
   finest grain there is — "never the main session's traffic under an agent's
   lane" — and the export is what lets them. Rejected: unexporting it and
   deleting those cases (throws away round 1's answer to a closed finding), and
   inlining it into `laneContentRequest` (one function with two jobs).
5. **`laneContextInput` returns `{ item, pending }`, the exact two keys
   `renderContextPanel` reads, so it spreads.** A test then spreads the same
   result into the same renderer, which is what pins the key *names* — a
   deepEqual alone would happily accept `{ record, pending }` and a silently
   empty panel. Rejected: passing the held object straight to
   `renderContextPanel` and teaching it about `key` (it would then need the
   selected lane too, and 42 existing cases pass `item`/`pending`).
6. **Nothing is renamed and nothing else moves.** `loadLaneContext`,
   `renderLanePanel`, `scheduleLaneContext`, `clearLaneContext`, `laneView` and
   every listener keep their names and their order, so every increment-5 case in
   `page.test.mjs` other than the two named below stays as it is.

### Module map

| Path | What it holds | Entry points |
| --- | --- | --- |
| `tools/argus-ui/public/context.js` | header 1-14, `import … format.js` 16, `PREVIEW_CHARS` 19, `contextBlocks` 65, `laneContentQuery` 158, `renderContextPanel` 175 | gains `import { resolveCursor } from './timeline.js'`, the private `laneContentRequest`, and the exports `fetchLaneContext` and `laneContextInput` |
| `tools/argus-ui/public/app.js` | `api()` 64 (drops `null`/`undefined`/`''` params), `laneView` 900, `clearLaneContext` 905, `loadLaneContext` 915-936, `renderLanePanel` 942-956, `scheduleLaneContext` 960, `refresh`'s refetch 1013, `selectSession`'s reset 1053, `resolveCursor` still used at 1088 | line 11 import, the middle of `loadLaneContext`, the `renderContextPanel(` call in `renderLanePanel` |
| `tools/argus-ui/public/timeline.js` | `buildLanes` 69 (lane = `{ key, kind, agent, spanId, label, startMs, endMs, records }`; view = `{ startMs, endMs, durationMs, lanes }`), `liveCursor` 320, `scrubCursor` 331, `resolveCursor` 346 (live → `endMs`, parked → clamped into the window) — **read only, unchanged** | `resolveCursor` is what `context.js` now imports |
| `tools/argus-ui/test/context.test.mjs` | 33 cases; factories `requestBody` 10, `item` 36, `lane` 48; the `laneContentQuery` block 430-458; file ends at 459 | gains two factories and the twelve cases below |
| `tools/argus-ui/test/page.test.mjs` | helpers `functionSource` 20, `detailListener` 29; increment 5's block 346-518; the cases to rewrite at 349 and 409 | two rewrites, two new cases |
| `tools/argus-ui/test/independence.test.mjs` | the project-wide import rule; already lists `public/context.js`, allows any specifier resolving inside the project — **unchanged** | — |
| `tools/argus/src/server.mjs` | `/api/content/at`, `atMs: intParam(searchParams, 'at', Date.now())` at 279 — **unchanged, and its suite is not run this round** | — |

### Environment

Node ≥ 20.11, already installed. Zero runtime dependencies, no install step, no
build step, and **there is no linter and no formatter in this repository** — no
`.prettierrc`, no `.editorconfig`, no eslint config anywhere.

The one command this round's test plan asks anyone to run, from the repository
root:

```
npm --prefix tools/argus-ui test
```

While working on a single file, `node --test tools/argus-ui/test/context.test.mjs`
and `node --test tools/argus-ui/test/page.test.mjs` run just that file; neither
is part of the closed list below.

### Test Plan

Tests are needed: both findings are missing assertions, and both are the reason
the production change above exists. Everything is `node:test` +
`node:assert/strict` in `tools/argus-ui/test/`, in the style already in those
files — one `test('a sentence stating the fact', () => {…})` per fact, factories
at the top of the file, a message on every non-obvious assert, nothing mocked
beyond the one four-line api fake below.

This section's list is the whole of what is asked for this round. Earlier
sections' cases are already in the files and stay as they are except the two
`page.test.mjs` cases a rewrite below names.

#### New factories in `tools/argus-ui/test/context.test.mjs`

Below the existing `lane` factory (line 48), and used by the cases that follow:

```js
const agentLane = (over = {}) =>
  lane({ key: 'agent:sp-b:probe', kind: 'agent', label: 'probe', spanId: 'sp-b', agent: 'probe', ...over });

const view = (over = {}) => ({ startMs: 1000, endMs: 5000, durationMs: 4000, lanes: [lane(), agentLane()], ...over });

/** An api function that records what it was asked for and answers what it was given. */
const recorder = (answer = { item: item() }) => {
  const calls = [];
  return {
    calls,
    api: async (path, params) => {
      calls.push({ path, params });
      return typeof answer === 'function' ? answer() : answer;
    },
  };
};
```

The view is a literal rather than `buildLanes(...)` output: the two fields
`resolveCursor` reads and the four a lane's filter reads are the whole input,
and spelling them out is what makes each case readable. `buildLanes`' own shape
is pinned by `timeline.test.mjs`, and the `lane` factory already models it.

#### New cases in `tools/argus-ui/test/context.test.mjs`

Appended after the `laneContentQuery` block, under a comment
`// fetchLaneContext(api, …) — the request that goes on the wire, and the record
that comes back.` The file's import at line 4 gains `fetchLaneContext` and
`laneContextInput`. Every case is `async` where it awaits.

| # | Case | Input / state | Expected |
| --- | --- | --- | --- |
| F1 | the request carries the cursor's own moment, for that lane only | `const { api, calls } = recorder();` then `await fetchLaneContext(api, { session: 's1', key: 'main', view: view(), cursor: { live: false, timeMs: 3000 } })` | `calls.length === 1`; `calls[0].path === '/api/content/at'`; `assert.deepEqual(calls[0].params, { session: 's1', at: 3000, main: '1' })` — exactly those three keys, so a request with no `at` (which the collector answers with the head, at every cursor position) fails here |
| F2 | a live cursor asks for the head of the recorded window | same, `cursor: { live: true, timeMs: null }` | `calls[0].params.at === 5000`, the view's `endMs` |
| F3 | a moment outside the window is clamped to it, never sent raw | `cursor: { live: false, timeMs: 9_000_000 }`, then a second call with `cursor: { live: false, timeMs: 0 }` | `at === 5000` and `at === 1000` — the moment goes through `resolveCursor`, not straight from `cursor.timeMs` |
| F4 | an agent lane asks with its own span, at the same moment | `key: 'agent:sp-b:probe'`, `cursor: { live: false, timeMs: 3000 }` | `assert.deepEqual(calls[0].params, { session: 's1', at: 3000, span: 'sp-b' })` — no `main` key, and the moment travels with the filter |
| F5 | the fetched record comes back under the lane it was fetched for | `const rec = item(); const { api } = recorder({ item: rec });` then `fetchLaneContext(api, { session: 's1', key: 'main', view: view(), cursor: { live: true, timeMs: null } })` | `assert.deepEqual(result, { key: 'main', item: rec })` **and** `assert.equal(result.item, rec, 'the record itself, not a copy and not null')` — this is the case a `{ key, item: null }` write fails |
| F6 | a lane the filter cannot identify fires no request at all | `view({ lanes: [lane(), lane({ key: 'agent::', kind: 'agent', label: 'subagent', spanId: null, agent: null })] })` with `key: 'agent::'`; then a second call with `key: 'agent:gone:x'`, which no lane in the view carries | `calls.length === 0` both times, and the result is `{ key: <that key>, item: null }` — an unfiltered request would answer with the main session's context under an agent's lane |
| F7 | with no lane open, or no session, nothing is asked for | `key: null` with a session; then `session: null` with `key: 'main'`; then `fetchLaneContext(api)` with no input object at all | `calls.length === 0` in all three; results `{ key: null, item: null }`, `{ key: 'main', item: null }`, `{ key: null, item: null }` |
| F8 | a failed fetch costs the panel and not the page | `const api = async () => { throw new Error('offline'); }` | the promise resolves rather than rejects, to `{ key: 'main', item: null }` — use `await fetchLaneContext(...)` directly, so a rejection fails the case as an error |
| F9 | an answer with no record is held as no record | api resolving `{}`, then `null`, then `{ item: null }` | `item === null` each time, and `key` still the lane's |
| F10 | the held record for the open lane is what the panel is drawn from | `const rec = item(); laneContextInput('main', { key: 'main', item: rec })` | `assert.deepEqual(out, { item: rec, pending: false })` and `assert.equal(out.item, rec)` |
| F11 | an answer held for another lane means a fetch in flight, not an empty context | `laneContextInput('agent:sp-b:probe', { key: 'main', item: item() })`; `laneContextInput('main', { key: null, item: null })`; `laneContextInput('main', null)` | `{ item: null, pending: true }` each time — saying "no API request here" while a fetch is in flight is the panel lying |
| F12 | what the page holds spreads straight into the panel, and the record's own content is what it shows | `const rec = item();` then `renderContextPanel({ lane: lane(), ...laneContextInput('main', { key: 'main', item: rec }), expanded: [] })`, and a second render with the held key `'agent:sp-b:probe'` | the first matches `/data-state="ready"/` and contains `You are a Claude agent.` and `the answer` (the fixture's own system prompt and assistant text); the second matches `/data-state="pending"/`. This is what pins the key *names*: a result carrying the record under any other field renders the pending panel and fails here |

#### Rewritten and new cases in `tools/argus-ui/test/page.test.mjs`

| # | Case | Input / state | Expected |
| --- | --- | --- | --- |
| P1 | **replaces** the case at line 349, `'app.js takes the context panel from its module'`, keeping that name | the whole `app.js` source | three assertions of the form `/import\s*\{[^}]*\bNAME\b[^}]*\}\s*from\s*['"]\.\/context\.js['"]/` for `renderContextPanel`, `fetchLaneContext` and `laneContextInput`. The `laneContentQuery` assertion is **deleted**: the page no longer calls it, and the mapping stays pinned by value in `context.test.mjs` |
| P2 | **replaces** the case at line 409, `'the panel asks the collector for the nearest request at the cursor\'s moment, for that lane only'`, keeping that name | `functionSource(appJs, 'loadLaneContext')`, then the statement slice from `indexOf('fetchLaneContext(')` to the next `';'` | the slice exists, and matches `/\bapi\b/`, `/session:\s*id\b/`, `/\bkey\b/`, `/view:\s*laneView\(\)/` and `/cursor:\s*state\.cursor\b/` — the page's own api, session, lane, lane view and cursor all reach the function whose request F1-F4 pin by value. The old `/\/api\/content\/at/` and `/resolveCursor\(/` assertions are **deleted**: both now live in `context.js` and are pinned by F1 |
| P3 | **new**, `'the fetched context is what the panel state holds'` | `functionSource(appJs, 'loadLaneContext')` | capture `const name = loadLaneContext.match(/const\s+(\w+)\s*=\s*await\s+fetchLaneContext\(/)`, assert it matched; slice from `indexOf('state.laneContext =')` to the next `';'` and assert it matches `new RegExp('state\\.laneContext\\s*=\\s*' + name[1] + '\\b')`. A literal written there instead — `{ key, item: null }` — shows a different context than the one fetched, and fails. No variable name is pinned: the case reads the name off the await |
| P4 | **new**, `'the panel is drawn from the answer held for the lane it belongs to'` | `functionSource(appJs, 'renderLanePanel')`, sliced from `indexOf('renderContextPanel(')` to the next `';'` | matches `/\.\.\.laneContextInput\(\s*key\s*,\s*state\.laneContext\s*\)/` and `/expanded:\s*state\.expanded/` — the held answer is the panel's input, so the second hop cannot be cut either |

Both slices in P2-P4 run to the next `;`, so a line-wrapped call passes just as
a one-line call does; no statement involved contains a `;` of its own.

Every other case in `page.test.mjs` stays exactly as it is, the staleness-guard
case at line 421 included: `loadLaneContext` still awaits, still guards on
`state.selectedLane !== key` and `state.selectedSessionId !== id` after that
await, and still writes `state.laneContext =` after both.

#### What is deliberately left untested, and why

- **That the browser's own `fetch` reaches the collector.** F1-F9 run against an
  injected api function; the transport itself is `app.js`'s `api()`, unchanged
  this round, and the route is covered by `tools/argus`' own suite.
- **`laneContentRequest` directly.** It is not exported; every decision it makes
  is observed through `fetchLaneContext` in F1-F7, which is the shape the page
  actually calls.
- **The click, the drag and the CSS in a real browser.** Unchanged in the code
  this round.
- **The reviewer's "beyond the criteria" observations** — the lane `<button>`,
  `renderTimeline`'s third argument, the extra request per live refresh, the
  expansion set collapsing when the record changes. None is a finding, and no
  case may pin behaviour for them.
- **Everything increment 6 owns** — the tools an agent used up to the moment.

#### What counts as done

```
npm --prefix tools/argus-ui test
```

That one command, from the repository root, is the whole list. Only files under
`tools/argus-ui` change, the run costs seconds and needs no install;
`tools/argus`' suite and `./test.sh` stay off the list, as in every earlier
round of this increment.

#### What is already red

I ran nothing this round — not the list, not a baseline. The reviewer's run
already establishes that `HEAD` is green at 161 cases, and no run of mine would
add a fact to that.

From reading, exactly two cases are red **during** this round by design, and
both are rewritten above rather than fixed anywhere else:

- `page.test.mjs:349` goes red the moment `app.js` stops importing
  `laneContentQuery`; P1 is its replacement.
- `page.test.mjs:409` goes red the moment the request leaves `loadLaneContext`,
  because `/api/content/at` and `resolveCursor(` move into `context.js` with it;
  P2 is its replacement.

Nothing else turns red: `fetchLaneContext` and `laneContextInput` are new
exports no existing case names, `laneContentQuery`, `contextBlocks`,
`renderContextPanel` and every fixture in `context.test.mjs` are untouched,
`independence.test.mjs` already lists `public/context.js` and accepts a
specifier that resolves inside the project, and `clearLaneContext`,
`scheduleLaneContext`, `scrubTo`, `refresh`, `selectSession` and the delegated
listeners keep every line the remaining cases read.

## Increment 6

The panel works. Three rounds of review read the production code line by line
and found it meeting the criterion every time; what the suite cannot see is the
last stretch of the chain from the click to the markup. This increment closes
exactly that: the reviewer's five measured mutations (M-A … M-E) each have to
fail a case when this increment is done, and nothing a reader of the page can
see may move.

The criterion carried forward from the blocked increment — "selecting a lane at
the chosen time shows that agent's (or the main session's) context as of that
moment, as a structured message list, each block collapsed to one line with its
size, expandable to the exact full text" — is owned here now. It is met by the
code as it stands; this section does not rebuild it, it pins it.

### The planner's open question, answered per hop

The planner asked, for each of the three hops, whether it can be made
value-testable or whether a sharpened source assertion is the honest ceiling.

| Hop | Finding | Answer |
| --- | --- | --- |
| The selected lane reaching the panel (M-A, M-C) | 1 | **Value-testable, by restructuring.** The lane lookup and the whole object `renderContextPanel` is called with move into `context.js` as one pure `lanePanelInput`. Both mutations then fail an executable case. One source assertion stays, over the four page values handed in. |
| The click's own repaint (M-B) | 2 | **A sharpened source assertion is the ceiling, and it kills M-B.** The hop is DOM event → DOM write; there is no value in it to assert. Today's case reads only that `loadLaneContext(` appears in the branch. The new one reads the statement and requires the repaint chained on that fetch's own promise. |
| The sizes and the preview in the markup (M-D, M-E) | 3 | **Already value-testable; only the assertions were loose.** No production change at all — the cases in `context.test.mjs` compare what the markup prints against the block's own `chars` and `preview`. |

### Implementation plan

Two production files change, both under `tools/argus-ui/public`. No markup, no
CSS, no README, no file in `tools/argus`. The rendered output is byte-identical
before and after.

**A. `tools/argus-ui/public/context.js` — the panel's whole input becomes one
pure value.**

Add, directly after `laneContextInput` (which stays exactly as it is, export
included) and before `renderContextPanel`:

```js
/**
 * Everything `renderContextPanel` is drawn from, out of what the page holds.
 *
 * The lane is looked up by the key the reader selected and by nothing else: a
 * lookup that lands on another lane paints one agent's context under another
 * agent's heading, and the reader cannot tell. A key no lane in the view
 * carries — and no key at all — resolves to no lane, which is how the panel
 * disappears when the selection is let go.
 *
 * The four keys are the four `renderContextPanel` reads, so the result is its
 * argument whole: the page cannot drop one of them on the way.
 *
 * @param {{ view: object|null, key: string|null, held: object|null, expanded: string[]|Set<string> }} input
 * @returns {{ lane: object|null, item: object|null, pending: boolean, expanded: string[]|Set<string> }}
 */
export function lanePanelInput({ view = null, key = null, held = null, expanded = [] } = {}) {
  const lane = key ? ((view?.lanes ?? []).find((entry) => entry.key === key) ?? null) : null;
  return { lane, ...laneContextInput(key, held), expanded };
}
```

The module header (lines 1-16) already says the module holds "what the page
holds turned into what the panel is drawn from" — still true, leave it.

**B. `tools/argus-ui/public/app.js` — the page hands its state over.**

- Line 11 becomes
  `import { fetchLaneContext, lanePanelInput, renderContextPanel } from './context.js';`.
  `laneContextInput` leaves this import: the page no longer calls it.
- `renderLanePanel` (lines 934-944) keeps its name, its doc comment, the
  container lookup and the `if (!container) return;`. The `const key` and
  `const lane` lines go, and the body becomes:

```js
  container.innerHTML = renderContextPanel(
    lanePanelInput({
      view: laneView(),
      key: state.selectedLane,
      held: state.laneContext,
      expanded: state.expanded,
    }),
  );
```

- Nothing else in `app.js` changes. `loadLaneContext`, `clearLaneContext`,
  `scheduleLaneContext`, `laneView`, `refresh`, `selectSession` and every
  listener — the `[data-lane]` branch at 1147-1155 included — keep every line
  they have. Finding 2 is closed by a test, not by an edit.

### Decisions, including the ones rejected

1. **`lanePanelInput` returns the whole argument object, not just the lane.**
   M-A was "delete the `lane,` line from the object literal in `app.js`". Once
   the object is built in the pure module there is no line in `app.js` to
   delete, and the deletion that remains — dropping `key: state.selectedLane`
   from the one call — is a named key a source assertion reads. Rejected: adding
   only a pure `laneByKey(view, key)` and keeping the literal in `app.js`, which
   pins M-C by value but leaves M-A exactly where it was, guarded by a source
   assertion on a `lane:` property.
2. **`laneContextInput` stays exported although `app.js` no longer imports it.**
   Its three cases pin the fresh/foreign/absent mapping at the finest grain
   there is, and the export is what lets them run. This is the same call the
   previous round made for `laneContentQuery`; making it private would delete a
   closed finding's answer.
3. **Finding 2 gets a sharpened assertion and no production change.** Rejected:
   consolidating the three `loadLaneContext().then(renderLanePanel)` call sites
   (`scheduleLaneContext` 952, the live control 1144, the lane click 1153) into
   one `refreshLanePanel()` helper — it moves the mutation surface without
   making it executable, and it edits two call sites no criterion of mine names.
   Rejected: a hand-rolled DOM so a test could import `app.js` and dispatch a
   real click — `app.js:24` reads `location.search` at module top level and the
   module exports nothing, so driving it needs fakes for `document`,
   `closest`, `querySelectorAll`, `EventSource`, `fetch`, `setInterval` and
   `navigator`; that is a jsdom-sized harness hand-written into the suite, and a
   dependency is forbidden (`tools/argus-ui/CLAUDE.md`, "Zero runtime
   dependencies").
4. **`laneView()` is now called on every panel repaint, including when no lane
   is selected.** Today the lookup is guarded by `key ? … : null`, so a repaint
   with nothing selected skips the build. Passing the view unconditionally is
   what keeps the call one flat expression a source assertion can read. The cost
   is one `buildLanes` over at most 2000 records per repaint, which the comment
   above `laneView` (app.js:894-899) already judges free, and the panel with no
   lane still renders the empty string, so nothing on screen changes.
5. **Finding 3 changes no production code.** The renderer already prints
   `block.chars` and `block.preview`; M-D and M-E are mutations of correct code
   that the assertions failed to read. Rejected: restructuring the summary line
   into a helper "so it can be unit-tested" — the markup is already the unit,
   and touching it would risk the one thing this increment must not move.

### Module map

| Path | What it holds | Entry points |
| --- | --- | --- |
| `tools/argus-ui/public/context.js` (288 lines) | header 1-16, imports `format.js` 18 and `resolveCursor` from `timeline.js` 19, `PREVIEW_CHARS` 22, `textOf` 35, `previewOf` 48, `makeBlock` 53, `contextBlocks` 68, `laneContentQuery` 161, private `laneContentRequest` 183, `fetchLaneContext` 204, `laneContextInput` 222, `renderContextPanel` 236 (head 265-269, block rows 271-285; the size span is line 280, the preview span line 279) | gains the export `lanePanelInput` after line 225 |
| `tools/argus-ui/public/app.js` (1284 lines) | import from `context.js` 11, `laneView` 900, `clearLaneContext` 905, `loadLaneContext` 915, `renderLanePanel` 934, `scheduleLaneContext` 948, `refresh` 987 (refetch 1001), `selectSession` 1024, `paintCursor` 1073, `scrubTo` 1091, `wireEvents` 1126 (live branch 1138-1146, lane branch 1147-1155, block-expand branch 1156-1164) | line 11 and the body of `renderLanePanel` |
| `tools/argus-ui/public/timeline.js` (465 lines) | `buildLanes` (lane = `{ key, kind, agent, spanId, label, startMs, endMs, records }`; view = `{ startMs, endMs, durationMs, lanes }`), `resolveCursor` 346, `renderTimeline` — **read only, unchanged** | — |
| `tools/argus-ui/public/format.js` | `esc` 9, `fmtNum` 15 (`>=1000` → `1.2k`, else the exact digits), `fmtClock` 43, `shortId` 63 — **unchanged** | the test computes expected sizes through `fmtNum` |
| `tools/argus-ui/test/context.test.mjs` (648 lines) | imports 4-12; factories `requestBody` 17, `item` 43, `lane` 55, `agentLane` 57, `view` 60, `recorder` 63; the render block 275-382; the round-1 block 384-452; `laneContentQuery` 454-482; `fetchLaneContext`/`laneContextInput` 484-647 | one import line, one helper, three rewritten assertions, four new cases |
| `tools/argus-ui/test/page.test.mjs` (549 lines) | helpers `functionSource` 20, `detailListener` 29; increment 5's block 346-548 | two rewritten cases (349, 462), one new case |
| `tools/argus-ui/test/independence.test.mjs` | the project-wide import rule; already lists `public/context.js` — **unchanged** | — |

### Environment

Node ≥ 20.11, already installed. Zero runtime dependencies, no install step, no
build step, and **there is no linter and no formatter in this repository** — no
eslint config, no `.prettierrc`, no `.editorconfig`.

The one command this increment's test plan asks anyone to run, from the
repository root:

```
npm --prefix tools/argus-ui test
```

It runs `node --test "test/*.test.mjs"` over the six files in
`tools/argus-ui/test/` and takes seconds. While working on a single file,
`node --test tools/argus-ui/test/context.test.mjs` and
`node --test tools/argus-ui/test/page.test.mjs` run just that file; neither is
part of the closed list below.

### Test Plan

Tests are needed, and they are the whole point of the increment: every case
below exists because a measured mutation survives without it. Everything is
`node:test` + `node:assert/strict` in `tools/argus-ui/test/`, in the style
already in those files — one `test('a sentence stating the fact', () => {…})`
per fact, factories at the top of the file, a message on every non-obvious
assert, nothing faked beyond the `recorder` api function already there. No test
imports `tools/argus`, and no test needs a DOM.

This section's list is the whole of what is asked for. Every other case in both
files stays exactly as it is; the two rewrites named below are the only existing
cases that may be touched, and they are touched because the production change
makes them read a line that no longer exists.

#### Criterion — the panel is drawn from the lane the reader selected (M-A, M-C)

Level: unit, executable, in `tools/argus-ui/test/context.test.mjs`, plus one
source assertion in `tools/argus-ui/test/page.test.mjs`. The import at line 4-11
of `context.test.mjs` gains `lanePanelInput`. The existing `lane()`,
`agentLane()`, `view()` and `item()` factories are the whole input; `view()`
already carries `[lane(), agentLane()]`, i.e. the main lane and
`agent:sp-b:probe`.

| # | Case name | Input / state | Expected |
| --- | --- | --- | --- |
| C1 | `the panel input is built from the lane whose key the reader selected` | `const v = view(); const rec = item();` then `lanePanelInput({ view: v, key: 'agent:sp-b:probe', held: { key: 'agent:sp-b:probe', item: rec }, expanded: ['12:0'] })` | `assert.deepEqual(out, { lane: v.lanes[1], item: rec, pending: false, expanded: ['12:0'] })` and `assert.equal(out.lane, v.lanes[1], 'the agent lane itself — a lookup that lands on the main lane puts a subagent under the main session\'s heading')`. Then the same for `key: 'main'` with `held: { key: 'main', item: rec }`: `out.lane === v.lanes[0]` |
| C2 | `a key no lane carries, and no key at all, leave nothing to draw` | `lanePanelInput({ view: view(), key: 'agent:gone:x', held: null })`; `lanePanelInput({ view: view(), key: null, held: { key: null, item: null } })`; `lanePanelInput()` with no argument | `lane === null` all three times; the last is `deepEqual` to `{ lane: null, item: null, pending: true, expanded: [] }`; and `assert.equal(renderContextPanel(lanePanelInput({ view: view(), key: null, held: null })), '', 'no lane selected, no panel under the timeline')` |
| C3 | `a subagent lane's context is drawn under that subagent's own heading` | `const rec = item();` then `renderContextPanel(lanePanelInput({ view: view(), key: 'agent:sp-b:probe', held: { key: 'agent:sp-b:probe', item: rec }, expanded: [] }))` | `assert.match(html, /data-state="ready"/, 'an input with no lane renders the empty string — this is the case a dropped lane fails')`; `assert.ok(html.includes('data-context-lane="agent:sp-b:probe"'))`; `assert.ok(html.includes('probe'))`; `assert.ok(!html.includes('main session'), 'the main session\'s heading over a subagent\'s context is the mutation this case exists to catch')`; `assert.ok(html.includes('the answer'), 'the record\'s own content must be what the panel shows')`. Then the main-lane counterpart with `key: 'main'`: `data-context-lane="main"` and `html.includes('main session')` |
| P2 | **replaces** `page.test.mjs:462`, renamed to `the panel is drawn from the lane the reader selected and the answer held for it` | `functionSource(appJs, 'renderLanePanel')`, sliced from `indexOf('renderContextPanel(')` to the next `';'` (the call spans lines and contains no `;` of its own) | the slice matches `/lanePanelInput\(/`, `/view:\s*laneView\(\)/`, `/key:\s*state\.selectedLane\b/` (message: without it the panel paints empty for every lane), `/held:\s*state\.laneContext\b/` and `/expanded:\s*state\.expanded\b/`. The old `/\.\.\.laneContextInput\(\s*key\s*,\s*state\.laneContext\s*\)/` assertion is **deleted**: that call now lives inside `lanePanelInput` and C1 pins it by value |
| P1 | **replaces** `page.test.mjs:349`, keeping its name `app.js takes the context panel from its module` | the whole `app.js` source | the loop's name list becomes `['renderContextPanel', 'fetchLaneContext', 'lanePanelInput']` — `laneContextInput` is dropped from it, because the page no longer imports it and the case would otherwise go red on a correct change |

#### Criterion — selecting a lane repaints the panel when its own fetch resolves (M-B)

Level: source assertion over `app.js`, in `tools/argus-ui/test/page.test.mjs`.
The honest ceiling for this hop, per the table above.

| # | Case name | Input / state | Expected |
| --- | --- | --- | --- |
| P3 | **new**, `selecting a lane repaints the panel once its own fetch resolves, without waiting for an ingest` | `const clickListener = detailListener(appJs, 'click');` then `const laneIdx = clickListener.indexOf('data-lane');`, `const loadIdx = clickListener.indexOf('loadLaneContext(', laneIdx);`, `const endIdx = clickListener.indexOf(';', loadIdx);`, `const slice = clickListener.slice(loadIdx, endIdx);` | `assert.ok(laneIdx >= 0)`, `assert.ok(loadIdx > laneIdx, 'the lane branch must fetch the context it is about to show')`, `assert.ok(endIdx > loadIdx)`, and `assert.match(slice, /\.then\(\s*(?:renderLanePanel\b|\(\s*\)\s*=>\s*renderLanePanel\s*\()/, 'the fetch the click started must repaint the panel when it resolves — a finished session receives no further ingest, so nothing else ever repaints it and the panel keeps its pending line forever')` |

The existing case at `page.test.mjs:394`, `selecting a lane fetches its
context`, stays as it is: it pins that the fetch happens, P3 pins that its
answer is painted.

#### Criterion — the sizes and the one line reach the markup (M-D, M-E)

Level: unit, executable, in `tools/argus-ui/test/context.test.mjs`. No
production change. `fmtNum` joins `esc` in the import from
`../public/format.js` at line 12. Add one helper beside the factories, used by
the two new cases only:

```js
/** The markup of each rendered block, in the order the panel prints them. */
const blockChunks = (html) => [...html.matchAll(/<details class="ctx-block"[\s\S]*?<\/details>/g)].map((m) => m[0]);
```

| # | Case name | Input / state | Expected |
| --- | --- | --- | --- |
| C4 | `every collapsed line shows that block's own size` | `const { blocks } = contextBlocks(requestBody()); const chunks = blockChunks(renderContextPanel({ lane: lane(), item: item() }));` | first `assert.ok(new Set(blocks.map((b) => b.chars)).size > 1, 'the fixture must carry blocks of differing sizes, or one size printed for all of them would pass')` and `assert.equal(chunks.length, blocks.length)`; then per block `const m = chunks[i].match(/<span class="ctx-size" data-chars="(\d+)">([\s\S]*?)<\/span>/);` `assert.ok(m, …)`, `assert.equal(Number(m[1]), blocks[i].chars, 'block i must advertise its own measured size')`, `assert.equal(m[2], esc(fmtNum(blocks[i].chars)), 'and the reader must see that same size, not another block\'s and not zero')` |
| C5 | **rewrites two assertions inside the existing case at `context.test.mjs:302`**, `the head names the lane and the record the context came from` | `const body = requestBody(); const html = renderContextPanel({ lane: lane(), item: item({ body }) });` | the loose `assert.match(html, /data-chars="\d+"/)` on line 305 becomes `assert.match(html, new RegExp('<span class="context-meta" data-chars="' + body.length + '"'), 'the head\'s total must be the body\'s own length, not any number')`, and one assertion is added: `assert.ok(html.includes(fmtNum(body.length) + ' chars'), 'the readable line must carry the same total the data attribute does')`. Every other assertion in that case stays |
| C6 | `the one line a collapsed block shows reaches the markup` | `const { blocks } = contextBlocks(requestBody()); const chunks = blockChunks(renderContextPanel({ lane: lane(), item: item() }));` | first `assert.ok(blocks.every((b) => b.preview.length > 0), 'no block of the fixture may preview as nothing, or an emptied preview span would pass')` and `assert.ok(blocks.some((b) => b.preview.endsWith('…')), 'at least one preview must be a real cut, so this case cannot pass on previews that are just the whole text')`; then per block `const m = chunks[i].match(/<span class="ctx-preview">([\s\S]*?)<\/span>/);` `assert.ok(m, …)`, `assert.equal(m[1], esc(blocks[i].preview), 'block i\'s collapsed line must be its own preview')` |

The existing case at `context.test.mjs:282` — one `<details>` per block, in
order, each with a `ctx-size` span and a `<pre>` — stays untouched: it pins the
count and the order, which C4 and C6 do not.

#### What is deliberately left untested, and why

- **A real click in a real browser.** No DOM and no dependency is available;
  P3 is the sharpened source assertion that the measured mutation fails, and the
  table at the top of this section says so as a decision.
- **The other two repaint chains** — the debounced scrub (`scheduleLaneContext`)
  and the return-to-live control. Their fetches are pinned by the existing cases
  at `page.test.mjs:478` and `:502`; no criterion of mine names their repaint,
  and no mutation was measured on them.
- **The transport.** `app.js`'s own `api()` and the collector's
  `/api/content/at` are unchanged here, and `tools/argus`' suite covers the
  route.
- **The parser.** `contextBlocks`, `previewOf`, `textOf` and `laneContentQuery`
  keep the 40-odd cases they have; this increment reads what the renderer prints,
  not what the parser computes.
- **The reviewer's round-2 observations** — the expansion set collapsing when a
  newer record arrives, the whole body refetched every refresh, the
  `main`/`span`/`agent` names agreeing across the UI/collector boundary. None is
  a finding, and no case may pin behaviour for them.
- **Everything increment 7 owns** — the tools an agent used up to the moment.

#### What counts as done

```
npm --prefix tools/argus-ui test
```

That one command, from the repository root, is the whole list. Only files under
`tools/argus-ui/public` and `tools/argus-ui/test` change; `tools/argus`' suite
and `./test.sh` stay off the list, as in every round of increment 5.

#### What is already red

I ran nothing — not the list, not a baseline. The reviewer's round-2 run
establishes that `HEAD` is green at 175 cases, and no run of mine would add a
fact to that.

From reading, exactly two cases go red **during** the work, both by design and
both rewritten above rather than repaired anywhere else:

- `page.test.mjs:349` goes red the moment `app.js` stops importing
  `laneContextInput`; P1 is its replacement.
- `page.test.mjs:462` goes red the moment `...laneContextInput(key,
  state.laneContext)` leaves `renderLanePanel`; P2 is its replacement.

Nothing else turns red. `lanePanelInput` is a new export no existing case names;
`laneContextInput`, `laneContentQuery`, `fetchLaneContext`, `contextBlocks`,
`renderContextPanel` and every fixture in `context.test.mjs` keep their
behaviour and their cases; `page.test.mjs:450`, `:511` and `:520-525` read
`lane-panel`, `renderContextPanel(` and `state.expanded` inside
`renderLanePanel`, and all three survive the new body; `independence.test.mjs`
already lists `public/context.js` and this increment adds no import at all.

## Increment 7

The last increment. Selecting a lane already shows that agent's context at the
cursor's moment; this adds the second half of the same click — the tools that
agent had used by that moment, each with its name and the parameters it was
called with — and closes the issue with `./test.sh` green.

The data is already in the page. `loadTimeline` fetches
`/api/events?event=claude_code.tool_result&sinceSeq=…` on every refresh and
`mergeToolMarks` accumulates the answers, so every tool call of the session has
already crossed the wire, exactly once each, carrying `tool_name` and
`tool_input` in its attributes. What increment 3 did was throw the payload away
at the merge (`{ seq, timeMs, spanId }` and nothing else) because a mark needed
two numbers and a span. This increment keeps a bounded projection of it
instead. **No new request, no collector change, no new route.**

### What I checked, and what I did not run

Read-only: `tools/argus-ui/public/{app,context,timeline,format}.js`,
`index.html`, `styles.css`, the four UI test files, `tools/argus/src/server.mjs`
(the `/api/events` shape), `tools/argus/src/claude.mjs` (`toolParametersOf`,
`contentMetaOf`), `test.sh`, `test-repo.sh`, `tools/argus-ui/README.md`, and
increments 1–6 of this file plus the planner's and reviewer's last sections.
**I ran no test command and no collector**; every fact below is read off the
code or off increment 3's measured capture (this file, Increment 3, findings
1, 2 and 6), which is the only measurement of `claude_code.tool_result` this
run has and needs no repeat.

Facts that decide the design:

1. **A tool call carries no attribution attribute at all** — no `agent.name`,
   no `query_source`. Its `spanId` is the span of the *conversation* that made
   it, which is exactly the lane's span. So: a call belongs to the agent lane
   whose `spanId` it carries, and to the main lane otherwise. That is the rule
   `buildDensity` already counts with (`timeline.js:248-261`), and the tool
   list must use the same one or the panel and the lane's `data-tools` count
   will disagree.
2. **The parameters arrive as a JSON string** under `tool_input`, with
   `tool_parameters` the pre-2.1 name (the collector's own `toolParametersOf`
   at `tools/argus/src/claude.mjs:59-68` reads both, in that order; the UI may
   not import it — `tools/argus-ui/CLAUDE.md`, "never imports from
   `tools/argus`" — so the same two names are restated in the UI with a comment
   naming why).
3. **`/api/events` ships tool attributes whole.** `server.mjs:229-247` strips
   the body only from `CONTENT_EVENTS` (the two `api_*_body` events);
   `claude_code.tool_result` is not one, so its `tool_input` arrives untouched.
   One `Write` call is a file's entire content, which is why holding every
   call's parameters unbounded is the thing this plan must not do.

### Implementation plan

Seven files, all in `tools/argus-ui`. One is new.

**A. `public/format.js` — the one-line-preview rule moves here.**

`PREVIEW_CHARS` and `previewOf` move out of `context.js` verbatim, because both
panels now collapse a text to one line and a second copy of the rule would
drift. Append after `shortId`:

```js
/** A collapsed row shows this much of its text on one line. */
export const PREVIEW_CHARS = 120;

/**
 * The one line a collapsed row shows.
 *
 * The cut is measured on the text itself rather than on its flattened form, so
 * a text carrying more than one line's worth says so even when collapsing its
 * whitespace would have brought it under the limit.
 */
export function previewOf(value) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  const flat = text.slice(0, PREVIEW_CHARS).replace(/\s+/g, ' ').trim();
  return text.length > PREVIEW_CHARS ? `${flat}…` : flat;
}
```

For a string argument this is character-for-character what `context.js` does
today, so every preview case in `context.test.mjs` keeps passing unchanged.

**B. `public/context.js` — two lookups and one rule leave.**

- Line 18 becomes
  `import { esc, fmtClock, fmtNum, previewOf, shortId } from './format.js';`
  and line 19 becomes `import { laneByKey, resolveCursor } from './timeline.js';`.
- Delete lines 21-22 (`PREVIEW_CHARS`) and 41-51 (`previewOf`). Nothing else in
  the module uses `PREVIEW_CHARS`.
- `laneContentRequest` line 185 becomes
  `const filter = laneContentQuery(laneByKey(view, key));`.
- `lanePanelInput` line 243 becomes `const lane = laneByKey(view, key);`.
- Nothing else moves. `renderContextPanel` is byte-identical, and both
  functions keep their behaviour by construction: `laneByKey` is the same
  `key ? lanes.find(…) ?? null : null` lifted out.

**C. `public/timeline.js` — the lane rules both panels share, and the richer
projection.**

Add `previewOf` to the `./format.js` import. Add, beside `TOOL_EVENT`:

```js
/** A tool call's parameters are kept up to this much text; beyond it, a size. */
export const TOOL_PARAM_CHARS = 2000;
```

Add `laneByKey` and `spanLaneKeys` (place them after `laneKeyOf`, whose rule
they complete):

```js
/**
 * The lane a key names, or none.
 *
 * One lookup for both panels: a context panel and a tool list that resolved the
 * same key differently would put one agent's tools under another agent's
 * context, and the reader could not tell. No key at all is no lane, which is how
 * both panels disappear when the selection is let go.
 */
export function laneByKey(view, key) {
  if (!key) return null;
  return (view?.lanes ?? []).find((lane) => lane.key === key) ?? null;
}

/**
 * Which lane each span belongs to — agent lanes by their own span, and nothing
 * else.
 *
 * A tool call carries the span of the conversation that made it, so this map
 * plus "the main lane otherwise" is the whole attribution rule: the one the
 * density counts with and the one the tool list is filtered by, so a lane's
 * `data-tools` count and the rows under it can never disagree.
 */
export function spanLaneKeys(lanes) {
  const bySpan = new Map();
  for (const lane of Array.isArray(lanes) ? lanes : []) {
    if (lane?.kind !== 'agent' || !lane.spanId) continue;
    if (!bySpan.has(lane.spanId)) bySpan.set(lane.spanId, lane.key);
  }
  return bySpan;
}
```

`buildDensity` lines 248-252 collapse to `const spanToLane = spanLaneKeys(lanes);`
— same map, same behaviour, one owner.

Add the projection, directly above `mergeToolMarks`:

```js
/** The parameters as text: pretty JSON when they parse, the string as it arrived otherwise. */
function paramText(raw) {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') return JSON.stringify(raw, null, 2) ?? '';
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return JSON.stringify(parsed, null, 2) ?? raw;
  } catch {
    // Not JSON: the string itself is what the call was made with.
  }
  return raw;
}

/**
 * One tool-result event turned into the row a panel draws: which tool, what it
 * was called with, and how much of that there was.
 *
 * The call carries no attribution of its own — only the span of the
 * conversation that made it — so `spanId` is what later decides whose lane it
 * belongs to. The parameters arrive as a JSON string under `tool_input`
 * (`tool_parameters` on CLI versions before 2.1) and are pretty-printed so the
 * row is readable.
 *
 * `chars` is the whole size and `text` is capped at TOOL_PARAM_CHARS: a single
 * Write call carries a file's entire content, and a session's worth of those
 * kept in page state is megabytes held for a line nobody reads to the end.
 * `truncated` says the two differ, so the panel can never imply it is showing
 * everything when it is not.
 */
export function toolCallOf(item) {
  const attrs = item?.attrs ?? {};
  const text = paramText(attrs.tool_input ?? attrs.tool_parameters);
  const name = typeof attrs.tool_name === 'string' && attrs.tool_name ? attrs.tool_name : 'tool';
  return {
    seq: item.seq,
    timeMs: item.timeMs,
    spanId: item.spanId ?? null,
    name,
    chars: text.length,
    preview: previewOf(text),
    text: text.slice(0, TOOL_PARAM_CHARS),
    truncated: text.length > TOOL_PARAM_CHARS,
  };
}
```

`mergeToolMarks` keeps its name, its dedup-by-`seq`, its held-not-seen
watermark and its non-mutation; only line 308 changes, from the three-field
literal to `merged.push(toolCallOf(item));`. Its doc comment's `@param` line
and the sentence about what a mark carries are rewritten to name `toolCallOf`
and the cap.

**D. `public/tools.js` — new module, the tools one lane has used up to a
moment.**

```js
/**
 * argus-ui — the tools one lane has used, up to a moment.
 *
 * The sibling of `context.js` under the same click: that module answers "what
 * was in this agent's context at this moment", this one answers "what had it
 * done by then, and what for". It needs no fetch of its own — every tool call
 * of the session is already in page state, put there by the incremental
 * `/api/events` poll the lanes are drawn from — so the list paints the instant
 * a lane is clicked, whether or not the context has arrived.
 *
 * No `document`, no `fetch`, no `location`, the same contract `timeline.js` and
 * `context.js` keep.
 */

import { esc, fmtClock, fmtNum } from './format.js';
import { laneByKey, resolveCursor, spanLaneKeys } from './timeline.js';

/**
 * The calls one lane had made by the cursor's moment, newest first.
 *
 * The moment is resolved by the same rule the context panel asks with — a live
 * cursor means the head of the window, a parked one its own moment — so the two
 * panels under one click can never be showing two different moments. A call
 * belongs to the agent lane whose span it carries and to the main lane
 * otherwise, which is the rule the lane's own tool count was computed with.
 *
 * @param {{ view: object|null, key: string|null, calls: object[], cursor: object|null, expanded: string[]|Set<string> }} input
 * @returns {{ lane: object|null, calls: object[], atMs: number, expanded: string[]|Set<string> }}
 */
export function laneToolInput({ view = null, key = null, calls = [], cursor = null, expanded = [] } = {}) {
  const lane = laneByKey(view, key);
  const atMs = resolveCursor(cursor, view).timeMs;
  if (!lane) return { lane: null, calls: [], atMs, expanded };
  const owners = spanLaneKeys(view?.lanes ?? []);
  const mine = (Array.isArray(calls) ? calls : []).filter(
    (call) =>
      Number.isFinite(call?.timeMs) &&
      call.timeMs <= atMs &&
      (owners.get(call.spanId) ?? 'main') === lane.key,
  );
  // Newest first: the reader parked the cursor on a moment and asks what led up
  // to it, so the calls nearest that moment are the ones to read first.
  mine.sort((a, b) => b.timeMs - a.timeMs || b.seq - a.seq);
  return { lane, calls: mine, atMs, expanded };
}

/**
 * The tool list for the selected lane, as of the cursor's moment.
 *
 * No attribute named `data-lane` may appear in here: the page binds
 * `[data-lane]` to lane rows, so one in this markup would make every click
 * inside the panel toggle the lane selection. The expansion keys are prefixed
 * `tool:` so they cannot collide with a context block's `<seq>:<index>`.
 *
 * @param {{ lane: object|null, calls: object[], atMs: number, expanded: string[]|Set<string> }} input
 */
export function renderToolPanel({ lane = null, calls = [], atMs = 0, expanded = [] } = {}) {
  if (!lane) return '';

  const list = Array.isArray(calls) ? calls : [];
  const head = `<div class="context-head"><span class="context-title">${esc(lane.label)} · tools</span>
      <span class="tools-meta" data-calls="${esc(list.length)}" data-time="${esc(atMs)}">${esc(
        `${list.length} tool call${list.length === 1 ? '' : 's'} · up to ${fmtClock(atMs)}`,
      )}</span>
    </div>`;
  const shell = (dataState, inner) =>
    `<div class="panel tools-panel" data-state="${dataState}" data-tools-lane="${esc(lane.key)}">${head}${inner}</div>`;

  if (!list.length) {
    return shell('empty', '<div class="placeholder">No tool call on this lane at or before this moment.</div>');
  }

  const openKeys = new Set(expanded ?? []);
  const rows = list
    .map((call) => {
      const key = `tool:${call.seq}`;
      const cut = call.truncated
        ? `\n… ${fmtNum(call.chars - call.text.length)} more characters, not kept in the page`
        : '';
      return `<details class="ctx-block" data-kind="tool_use" data-tool="${esc(call.name)}"${
        openKeys.has(key) ? ' open' : ''
      }>
      <summary data-block="${esc(key)}">
        <span class="tool-time">${esc(fmtClock(call.timeMs))}</span><span class="ctx-label">${esc(call.name)}</span>
        <span class="ctx-preview">${esc(call.preview)}</span>
        <span class="ctx-size" data-chars="${esc(call.chars)}">${esc(fmtNum(call.chars))}</span>
      </summary>
      <pre class="ctx-text">${esc(call.text)}${esc(cut)}</pre>
    </details>`;
    })
    .join('');

  return shell('ready', `<div class="ctx-blocks">${rows}</div>`);
}
```

The row classes are the context panel's own (`ctx-block`, `ctx-label`,
`ctx-preview`, `ctx-size`, `ctx-text`, `ctx-blocks`, `context-head`,
`context-title`): a collapsed row with a label, a line and a size is the same
thing on screen, and reusing them keeps the CSS diff to four rules.

**E. `public/app.js` — the click paints both panels.**

- After line 11, add `import { laneToolInput, renderToolPanel } from './tools.js';`.
- The state comment at lines 36-38 is false as of this increment. Replace it
  with: `// Tool calls, kept as the row a panel draws — seq, moment, span, the`
  / `// tool's name and its call parameters capped at TOOL_PARAM_CHARS. A whole`
  / `// tool_input is a file's content, so the cap is what keeps a long`
  / `// session's index bounded while still answering "which tools, and what for".`
- `renderLanePanel` (lines 934-945) keeps its name, its doc comment, the
  container lookup and the `if (!container) return;`. Its body becomes:

```js
  const view = laneView();
  container.innerHTML =
    renderContextPanel(
      lanePanelInput({ view, key: state.selectedLane, held: state.laneContext, expanded: state.expanded }),
    ) +
    renderToolPanel(
      laneToolInput({
        view,
        key: state.selectedLane,
        calls: state.toolMarks,
        cursor: state.cursor,
        expanded: state.expanded,
      }),
    );
```

- **Nothing else in `app.js` changes.** Every repaint path already goes through
  `renderLanePanel` — the lane click (1153-1154), the debounced scrub
  (`scheduleLaneContext`, 953), the return-to-live control (1145) and
  `renderDetail` (207) — so the tool list follows the selection and the cursor
  with no new wiring. The `summary[data-block]` branch (1157-1164) already
  records expansions by key, and the `tool:` prefix keeps the two namespaces
  apart. `loadTimeline`, `mergeToolMarks`'s call site, `clearTimelineIndexes`
  and `selectSession` are untouched.

**F. `public/styles.css` — four rules, appended after the context section.**

```css
/* --------------------------------- tools -------------------------------- */

.tools-panel {
  padding: 10px 12px 4px;
}

.tools-meta {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--text-faint);
}

/* One column more than a context block: a tool row leads with its moment. */
.tools-panel .ctx-block > summary {
  grid-template-columns: 80px 120px 1fr 60px;
}

.tool-time {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--text-faint);
}
```

**G. `tools/argus-ui/README.md` — one sentence.** The "Timeline" bullet ends
with the context list; append to it: "The same click also lists, under the
context, every tool that agent had called by that moment — newest first, each
row naming the tool and expanding to the parameters it was called with."

### Decisions, including the ones rejected

1. **The tool list is drawn from page state, not from a request of its own.**
   Every tool call already crosses the wire once, incrementally, for the
   activity marks. Rejected: fetching per selection — `/api/events` has no span
   filter and no `at` filter (`store.queryEvents`, `store.mjs:897-924`), so a
   per-lane fetch would re-ship *every* tool call of the session, payload
   included, on every click and every settled scrub. That is exactly the
   regression increment 1 avoided for bodies. Rejected: adding a filtered
   `/api/tools` route to the collector — it buys nothing the page does not
   already hold and doubles the increment's blast radius across both packages
   on the run's closing step.
2. **The parameters are kept, capped at 2000 characters, with the true size
   shown.** This reverses increment 3's "the payload is dropped" on purpose:
   the payload had no use then and is the criterion now. The cap is what keeps
   the reversal honest — worst case ~2 KB × the session's tool calls in page
   memory, against a `Write` whose single `tool_input` is a whole file.
   Rejected: keeping the parameters whole — unbounded page memory for text
   beyond what "what for" needs, and the same string then sits a second time in
   the DOM inside a `<pre>`. Rejected: keeping only a 120-character preview —
   "with the call's parameters" then holds for a `Bash` command and fails for
   anything structured. The `<pre>` of a cut call says how many characters are
   missing, so the panel never implies it is complete; the untruncated
   attribute remains readable in the Events view, which renders every attribute
   of an event in full (`app.js:612-616`) and is one of the technical views the
   timeline keeps reachable.
3. **Every call up to the moment is listed — no row cap.** The criterion is a
   completeness claim ("the tools that agent has used up to that moment"), and
   a "showing the last 200 of 900" line would be a visible hole in it. The
   memory and DOM cost is already bounded per row by decision 2.
4. **Newest first.** The reader parks the cursor on a moment and asks what led
   up to it; the calls nearest that moment are the ones to read first, and they
   sit at the top where the click left the pointer. Rejected: chronological,
   which matches the context list's order but buries the interesting end of a
   long list.
5. **Attribution goes through one shared `spanLaneKeys`, not a second copy of
   the rule.** A lane's bar advertises `data-tools="N"` from `buildDensity`; if
   the panel filtered by a rule of its own, the bar could say 7 and the list
   show 6, and nothing would catch it. Rejected: re-deriving the map inside
   `tools.js`.
6. **The lane lookup moves to `timeline.js` as `laneByKey`, used by all three
   call sites.** Two panels resolving one key differently is the failure this
   forecloses; `context.js` already did the same `find` twice. The diff to
   `context.js` is two call sites and one import, and increment 6's cases pin
   `lanePanelInput` by value, so they cover the swap rather than being broken
   by it.
7. **The one-line-preview rule moves to `format.js`.** Rejected: exporting
   `previewOf` from `context.js` and importing it into `tools.js` — that makes
   one panel depend on the other for a text rule that belongs to neither.
   Rejected: a third copy in `tools.js`.
8. **The two panels share `#lane-panel` and one assignment.** Rejected: a
   second container `#lane-tools` painted by a second function — four repaint
   sites would each have to call both, and one forgotten call site is a panel
   that silently stops following the cursor.
9. **A scrub updates the tool list on the same 250 ms debounce as the context**,
   although the list needs no fetch. Repainting a several-hundred-row panel on
   every pixel of a drag is the cost this avoids; the two panels moving
   together is also what keeps them showing one moment.
10. **An agent lane with no `spanId`** (a subagent whose records carried no
    span) owns no tool calls — they fall to the main lane. That is exactly what
    `buildDensity` already counts, so the panel and the bar agree; changing it
    would mean changing the density too, which no criterion of mine names.

### Module map

| Path | What it holds | Entry points |
| --- | --- | --- |
| `tools/argus-ui/public/tools.js` | **new**, ~90 lines: `laneToolInput` (lane lookup, cursor moment, span attribution, newest-first order), `renderToolPanel` (head, empty state, one `<details>` per call) | both exports; imported by `app.js` only |
| `tools/argus-ui/public/timeline.js` (465 lines) | `TOOL_EVENT` 21, `laneKeyOf` 58, `buildLanes` 69, `laneGeometry` 146, `contextPoints` 162, `areaPolygon` 181, `activityMarks` 203, `buildDensity` 239 (the `spanToLane` block is 248-252), `mergeToolMarks` 299 (the push is line 308), `liveCursor` 320, `scrubCursor` 331, `resolveCursor` 346, `renderTimeline` 373, `renderDetailViews` 457 | gains `TOOL_PARAM_CHARS`, `laneByKey`, `spanLaneKeys`, `paramText` (private), `toolCallOf`; `buildDensity` and `mergeToolMarks` each lose a few lines to them |
| `tools/argus-ui/public/context.js` (308 lines) | `PREVIEW_CHARS` 22, `textOf` 35, `previewOf` 48, `makeBlock` 53, `contextBlocks` 68, `laneContentQuery` 161, `laneContentRequest` 183 (lookup at 185), `fetchLaneContext` 204, `laneContextInput` 222, `lanePanelInput` 242 (lookup at 243), `renderContextPanel` 256 | imports at 18-19; the two lookups; `PREVIEW_CHARS`/`previewOf` leave |
| `tools/argus-ui/public/format.js` (65 lines) | `esc` 9, `fmtNum` 15, `fmtCost` 23, `fmtDur` 31, `fmtClock` 43 (`0` renders as `–`), `fmtAgo` 51, `isLive` 61, `shortId` 63 | gains `PREVIEW_CHARS` and `previewOf` |
| `tools/argus-ui/public/app.js` (1285 lines) | import block 10-22, `state` 26-60 (tool comment 36-38, `toolMarks` 39), `renderDetail` (timeline 191-198, `#lane-panel` 200), `loadTimeline` 872, `laneView` 900, `loadLaneContext` 915, `renderLanePanel` 934, `scheduleLaneContext` 949, `refresh` 988, `selectSession` 1025, `wireEvents` 1127 (live 1139, lane 1148, block 1157) | one import line, the state comment, the body of `renderLanePanel` |
| `tools/argus-ui/public/styles.css` (1362 lines) | the context section is 1025-1140; `.ctx-block > summary` is a `160px 1fr 60px` grid at 1056 | four rules appended |
| `tools/argus-ui/test/tools.test.mjs` | **new** | the cases below |
| `tools/argus-ui/test/timeline.test.mjs` (979 lines) | factories 23-69 (`session`, `record`, `threeRecordContent`, `toolMark` 69), merge cases 575-669 | import line, two rewritten cases, new cases |
| `tools/argus-ui/test/page.test.mjs` (568 lines) | helpers `functionSource` 20, `detailListener` 29; `renderLanePanel` cases 467-496 | one rewritten case, three new |
| `tools/argus-ui/test/context.test.mjs` (779 lines) | imports 4-13 (`PREVIEW_CHARS` at 7) | the import line only |
| `tools/argus-ui/test/independence.test.mjs` (79 lines) | the must-exist list 21-35, the must-be-scanned list 53-61 | `public/tools.js` in both |

### Environment

Node ≥ 20.11, already installed. Zero runtime dependencies, no install step, no
build step, **no linter and no formatter in this repository** (no eslint config,
no `.prettierrc`, no `.editorconfig`). Nothing to start: every case below is a
pure import or a source read, and no test needs a collector or a DOM.

The two commands this increment's test plan asks for, both from the repository
root:

```
npm --prefix tools/argus-ui test
./test.sh
```

The first is `node --test "test/*.test.mjs"` over the (now seven) files in
`tools/argus-ui/test/`, seconds. The second runs five suites — `test-repo.sh`,
`test-worktree.sh`, `tools/argus`, `tools/argus-ui`, `tools/log-parser` — and
is the issue's own criterion; it takes a couple of minutes and needs no network
and no argument. While working on a single file,
`node --test tools/argus-ui/test/tools.test.mjs` runs just that one; it is not
part of the closed list.

### Test Plan

Tests are needed. Everything is `node:test` + `node:assert/strict` in
`tools/argus-ui/test/`, in the style already there: one
`test('a sentence stating the fact', () => {…})` per fact, factories at the top
of the file, a message on every non-obvious assert, nothing imported from
`tools/argus`, nothing faked. The rule this run learned the hard way applies
throughout: **a hop that can be pinned by value is pinned by value**; only the
page's own DOM-writing hops are source assertions, and those read the exact
statement rather than a mention.

This section is the whole of what is asked for. Every case not named here stays
exactly as it is.

#### Criterion — the parameters and the tool's name survive the merge into page state

Level: unit, `tools/argus-ui/test/timeline.test.mjs`. The import at line 4-20
gains `toolCallOf`, `TOOL_PARAM_CHARS`, `spanLaneKeys` and `laneByKey`. Add one
factory beside `toolMark` (line 69):

```js
/** A tool-result event as /api/events serves it. */
const toolEvent = (over = {}) => ({
  seq: 5,
  timeMs: 2200,
  spanId: 'sp-a',
  eventName: 'claude_code.tool_result',
  attrs: {
    tool_name: 'Bash',
    tool_use_id: 'toolu_01',
    success: 'true',
    tool_input: JSON.stringify({ command: 'echo hi', description: 'say hi' }),
  },
  ...over,
});
```

| # | Case name | Input / state | Expected |
| --- | --- | --- | --- |
| T1 | `a tool call keeps the tool's name and the parameters it was called with` | `toolCallOf(toolEvent())` | `deepEqual` against the whole expected object: `{ seq: 5, timeMs: 2200, spanId: 'sp-a', name: 'Bash', chars: <computed>, preview: <computed>, text: JSON.stringify({ command: 'echo hi', description: 'say hi' }, null, 2), truncated: false }`, where the expected `text` is written out as that `JSON.stringify(…, null, 2)` expression, `chars` is `text.length` and `preview` is `previewOf(text)` imported from `../public/format.js`. Plus `assert.ok(out.text.includes('echo hi'), 'the command the call was made with is what answers "what for"')` |
| T2 | `the pre-2.1 attribute name is read when the current one is absent` | `toolCallOf(toolEvent({ attrs: { tool_name: 'Read', tool_parameters: JSON.stringify({ file_path: '/tmp/a.txt' }) } }))` | `name === 'Read'` and `text.includes('/tmp/a.txt')`. Then both present at once: `attrs: { tool_name: 'Read', tool_input: '{"file_path":"/new"}', tool_parameters: '{"file_path":"/old"}' }` → `text.includes('/new')` and `!text.includes('/old')`, message: the current name wins |
| T3 | `parameters that are not JSON are kept as they arrived, not dropped` | `toolCallOf(toolEvent({ attrs: { tool_name: 'Bash', tool_input: 'not json {' } }))` | `text === 'not json {'`, `chars === 10`, `truncated === false` — and the call did not throw |
| T4 | `a call with no parameters and no name is still a row` | `toolCallOf({ seq: 1, timeMs: 1000, spanId: 'sp-a' })`; then `toolCallOf({ seq: 1, timeMs: 1000, spanId: 'sp-a', attrs: { tool_name: '' } })` | both `deepEqual` to `{ seq: 1, timeMs: 1000, spanId: 'sp-a', name: 'tool', chars: 0, preview: '', text: '', truncated: false }` |
| T5 | `a call whose parameters are a whole file keeps a bounded amount of them, and says how much there was` | `const big = 'x'.repeat(50_000); const out = toolCallOf(toolEvent({ attrs: { tool_name: 'Write', tool_input: JSON.stringify({ file_path: '/tmp/big', content: big }) } }));` | `assert.equal(out.text.length, TOOL_PARAM_CHARS, 'the page may not hold a file per tool call')`; `assert.ok(out.chars > TOOL_PARAM_CHARS)`; `assert.equal(out.truncated, true)`; `assert.ok(out.text.startsWith('{\n  "file_path": "/tmp/big"'), 'what is kept is the beginning, where the parameters that name the call are')`; `assert.ok(out.preview.length <= 121, 'the collapsed line stays one line')`; `assert.ok(out.preview.endsWith('…'))` |
| T6 | `a missing spanId becomes null rather than undefined` | **rewrite of the existing case at `timeline.test.mjs:653`** — `mergeToolMarks([], [{ seq: 3, timeMs: 2000 }])` | `deepEqual(result.marks, [{ seq: 3, timeMs: 2000, spanId: null, name: 'tool', chars: 0, preview: '', text: '', truncated: false }])`. The case keeps its name and its point |
| T7 | **replaces** the case at `timeline.test.mjs:575`, renamed `merging into an empty index keeps every call, with the name and parameters a panel draws` | `mergeToolMarks([], [toolEvent({ seq: 4, timeMs: 2000 }), { seq: 7, timeMs: 3000, spanId: 'sp-b' }])` | `deepEqual(result.marks, [toolCallOf(toolEvent({ seq: 4, timeMs: 2000 })), toolCallOf({ seq: 7, timeMs: 3000, spanId: 'sp-b' })])` and `result.seq === 7`, with the message that the merge projects through `toolCallOf` and holds nothing else |

The other merge cases at `:590`, `:602`, `:613`, `:621`, `:632`, `:643` and
`:658` stay exactly as they are — dedup, watermark, non-mutation and the
density's reading of the index are unchanged by the richer projection, and they
must go on passing to show it.

#### Criterion — a call lands on the lane that made it, and on no other

Level: unit, `tools/argus-ui/test/timeline.test.mjs` for the shared rules and
`tools/argus-ui/test/tools.test.mjs` for the list.

| # | Case name | Input / state | Expected |
| --- | --- | --- | --- |
| T8 | `each agent lane's span names that lane, and nothing else does` | `spanLaneKeys(buildLanes({ session: session(), content: threeRecordContent() }).lanes)` — the existing fixture builds one main lane and one agent lane on `sp-a` | the map has exactly one entry, `'sp-a' → 'agent:sp-a:code-reviewer'`; `assert.equal(map.get(undefined), undefined)` and `assert.equal(map.size, 1, 'the main lane owns no span — a tool call reaches it by not matching any agent')`. Plus: two agent lanes with the same `spanId` keep the first (`spanLaneKeys([{ kind: 'agent', spanId: 's', key: 'a' }, { kind: 'agent', spanId: 's', key: 'b' }]).get('s') === 'a'`), an agent lane with no span is skipped, and `spanLaneKeys(undefined)` is an empty map |
| T9 | `a key names its lane, and a key no lane carries names none` | `laneByKey` over `buildLanes({ session: session(), content: threeRecordContent() })` | `laneByKey(view, 'agent:sp-a:code-reviewer') === view.lanes[1]`; `laneByKey(view, 'main') === view.lanes[0]`; `laneByKey(view, 'agent:gone:x') === null`; `laneByKey(view, null) === null`; `laneByKey(null, 'main') === null`; `laneByKey({}, 'main') === null` |

`tools.test.mjs` opens with its own factories, modelled on `context.test.mjs`'s
so the two panels' cases read alike:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import { laneToolInput, renderToolPanel } from '../public/tools.js';
import { toolCallOf, TOOL_PARAM_CHARS } from '../public/timeline.js';
import { esc, fmtNum, previewOf } from '../public/format.js';

const lane = (over = {}) => ({ key: 'main', kind: 'main', label: 'main session', spanId: null, agent: null, ...over });
const agentLane = (over = {}) =>
  lane({ key: 'agent:sp-b:probe', kind: 'agent', label: 'probe', spanId: 'sp-b', agent: 'probe', ...over });
const view = (over = {}) => ({ startMs: 1000, endMs: 5000, durationMs: 4000, lanes: [lane(), agentLane()], ...over });

/** A call as the merged index holds it: main traffic rides the interaction span. */
const call = (over = {}) =>
  toolCallOf({
    seq: 1,
    timeMs: 2000,
    spanId: 'sp-main',
    attrs: { tool_name: 'Bash', tool_input: JSON.stringify({ command: 'echo hi' }) },
    ...over,
  });

/** The markup of each rendered row, in the order the panel prints them. */
const rowChunks = (html) => [...html.matchAll(/<details class="ctx-block"[\s\S]*?<\/details>/g)].map((m) => m[0]);
```

| # | Case name | Input / state | Expected |
| --- | --- | --- | --- |
| U1 | `an agent lane lists its own calls, and the main lane the rest` | four calls: `call({ seq: 1, timeMs: 1500 })` and `call({ seq: 3, timeMs: 2500, attrs: { tool_name: 'Read', tool_input: '{"file_path":"/a"}' } })` on `sp-main`, `call({ seq: 2, timeMs: 2000, spanId: 'sp-b', attrs: { tool_name: 'Grep', tool_input: '{"pattern":"x"}' } })` on the probe's span, and `call({ seq: 4, timeMs: 2600, spanId: null })` | `laneToolInput({ view: view(), key: 'agent:sp-b:probe', calls, cursor: null }).calls.map((c) => c.seq)` is `[2]`, with the message that a subagent's list showing main-session calls is the mutation this catches; the same for `key: 'main'` is `[4, 3, 1]` — the span-less call included, the probe's excluded |
| U2 | `only the calls made at or before the moment are listed` | the same four calls, `cursor: { live: false, timeMs: 2500 }` | main lane → `[3, 1]`: the call *at* 2500 is in (a boundary that excludes it hides the call the reader scrubbed to) and the one at 2600 is out. Then `timeMs: 1499` → `[]`, and `timeMs: 9999` (past the window) → clamped to the window end, `[4, 3, 1]` |
| U3 | `a live cursor lists everything recorded, a parked one does not` | the same four calls and `key: 'main'`, with `cursor: null`, then `cursor: { live: true, timeMs: null }`, then `cursor: { live: false, timeMs: 2000 }` | the first two both give `[4, 3, 1]` and `atMs === 5000` (the window's end); the third gives `[1]` with `atMs === 2000`. Message: the tool list and the context fetch resolve the moment by the same rule, so one click cannot show two moments |
| U4 | `the newest call is the first row` | calls at 1500, 2000, 2500 on the main span, given in ascending order | `calls.map((c) => c.timeMs)` is `[2500, 2000, 1500]`; and two calls with the same `timeMs` come back highest-`seq` first |
| U5 | `no lane selected leaves nothing to list, and nothing to draw` | `laneToolInput({ view: view(), key: null, calls: [call()] })`, `…key: 'agent:gone:x'…`, and `laneToolInput()` with no argument | each has `lane === null` and `deepEqual(out.calls, [])`; and `assert.equal(renderToolPanel(laneToolInput({ view: view(), key: null, calls: [call()] })), '', 'no lane selected, no tool panel under the timeline')`; `renderToolPanel()` is `''` too |
| U6 | `the index the page holds is not reordered under it` | `const calls = [call({ seq: 1, timeMs: 1500 }), call({ seq: 2, timeMs: 2500 })]; const before = calls.slice(); laneToolInput({ view: view(), key: 'main', calls });` | `deepEqual(calls, before)` — the sort must not run on the array page state holds |

#### Criterion — the panel says which tool, and what it was called with

Level: unit, `tools/argus-ui/test/tools.test.mjs`. Every case renders through
`renderToolPanel(laneToolInput({…}))`, so what is asserted is what the page
paints.

| # | Case name | Input / state | Expected |
| --- | --- | --- | --- |
| R1 | `every row names its own tool` | three calls with distinct names (`Bash`, `Read`, `Grep`) and distinct moments on the main span, rendered for `key: 'main'` | `rowChunks(html).length === 3`; per row `assert.equal(chunk.match(/<span class="ctx-label">([\s\S]*?)<\/span>/)[1], esc(expected.name), 'row i must name its own tool — one name printed for every row is the mutation this catches')`; and `assert.match(chunk, new RegExp('data-tool="' + expected.name + '"'))` |
| R2 | `every row carries that call's own parameters, in full where they fit` | the same three calls, each with a different `tool_input` (`{command:'echo hi'}`, `{file_path:'/tmp/a.txt'}`, `{pattern:'needle'}`) | per row: the `<pre class="ctx-text">…</pre>` content equals `esc(callAtThatRow.text)` exactly; `assert.ok(rows[1].includes('/tmp/a.txt'), 'the parameters are what answers "what for"')`; and `assert.ok(!rows[0].includes('/tmp/a.txt'), 'one call\'s parameters under another call\'s name is unreadable and wrong')` |
| R3 | `every collapsed row shows that call's own size and its own one line` | the three calls, whose parameter texts differ in length | first `assert.ok(new Set(calls.map((c) => c.chars)).size > 1, 'the fixture must carry calls of differing sizes, or one size printed for all of them would pass')`; per row `data-chars` equals that call's `chars` and the visible text equals `esc(fmtNum(chars))`; per row the `<span class="ctx-preview">` content equals `esc(call.preview)`, with a guard that no preview in the fixture is empty |
| R4 | `a call whose parameters were cut says how much is missing, and still reports the whole size` | one call built from `'x'.repeat(50_000)` as in T5 | the row's `data-chars` is the *untruncated* `chars`; the `<pre>` contains `esc(call.text)` and then `more characters, not kept in the page`; `assert.ok(!html.includes('x'.repeat(TOOL_PARAM_CHARS + 1)), 'the panel may not paint what the page deliberately did not keep')` |
| R5 | `the panel names the lane it was drawn for, and how many calls up to when` | `key: 'agent:sp-b:probe'` with one call on `sp-b` at 2000, `cursor: { live: false, timeMs: 3000 }` | `data-tools-lane="agent:sp-b:probe"`, `data-state="ready"`, `data-calls="1"`, `data-time="3000"`, the label `probe` present, `1 tool call` (singular) present, and `assert.ok(!html.includes('main session'), 'a subagent\'s tools under the main session\'s heading is the mutation this catches')`. Then the main lane with two calls → `data-calls="2"` and `2 tool calls` |
| R6 | `a lane that had used no tool by that moment says so rather than vanishing` | `key: 'main'`, calls all after the cursor | `data-state="empty"`, the placeholder sentence present, `rowChunks(html).length === 0`, and `assert.ok(html.includes('data-tools-lane="main"'), 'the panel stays, so the reader can tell "nothing yet" from "nothing selected"')` |
| R7 | `an expanded row stays open across a repaint, and its key cannot collide with a context block's` | `expanded: ['tool:2']` over calls with `seq` 1, 2, 3 | the row whose `data-block="tool:2"` carries ` open`; the other two do not; every `data-block` in the markup starts with `tool:`; and `assert.ok(!/data-lane=/.test(html), 'a data-lane attribute here would make every click inside the panel toggle the lane selection')` |
| R8 | `a parameter that looks like markup is shown, not run` | a call with `tool_input: JSON.stringify({ command: '<script>alert(1)</script> && echo "a" & b' })` | `assert.ok(!html.includes('<script>'))`; `assert.ok(html.includes('&lt;script&gt;'))`; and the same for the preview span — the escaped form appears in both the `<pre>` and the collapsed line |

#### Criterion — the click paints the tool list, under the same selection and the same moment

Level: source assertions over `app.js`, in `tools/argus-ui/test/page.test.mjs`.
The page's own hop is DOM event → DOM write; there is no value in it to assert,
so each case reads the exact statement (the honest ceiling this run settled on
in increment 6).

| # | Case name | Input / state | Expected |
| --- | --- | --- | --- |
| P1 | **new**, `app.js takes the tool panel from its module` | the whole `app.js` source | for each of `renderToolPanel` and `laneToolInput`: `assert.match(appJs, new RegExp('import\\s*\\{[^}]*\\b' + name + '\\b[^}]*\\}\\s*from\\s*[\'"]\\./tools\\.js[\'"]'), …)` — the same loop shape the existing case at `:349` uses for `context.js` |
| P2 | **new**, `the markup the panels render is what reaches the container` | `functionSource(appJs, 'renderLanePanel')` | `assert.match(renderLanePanel, /container\.innerHTML\s*=\s*renderContextPanel\(/, 'a panel computed and then thrown away paints an empty box for every lane')` and `assert.match(renderLanePanel, /\+\s*renderToolPanel\(/, 'the tool list must be part of that same assignment, so no repaint can paint one panel without the other')`. This closes the reviewer's recorded M-K' hop, which now sits inside this increment's own chain |
| P3 | **new**, `the tool list is drawn for the selected lane, at the cursor's moment, from the calls the page holds` | `functionSource(appJs, 'renderLanePanel')` sliced from `indexOf('renderToolPanel(')` to the next `';'` | the slice matches `/laneToolInput\(/`, `/\bview,/`, `/key:\s*state\.selectedLane\b/` (message: without it the list is empty for every lane), `/calls:\s*state\.toolMarks\b/` (message: the merged index is the only source there is), `/cursor:\s*state\.cursor\b/` (message: without it the list ignores the scrub) and `/expanded:\s*state\.expanded\b/` |
| P4 | **rewrites two assertions** in the existing case at `page.test.mjs:481`, `the panel is drawn from the lane the reader selected and the answer held for it` | as today, plus `functionSource(appJs, 'renderLanePanel')` whole | the assertion `assert.match(slice, /view:\s*laneView\(\)/, …)` is replaced by two: `assert.match(renderLanePanel, /const view = laneView\(\);/, 'the page must build its lane view once and hand the same one to both panels')` and `assert.match(slice, /\bview,/, 'the page\'s own lane view must reach the panel')`. Every other assertion in that case stays untouched |

The case at `page.test.mjs:467` (`renderLanePanel` writes into `lane-panel`,
delegates to `renderContextPanel`, never calls `renderDetail`) and the one at
`:511` (`state.expanded` reaches the panel) stay as they are and must keep
passing over the new body.

#### The project's own rules

| # | Case name | Input / state | Expected |
| --- | --- | --- | --- |
| I1 | **edits** `tools/argus-ui/test/independence.test.mjs` | the two lists at lines 21-35 and 53-61 | `'public/tools.js'` is added to both, so the new module is required to exist and is required to be inside the import scan. No case body changes |
| C1 | **edits** the import block of `tools/argus-ui/test/context.test.mjs` | lines 4-13 | `PREVIEW_CHARS` moves from the `../public/context.js` import list to the `../public/format.js` one. No case body changes, and every existing case in the file must keep passing — that is the evidence the move changed no behaviour |

#### What is deliberately left untested, and why

- **A real click in a real browser.** No DOM and no dependency is available
  (`tools/argus-ui/CLAUDE.md`: zero runtime dependencies); P2 and P3 are the
  sharpened source assertions that stand in for it, by the same decision
  increment 6 recorded.
- **The CSS.** Four declarative rules with no logic; nothing a `node --test`
  case could assert about them that would not be a copy of the file.
- **The README sentence.** Prose.
- **The wire.** `/api/events`, its `sinceSeq` paging and the tool-event fetch
  are unchanged here, and `page.test.mjs:156` and `tools/argus`' own suite
  already cover them.
- **`buildDensity`'s counts and marks.** Unchanged behaviour behind a lifted
  helper; the existing density cases at `timeline.test.mjs:520-670` are the
  regression test for the lift, and no new case is added for them.
- **The debounce and the repaint paths.** `scheduleLaneContext`, the live
  control and `refresh` are untouched and already pinned at
  `page.test.mjs:495-520`; the tool list rides those paths without adding one.
- **Recordings made without the content flags.** Out of contract for the whole
  run (issue decision 5); no case may pin behaviour for a tool event with no
  `tool_input`, beyond T4's "a call with no parameters is still a row", which
  exists for a malformed record rather than for an unflagged recording.

#### What counts as done

Two commands, from the repository root, and nothing else:

```
npm --prefix tools/argus-ui test
./test.sh
```

The first is the increment's own suite and points straight at what broke; the
second is the issue's closing criterion and is the one that must be green for
the issue to be complete. Nothing else is to be run: no linter exists, and
`tools/argus` is untouched by this increment except as one of the five suites
`./test.sh` already runs.

#### What is already red

Nothing, as far as reading shows: the working tree is clean at `57fac55`, the
previous increment was accepted with 181 passing UI cases and exit 0, and this
increment touches no other package. **I ran neither command, not even as a
baseline** — a run would have bought no fact I could not state from the code,
and the first run belongs to whoever runs it downstream. Two things will go red
the moment the production change lands and before the test work is done, and
they are expected: `timeline.test.mjs:575` and `:653` (the two `deepEqual`s over
the old three-field mark shape) and `context.test.mjs`'s import of
`PREVIEW_CHARS`, which will be an undefined binding until the import line moves.
T6, T7 and C1 above are their fixes.

## Increment 7 — Round 1

The reviewer raised one finding and it is a test defect, not a behaviour defect:
the tool list itself was accepted (per lane, per moment, name and parameters),
`bash test.sh` was green, and nothing in `public/` is wrong. Increment 7's
production change turned `renderLanePanel`'s single call into a concatenation of
two, and one increment-6 pin reads that statement by slicing to the first `;` —
so the slice now swallows the second call's arguments and the pin passes on
them. The whole correction is one helper and two edited cases in
`tools/argus-ui/test/page.test.mjs`. No file under `public/` changes.

### The finding, restated as the defect to remove

`page.test.mjs:479-501`, "the panel is drawn from the lane the reader selected
and the answer held for it", builds its slice as

```js
const callIdx = renderLanePanel.indexOf('renderContextPanel(');
const endIdx = renderLanePanel.indexOf(';', callIdx);
const slice = renderLanePanel.slice(callIdx, endIdx);
```

Against today's `renderLanePanel` (`tools/argus-ui/public/app.js:936-953`) the
first `;` after `renderContextPanel(` is the terminator of the whole
`container.innerHTML = renderContextPanel(…) + renderToolPanel(…);` assignment,
so the slice contains the `laneToolInput({…})` arguments as well as the
`lanePanelInput({…})` ones. Both argument lists carry `key: state.selectedLane`
and `expanded: state.expanded`, so those two assertions are satisfied by the
tool panel alone and say nothing about the context panel. The reviewer proved it
in a throwaway worktree: increment 6's mutation M-A2 — delete
`key: state.selectedLane,` from the `lanePanelInput({…})` call at `app.js:942` —
was 180 pass / 1 fail / exit 1 when increment 6 was accepted and is now 205 pass
/ 0 fail / exit 0, as is the variant `key: null`.

What has to hold again, and is the bar for this round: with the **context**
panel's input wired to anything other than `state.selectedLane`, or its
`expanded` wired to anything other than `state.expanded`, the `tools/argus-ui`
suite is red — while the tool panel's own arguments sit untouched. The `held:`
and `lanePanelInput(` assertions in that case never lost their power and stay
as they are.

### Implementation plan

One edit, in one file: `tools/argus-ui/test/page.test.mjs`.

1. **Add a parser helper next to `functionSource` (line 20) and
   `detailListener` (line 29)**, in their style — a short doc comment, an
   `assert.ok` on the anchor it needs, plain string scanning, no dependency:

   ```js
   /** The argument text of one call, from its `(` to the parenthesis that closes it. */
   function callArguments(source, name) {
     const open = source.indexOf(`${name}(`);
     assert.ok(open >= 0, `the source must still call ${name}()`);
     let depth = 0;
     for (let i = open + name.length; i < source.length; i += 1) {
       if (source[i] === '(') depth += 1;
       else if (source[i] === ')') {
         depth -= 1;
         if (depth === 0) return source.slice(open + name.length + 1, i);
       }
     }
     return assert.fail(`the ${name}( call must be closed by a matching )`);
   }
   ```

   It returns the text *between* the call's own parentheses, so a sibling call
   in the same statement — before it or after it — is outside the slice
   whatever punctuation separates them. Neither argument list contains a string
   literal or a comment holding an unbalanced parenthesis, so counting `(` and
   `)` is enough and a tokenizer is not.

2. **Rewrite the slice of the increment-6 case** (`page.test.mjs:479-501`) to
   `const slice = callArguments(renderLanePanel, 'renderContextPanel');`,
   dropping the two now-dead lines (`const callIdx = …indexOf('renderContextPanel(')`
   with its `assert.ok`, and `const endIdx = …indexOf(';', callIdx)` with its
   `assert.ok`). Keep all five existing assertions and their existing failure
   messages verbatim, and keep the `const view = laneView();` assertion, which
   matches against the whole function and not the slice. Add one assertion:
   the slice must not contain `laneToolInput(`, so a future third panel in the
   same statement cannot re-blunt the case the way the second one did.

3. **Rewrite the slice of the increment-7 case** (`page.test.mjs:601-615`) the
   same way, to `callArguments(renderLanePanel, 'renderToolPanel')`, with the
   mirror-image extra assertion that its slice does not contain
   `lanePanelInput(`. This case discriminates correctly today only because
   `renderToolPanel(` happens to be the last call before the `;`; it is the
   same latent defect and it costs three lines to remove while the helper is
   being added.

Nothing else in the suite is affected. The three other `indexOf(';', …)` slices
(`page.test.mjs:408`, `:425`, `:442`) sit in `wireEvents`' click listener and in
`loadLaneContext`, where each anchored call is its own statement and increment 7
changed nothing.

### Decisions, including the ones rejected

- **Fix the test's parser, not the production statement.** Splitting
  `renderLanePanel` into `const context = …; const tools = …;` would restore the
  `;` slice, but it would break the increment-7 case that pins
  `container.innerHTML = renderContextPanel(` (`page.test.mjs:586-599`, the
  "computed and then thrown away" pin), trade one test problem for another, and
  change working code to suit a crude parser. Rejected.
- **A balanced-paren scan, not a regex over the argument list.** A regex like
  `/renderContextPanel\(\s*lanePanelInput\(\{([^}]*)\}/` would work on today's
  formatting and break on the next reflow; the scan is indifferent to line
  breaks and to what the arguments look like inside.
- **Leave the whole-function `state.expanded` assertion at
  `page.test.mjs:545-550` alone.** It matches `renderLanePanel` entire, so the
  tool panel's `expanded:` satisfies it too — but the mutation it exists for
  (dropping `expanded: state.expanded` from `lanePanelInput`) is caught by the
  repaired case in step 2, and editing a second case buys no discrimination the
  suite does not then have. Recorded so its looseness reads as known, not
  missed.
- **Do not chmod `test.sh`.** `git ls-tree main test.sh` is `100644` here as in
  `main`, so `./test.sh` exits 126 on the mode, unchanged by this issue and
  owned by no increment in it. Changing a file mode nothing in this increment
  touches is scope this increment was not given; the runnable spelling
  `bash test.sh` is what the closed list below uses, exactly as the reviewer ran
  it in every round.
- **No new production behaviour, and no new production test.** The reviewer's
  two recorded observations — parameters capped at `TOOL_PARAM_CHARS` (2000),
  and tool calls older than the 2000-event poll window never being fetched —
  are explicitly recorded as observations and not findings, the second one being
  increment 4's poll. Neither is in scope this round.

### Module map

| Path | What it holds | Entry points |
| --- | --- | --- |
| `tools/argus-ui/test/page.test.mjs` (616 lines) | helpers `functionSource` 20, `detailListener` 29; the increment-6 lane-panel cases 467-573 (the defective one at 479-501, the loose `state.expanded` one at 536-551); the increment-7 cases 575-615 (the `innerHTML` pin 586-599, the tool-input case 601-615) | the new `callArguments` helper, and the slice lines of the two cases named above — nothing else in the file changes |
| `tools/argus-ui/public/app.js` (1285 lines) | `renderLanePanel` at 936-953: `container.innerHTML = renderContextPanel(lanePanelInput({ view, key: state.selectedLane, held: state.laneContext, expanded: state.expanded })) + renderToolPanel(laneToolInput({ view, key: state.selectedLane, calls: state.toolMarks, cursor: state.cursor, expanded: state.expanded }));` | **read only, unchanged** — it is the text the two cases parse |
| `tools/argus-ui/public/context.js` | `lanePanelInput` 242, `renderContextPanel` 256 | untouched |
| `tools/argus-ui/public/tools.js` | `laneToolInput`, `renderToolPanel` | untouched |

### Environment

Node ≥ 20.11 (v22.22.2 is installed). Zero runtime dependencies, no install
step, no build step, **no linter and no formatter in this repository** (no
eslint config, no `.prettierrc`, no `.editorconfig`). Nothing to start: both
cases are source reads — no collector, no DOM, no network, no fixture files.

The two commands the closed list asks for, both from the repository root:

```
node --test tools/argus-ui/test/page.test.mjs
bash test.sh
```

The first runs only the edited file (the file resolves `public/` from
`import.meta.url`, so it runs the same from anywhere), a second or two. The
second runs five suites — `test-repo.sh`, `test-worktree.sh`, `tools/argus`,
`tools/argus-ui`, `tools/log-parser` — and is the issue's closing criterion; a
couple of minutes, no network, no arguments. `test.sh` is mode `100644` in the
tree and in `main`, so the criterion's spelling `./test.sh` exits 126 on
permissions alone; `bash test.sh` is the same script and is the spelling to run.
`npm --prefix tools/argus-ui test` runs the seven UI test files and is what
`bash test.sh` invokes for this project; it is not in the closed list because
the full run already covers it.

### Test Plan

Tests are needed: the correction *is* a test, and the finding is that a pin
stopped discriminating. No production code changes this round, so there is no
new behaviour to cover — the work is to make two existing cases assert what
their names have always claimed.

#### What, per finding

**Finding 1 — the increment-6 pin on the context panel's input.** One case,
rewritten in place, keeping its name
(`'the panel is drawn from the lane the reader selected and the answer held for it'`).

| # | Input (the slice) | Expected |
| --- | --- | --- |
| F1-a | `callArguments(functionSource(app.js, 'renderLanePanel'), 'renderContextPanel')` at `HEAD` | contains `lanePanelInput(`, `view,`, `key: state.selectedLane`, `held: state.laneContext`, `expanded: state.expanded` — the five assertions already in the case, with their messages unchanged — so the case is green as the code stands |
| F1-b | the same slice, mutation M-A2: `key: state.selectedLane,` deleted from the `lanePanelInput({…})` call at `app.js:942` | `/key:\s*state\.selectedLane\b/` finds nothing in the slice → red. This is the mutation the reviewer showed green; it is the reason the round exists |
| F1-c | the same slice, hop `key: state.selectedLane` → `key: null` in that same call | red, same assertion |
| F1-d | the same slice, hop `expanded: state.expanded` → `expanded: {}` in that same call | red on `/expanded:\s*state\.expanded\b/` |
| F1-e | the same slice, with the *tool* panel's `key:` or `expanded:` mutated instead | the case stays **green** — its slice must not reach the neighbouring call. Expressed as a standing assertion, `assert.doesNotMatch(slice, /laneToolInput\(/, …)`, rather than as a mutation anyone runs |

**The mirror case — the increment-7 tool-input pin.** The same rewrite, keeping
its name (`'the tool list is drawn for the selected lane, at the cursor\'s moment, from the calls the page holds'`).

| # | Input (the slice) | Expected |
| --- | --- | --- |
| F1-f | `callArguments(…, 'renderToolPanel')` at `HEAD` | contains `laneToolInput(`, `view,`, `key: state.selectedLane`, `calls: state.toolMarks`, `cursor: state.cursor`, `expanded: state.expanded` — the six assertions already there, messages unchanged — green |
| F1-g | the same slice, `key: state.selectedLane,` deleted from the `laneToolInput({…})` call at `app.js:947` | red (it already was; the rewrite must not lose this) |
| F1-h | the same slice, plus `assert.doesNotMatch(slice, /lanePanelInput\(/, …)` | green at `HEAD`, and red if the helper ever hands back more than this call's own arguments |

**Edges of the helper**, covered by the two cases themselves rather than by
cases of their own: a call whose arguments span several lines (both do), a
nested call inside the arguments (both have exactly one, `lanePanelInput(` /
`laneToolInput(` — the depth counter is what makes the scan stop at the outer
`)` and not the inner one), and an anchor that is missing or unclosed (the
helper's own `assert.ok` / `assert.fail`, which turn a renamed or malformed call
into a named failure instead of a confusing one).

**Left untested, deliberately.** `callArguments` gets no test file of its own:
it is a test helper, its two call sites exercise it on the only two calls in the
repository it is pointed at, and a suite that tests its own helpers grows a
second suite to maintain. The looseness of `page.test.mjs:545-550` is left as
it is, for the reason in the decisions above. Nothing under `public/` is
re-tested: no production file changes, and the 205 cases that exist already
cover the tool list per the reviewer's own reading.

#### How

- **Level:** source-reading unit cases, the level increments 6 and 7 established
  for the page wiring — `app.js` touches `document` at import time and there is
  no DOM in the suite, so what the page hands each panel is verified by parsing
  `app.js` rather than by rendering it.
- **File:** `tools/argus-ui/test/page.test.mjs`, both cases edited in place. No
  new file.
- **Framework:** `node:test` with `node:assert/strict`, both already imported at
  the top of the file. Zero dependencies, no runner config.
- **Conventions of that file, to follow:** a flat `test('lowercase sentence
  naming the behaviour', () => {…})` with no `describe` and no hooks; each case
  re-reads its own source with
  `fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8')` (there is no shared
  fixture and none is to be introduced); slices are taken with the file's own
  helpers `functionSource` / `detailListener`, each of which asserts its anchor
  before slicing — `callArguments` joins them and belongs directly after
  `detailListener` at line 36, above the first `//` section comment; every
  `assert.match` carries a message saying what breaks in the product if the
  assertion fails ("without it the panel paints empty for every lane"), not what
  the regex is; the existing messages are kept verbatim, and the two new
  `doesNotMatch` messages are written in the same voice — for example "the
  context panel's arguments must be read on their own, or a sibling panel's
  `key:` silently satisfies this case".
- **Nothing is faked and nothing is stubbed:** the input is the real
  `public/app.js` on disk.
- **Command that runs just this file:**
  `node --test tools/argus-ui/test/page.test.mjs`.

#### What counts as done

Two commands, from the repository root, and nothing else:

```
node --test tools/argus-ui/test/page.test.mjs
bash test.sh
```

The first points straight at the edited file: it must report the same case count
as before plus nothing (the two cases are rewritten, not added), 0 fail, exit 0.
The second is the issue's closing criterion — `PASS: all 5 suites`, exit 0 —
and covers the whole `tools/argus-ui` suite along the way, which is why
`npm --prefix tools/argus-ui test` is not on the list. No linter exists, and no
other package is touched.

#### What is already red

Nothing. The working tree is clean at `7686727`, and the reviewer's own run of
this round's starting point was 205 pass / 0 fail / exit 0 for the UI suite and
`PASS: all 5 suites` / exit 0 for `bash test.sh`. **I ran neither command, not
even as a baseline** — reading the source settles what they will say, and the
first run belongs to whoever runs it downstream.

The correction is expected to be green the moment it lands: the production code
already passes `key: state.selectedLane` and `expanded: state.expanded` to
`lanePanelInput`, so the repaired case asserts what is true. If it comes out red
at `HEAD`, the fault is in the helper's scan and not in `app.js` — fix the
helper, and do not weaken the assertion or touch `public/`.
