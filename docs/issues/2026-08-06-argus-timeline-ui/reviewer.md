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
