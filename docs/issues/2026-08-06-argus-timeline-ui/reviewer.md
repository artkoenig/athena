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

## Increment 2

Status: **1 finding, correction needed.** The lane model and the flag-removal are
sound and well covered; nothing pins the landing behaviour itself, so the whole
timeline can disappear from the page with the suite green.

### Commands run

- `npm --prefix tools/argus-ui test` — `node --test test/*.test.mjs`, 34 cases,
  0 failed, exit 0. Nothing skipped, nothing excluded. This was the only command
  on the list, and no other suite was run.

### Criterion 1 — opening a session lands on the timeline, technical views subordinate

Met in the code. `public/app.js` starts with `tab: null` (line 23), resets
`state.tab = null` in `selectSession` (line 913), and `renderDetail` emits
`renderTimeline(buildLanes({ session, content: state.content }))` (line 165)
*above* `renderDetailViews` (line 167) and the `#tab-body` container (line 169),
so a freshly opened session shows the timeline and no technical view. All six
previous views stay in the nav (`DETAIL_VIEWS` in `public/timeline.js`), and
clicking the open one closes it back to the timeline alone (line 973). The
timeline is never nested inside a view, so the subordination runs the right way.
`/api/content` is fetched on every refresh (`loadTimeline`, line 824) and its
failure costs the lanes, not the page.

See Finding 1 for the test gap on this criterion.

### Criterion 2 — one lane for the main session, one per subagent, spanning its lifetime

Met, and covered. `buildLanes` gives the main session its own lane from
`session.firstSeenMs`/`lastSeenMs`, widened by main records only, and one lane
per subagent group with `startMs`/`endMs` from that group's first and last
content record. Records with no usable time are dropped before anything is
derived, lane order is sorted rather than API-order dependent, and
`laneGeometry` clamps into `[0, 100]` with a `Math.max(1, span)` guard, so a
zero-length window paints no `NaN%`. Cases 21, 22, 23, 24, 25, 26, 27, 28 and 29
would each fail if that broke.

The lane's extent is the first-to-last *content record* of that agent, not a
span's real start and end; an agent that emitted a single API request paints the
0.6 % minimum bar rather than its true duration. That is an approximation, not a
criterion violation — the vertical slice still answers "which agents are
running" wherever an agent has more than one record.

### Criterion 3 — two concurrent subagents of one type get two lanes

Met, and covered. The lane key is `agent:<spanId>:<agent>`, so two
`general-purpose` instances on `sp-a` and `sp-b` stay apart, and the `#1`/`#2`
suffix fires only where labels actually collide. Cases 31, 32, 33 and 34 pin
both the model and the rendered markup.

### Criterion 4 — the UI advises no flag `argus env` now sets

Met, and covered. `OTEL_LOG_TOOL_DETAILS` is gone from the tasks placeholder and
`CLAUDE_CODE_ENHANCED_TELEMETRY_BETA` from the traces placeholder, the setup
paragraph and `index.html`. Case 8 walks every file under `public/` against the
17 names `otelEnvFor` sets and case 9 keeps `OTEL_RESOURCE_ATTRIBUTES` and
`CLAUDE_CODE_OTEL_DIAG_STDERR` — which `argus env` does not set — from being
deleted as collateral. I checked the list in case 8 against
`tools/argus/src/claude.mjs:310` `otelEnvFor`: every flag it sets is on the list
except `UROBOROS_OBS_URL`/`UROBOROS_OBS_TOKEN`, and no file under `public/`
names either of those, so the gap is inert.

### Finding 1 — criterion 1's landing behaviour has no test that fails when it breaks

The only test touching the landing is case 7 in `test/page.test.mjs`, and it
asserts that `public/app.js` contains an *import* of `./timeline.js` and that
`index.html` loads `app.js` as a module. Nothing asserts that the page starts on
the timeline or that the timeline is rendered at all; `app.js` reads `location`
at module scope, so no test imports it, and its behaviour is unpinned.

Reproduction, verified in a throwaway `git worktree` at HEAD (removed
afterwards; the checkout was not touched): in `public/app.js` change line 23
`tab: null,` back to `tab: 'overview',` and delete line 165
`${renderTimeline(buildLanes({ session, content: state.content }))}` from
`renderDetail`, leaving the import untouched. The UI then opens every session on
the Overview view and draws no timeline anywhere — criterion 1 fully undone —
and `npm --prefix tools/argus-ui test` still reports 34 passed, 0 failed,
exit 0.

The gap is closable with the technique the file already uses: a source-level
assertion over `app.js` that the initial state opens no technical view, that
selecting a session resets to that state, and that `renderDetail` calls
`renderTimeline` above `renderDetailViews`. Naming the criterion, not the test:
"opening a session lands on the timeline" must have a case that fails when the
landing is removed.

### Nothing in the diff that no criterion asked for

