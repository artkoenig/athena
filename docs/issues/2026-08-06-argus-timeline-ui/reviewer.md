# Reviewer

## Increment 1

Status: **1 finding requiring a correction.**

Scope reviewed: the whole diff `main...HEAD` (merge base `57e5fd4`) against the three
criteria of increment 1. Handoff files in the issue directory were not judged.

### Commands run

- `npm --prefix tools/argus test` — `node --test test/*.test.mjs`, 154 cases,
  0 failures, 0 skipped, exit 0. Nothing else was run; this was the whole list.

### Criterion 1 — `argus env` carries the content flags by default

Met, and the flag names check out against the CLI's own monitoring documentation
(`https://docs.claude.com/en/docs/claude-code/monitoring-usage.md`, fetched during this
review):

- `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_TOOL_DETAILS`, `OTEL_LOG_TOOL_CONTENT` and
  `OTEL_LOG_RAW_API_BODIES` are documented under exactly those names, and
  `OTEL_LOG_RAW_API_BODIES=1` is documented as the flag that makes the CLI emit
  `claude_code.api_request_body` / `claude_code.api_response_body` with an inline `body`
  attribute. So the "not emittable" branch of the criterion does not apply: the events
  exist and the diff sets the right flag.
- `CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH` is documented with the 61440 default the diff
  cites, in UTF-16 code units, which matches `bodyChars`/`bodyLength` in
  `contentMetaOf` (`tools/argus/src/claude.mjs`).
- Both output formats are pinned by tests that run the real binary
  (`tools/argus/test/config.test.mjs`, shell and `--format settings`), plus
  `otelEnvFor` unit cases including the `traces: false` path.

The `agent:<source>:<name>` grammar `agentOf` parses is not in the documentation, but the
installed CLI binary (`/opt/claude-code/bin/claude`) contains the literals `agent:custom`
(24×), `agent:builtin` (14×) and `repl_main_thread` (65×), which is consistent with the
implementation. The documentation confirms `query_source` is the only agent-bearing
attribute on the two body events: `agent.name`/`agent_id` are listed on `api_request`
and on spans, not on `api_request_body`/`api_response_body`, and the standard-attribute
table carries neither.

### Criterion 2 — the collector stores and serves the content-bearing records

Met in the code: `TelemetryStore` indexes content records on ingest, `listContent`
serves metadata without the body, `contentAt` serves the newest record at or before a
moment with its body, and `/api/content` + `/api/content/at` expose both behind the same
token gate as the other `/api/` routes (`server.mjs`, the `authorized` check at line 330
precedes `handleApi`). `/api/events` strips `body` from the copy it ships and attaches
`content` metadata instead, without mutating the stored record — that is pinned by a test.

The one gap is the test coverage for the second of the two events; see finding 1.

### Criterion 3 — recordings without the content flags are out of contract

Met. No new test constructs a content-less recording or asserts anything about one:
every fixture (`bodyLog` in `store.test.mjs`, `contentLogsPayloadJson` in
`server.test.mjs`, the `describeEvent` case in `claude.test.mjs`) carries a `body`. The
`typeof body === 'string'` guards in `bodyCharsOf`/`contentMetaOf` are defensive defaults
for file mode (`body_ref`), not a compatibility path, and no compatibility notice was
added to the README.

### Finding 1 — nothing in the suite covers `claude_code.api_response_body`