`public/format.js` is the eight formatters lifted out of `app.js` unchanged, so
`timeline.js` can escape without a second copy of `esc` — motivated by criterion
1's rendering, not new behaviour. The click-to-close on an open view, the CSS
block for the lanes and the README's new Timeline bullet all serve criteria 1
and 2. The reworded tasks and traces placeholders are criterion 4's removals.
No production behaviour beyond the four criteria appears in the diff, and
nothing from the deliberately excluded increments (activity, context curve,
scrubbing, live mode, per-lane detail) was built ahead of time.

### Beyond the criteria (blast radius)

- **The record shape the lanes consume matches the API.**
  `contentMetaOf` (`tools/argus/src/claude.mjs:210`) emits `timeMs`, `spanId`,
  `agent` and `isSubagent`, which is exactly what `buildLanes` reads, and
  `/api/content` accepts `limit` up to 2000, the value `loadTimeline` asks for.
  No mismatch between the fabricated test records and the served ones.
- **Serving the two new modules works.** `src/server.mjs` maps `.js` to
  `text/javascript; charset=utf-8` and serves any file under `public/`, so the
  module graph `index.html → app.js → timeline.js → format.js` resolves with no
  allowlist to update. The independence test was extended to cover both new
  files, so the "imports nothing outside the project" rule still holds over them.
- **`app.js` uses only what it imports.** It imports all eight exports of
  `format.js` and the three of `timeline.js`; the removed `TABS` constant has no
  remaining reference, and the periodic repaint at line 1070 is guarded by
  `state.tab === 'overview'`, which is simply false in the landing state.
- **Empty `spanId` merges same-type lanes — reported, not raised as a finding.**
  `contentMetaOf` normalises a missing span id to `''`, and `buildLanes` would
  then key two concurrent `general-purpose` instances as one
  `agent::general-purpose` lane spanning both — the merge criterion 3 forbids.
  Whether records ever arrive without a span id (for example from a block
  printed with `argus env --traces false`) is CLI behaviour I could not verify
  here, so this is an observation rather than a finding; the issue's own
  assumptions allow lanes to show what is attributable.
- **No stale document found.** `tools/argus/README.md` and `skills/argus/SKILL.md`
  describe the HTTP API and the signals, not which view a session opens on;
  `tools/argus-ui/README.md` was updated in this diff. `tools/argus-ui/CLAUDE.md`
  says "one test file per `src/` module" — the two new files test `public/`
  modules, which the sentence does not forbid.
- **A long session truncates the oldest lanes.** `/api/content?limit=2000`
  keeps the newest records, so a subagent that ran before the cutoff draws no
  lane at all. The store evicts old content by char budget anyway, so this is
  increment 1's window, not a regression introduced here.

## Increment 2 — Round 1

Status: **0 findings, accepted.** All four criteria are met in the code and each
now has a case that fails when the behaviour breaks; nothing in the diff goes
beyond them, and the suite is green.

### Commands run

- `npm --prefix tools/argus-ui test` — `node --test "test/*.test.mjs"`, 37 cases,
  37 passed, 0 failed, 0 skipped, 0 todo, exit 0. Nothing was skipped or
  excluded. This was the only command on the list; no other suite was run, and
  no run was needed at the merge base because nothing was red.

### Criterion 1 — opening a session lands on the timeline, technical views subordinate

Met. `public/app.js` opens with `tab: null` in the state literal (line 23), and
`renderTabBody` has an explicit `case null` that paints an empty `#tab-body`
(lines 179-181), so a freshly loaded page shows the timeline and no technical
view. `selectSession` resets `state.tab = null` (line 913), so switching
sessions returns to the timeline whatever view the previous session was left on.
`renderDetail` composes `renderTimeline(buildLanes(...))` (line 165) above
`renderDetailViews({ selected: state.tab, counts })` (line 167) and the
`#tab-body` container (line 169) — the timeline is never nested inside a view,
so the subordination runs the right way. All six previous views stay reachable
(`DETAIL_VIEWS` in `public/timeline.js`), the delegated `[data-tab]` handler
opens one and closes the open one back to the timeline alone (line 973), and
`loadTimeline` (line 824) refuels the lanes on every refresh with a failure that
costs the lanes rather than the page.

Covered: `test/page.test.mjs` cases 7-10 pin the module import, `tab: null` with
no string default, the `state.tab = null` in `selectSession`, and the
`renderTimeline` → `renderDetailViews` → `#tab-body` order inside `renderDetail`;
`test/timeline.test.mjs` cases 21-23 pin that all six views are offered, that
none is `aria-selected="true"` when nothing is chosen, and that exactly one is
marked when one is. The previous round's Finding 1 reproduction — setting
`tab: 'overview'` and deleting the `renderTimeline` line — now fails case 8 and
case 10 respectively, so the gap it named is closed.

### Criterion 2 — one lane for the main session, one per subagent, spanning its lifetime

Met. `buildLanes` (`public/timeline.js:37`) gives the main session a lane from
`session.firstSeenMs`/`lastSeenMs`, widened only by main-session records, and one
lane per subagent group whose `startMs`/`endMs` are that group's first and last
content record. Records without a usable time are filtered out before anything is
derived, lanes are sorted by start time rather than API order, and
`laneGeometry` clamps into `[0, 100]` behind a `Math.max(1, span)` guard, so a
zero-length window paints no `NaN%` into a style attribute. Every lane is a bar
in one shared window, so a vertical slice answers which agents were running.

Covered: `test/timeline.test.mjs` cases 24-33 pin the empty-content main lane,
the three-records-one-span agent lane, order independence, a subagent outliving
the session, no-time records changing nothing, exact geometry, the minimum-width
instant bar, the zero-length window, the rendered bars and the escaping of a
hostile agent label.

### Criterion 3 — two concurrent subagents of one type get two lanes

Met. The lane key is `agent:<spanId>:<agent>` (`public/timeline.js:68`), so two
`general-purpose` instances on `sp-a` and `sp-b` never merge, and the `#1`/`#2`
label suffix is applied only where two lanes actually carry the same label.

Covered: `test/timeline.test.mjs` cases 34-37 pin two lanes plus the numbered
labels for the concurrent case, the rendered markup carrying both bars, two
requests on one span still making one lane, and no suffix where labels differ.

### Criterion 4 — the UI advises no flag `argus env` now sets by default

Met. `OTEL_LOG_TOOL_DETAILS` is gone from the tasks placeholder,
`CLAUDE_CODE_ENHANCED_TELEMETRY_BETA`/`OTEL_TRACES_EXPORTER` from the traces
placeholder and from the setup paragraph in both `public/app.js` and
`public/index.html`. I re-checked the list in `test/page.test.mjs:101` against
`otelEnvFor` (`tools/argus/src/claude.mjs:310`): every name that function sets is
on it except `UROBOROS_OBS_URL`/`UROBOROS_OBS_TOKEN`, and no file under `public/`
names either, so the omission is inert. `tools/argus-ui/README.md` names no flag
at all. The two names still advised — `OTEL_RESOURCE_ATTRIBUTES` and
`CLAUDE_CODE_OTEL_DIAG_STDERR` — are set by nothing in `otelEnvFor`.

Covered: `test/page.test.mjs` case 11 walks every file under `public/` against
the 17 names and case 12 keeps the two legitimate ones from being deleted as
collateral.

### Nothing in the diff that no criterion asked for

`public/format.js` is the eight formatters moved out of `app.js` unchanged (I
diffed the bodies against `main`), which is what lets `timeline.js` escape
without a second `esc`; `app.js` declares none of them any more and uses all
eleven imports. The CSS block adds only lane, track, bar and axis rules, all
against variables that already exist (`--accent`, `--violet`, `--text-faint`,
`--mono`, `--border`). The README's new Timeline bullet and the "event tail"
rewording describe exactly criteria 1 and 2. `index.html` already loaded
`app.js` as a module on `main`, so the import addition needed no other change.
Nothing from the excluded increments — activity blocks, context curve,
scrubbing, live mode, per-lane context or tool list — was built ahead of time.
The collector (`tools/argus/**`) is untouched by increment 2's commits; those
hunks in the diff are increment 1's accepted baseline.

### Beyond the criteria (blast radius)

- **The module graph resolves as served.** `src/server.mjs` maps `.js` to
  `text/javascript; charset=utf-8` and serves any file under `public/` with no
  allowlist, so `index.html → app.js → timeline.js → format.js` loads. The
  independence test was extended to both new files, so the "nothing reaches
  outside the project" rule still covers them.
- **No duplicate declaration in `app.js`.** The removed formatting block left no
  `const esc` / `function fmt*` behind, so the imports cannot collide — which
  matters because a `SyntaxError` there would blank the page and no test imports
  `app.js`.
- **The lane inputs match what the API serves.** `contentMetaOf`
  (`tools/argus/src/claude.mjs:210`) emits `timeMs`, `spanId`, `agent` and
  `isSubagent`, exactly the fields `buildLanes` reads, and `/api/content` caps
  `limit` at 2000, the value `loadTimeline` asks for.
- **No stale document.** `README.md`, `tools/argus/README.md` and
  `tools/argus/CLAUDE.md` describe the collector, its API and how to start the
  interface — none of them names which view a session opens on.
  `tools/argus-ui/README.md` was updated in this diff.
- **Empty `spanId` would merge same-type lanes — observation, not a finding.**
  `contentMetaOf` normalises a missing span id to `''`, so two concurrent
  `general-purpose` subagents whose records carry no span id key as one
  `agent::general-purpose` lane. Whether the CLI ever emits content records
  without a span id is behaviour I cannot verify from this checkout (no recorded
  telemetry is present), so there is no reproduction and no finding; if such
  records exist, the data holds no discriminator either.
- **A long session still truncates the oldest lanes.** `/api/content?limit=2000`
  keeps the newest records, so a subagent that ran before the cutoff draws no
  lane. Unchanged from increment 1's retention window, not introduced here.
- **Residual, below the finding bar:** nothing pins `renderTabBody`'s `case
  null`. Deleting it would let the landing state fall through to the overview
  panel *under* the timeline with the suite green. The landing state itself
  (`tab: null`) and the timeline's presence are both pinned, and the project
  forbids runtime dependencies, so a DOM-level test is not available; I raise
  this as an observation rather than a correction.