**Criterion violated:** criterion 2 ("the collector stores and serves what those events
carry"), for `api_response_body`, which criterion 1 names alongside `api_request_body`.

**The gap.** `grep -rn "api_response_body\|apiResponseBody" tools/argus/test/` returns
nothing. All three new test files exercise `claude_code.api_request_body` only, and the
`eventName` filter of `listContent`/`contentAt` is never passed a value in any test at
either level — so the `event=` query parameter of `/api/content` and `/api/content/at`,
which is the only way to reach a response body at all (`contentAt` defaults `eventName`
to `EVENT.apiRequestBody`, `server.mjs`), is unverified end to end.

**Reproduction.** Delete `EVENT.apiResponseBody` from `CONTENT_EVENTS`
(`tools/argus/src/claude.mjs`, the `export const CONTENT_EVENTS` line). Then:

- `#applyLog` (`store.mjs`) no longer indexes response bodies, so
  `GET /api/content?session=<id>&event=claude_code.api_response_body` answers with an
  empty list and `GET /api/content/at?...&event=claude_code.api_response_body` answers
  `null` for a session that contains response bodies;
- `/api/events` no longer strips their `body`, so every poll of the tail ships the whole
  response body verbatim — the leak the diff's own test guards against for requests;
- `npm --prefix tools/argus test` still reports 154 passing cases, 0 failures.

**What would close it:** a case that ingests a `claude_code.api_response_body` record and
asserts it is listed by `/api/content` (or `listContent`) with the body withheld, that
`contentAt`/`/api/content/at` with `event=claude_code.api_response_body` returns its body,
and that `/api/events` strips its `body` the way it does for a request body. The exact
shape is the test-author's call.

### Beyond the criteria (blast radius)

Traced; two consequences worth recording, neither of which I count as a correction because
neither violates a criterion of this increment and neither has a demonstrated failure.

1. **Span-carried content is neither stripped nor budgeted.** `OTEL_LOG_TOOL_CONTENT=1`
   plus `CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH=2000000` makes the CLI attach a `tool.output`
   span event whose attributes hold the tool's input and output, truncated at that limit
   *per attribute* (documented in the CLI's monitoring page). `otlp/decode.mjs` keeps span
   events with their attributes, `getTrace` (`store.mjs`) spreads the whole span into its
   response, and spans are trimmed only by count (`maxSpans: 50_000`) and retention — the
   new `maxContentChars` budget covers log bodies only. Consequence: a session with large
   tool outputs retains far more in `this.spans` than in the budgeted content index, and
   `GET /api/traces/:id` returns that content in full, where `/api/events` was deliberately
   made not to. Reproduction is by construction: POST a trace export with a
   `tool.execution` span carrying a `tool.output` span event with a large attribute, then
   `GET /api/traces/<traceId>` — the attribute comes back whole.
2. **`/api/events?search=` now walks the bodies.** `queryEvents` builds its haystack as
   `JSON.stringify(log.attrs)` per log (`store.mjs`), and content records sit in
   `this.logs` like any other. With the content window filled, a single search request
   stringifies up to `maxContentChars` (128 M chars) of body text on the event loop.
   Correctness is unaffected; only latency.

Also checked and clear: `tools/argus-ui/public/app.js` reads named `session.counts.*`
fields, so the added `contentRecords` counter changes no rendering; the UI never read
`attrs.body`, so stripping it from `/api/events` breaks no consumer; SSE frames carry
`summary` and never `attrs`, so no body reaches the stream.

**Ordering note, not a finding:** `contentAt` scans `contentLogs` in ingest order and
returns the first record with `timeMs <= atMs`, so "newest at or before" is really "last
ingested at or before". That matches how `queryEvents` already works and I could not
construct a real out-of-order arrival for one session, so it is recorded here only.

## Increment 1 — Round 1

Status: **accepted, 0 findings requiring a correction.**

Scope reviewed: the whole diff `main...HEAD` (merge base `57e5fd4`) against the three
criteria of increment 1, judged from the issue file and the diff alone. Handoff files in
the issue directory were not judged. The `## Increment 1` section above is an earlier pass
on the same increment; this section re-reviews everything from scratch.

### Commands run

- `npm --prefix tools/argus test` — `node --test "test/*.test.mjs"`, 159 cases, 159 pass,
  0 fail, 0 skipped, exit 0. That was the whole list; nothing else was run, and no run was
  needed at the merge base because nothing was red.

### Criterion 1 — `argus env` (both formats) carries the content flags by default

Met. `otelEnvFor` (`tools/argus/src/claude.mjs`) sets `OTEL_LOG_USER_PROMPTS=1`,
`OTEL_LOG_TOOL_DETAILS=1`, `OTEL_LOG_TOOL_CONTENT=1`, `OTEL_LOG_RAW_API_BODIES=1` and
`CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH=2000000` unconditionally, outside the `if (traces)`
branch.

The flag names were verified against the CLI's monitoring documentation
(`https://docs.claude.com/en/docs/claude-code/monitoring-usage.md`, fetched during this
review). All five appear verbatim; `OTEL_LOG_RAW_API_BODIES` is documented as "Emit the
full Anthropic Messages API request and response JSON as `api_request_body` /
`api_response_body` log events", with `1` meaning inline bodies and `file:<dir>` meaning
`body_ref` pointers. So the "not emittable" branch of the criterion does not apply and no
finding is owed there. `CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH` is documented with the 61440
default (UTF-16 code units) the diff's comment cites.

Confirmed against the installed CLI binary (`/opt/claude-code/bin/claude`) that the body
events carry their text as the `body` *attribute* and not as the OTLP record body:
`function mHd(e,t,r){…let{content:i,truncated:s}=FO(o);su(e,{body:i,body_length:String(o.length),…s&&{body_truncated:"true"},…r})}`.
That also confirms `body_truncated` is absent when nothing was truncated, which
`bool(undefined) === false` handles, and that `body_length` is the untruncated UTF-16
length — matching the `bodyLength`/`bodyChars` split in `contentMetaOf`.

Tests: `tools/argus/test/config.test.mjs` runs the real `bin/argus.mjs` for the shell
format and for `--format settings` and asserts all four flags in each;
`tools/argus/test/claude.test.mjs` pins them at unit level including the `traces: false`
path and asserts the content limit exceeds the CLI's 61440 default. A regression that
dropped any flag, or moved one inside the traces branch, fails.

### Criterion 2 — the collector stores and serves the content-bearing records

Met. `TelemetryStore` indexes `claude_code.api_request_body` and
`claude_code.api_response_body` into `contentLogs` on ingest with a char budget,
`listContent` serves metadata without a body, `contentAt` serves the newest matching
record at or before a moment with its body, and `/api/content` and `/api/content/at`
expose both. Both routes sit behind the same gate as every other `/api/` path: the
`authorized(req, url)` check in `server.mjs` runs at request dispatch before `handleApi`
is reached, so a new route cannot escape it. `/api/events` ships a copy with `body`
removed and `content` metadata attached, leaving the stored record intact.

Tests would catch a break in each part: store-level cases cover listing with parsed
metadata, `contentAt` at the exact boundary and before the first record, the `agent`,
`main` and `span` filters, the `eventName` filter for both event types plus the
`api_request_body` default, char-budget eviction from both indexes, the oversized-single-
body exception, `clear()` and session eviction; HTTP-level cases cover POST-then-`GET
/api/content` without a body, `/api/content/at` returning the full body, the 200-with-null
answer before the first record, the 400 without a `session`, and the tail stripping the
body for a request body and for a response body while `/api/content/at` still serves it.

Edges I checked and found covered by construction rather than by a case, none of which
leaves a criterion unverifiable: `listContent`'s newest-first-then-reversed ordering and
its `limit`, and the `session.counts.contentRecords` counter, are unasserted; no criterion
of this increment turns on them.

### Criterion 3 — recordings without the content flags are out of contract

Met. No test in the diff constructs a content-less record or asserts anything about one:
every fixture (`bodyLog`/`responseBodyLog` in `store.test.mjs`, `contentLogsPayloadJson`
in `server.test.mjs`, both `describeEvent` cases in `claude.test.mjs`) carries a `body`.
No fallback rendering and no compatibility notice was added; the README's new prose
describes the flags as on, never as optionally absent. The `typeof body === 'string'`
guards in `bodyCharsOf`/`contentMetaOf` and the `?? null` in `contentAt` are file-mode
defensive defaults (`body_ref`, which `otelEnvFor` never selects), not a compatibility
path, and nothing pins their behaviour.

### Nothing in the diff that no criterion asked for

`CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH`, the `maxContentChars` budget with its eviction, the
`agentOf`/`isSubagentSource` attribution helpers and the two `describeEvent` cases are all
in service of criteria 1 and 2 (a body truncated at 61440 chars is not "what those events
carry"; an unbudgeted body index is not storable; the increment's own question about
subagent attribution is what the `agent`/`main` filters answer). The README edits correct
statements the change would otherwise make false. I count none of it as unasked-for scope,
and no UI work leaked into this increment.

### Beyond the criteria (blast radius)

Traced; three consequences recorded, none of which I count as a correction because none
violates a criterion of this increment and none has a demonstrated failure.

1. **The UI still advises setting a flag that is now on.** `tools/argus-ui/public/app.js`
   line 398 renders "Set `OTEL_LOG_TOOL_DETAILS=1` in the agent environment to see task
   content and status here" when tool calls were seen without parameters. `argus env` now
   sets that flag, so the advice is dead: the real reason task ids stay unlinked is that
   `OTEL_LOG_TOOL_CONTENT` delivers the tool result as a *span event* and the store reads
   no span events (`store.mjs` touches `log.attrs` only; only `otlp/decode.mjs` keeps
   `span.events`). The README's parallel claim was corrected in this diff; this string was
   not. Reproduction: run a session with the new `argus env` block, make a `TaskCreate`
   call, open the Tasks tab — the placeholder tells you to set a variable that is already
   `1`. Left alone deliberately: `tools/argus-ui` belongs to a later increment.
   The same now-stale reasoning survives as a comment on `#applyTodo`
   (`tools/argus/src/store.mjs`, lines 558-566).
2. **A raised content limit meets a fixed 32 MB ingest cap.** `MAX_BODY_BYTES = 32 * 1024
   * 1024` in `server.mjs` rejects an oversized export with 413 and destroys the request,
   which drops every record in that batch, not just the large one. With
   `CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH=2000000`, sixteen maximal bodies in one OTLP batch
   reach that cap. I could not demonstrate the CLI actually emitting such a batch, so this
   is a risk note and not a finding.
3. **Span-carried content is neither stripped nor budgeted.** `OTEL_LOG_TOOL_CONTENT=1`
   plus the raised limit makes the CLI attach a `tool.output` span event whose attributes
   hold the tool's input and output, truncated per attribute at the content limit
   (documented on the CLI's monitoring page). `getTrace` spreads whole spans into its
   response, and spans are bounded only by `maxSpans` and retention, while
   `maxContentChars` covers log bodies alone. Reproduction by construction: POST a trace
   export with a `claude_code.tool.execution` span carrying a `tool.output` span event with
   a large attribute, then `GET /api/traces/<traceId>` — the attribute comes back whole,
   where `/api/events` was deliberately made not to do that for log bodies.

Also checked and clear: `/api/config`'s new `limits.contentChars` is read by no UI code
(`limits` appears only in `server.mjs`); the argus-ui event inspector renders
`event.attrs` generically, so the stripped `body` simply never appears and no consumer
breaks; the `body` text lives in attributes only, so `describeEvent`'s default branch
(`log.body`) cannot leak it; `agent:custom:`/`agent:builtin:` literals in the CLI binary
back the `query_source` grammar `agentOf` parses, and the documentation's standard-
attribute table carries neither `agent.name` nor `agent_id`, so `query_source` is indeed
the only attribution these two events offer.
