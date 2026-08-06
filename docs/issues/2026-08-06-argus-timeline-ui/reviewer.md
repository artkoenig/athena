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

## Increment 3

**Status: 1 finding requires a correction.** The lanes do carry activity marks
and a context area, and the pure functions behind them are pinned case by case.
The gap is in the wiring: `loadTimeline` writes the tool marks it fetched into
shared page state after an `await` without checking that the session it fetched
them for is still the selected one, and the watermark it raises never recovers,
so a lane can end up showing another session's tool calls and none of its own.

### Commands run

- `npm --prefix tools/argus-ui test` — 61 cases, 61 pass, 0 fail, 0 skipped,
  exit 0. Nothing was excluded. This is the only command my prompt lists and the
  only one I ran; `tools/argus`' own suite and `./test.sh` were not run, by that
  list.

### Criterion — each lane shows its activity over time (tool calls, API requests) and, behind it, the context size over time

Met in the drawing, with the wiring defect below.

- **Activity, both kinds.** `buildDensity`
  (`tools/argus-ui/public/timeline.js:238`) splits every lane's records into
  `{kind:'request'}` from `claude_code.api_request_body` content records and
  `{kind:'tool'}` from the fetched `claude_code.tool_result` events, and
  `activityMarks` (`:202`) buckets them into at most `ACTIVITY_BUCKETS` (120)
  marks per lane, keeping a `count` per bucket so no record is lost.
  `renderTimeline` (`:317`) paints one `<span class="lane-mark"
  data-kind="request|tool">` per bucket, absolutely positioned in the same
  `.lane-track` the lane bar sits in, with `--teal` and `--warn` backgrounds and
  a legend above the lanes. Attribution: a request goes to the lane produced by
  the same `laneKeyOf` rule the lanes were built with; a tool result goes to the
  lane whose `spanId` it carries, and to `main` when no lane owns that span.
- **Context size, as an area behind the bar.** `contextPoints` (`:161`) maps
  each request's `bodyLength` to a point in a 0…100 box scaled by the session's
  peak (`maxBodyLength`), not the lane's, so a subagent's hill reads smaller
  than the main session's mountain — which is what makes "where consumption
  grows" comparable across lanes. `areaPolygon` (`:180`) closes it on the
  baseline, and `renderTimeline` emits the `<svg class="lane-curve">` *before*
  the `<span class="lane-bar">` in the row, with `.lane-curve { inset: 0 }` and
  the bar moved to `bottom: 0; height: 5px` (`styles.css`), so the area is
  behind the bar rather than instead of it.
- **Without opening any detail.** The whole thing is composed in `renderDetail`
  (`app.js:170`) as `renderTimeline(buildDensity(buildLanes(...)))`, above the
  technical-views nav, and the landing state (`tab: null`) opens no view. Peak
  context and the two counts are additionally readable per lane from
  `data-peak` / `data-requests` / `data-tools` and the `lane-meta` title.
- **Divide-by-zero and overflow.** A zero-length window, a lane of one instant,
  a session where every `body_length` is 0, and a mark past the window end all
  stay finite and inside 0…100 (`clamp`, `Math.max(1, span)`), and no `style`
  attribute can carry `NaN`.

### Finding 1 — a lane can show another session's tool calls and permanently lose its own

`tools/argus-ui/public/app.js:839–857`. `loadTimeline` captures `const id =
state.selectedSessionId`, awaits two fetches, and then unconditionally pushes
the returned tool events into `state.toolMarks` and raises `state.toolSeq`:

```js
  state.content = content?.items ?? [];
  for (const item of tools?.items ?? []) {
    state.toolMarks.push({ seq: item.seq, timeMs: item.timeMs, spanId: item.spanId });
    if (item.seq > state.toolSeq) state.toolSeq = item.seq;
  }
```

There is no re-check that `state.selectedSessionId === id` after the await, and
no de-duplication by `seq`. Two `refresh()` calls can be in flight at once:
`scheduleRefresh` guards only a pending timer (`app.js:958`), while
`selectSession` calls `refresh()` directly (`app.js:939`).

Reproduction (state, steps, wrong result):

- State: a collector holding a live session A (its `tool_result` logs have the
  highest `seq` in the store, because `seq` is a single global counter in
  `tools/argus/src/store.mjs:270`) and a finished older session B whose
  `tool_result` logs all have a lower `seq`.
- Steps: open the UI on A. An `ingest` SSE event fires `scheduleRefresh`, and
  400 ms later `refresh()` reaches `loadTimeline` and issues
  `/api/events?session=A&event=claude_code.tool_result&sinceSeq=<A's watermark>`.
  Before that request resolves, click B in the session list. `selectSession`
  sets `selectedSessionId = B`, clears `toolMarks` and sets `toolSeq = 0`, and
  starts a second `refresh()`.
- Wrong result: A's in-flight response lands afterwards and pushes A's tool
  marks into the array that now belongs to B, and sets `state.toolSeq` to A's
  highest `seq`. B's lanes then paint A's tool marks (on whichever lane owns
  those spans — normally `main`, since A's spans are not B's lanes), and every
  later fetch for B asks `sinceSeq=<A's max seq>`, which `queryEvents` answers
  by breaking out of its newest-first walk at the first `log.seq <= sinceSeq`
  (`tools/argus/src/store.mjs:911`). B's own tool events, all below that
  watermark, are therefore never returned again: B's lanes show zero tool-call
  marks for the rest of the page's life, until B is deselected and reselected.
- Expected: B's lanes show B's tool calls and nothing of A's.
- Second, milder wrong result from the same missing guard: two overlapping
  refreshes for *one* session both read the same `state.toolSeq` and both push
  the same events, so a bucket's `count` — the number in the mark's tooltip,
  "N tool calls" — is inflated to twice what happened.

Criterion violated: "Each lane shows its activity over time (tool calls, API
requests)". A lane that shows a different session's tool calls, and none of its
own, does not.

Note for whoever fixes it: increment 2 already had the stale-write race on
`state.content`, but a wholesale overwrite self-corrects on the next refresh.
What increment 3 adds is accumulating state plus a monotonic watermark, and
neither recovers. The fix belongs in `loadTimeline` (drop the result when the
selection moved on, and/or ignore an item whose `seq` is already held); the
existing source-level cases in `test/page.test.mjs` are the natural place to pin
it.

### The tests against the intent

No gap I can name beyond finding 1.

- Both halves of the criterion have cases that fail if the behaviour breaks:
  activity marks (one bucket carries its count; a request and a tool call at
  one moment stay two marks; 500 records stay under 120 marks and lose none; a
  mark never leaves the track), the context area (scaled session-wide, exact at
  round numbers, zero-length window, all-zero sizes, single point still a
  four-vertex plateau, empty means no polygon), and the composition (the curve
  precedes the bar inside the same lane row; both `data-kind="request"` and
  `data-kind="tool"` appear on the agent lane; a bare lane renders neither).
- Attribution edges are covered where they matter: requests land on the lane
  that made them, a tool call lands on the lane whose span it carries, a tool
  call on an unowned span falls to `main`, and two concurrent same-type agents
  keep their own tool calls rather than merging. A response body contributes
  neither a context point nor an activity mark.
- The wiring the pure functions depend on is pinned at source level in
  `test/page.test.mjs`: `loadTimeline` fetches `/api/events` scoped to
  `TOOL_EVENT` with `sinceSeq`, `selectSession` clears both `toolMarks` and
  `toolSeq`, and `renderDetail` composes `renderTimeline(buildDensity(...))`.
  These are string assertions over `app.js`, which is what this project can do
  without a DOM or a dependency; they pin that the calls exist, not that the
  state stays consistent across two in-flight refreshes — which is exactly the
  hole finding 1 fell through.
- Increment 2's call shape is pinned as still working (`renderTimeline` from a
  bare `buildLanes` view), so the density staying optional is not a claim only
  the comment makes.

### Nothing in the diff that no criterion asked for

Increment 3 touches five files (`git diff 20334e6 49daa02`), handoffs aside:
`timeline.js` (the new exports and the richer row markup), `app.js` (the tool
fetch and the composition), `styles.css` (lane track height, curve, marks,
legend, `--meta-w`), `README.md`, and the two test files. The README bullet
gains one clause describing exactly what the lanes now draw — documentation of
this criterion, not new prose beside it. The legend and the `lane-meta` numbers
are not literally named by the criterion but serve it directly: they are what
makes a coloured mark and a shaded area readable as "API request", "tool call"
and "context size" without a detail view. I raise neither as a finding.

### Beyond the criteria (blast radius)

- **The API the page now calls exists and carries what it reads.**
  `/api/events` accepts `session`, `event`, `sinceSeq` and a `limit` capped at
  2000 (`tools/argus/src/server.mjs:219–226`), and its items spread the stored
  log record, which carries `seq`, `timeMs` and `spanId`
  (`tools/argus/src/otlp/decode.mjs:227`) — the three fields `loadTimeline`
  keeps. `argus-ui`'s server forwards any `/api/` path with its query string
  untouched (`src/server.mjs:52`), so no parameter is dropped in the middle.
  No collector change was needed and none was made.
- **The project rules still hold.** `timeline.js` imports only `./format.js`,
  touches no `document`/`fetch`/`location`, and the independence test covers
  both new public modules. No runtime dependency was added.
- **Whether a subagent's tool calls actually reach its lane is not verifiable
  here — observation, not a finding.** The attribution rests on a subagent's
  `api_request_body` record and its `tool_result` events carrying the *same*
  `spanId`. Nothing in this checkout records real telemetry, so I can neither
  confirm nor refute it; if they differ, every tool mark silently lands on the
  main lane and the suite stays green, since `buildDensity`'s fallback is
  exactly that. Stated so the risk is on the record, not as a finding: I have no
  reproduction.
- **`/api/content?limit=2000` still truncates the oldest records**, so in a very
  long session the curve and the lanes start at the cutoff. Unchanged from
  increment 1's retention window, not introduced here.
- **No document made stale.** `tools/argus/README.md` and both `CLAUDE.md` files
  describe the collector, its API and the split between the two projects; none
  of them describes what a lane draws. `tools/argus-ui/README.md` was updated in
  this diff.
- **Residual, below the finding bar:** `areaPolygon` widens a single-point
  plateau to `MIN_CURVE_WIDTH_PCT` but clips at 100, so a lone request at
  x = 99.9 draws a 0.1-wide sliver instead of 0.6. Visual only, at the extreme
  right edge, and the clamp is deliberate; not worth a round.

## Increment 3 — Round 1

**Status: 1 finding requires a correction.** The lanes draw both halves of the
criterion and the wiring race raised earlier is gone, but nothing in the suite
ties an activity mark to the moment its tool call or API request happened: the
whole time→position mapping for the marks can be replaced by a constant and the
suite stays green, so "activity **over time**" is unverified.

### Commands run

- `npm --prefix tools/argus-ui test` — 73 cases, 73 pass, 0 fail, 0 skipped,
  0 todo, exit 0. Nothing excluded. This is the only command my prompt lists and
  the only one I ran; `tools/argus`' own suite and `./test.sh` were not run, by
  that list.

### Criterion — each lane shows its activity over time (tool calls, API requests) and, as a curve or area behind it, the context size over time

Met in the code, read against the criterion word by word.

- **Activity, both kinds, per lane.** `buildDensity`
  (`tools/argus-ui/public/timeline.js:239`) feeds `activityMarks` (`:203`) one
  `{kind:'request'}` item per `claude_code.api_request_body` content record and
  one `{kind:'tool'}` item per fetched `claude_code.tool_result` event, bucketed
  into at most `ACTIVITY_BUCKETS` (120) marks per lane, each keeping its
  `count`. `renderTimeline` (`:321`) paints one
  `<span class="lane-mark" data-kind="request|tool">` per bucket inside the same
  `.lane-track` as the bar, coloured `--teal` / `--warn` (both defined in
  `styles.css`), with a legend above the lanes.
- **Attribution.** A request goes to the lane produced by `laneKeyOf` — the same
  rule `buildLanes` keyed the lanes with — and a tool result to the lane whose
  `spanId` it carries, falling back to `main` when no lane owns that span. Two
  concurrent same-type subagents keep their own marks, since a lane is a span.
- **Context size behind the bar.** `contextPoints` (`:162`) maps each request's
  `bodyLength` into a 0…100 box scaled by the session peak (`maxBodyLength`),
  not the lane's, so a subagent's hill reads smaller than the main session's
  mountain; `areaPolygon` (`:181`) closes it on the baseline; `renderTimeline`
  emits the `<svg class="lane-curve">` before the `<span class="lane-bar">` in
  the row, and `styles.css` puts the curve at `inset: 0` and the bar at
  `bottom: 0; height: 5px`, so the area is behind the bar rather than instead
  of it.
- **Without opening any detail.** `renderDetail` (`app.js:177`) composes
  `renderTimeline(buildDensity(buildLanes(...)))` above the technical-views nav,
  and the landing state (`tab: null`) opens no view.
- **Numerics.** A zero-length window, a lane of one instant, a session where
  every `body_length` is 0 and a mark past the window end all stay finite and
  inside 0…100; no `style` attribute can carry `NaN`.
- **The earlier stale-answer defect is fixed, and I checked the fix rather than
  the claim.** `loadTimeline` (`app.js:857`) now re-reads
  `state.selectedSessionId !== id` after both fetches resolve and before writing
  any state, and accumulates through `mergeToolMarks` (`timeline.js:299`), which
  drops an item whose `seq` is already held and returns the highest seq *held*.
  Two overlapping refreshes for one session therefore double nothing, and a
  response for a session that is no longer selected reaches neither the marks
  nor the watermark.

### Finding 1 — nothing pins an activity mark to the time its activity happened

Criterion violated: "Each lane shows its activity over time (tool calls, API
requests)". The position of a mark on the lane *is* the "over time" half of that
sentence, and it is the one part of the drawing no case constrains.

Reproduction (state, change, wrong result, and why nothing catches it):

- State: `activityMarks` in `tools/argus-ui/public/timeline.js:203–225`, whose
  only time-dependent output is `bucket` and the `leftPct` derived from it
  (`:209–220`).
- Change: force `const bucket = 0` (or emit `leftPct: 0` and keep the bucket
  key). Every tool call and every API request of every lane then paints at the
  left edge of the track, whatever moment it happened at, and the timeline no
  longer shows activity over time at all.
- Wrong result nobody sees: `npm --prefix tools/argus-ui test` still passes
  73/73. I walked every assertion that touches these marks and each one survives
  the change — `activity in one bucket is one mark carrying its count`
  (`test/timeline.test.mjs:440`, asserts only count and kind), `a tool call and
  an API request at the same moment stay two marks` (`:454`, asserts the two
  `leftPct` values are *equal to each other*, which 0 === 0 satisfies), `the
  marks are bounded however many records arrive, and lose none` (`:471`, asserts
  `length <= 120` and a total of 500 — one bucket of 500 passes both), `a mark
  never leaves the track` (`:483`, asserts `0 <= leftPct < 100` and finiteness),
  and the render cases (`:507`, `:544`), which assert the presence of
  `data-kind="request"` / `data-kind="tool"` and the absence of `NaN`. The one
  case that reads a `style` attribute for `left:` (`:188`) renders a bare
  `buildLanes` view, which carries no marks at all.
- Expected: a case that fails when a mark's position stops following the item's
  time — for instance, items at known offsets in a known window whose marks come
  out at the matching fractions of the track (within one bucket width,
  `100 / ACTIVITY_BUCKETS`), and a later item's mark strictly to the right of an
  earlier one. Shape and file are the test-author's call; the gap is that the
  mapping from `timeMs` to track position is unpinned for the marks.

Note on why this is not pedantry: the *curve's* time mapping is pinned exactly
(`contextPoints places a record by time inside the window, exact at round
numbers`, `:383`, asserts `x` is `[0, 50, 100]`), and `areaPolygon` preserves
those x values into the markup. The marks are the half of the criterion that has
no equivalent.

### The tests against the intent — the rest

Beyond finding 1, both halves of the criterion have cases that fail if the
behaviour breaks.

- Context size: scaled session-wide and not per lane, exact at round numbers,
  zero-length window, all-zero `bodyLength`, a single request still a
  four-vertex plateau, no requests means no polygon, and the area closes on the
  baseline.
- Which lane a record belongs to: requests land on the lane that made them, a
  tool call lands on the lane whose span it carries, a tool call on an unowned
  span falls to `main`, two concurrent same-type agents never merge their tool
  calls, and a response body contributes neither a context point nor an activity
  mark.
- Composition: the curve precedes the bar inside one lane row, a lane with
  nothing on it renders neither curve nor mark, and increment 2's
  `renderTimeline(buildLanes(...))` call shape still works.
- Accumulation: `mergeToolMarks` is pinned for the empty index, a duplicate
  `seq`, the same response merged twice, a watermark that may not run ahead of
  what is held, an unusable `seq`, non-mutation of its input, out-of-order
  items, a missing `spanId`, and that the merged index is what the density
  reads.
- Wiring is pinned at source level in `test/page.test.mjs` (the `/api/events`
  fetch scoped to `TOOL_EVENT` with `sinceSeq`, the guard sitting after the
  awaits and before `state.content =`, `mergeToolMarks` as the only path into
  page state, the reset on session change, and
  `renderTimeline(buildDensity(...))`). String assertions over `app.js` are what
  this project can do without a DOM or a dependency; they pin that the calls
  exist and in what order, not what they compute.

### Nothing in the diff that no criterion asked for

Increment 3's own commits (`20334e6`, `49daa02`, `8dafdcf`, `afff0b9`) touch,
handoffs aside: `timeline.js` (the new exports and the richer row markup),
`app.js` (the tool fetch, the stale-answer guard, the composition),
`styles.css` (track height, curve, marks, legend, `--meta-w`),
`tools/argus-ui/README.md` (one clause describing what the lanes now draw) and
the two test files. The legend and the `lane-meta` data attributes are not
literally named by the criterion but serve it directly — they are what makes a
coloured mark and a shaded area readable as "API request", "tool call" and
"context size" without a detail view. I raise neither as a finding. No file
outside `tools/argus-ui` was touched by this increment.

### Beyond the criteria (blast radius)

- **The API the page calls exists and carries what it reads.** `/api/events`
  accepts `session`, `event`, `sinceSeq` and a `limit` capped at 2000
  (`tools/argus/src/server.mjs:219–226`) and spreads the stored log record, so
  `seq`, `timeMs` and `spanId` — the three fields `mergeToolMarks` keeps — are
  present. `api()` (`app.js:50`) drops only `null`/`undefined`/`''`, so
  `sinceSeq: 0` is sent as `0`. No collector change was needed and none was made
  by this increment.
- **Project rules hold.** `timeline.js` imports only `./format.js`, touches no
  `document`/`fetch`/`location`, and `independence.test.mjs` covers both new
  public modules. No runtime dependency was added.
- **Callers of what changed.** The only consumers of `timeline.js` are `app.js`
  and the two test files; `renderTimeline` still accepts a bare `buildLanes`
  view (`lane.context`/`lane.activity` default to empty), so increment 2's call
  shape is not broken. `state.events` (Events tab) and `state.toolMarks` are
  separate fields; the new fetch adds a request per refresh and changes no
  existing one.
- **No document made stale.** Only `tools/argus/README.md` and
  `tools/argus-ui/README.md` mention a timeline or lanes; the former's single
  hit is about the event tail, and the latter was updated in this diff. Neither
  `CLAUDE.md` describes what a lane draws.
- **Observation, not a finding — whether a subagent's tool calls really reach
  its lane.** The attribution assumes a subagent's `api_request_body` record and
  its `tool_result` events carry the same `spanId`. Nothing in this checkout
  records real telemetry, so I can neither confirm nor refute it; if they
  differ, every tool mark lands on the main lane and the suite stays green,
  because that fallback is deliberate. On the record without a reproduction.
- **Observation, not a finding — the 2000-record ceiling.** `loadTimeline`
  fetches `/api/content` with `limit: 2000` (the server's maximum) on every
  refresh, and that page holds request *and* response bodies, so a session past
  roughly a thousand API turns loses its oldest records and the curve starts at
  the cutoff. The tool marks accumulate instead, so activity and context history
  can disagree at that scale. The content fetch and its limit came with
  increment 2 and are unchanged here; increment 3 did not break it.

## Increment 3 — Round 2

**Status: accepted, no finding requires a correction.** Both halves of the
criterion are drawn on the lanes and both are now pinned in time: the four new
cases tie an activity mark's position to the moment its tool call or API request
happened, including its direction, which was the one gap round 1 named.

### Commands run

- `npm --prefix tools/argus-ui test` — 77 cases, 77 pass, 0 fail, 0 skipped,
  0 todo, exit 0. Nothing excluded. This is the only command my prompt lists and
  the only one I ran; `tools/argus`' own suite and `./test.sh` were not run, by
  that list.

### Criterion — each lane shows its activity over time (tool calls, API requests) and, as a curve or area behind it, the context size over time

Met. Read against the criterion word by word, from the diff against `main`.

- **Activity, both kinds, per lane.** `buildDensity`
  (`tools/argus-ui/public/timeline.js:239`) feeds `activityMarks` (`:203`) one
  `{kind:'request'}` per `claude_code.api_request_body` content record and one
  `{kind:'tool'}` per fetched `claude_code.tool_result` event, bucketed into at
  most `ACTIVITY_BUCKETS` (120) marks per lane, each keeping its `count`.
  `renderTimeline` (`:321`) paints one `<span class="lane-mark"
  data-kind="request|tool">` per bucket inside the same `.lane-track` as the
  bar, coloured `--teal` / `--warn`, with a legend above the lanes.
- **Over time, and now verified as such.** `activityMarks` maps `timeMs` to a
  bucket and the bucket to `leftPct`; `renderTimeline` writes that number into
  `style="left:…%"`. `styles.css:910` positions `.lane-mark` absolutely in the
  relative `.lane-track` (`:869`), so the number is the position on screen.
- **Context size as an area behind the bar.** `contextPoints` (`:162`) maps each
  request's `bodyLength` into a 0…100 box scaled by the session peak, not the
  lane's; `areaPolygon` (`:181`) closes it on the baseline; the `<svg
  class="lane-curve">` is emitted before the `<span class="lane-bar">`, and the
  CSS puts the curve at `inset: 0` and the bar at `bottom: 0; height: 5px`, so
  the area sits behind the bar and the marks paint on top of both.
- **Without opening any detail.** `renderDetail` (`app.js:177`) composes
  `renderTimeline(buildDensity(buildLanes(...)))` above the technical-views nav,
  and the landing state (`tab: null`) opens no view.
- **The field names the drawing reads are the ones the API sends.**
  `contentMetaOf` (`tools/argus/src/claude.mjs:210`) returns `eventName`,
  `timeMs`, `bodyLength`, `spanId`, `agent`, `isSubagent` — exactly what
  `buildDensity` filters and measures on — and `EVENT.toolResult` is literally
  `claude_code.tool_result`, the value of `TOOL_EVENT`. The fixtures are not
  inventing a shape.
- **The stale-answer guard from round 1 still stands.** `loadTimeline`
  (`app.js:857`) re-reads `state.selectedSessionId !== id` after both fetches
  resolve and before writing state, and accumulates through `mergeToolMarks`,
  which drops a `seq` already held and returns the highest seq *held*.

### Round 1's finding is closed, checked against the code rather than the claim

Round 1 said the whole `timeMs` → track-position mapping for the marks could be
replaced by a constant with the suite staying green. Four cases in
`test/timeline.test.mjs:669–748` now pin it, and I checked each degradation by
hand rather than trusting the titles:

- Constant `bucket = 0`: the four items of `a mark sits at the fraction of the
  track its moment sits at in the window` collapse into one mark, so its
  `deepEqual([0, 25, 50, 75])` fails.
- Any offset or scale error: the same `deepEqual` fails.
- A *mirrored* mapping (`100 - …`) survives that case and survives `the rendered
  marks carry the positions their moments earned`, because both compare sorted
  positions that happen to be symmetric — but `a later moment always sits
  strictly right of an earlier one` (`:687`) compares each mark against the ideal
  position of *its own* time and asserts `diff >= 0`, which a mirror breaks. The
  direction is pinned, not just the spacing.
- An epoch-relative rather than window-relative position: `a mark keeps
  following its moment when the window does not start at zero` (`:736`) fails.

### The tests against the intent — the rest

No gap I can name.

- Context size: scaled session-wide and not per lane, exact at round numbers
  (`x` is `[0, 50, 100]`), zero-length window, all-zero `bodyLength`, a single
  request still a four-vertex plateau, no requests means no polygon, and the area
  closes on the baseline.
- Which lane a record belongs to: requests land on the lane that made them
  (`:284`), a tool call on the lane whose span it carries (`:295`), a tool call
  on an unowned span on `main` (`:307`), two concurrent same-type agents never
  merge (`:323`), and a response body contributes neither context point nor mark
  (`:341`).
- Bounds and composition: 500 records stay under 120 marks and lose none, a mark
  never sits at or past the right edge, a request and a tool call at one moment
  stay two marks, the curve precedes the bar inside one lane row, a lane with
  nothing on it renders neither, and increment 2's `renderTimeline(buildLanes(…))`
  call shape still works.
- Accumulation: `mergeToolMarks` is pinned for the empty index, a duplicate
  `seq`, the same response merged twice, a watermark that may not run ahead of
  what is held, an unusable `seq`, non-mutation, out-of-order items, a missing
  `spanId`, and that the merged index is what the density reads.
- Wiring is pinned at source level in `test/page.test.mjs` (the `/api/events`
  fetch scoped to `TOOL_EVENT` with `sinceSeq`, the guard between the awaits and
  `state.content =`, `mergeToolMarks` as the only path into page state, the reset
  on session change, and `renderTimeline(buildDensity(…))`). String assertions
  over `app.js` are what this project can do without a DOM or a dependency.

### Nothing in the diff that no criterion asked for

Round 2 added no production line: `git diff 76bd706..HEAD -- tools/` is 84 added
lines in `test/timeline.test.mjs` and nothing else. Increment 3's production
footprint is unchanged from round 1 — `timeline.js`, `app.js`, `styles.css` and
one README clause describing what the lanes draw. The legend and the `lane-meta`
data attributes are not literally named by the criterion but serve it directly;
I raise neither, as in round 1. Handoff files are outside what I judge.

### Beyond the criteria (blast radius)

- **Callers of what changed.** Nothing outside `app.js` and the two test files
  imports `timeline.js`; `renderTimeline` still accepts a bare `buildLanes` view.
  Round 2 changed no callable at all, so nothing new can have broken.
- **Increment 1 and 2 behaviour.** The lane bar moved to `bottom: 0; height: 5px`
  inside a 26px track, which changes how a lane looks, not the horizontal span
  that increment 2's criterion is about; `laneGeometry` is untouched.
- **Project rules hold.** `timeline.js` imports only `./format.js` and touches no
  `document`/`fetch`/`location`; `independence.test.mjs` covers both new public
  modules; no runtime dependency was added.
- **No document made stale.** Only `tools/argus/README.md` and
  `tools/argus-ui/README.md` mention a timeline or lanes; the former's hit is
  about the event tail, the latter was updated in this diff. Neither `CLAUDE.md`
  describes what a lane draws.
- **Observation, not a finding — subagent tool attribution.** A tool call reaches
  its subagent lane only if its `tool_result` event carries the same `spanId` as
  that agent's `api_request_body` record. Nothing in this checkout records real
  telemetry, so I can neither confirm nor refute it; if they differ, every tool
  mark lands on the main lane and the suite stays green, because that fallback is
  deliberate. On the record without a reproduction.
- **Observation, not a finding — the 2000-record ceilings.** `/api/content` is
  fetched with `limit: 2000` (the server maximum) and holds request *and*
  response bodies, and the first `/api/events` fetch for a session takes the
  newest 2000 `tool_result` events before the watermark advances past the rest
  (`tools/argus/src/store.mjs:908`, newest-first walk). A session past roughly a
  thousand API turns, or past 2000 tool calls, therefore starts its curve and its
  tool marks at that cutoff. Degradation at scale within a fixed retention
  window, not a wrong drawing of what is retained; the content limit predates
  increment 3 and the event limit is the server's own maximum.

## Increment 4

**Status: one finding requires a correction.** The scrub and the live mode are
built and behave correctly where I can read them, but nothing pins the one wire
that makes the criterion's first half work: delete the branch that routes the
slider's `input` event to `scrubTo`, and the suite still passes 103/103 while
the timeline no longer scrubs.

### Commands run

- `npm --prefix tools/argus-ui test` — 103 cases, 103 pass, 0 fail, 0 skipped,
  0 todo, exit 0. Nothing excluded. This is the only command my prompt lists;
  `tools/argus`' suite and `./test.sh` were not run, by that list.
- The same command once more in a throwaway `git worktree` outside the checkout,
  against a deliberately broken copy, to verify finding 1 below. The worktree was
  removed; the checkout under review was never modified.

### Finding 1 — no test fails when the scrub control stops scrubbing

Criterion violated: "The timeline can be scrubbed backward and forward to any
point of the recorded session" — the behaviour is implemented but unverified, so
it is one edit away from being lost silently.

Reproduction: in `tools/argus-ui/public/app.js:1113-1118`, delete the four lines

```js
    if (event.target.id === 'timeline-scrub') {
      scrubTo(event.target);
      return;
    }
```

from the `input` listener in `wireEvents`, and run
`npm --prefix tools/argus-ui test`: 103 cases, 103 pass, exit 0 (verified in a
sandbox worktree). With those lines gone, dragging or arrow-keying the slider
changes nothing in the page: `state.cursor` stays live, the cursor line and the
dimmed region stay at 100%, and the next refresh re-renders the thumb back onto
the head. The nearest existing case, "a drag moves the cursor without
re-rendering the page under the pointer" (`test/page.test.mjs:260`), reads
`scrubTo`'s own body and passes with `scrubTo` never called by anything.

The same hole covers the drag guard: nothing asserts that
`scrubbing` is ever set to `true`. Delete the `pointerdown` listener at
`app.js:1103-1105` and the suite is green again, while the `scrubbing` check
inside `scheduleRefresh` — which the case at `test/page.test.mjs:290` does pin —
becomes dead code and a refresh mid-drag replaces the slider under the pointer.

The asymmetry makes the gap plain: the return-to-live half of the criterion *is*
pinned at the page level ("a control returns the page to live",
`test/page.test.mjs:279`, asserts `wireEvents` acts on `data-cursor-live` and
writes `liveCursor()`), and the scrub half has no equivalent. `functionSource`
already extracts the whole of `wireEvents`, including both listeners, so a case
in the file's established style reaches them.

### Criterion — the timeline scrubs, and a live mode follows the head

Met in the code, read from the diff against `main`.

- **Scrub over the whole recorded session.** `renderTimeline`
  (`tools/argus-ui/public/timeline.js:372`) emits
  `<input type="range" id="timeline-scrub" min="{view.startMs}"
  max="{view.endMs}" step="1">`, whose bounds are the window `buildLanes`
  derived from `session.firstSeenMs`/`lastSeenMs` and every content record — the
  same window the lanes are drawn in — so every millisecond of the session is
  addressable, backward and forward. Pinned by "the scrub control spans the whole
  recorded session" (`test/timeline.test.mjs`).
- **The cursor is visible and consistent.** The thumb, the `.timeline-cursor-line`,
  the dimmed `.timeline-ahead` region and the clock readout all come from a single
  `resolveCursor` call per render (`timeline.js:428`) and a single one per drag
  (`app.js` `paintCursor`), so they cannot drift apart. Pinned at 37.5% and at the
  head by two rendering cases.
- **Live follows the newest data.** `liveCursor()` carries no time, and
  `resolveCursor` resolves live to the window's current `endMs` on every render;
  the SSE `ingest` handler schedules the refresh that re-renders. Pinned by "live
  mode follows the head as new data arrives".
- **Scrubbing leaves live, including on the head.** `scrubCursor` always returns
  `live: false`, clamped into the window; pinned, head case included.
- **A control returns to live.** The `Live` button carries `data-cursor-live` and
  `aria-pressed`, and the delegated click handler writes `liveCursor()` and
  re-renders (`app.js:1057`).
- **Position arithmetic is safe at the edges.** A zero-length window resolves to
  `leftPct: 100` rather than dividing by zero; out-of-window and `NaN` times clamp
  to an end; `resolveCursor` leaves its argument untouched. All four pinned, and
  two rendering cases assert the markup contains no `NaN`.

### Beyond the criteria

- **Increments 1–3 still hold.** `renderTimeline`'s new second parameter is
  optional and `cursor?.live !== false` resolves live, so the increment 2/3 call
  shape `renderTimeline(view)` renders unchanged — pinned by "the timeline still
  renders from a bare view with no cursor given". The one edited older case now
  matches `.lane-bar` styles specifically instead of every `style="` in the
  document, which the new cursor attributes would otherwise have swept in; that
  tightens it rather than weakening it, and it still forbids `NaN` anywhere.
- **Nothing else reads the changed markup.** `.timeline-lanes` gained a
  `position: relative` and a first child that carries no `data-lane`, and no
  selector or test counts children of `.timeline-lanes`. The cursor overlay's
  `left`/`right` use `--label-w`/`--meta-w`, both declared on `.timeline`
  (`styles.css:796`, and the narrow-screen override at `:1212`), which the overlay
  inherits — so it spans exactly the lane track column at both widths, and
  `pointer-events: none` keeps it off future lane clicks.
- **No document made stale.** `tools/argus-ui/README.md` gained three lines
  describing the cursor and the Live control, matching what ships; no other file
  in the repository describes the timeline's controls.
- **No scope beyond the criterion.** The diff adds the cursor, the control, their
  wiring and their styling, and touches nothing belonging to the later increments'
  context and tool views.
- **Observation, not a finding — the in-flight refresh window.** `scrubbing`
  defers only refreshes that have not started; a `refresh()` already awaiting the
  collector when the pointer goes down still calls `renderDetail()` and replaces
  the slider mid-drag, ending that drag (the cursor value already scrubbed to
  survives, and a second grab continues). Browser-only behaviour I cannot
  reproduce here, and the criterion stays reachable, so it is on the record
  without a reproduction.

## Increment 4 — Round 1

**Status: accepted, no finding requires a correction.** The scrub, the cursor
and the live mode meet the criterion in the code, and the wiring that makes the
scrub half work is now pinned: every deletion I could think of that would
silently stop the timeline from scrubbing, from registering a drag, or from
returning to live now turns the suite red.

### Commands run

- `npm --prefix tools/argus-ui test` — 106 cases, 106 pass, 0 fail, 0 cancelled,
  0 skipped, 0 todo, exit 0. Nothing excluded. This is the only command my
  prompt lists; `tools/argus`' suite and `./test.sh` were not run, by that list.
- The same command five more times in a throwaway `git worktree` outside the
  checkout, each against a single deliberate mutation, to check what the suite
  would catch (results below). The worktree was removed and the checkout under
  review was never modified — `git status --porcelain` is empty and
  `git worktree list` names only the checkout.

### Mutation checks on the criterion's wiring

Each mutation was applied alone to a sandbox copy and the listed command run
against it.

| Mutation | Result |
| --- | --- |
| Delete the `if (event.target.id === 'timeline-scrub') { scrubTo(…); return; }` branch from the `input` listener (`app.js:1115-1118`) | 105 pass, 1 fail, exit 1 |
| Delete the `pointerdown` listener on `#detail` (`app.js:1103-1105`) | 105 pass, 1 fail, exit 1 |
| Delete the `[data-cursor-live]` branch from the `click` listener (`app.js:1057-1063`) | 105 pass, 1 fail, exit 1 |
| Drop `state.cursor` from the `renderTimeline(…)` call in `renderDetail` (`app.js:188`) | 105 pass, 1 fail, exit 1 — `not ok 20 - the timeline is rendered with the page's cursor` |
| Make `resolveCursor` prefer a finite `cursor.timeMs` even in live mode | 106 pass, exit 0 — but the mutation is inert, because `liveCursor()` returns `timeMs: null` and "the live cursor is a fresh object every call" pins that. Not a gap. |

The first two are exactly the reproductions the `## Increment 4` section
recorded as unpinned; the three cases added in `test/page.test.mjs:317-343`
close them.

### Criterion — the timeline scrubs, and a live mode follows the head

Met, judged from the diff against `main` and from the mutation checks above.

- **Scrubbed backward and forward to any point.** `renderTimeline`
  (`tools/argus-ui/public/timeline.js:430-434`) emits
  `<input type="range" id="timeline-scrub" min="{view.startMs}"
  max="{view.endMs}" step="1">`. The bounds are the same window the lanes are
  drawn in — `buildLanes` takes `startMs`/`endMs` from `session.firstSeenMs`,
  `session.lastSeenMs` and every content record — and `step="1"` makes every
  millisecond of the recording addressable in both directions. The delegated
  `input` listener routes the slider to `scrubTo`, which writes
  `scrubCursor(Number(input.value), …)` into `state.cursor` and repaints without
  re-rendering. Pinned by "the scrub control spans the whole recorded session",
  "a scrubbed cursor puts the thumb, the line and the readout on one moment" and
  "the scrub control's input reaches the scrub".
- **A live mode that follows the newest data.** `liveCursor()` carries no time
  and `resolveCursor` resolves a live cursor to the window's *current* `endMs`
  on every render, so each refresh moves it to the new head. The page opens live
  (`app.js:42`) and every session selection resets to live
  (`app.js:962`). Pinned by "live mode follows the head as new data arrives",
  "a session opens live, with the cursor on the newest data", "the page opens
  live" and "selecting a session returns to live".
- **Scrubbing leaves live mode, head included.** `scrubCursor` returns
  `live: false` unconditionally, clamped into the window. Pinned by "scrubbing
  leaves live mode" and "scrubbing to the head still leaves live mode".
- **A control returns to it.** The `Live` button carries `data-cursor-live` and
  `aria-pressed`, and the delegated click handler writes a fresh `liveCursor()`
  and re-renders. Pinned by "a control returns the page to live" and, at the
  markup level, by the `aria-pressed` assertions in the two rendering cases.
- **One resolution per render.** Thumb, cursor line, dimmed region and clock
  readout all come from a single `resolveCursor` call — `timeline.js:428` per
  render, `paintCursor` per drag — so they cannot drift. Pinned at 37.5% and at
  100%.
- **Edges are safe.** A zero-length window resolves to `leftPct: 100` instead of
  dividing by zero, out-of-window and `NaN` times clamp to an end, and
  `resolveCursor` leaves its argument untouched. All pinned, and two rendering
  cases forbid `NaN` anywhere in the markup.

### Beyond the criteria

- **Increments 1–3 still hold.** `renderTimeline`'s second parameter is optional
  and `cursor?.live !== false` resolves live, so the increment 2/3 call shape
  `renderTimeline(view)` renders unchanged — pinned by "the timeline still
  renders from a bare view with no cursor given". The one older case that
  increment 4 edited now matches `.lane-bar` styles specifically and adds a
  document-wide `doesNotMatch(/NaN/)`: strictly stronger than what it replaced.
- **Nothing else reads the changed markup or CSS.** `.timeline-lanes` gained
  `position: relative` and a first child carrying no `data-lane`; `.lane-track`
  was already `position: relative` (`styles.css:869`), so the lane bars, curves
  and activity marks keep their containing block. The overlay's
  `left`/`right` use `--label-w`/`--meta-w`, declared on `.timeline`
  (`styles.css:796`) with a narrow-screen override (`styles.css:1213`), so it
  spans the lane track column at both widths, and `pointer-events: none` on
  `.timeline-cursor` keeps it off anything below it.
- **No new delegated handler shadows an old one.** The scrub branch in the
  `input` listener returns before the `event-search` branch and matches only
  `#timeline-scrub`; the `Live` branch in the `click` listener sits after
  `[data-copy]` and before `[data-tab]`, and no other element carries
  `data-cursor-live`.
- **A stuck drag flag heals itself.** `pointerup`/`pointercancel` are bound on
  `window`, not on the slider, so any release anywhere clears `scrubbing`, and
  `scheduleRefresh` re-arms every 400 ms until it does. No path leaves refreshes
  permanently deferred.
- **No document made stale.** `tools/argus-ui/README.md` gained three lines that
  say exactly what the criterion asks for. `skills/argus/SKILL.md` and
  `tools/argus/README.md` mention only the *event* timeline (the `/api/events`
  view), which this change does not touch.
- **No scope beyond the criterion.** The increment 4 production diff is the
  cursor functions, the scrub markup, its wiring, its CSS and the README lines.
  Nothing reaches into the later increments' context or tool views.
- **Observation, not a finding — arrow-key scrubbing is 1 ms per press.**
  `step="1"` (`timeline.js:432`) is what makes every millisecond addressable, so
  it serves the criterion, but on a ten-minute session one arrow key press moves
  the cursor 0.00017% of the track. `Home`/`End`/`PageUp`/`PageDown` and a
  pointer drag still reach any point, so the criterion is met; recorded in case
  a later increment wants a coarser keyboard step.
- **Observation, not a finding, carried over — the in-flight refresh window.**
  `scrubbing` defers only refreshes that have not started; a `refresh()` already
  awaiting the collector when the pointer goes down still calls `renderDetail()`
  and replaces the slider mid-drag. The scrubbed value survives and a second
  grab continues. Browser-only behaviour I cannot reproduce here.

## Increment 5

**Status: 3 findings require a correction.** The production code meets the
criterion — I read every line of it and could not make it misbehave — but three
clauses of the criterion are unverifiable: nothing in the suite fails when the
expanded block stops showing the full text, when every lane is queried as the
main session, or when the `assistant` kind disappears. Each is proven by a
mutation run below, not suspected.

### Commands run

- `npm --prefix tools/argus-ui test` — 154 cases, 154 pass, 0 fail, 0 cancelled,
  0 skipped, 0 todo, exit 0. Nothing excluded. This is the only command my
  prompt lists; `tools/argus`' suite and `./test.sh` were not run, by that list.
- The same command four more times in a throwaway `git worktree` outside the
  checkout (baseline plus three single mutations), to find out what the suite
  would catch. The worktree was removed; `git worktree list` names only the
  checkout and `git status --porcelain` is empty. The checkout under review was
  never modified.

| Sandbox run | Result |
| --- | --- |
| Unmutated copy of `HEAD` | exit 0 |
| M1 — `ROLE_KINDS` at `context.js:21` becomes `new Set(['user', 'system'])` | 154 pass, exit 0 |
| M2 — the whole filter at `app.js:927-933` becomes `const filter = !lane ? null : { main: '1' };` | 154 pass, exit 0 |
| M3 — `context.js:199` becomes `<pre class="ctx-text">${esc(block.preview)}</pre>` | 154 pass, exit 0 |

### Criterion — selecting a lane at the chosen time shows that agent's context as a message list

Met in the code, judged from the diff against `main`.

- **Selecting a lane.** `renderTimeline` emits each lane row as
  `<button type="button" class="lane" data-lane="…" aria-current="…">`
  (`tools/argus-ui/public/timeline.js:415-425`), so the row is reachable by
  pointer and keyboard; the delegated `click` handler on `#detail`
  (`app.js:1170-1177`) toggles `state.selectedLane` and clicking the open lane
  lets go. `.timeline-cursor` carries `pointer-events: none`
  (`styles.css:1004`), so the dimmed-ahead overlay drawn across the lane track
  cannot swallow a click on the part of a lane right of the cursor.
- **At the chosen time, for that lane.** `loadLaneContext` (`app.js:911-943`)
  resolves the page's own cursor through `resolveCursor(state.cursor, view)` and
  asks `GET /api/content/at?session=…&at=<that moment>` with exactly one lane
  filter — `main=1`, else the lane's `span`, else its `agent` name. The
  collector's `contentAt` defaults `eventName` to `claude_code.api_request_body`
  and returns the newest matching record with `timeMs <= atMs`, so "the nearest
  API request at or before that time" is what arrives. Live mode refetches it
  (`refresh`, `app.js:1022`), a scrub refetches it debounced
  (`scrubTo` → `scheduleLaneContext`, `app.js:1113-1116` and `app.js:975-983`),
  and returning to live refetches it (`app.js:1163-1168`). A stale answer is
  dropped by the session and lane guards after the await (`app.js:940-942`).
- **A structured message list.** `contextBlocks` (`context.js:64-142`) walks the
  system prompt (string or array of text entries), then every message in order —
  `text` under the message's role, `thinking`, `tool_use` labelled with the tool
  name, `tool_result` labelled with its `tool_use_id` and marked `error` — then
  every remaining top-level field. Order is the order in the body; nothing is
  dropped, and an unknown content block is kept under its own type.
- **One line with its size, expandable to the full text.** Each block renders as
  `<details><summary>` label + preview + `ctx-size` `</summary><pre>` full text
  `</pre></details>` (`context.js:194-200`), collapsed unless its
  `"<seq>:<index>"` key is in the expanded set. `chars` is the length of the very
  string the `<pre>` carries (`makeBlock`, `context.js:49-52`), so the number and
  the thing behind it are one measurement. Everything printed goes through
  `esc`.
- **Edges.** No body, an empty body, a non-object body and a body cut mid-JSON
  all render (raw block or nothing, never a crash); a moment before the lane's
  first request says so; a fetch in flight says something different from "there
  is nothing here".

### Finding 1 — "expandable to the exact full text" is unpinned in the renderer

`tools/argus-ui/public/context.js:199`. Only the *parser* half of this clause is
tested: `block.text` is asserted to be exact and uncut. What the panel actually
puts inside `<pre class="ctx-text">` is never read by any assertion — the
rendering cases count `<pre class="ctx-text">` tags and grep for a substring that
the collapsed preview also contains.

Reproduction (measured, M3 above): change `context.js:199` to
`<pre class="ctx-text">${esc(block.preview)}</pre>`. A 70 KB tool result then
expands to 120 characters plus an ellipsis — the criterion's "exact full text"
is gone — and `npm --prefix tools/argus-ui test` still reports 154 pass, exit 0.
Every panel case survives: `data-chars` still reports the true size, so the
collapsed line now advertises 70,000 chars behind an expansion that shows 121.

What a test has to catch: for a block whose text is longer than `PREVIEW_CHARS`,
the text between that block's `<pre class="ctx-text">` and `</pre>` is the whole
of `esc(block.text)`, not the preview and not a cut of it.

### Finding 2 — "that agent's (or the main session's) context" is unpinned: nothing ties a lane to its query

`tools/argus-ui/public/app.js:927-933`, against
`tools/argus-ui/test/page.test.mjs:404` ("the panel asks the collector for the
nearest request at the cursor's moment, for that lane only"). That case asserts
that the source of `loadLaneContext` matches `/\bmain\b/`, `/\bspan\b/` and
`/\bagent\b/` — and the three-line comment above the filter
("main traffic for the main lane, an agent lane's own span … its name only when
it carries no span at all") contains all three words on its own. The mapping
from a lane to the query it produces is therefore asserted by nothing.

Reproduction (measured, M2 above): replace the whole filter expression with
`const filter = !lane ? null : { main: '1' };`, leaving the comment in place.
Selecting the `agent:sp-a:probe` lane then sends
`/api/content/at?session=…&at=…&main=1` and the panel shows the **main
session's** request body under the subagent's lane — the criterion's "that
agent's … context" is violated for every subagent — and the suite still reports
154 pass, exit 0.

What a test has to catch: a lane of kind `agent` with `spanId: 'sp-a'` must
produce a query carrying `span=sp-a` and neither `main` nor a bare session
query; an agent lane with no span must fall back to its `agent` name; the main
lane must produce `main=1`. Whether that means exporting the lane→filter mapping
as a pure function or driving the loader some other way is the implementer's
call, not mine.

### Finding 3 — the `assistant` kind, one of the five the criterion names, is unpinned

`tools/argus-ui/public/context.js:21`, against
`tools/argus-ui/test/context.test.mjs:51` ("the five kinds the criterion names
all reach the list"). The kind sequence that case asserts is
`['system','system','user','system','thinking','tool_use','tool_result','field',
'field','field','field']` — there is no `assistant` in it. Every `assistant`
message in every fixture of the file carries only `thinking` and `tool_use`
parts, whose kinds ignore the role, so no assertion in the suite ever observes
an assistant text block.

Reproduction (measured, M1 above): change `context.js:21` to
`new Set(['user', 'system'])`. A body containing
`{ role: 'assistant', content: [{ type: 'text', text: 'answer' }] }` — the shape
of every assistant turn in a real context — then renders that block as kind
`other`, losing the assistant colour and the criterion's named kind, and the
suite still reports 154 pass, exit 0. The same fixture gap hides a worse
mutation: dropping `case 'text'` for assistant messages would delete every
assistant reply from the list, and no case would notice.

What a test has to catch: a message with `role: 'assistant'` and a `text`
content part yields exactly one block that the panel identifies as an assistant
block, carrying that text.

### Beyond the criteria

- **Increments 1–4 still hold.** `renderTimeline`'s third parameter defaults to
  `null`, so the two-argument call shape keeps working (pinned by "with nothing
  selected no lane claims to be current"). The lane row's change from `<div>` to
  `<button>` is fully reset in CSS — `appearance: none; width: 100%;
  background: none; border: 0; color: inherit; font: inherit; text-align: left`
  (`styles.css:857-865`) — so the `--label-w | 1fr | --meta-w` grid, the bars,
  the curves and the activity marks keep their geometry, and every custom
  property the new rules use (`--panel-hover`, `--accent-soft`, `--violet`,
  `--teal`, `--warn`, `--bg-sunken`, `--text-dim`, `--text-faint`, `--mono`,
  `--radius`) is declared in both the dark and the light block.
- **No delegated handler shadows another.** The new `[data-lane]` branch sits
  after `[data-copy]` and `[data-cursor-live]` and before `[data-tab]`; no lane
  row contains any of those attributes, and the panel deliberately carries
  `data-context-lane` rather than `data-lane` (pinned). The
  `summary[data-block]` branch only records the expansion the browser already
  performed, so it cannot fight `<details>`.
- **A failing panel costs the panel only.** `loadLaneContext` swallows its own
  rejection (`.catch(() => null)`), so the new `await` inside `refresh`
  (`app.js:1022`) cannot abort the render chain.
- **Nothing in the diff is outside the criterion**, with one deliberate
  extension recorded here rather than as a finding: blocks of kind `field` (every
  non-message top-level key — `tools`, `max_tokens`, `stream`, `model`) and
  `thinking` go beyond the five kinds the criterion names. They add to the list
  rather than replacing anything in it, and without them the per-block sizes
  would not add up to the body the head reports. Triage may still call it scope.
- **No document made stale.** `tools/argus-ui/README.md` gained five lines that
  describe exactly this criterion. `skills/argus/SKILL.md`, `tools/argus/README.md`
  and the root `README.md` mention only the collector, its API and how to start
  the interface; none of them describes lane selection.
- **Observation, not a finding — a live refresh collapses the expanded blocks
  when a new request arrives.** The expansion key is `"<seq>:<index>"`
  (`context.js:193`), so as soon as live mode moves the panel to a newer record
  every block shuts. That is defensible (it is a different context) and no
  criterion speaks to it, but the case named "expanding a block is remembered,
  so a live refresh does not collapse it" (`page.test.mjs`) promises more than
  the code does, since it only greps for `state.expanded`.
- **Observation, not a finding — the whole body is refetched every refresh.**
  `refresh()` awaits `loadLaneContext()` on every cycle (≈400 ms after each
  ingest event) even when the cursor is pinned and the record has not changed,
  and `argus env` now allows bodies up to 2,000,000 chars. I cannot reproduce a
  user-visible failure from it here; recorded for whoever measures the UI next.
- **Observation, not a finding — an agent lane with neither span nor name.** If a
  record ever arrived with `query_source` exactly `"agent:"` and an empty
  `spanId`, its lane would get `{ agent: null }`, `api()` drops null parameters,
  and the unfiltered query would answer with main-session traffic. I could not
  construct that record from the collector's own parsing rules (`agentOf` falls
  back to the source segment), so it stays an observation.

## Increment 5 — Round 1

**Status: 2 findings require a correction.** Round 0's three findings are
closed, and the production code still meets the criterion when I read it line by
line. What is still unverifiable is the wiring in the middle: the suite stays
green when the panel stops asking for the cursor's moment, and when the fetched
record never reaches the renderer at all. Both are proven by a mutation run
below, not suspected — with either one in place the panel shows the wrong
context, or none, and `npm --prefix tools/argus-ui test` reports 161 pass, exit
0.

### Commands run

- `npm --prefix tools/argus-ui test` — 161 cases, 161 pass, 0 fail, 0 cancelled,
  0 skipped, 0 todo, exit 0. Nothing excluded. This is the only command my prompt
  lists; `tools/argus`' suite and `./test.sh` were not run, by that list.
- The same command twice more in a throwaway `git worktree` outside the
  checkout, one single mutation each, to find out what the suite would catch.
  The worktree was removed afterwards; `git worktree list` names only the
  checkout and `git status --porcelain` is empty. The checkout under review was
  never modified, and no test was written to produce these findings.

| Sandbox run | Result |
| --- | --- |
| M1 — the line `at: resolveCursor(state.cursor, view).timeMs,` (`app.js:927`) deleted, the `resolveCursor(state.cursor, view)` call kept above it | 161 pass, exit 0 |
| M2 — `app.js:935` becomes `state.laneContext = { key, item: null };` | 161 pass, exit 0 |

### Criterion — selecting a lane at the chosen time shows that agent's (or the main session's) context as of that moment, as a structured message list

Met in the code, judged from the diff against `main`.

- **Selecting a lane.** Each lane row is
  `<button type="button" class="lane" data-lane="…" aria-current="…">`
  (`tools/argus-ui/public/timeline.js:417-425`), reachable by pointer and
  keyboard; the delegated `click` handler on `#detail` (`app.js:1159-1167`)
  toggles `state.selectedLane`, clears the expansions and refetches. The
  dimmed-ahead overlay drawn across the track carries `pointer-events: none`
  (`styles.css:1004`) and its children inherit it, so it cannot swallow a click
  on the part of a lane right of the cursor.
- **That agent's, or the main session's.** `laneContentQuery` (`context.js:158-164`)
  is now a pure function and produces exactly one filter: `{ main: '1' }` for the
  main lane, else the lane's `{ span }`, else its `{ agent }`, else `null` —
  and `loadLaneContext` sends no request at all for `null`, so no lane can be
  answered with the main session's traffic by accident.
- **As of that moment, nearest at or before.** `loadLaneContext`
  (`app.js:915-936`) resolves the page's own cursor with
  `resolveCursor(state.cursor, view)` and puts that moment on the wire as `at`;
  the collector's `contentAt` defaults `eventName` to
  `claude_code.api_request_body` and returns the newest matching record with
  `timeMs <= atMs`. Live mode refetches (`refresh`, `app.js:1013`), a scrub
  refetches debounced (`scrubTo` → `scheduleLaneContext`, `app.js:1106` and
  `app.js:960-966`), returning to live refetches (`app.js:1156`), and the session
  and lane guards after the await (`app.js:934`) drop an answer that arrived
  after the reader moved on.
- **A structured message list — system prompt, user, assistant, tool call, tool
  result.** `contextBlocks` (`context.js:65-143`) emits the system prompt (string
  or array of text entries) first, then every message in order — `text` under the
  message's role, `thinking`, `tool_use` labelled with the tool name,
  `tool_result` labelled with its `tool_use_id` and marked `error` — then every
  remaining top-level field, `tools` included. Nothing is dropped; an unknown
  content block is kept under its own type.
- **One line with its size, expandable to the exact full text.** Each block is
  `<details><summary>` label + preview + `ctx-size` `</summary><pre>` full text
  `</pre></details>` (`context.js:216-222`), collapsed unless its
  `"<seq>:<index>"` key is in the expanded set, and `chars` is the length of the
  very string the `<pre>` carries (`makeBlock`, `context.js:50-53`). Everything
  printed goes through `esc`.
- **Edges.** No body, an empty body, a non-object body and a body cut mid-JSON
  all render (raw block or nothing, never a crash); a moment before the lane's
  first request says so; a fetch in flight says something different from "there
  is nothing here".

### Round 0's three findings are closed

Checked against the code and the new cases, not against the claim.

- **Exact full text.** `context.test.mjs:386-428` reads the content of every
  `<pre class="ctx-text">` and compares it to `esc(block.text)` block by block,
  with an explicit guard that the fixture is longer than `PREVIEW_CHARS`. A
  preview substituted for the text now fails.
- **The lane-to-query mapping.** `laneContentQuery` is exported and pinned by
  value for all four cases (`context.test.mjs:432-458`), and `loadLaneContext`
  delegates to it in one line.
- **The `assistant` kind.** `context.test.mjs:366-384` requires exactly one
  `assistant` block carrying the assistant's own text, in the parser and in the
  rendered markup.

### Finding 1 — "as of that moment" is unpinned: nothing checks what moment goes on the wire

`tools/argus-ui/public/app.js:924-929`. The one case over this call
(`page.test.mjs:409-419`) greps `loadLaneContext`'s source for `/api/content/at`,
`resolveCursor(` and `laneContentQuery(`. A grep for an identifier cannot see
which value that identifier's result becomes, and no case anywhere asserts that
the request carries an `at` parameter at all.

Reproduction (measured, M1 above): delete the line
`at: resolveCursor(state.cursor, view).timeMs,` from the parameter object and
keep a bare `resolveCursor(state.cursor, view);` call in the function. The page
then asks `GET /api/content/at?session=…&main=1` with no moment; the collector
defaults it to `Date.now()` (`tools/argus/src/server.mjs:279`,
`atMs: intParam(searchParams, 'at', Date.now())`), so scrubbing to any earlier
point of the session still returns the newest request body — the panel shows the
head's context at every cursor position, which is the whole of "as of that
moment" gone. `npm --prefix tools/argus-ui test` reports 161 pass, exit 0.

The criterion this misses: "shows that agent's … context **as of that moment**:
the body of the nearest API request **at or before that time**".

### Finding 2 — "shows that agent's context" is unpinned: nothing checks that the fetched record reaches the panel

`tools/argus-ui/public/app.js:935` and `app.js:942-956`. The cases over this path
require that `state.laneContext =` is written after the guards
(`page.test.mjs:421-434`) and that `renderLanePanel` mentions `lane-panel`,
`renderContextPanel(` and `state.expanded` (`page.test.mjs:436-446`,
`481-496`). None of them looks at what is written or what is handed over, so the
panel's only input — the record the fetch returned — is unpinned.

Reproduction (measured, M2 above): change `app.js:935` to
`state.laneContext = { key, item: null };`. Every lane, at every moment, then
renders the empty panel — "No API request on this lane at or before this
moment." — and no context is ever shown, while
`npm --prefix tools/argus-ui test` reports 161 pass, exit 0.

The criterion this misses: "Selecting a lane at the chosen time **shows** that
agent's (or the main session's) context".

### The tests against the intent — the rest

The 42 cases in `context.test.mjs` cover the criterion's rendering half well:
every named kind, sizes equal to the expanded text, previews cut to one line,
order, escaping, the empty and pending states, a truncated body, and the
`data-lane` attribute that must not appear in the panel. The gap is the layer
between the cursor and that renderer, which lives in `app.js` and is checked
only by reading its source for identifiers — the two findings above are the two
places where that method loses the criterion. Everything else in `page.test.mjs`
for this increment (container position, toggle-to-deselect, the debounce, the
live refetch, forgetting the lane on session change) pins a decision that has no
value to compare against, so a source assertion is as far as it can go there.

### Nothing in the diff that no criterion asked for

`context.js`, the lane button and `selectedKey` in `timeline.js`, the panel state
and loader in `app.js`, the `.lane`/`.ctx-*` rules in `styles.css` and the one
README paragraph all serve this criterion. The blocks beyond the five named
kinds — `thinking`, `field` (`tools`, `model`, `max_tokens`, `stream`) and
`other` — are more than the criterion enumerates, but dropping them would make
the panel's sizes lie about what fills the context, so I do not raise them. No
prose, flag or view was added that no criterion asked for.

### Beyond the criteria (blast radius)

- **`<div class="lane">` became `<button class="lane">`.** `renderTimeline` is
  called from `app.js` only, `.lane` gained `appearance: none; width: 100%;
  background: none; border: 0; font: inherit; text-align: left`, so the grid
  layout of increments 3 and 4 survives. The button's descendants are spans and
  one `<svg>` — no interactive content nested in a button. Every CSS variable the
  new rules use (`--panel-hover`, `--accent-soft`, `--violet`, `--teal`,
  `--warn`, `--bg-sunken`) is defined in `styles.css`.
- **The third argument of `renderTimeline`** defaults to `null`, so the
  two-argument calls the earlier increments' cases make still render, with every
  lane `aria-current="false"`.
- **A fourth module under `public/`.** `context.js` is served by the generic
  static handler (`.js` is in `MIME`) and reaches the collector through
  `PROXIED = pathname.startsWith('/api/')`, so `/api/content/at` needs no route
  of its own in `tools/argus-ui/src/server.mjs`. `independence.test.mjs` was
  extended to cover it.
- **One extra request per refresh** when a lane is open (`refresh` awaits
  `loadLaneContext`), guarded by `if (!id || !key)` so a closed panel costs
  nothing; the fetch swallows its own rejection, so a failing panel cannot take
  the page's refresh down with it.
- Nothing else found: no caller of the changed functions outside `app.js`, and
  no document made stale by this increment.

## Increment 5 — Round 2

**Status: 3 findings require a correction.** Round 1's two findings are closed
and the production code meets the criterion when I read it line by line. What is
still unverifiable is the last stretch of the same chain: the suite stays green
when the selected lane never reaches the panel, when the panel never repaints
after the click's own fetch, and when every collapsed line reports its size as
zero. Each is proven by a single-line mutation measured below, not suspected.

### Commands run

- `npm --prefix tools/argus-ui test` — `node --test "test/*.test.mjs"`, 175
  cases, 175 pass, 0 fail, 0 cancelled, 0 skipped, 0 todo, exit 0. Nothing was
  excluded. This is the only command my prompt lists; `tools/argus`' suite and
  `./test.sh` were not run, by that list. Nothing was red, so no run at the merge
  base was needed.
- The same command six more times in a throwaway `git worktree` outside the
  checkout — one unmutated baseline and five single mutations — to find out what
  the suite would catch. The worktree was removed afterwards; `git worktree list`
  names only the checkout and `git status --porcelain` is empty. The checkout
  under review was never modified, and no test was written to produce these
  findings.

| Sandbox run | Result |
| --- | --- |
| Unmutated copy of `HEAD` | 175 pass, exit 0 |
| M-A — `lane,` deleted from the `renderContextPanel({…})` call in `renderLanePanel` (`app.js:939-943`) | 175 pass, exit 0 |
| M-B — `loadLaneContext().then(renderLanePanel);` in the `[data-lane]` click branch (`app.js:1153`) becomes `loadLaneContext();` | 175 pass, exit 0 |
| M-C — the lane lookup in `renderLanePanel` (`app.js:938`) finds by `entry.kind === 'main'` instead of `entry.key === key` | 175 pass, exit 0 |
| M-D — the size span in `renderContextPanel` (`context.js:280`) becomes `<span class="ctx-size" data-chars="0">0</span>` | 175 pass, exit 0 |
| M-E — the preview span (`context.js:279`) becomes `<span class="ctx-preview"></span>` | 175 pass, exit 0 |

### Criterion — selecting a lane at the chosen time shows that agent's (or the main session's) context as of that moment, as a structured message list

Met in the code, read clause by clause against the diff to `main`.

- **Selecting a lane.** Each lane row is
  `<button type="button" class="lane" data-lane="…" aria-current="…">`
  (`tools/argus-ui/public/timeline.js:417-425`), reachable by pointer and by
  keyboard; the delegated `click` handler on `#detail` (`app.js:1147-1155`)
  toggles `state.selectedLane`, clears the expansions, repaints and refetches.
  The dimmed-ahead overlay across the track carries `pointer-events: none`
  (`styles.css`), so it cannot swallow a click on the part of a lane right of the
  cursor. Nothing in the panel carries `data-lane`, so no click inside it toggles
  the selection.
- **That agent's, or the main session's.** `laneContentQuery`
  (`context.js:161-167`) produces exactly one filter — `{ main: '1' }` for the
  main lane, else the lane's `{ span }`, else its `{ agent }`, else `null` — and
  a `null` filter fires no request at all, so no lane can be answered with the
  main session's traffic by accident. I checked the three names against the
  collector's route: `/api/content/at` reads `main === '1'`, `span` and `agent`
  (`tools/argus/src/server.mjs:263-281`) and ANDs them in `matchesContent`
  (`store.mjs:197-205`), so the parameter names the UI sends are the ones the
  collector filters on.
- **As of that moment, nearest at or before.** `laneContentRequest`
  (`context.js:183-188`) resolves the moment with `resolveCursor(cursor, view)`
  and puts it on the wire as `at`; `contentAt` (`store.mjs:953-968`) walks the
  content index backwards and returns the first record with `timeMs <= atMs`,
  defaulting `eventName` to `claude_code.api_request_body`. Live mode refetches
  (`refresh`, `app.js:1001`), a scrub refetches debounced (`scrubTo` →
  `scheduleLaneContext`, `app.js:1094` and `app.js:948-954`), returning to live
  refetches (`app.js:1144`), and the session and lane guards after the await
  (`app.js:926`) drop an answer that arrived after the reader moved on.
- **A structured message list — system prompt, user, assistant, tool call, tool
  result.** `contextBlocks` (`context.js:68-146`) emits the system prompt (string
  or array of text entries) first, then every message in order — `text` under the
  message's role, `thinking`, `tool_use` labelled with the tool name,
  `tool_result` labelled with its `tool_use_id` and marked `error` — then every
  remaining top-level field. Nothing is dropped; an unknown content block is kept
  under its own type.
- **One line with its size, expandable to the exact full text.** Each block is
  `<details><summary>` label + preview + `ctx-size` `</summary><pre>` full text
  `</pre></details>` (`context.js:277-283`), collapsed unless its
  `"<seq>:<index>"` key is in the expanded set, and `chars` is the length of the
  very string the `<pre>` carries (`makeBlock`, `context.js:53-56`). Everything
  printed goes through `esc`.
- **Edges.** No body, an empty body, a non-object body and a body cut mid-JSON
  all render (raw block or nothing, never a crash); a moment before the lane's
  first request says so; a fetch in flight says something different from "there
  is nothing here".

### Round 1's two findings are closed

Checked against the code and the new cases, not against the claim.

- **The moment on the wire.** The request object is built in one pure function
  and pinned by value: `fetchLaneContext` cases assert the params `deepEqual`
  `{ session, at, main|span }`, that a live cursor asks for the window's `endMs`,
  and that a moment outside the window is clamped rather than sent raw
  (`context.test.mjs:487-527`). Round 1's M1 — deleting the `at` line — now
  fails.
- **The fetched record reaching the panel.** `fetchLaneContext` returns
  `{ key, item }` pinned by identity, `laneContextInput` is pinned by value for
  the fresh, foreign, missing and null-held cases, and `page.test.mjs:418-433`
  requires that `state.laneContext` is written from the variable
  `fetchLaneContext` was awaited into. Round 1's M2 — writing
  `{ key, item: null }` — now fails.

### Finding 1 — the lane the reader selected never has to reach the panel

**Criterion clause missed:** "Selecting a lane at the chosen time shows that
agent's (or the main session's) context."

`tools/argus-ui/public/app.js:934-944`. `renderContextPanel` renders the empty
string for `lane: null` (`context.js:237`), so `lane` is the argument that
decides whether anything is shown at all and whose label says whose context it
is. `page.test.mjs:462-476` — the case named "the panel is drawn from the answer
held for the lane it belongs to" — slices the `renderContextPanel(` call and
asserts only `...laneContextInput(key, state.laneContext)` and
`expanded: state.expanded`. Nothing in the suite reads the `lane` argument.

Reproduction, measured:

- M-A: delete the line `lane,` from the object passed to `renderContextPanel` in
  `renderLanePanel`. Clicking any lane, at any cursor position, then paints an
  empty `#lane-panel` — the whole increment produces nothing visible — and
  `npm --prefix tools/argus-ui test` reports 175 pass, exit 0.
- M-C: change the lookup on `app.js:938` from
  `laneView().lanes.find((entry) => entry.key === key)` to
  `.find((entry) => entry.kind === 'main')`. Selecting the subagent lane
  `agent:sp-a:probe` then shows a panel headed "main session" — the reader cannot
  tell whose context is on screen — and the suite reports 175 pass, exit 0.

What a test has to catch: the lane object handed to `renderContextPanel` is the
lane whose key is `state.selectedLane`, and no lane means no panel. Whether that
means asserting on the call's `lane` argument at source level or lifting the
lookup into a pure function beside `laneContextInput` is the implementer's call,
not mine.

### Finding 2 — nothing fails when selecting a lane never repaints the panel

**Criterion clause missed:** the same one — "Selecting a lane at the chosen time
shows … context".

`tools/argus-ui/public/app.js:1147-1155`. The click branch paints the pending
panel, then fetches and repaints: `loadLaneContext().then(renderLanePanel);`.
The only case over this branch (`page.test.mjs:394-401`, "selecting a lane
fetches its context") asserts that `loadLaneContext(` appears after `data-lane`
and stops there; the repaint that turns the answer into markup is unread.

Reproduction, measured (M-B): change that line to `loadLaneContext();`. Open a
session that receives no further telemetry — a finished run, which is the normal
case for reading a session back — and click a lane. `state.laneContext` fills
correctly, but `#lane-panel` is never repainted: the panel keeps saying "Reading
the context at this moment…" for the life of the page, because the only other
repaint is `renderDetail` inside `refresh()`, and `refresh()` runs only on an
SSE `ingest` event (`app.js:1116-1118`); the 15-second `setInterval` in `boot`
repaints the session list and the overview tab only (`app.js:1277-1280`). The
suite reports 175 pass, exit 0.

What a test has to catch: selecting a lane repaints the panel once the fetch it
started has resolved, not only on the next refresh.

### Finding 3 — the size on a collapsed line is never read

**Criterion clause missed:** "each block collapsed to one line **with its
size**".

`tools/argus-ui/public/context.js:280`, against `context.test.mjs:296-297`. That
assertion counts `<span class="ctx-size" data-chars="\d+">` tags and compares the
count to the number of blocks; the digits it matches are never compared to
anything. `chars` is pinned at parser level (`block.chars === block.text.length`)
and the expanded text is pinned exactly, but the number the collapsed line prints
is not tied to either.

Reproduction, measured (M-D): replace the size span with
`<span class="ctx-size" data-chars="0">0</span>`. Every block of every context
then advertises a size of 0 — the panel's whole "where does the context go"
purpose is gone, and a 70 KB tool result looks the same as a four-character user
message — and `npm --prefix tools/argus-ui test` reports 175 pass, exit 0. The
head's total is loose in the same way: `context.test.mjs:305` matches
`data-chars="\d+"` without a value, so the body-size figure beside the model can
be replaced by any number.

What a test has to catch: for each block, the size the collapsed line shows is
that block's own `chars`, and the head's total is the body's own length.

Same measurement, recorded as part of this finding and not as a fourth: M-E —
emptying `<span class="ctx-preview">` — also leaves 175 pass, exit 0, so the one
line a collapsed block shows is unread in the markup too. The parser's `preview`
is pinned (cut to `PREVIEW_CHARS`, single line, ellipsis), only its arrival in
the panel is not.

### The tests against the intent — the rest

Everything else this criterion asks for has a case that fails when it breaks.

- The five named kinds reach the list in order, `assistant` included, each with
  its own `data-kind` in the markup; a tool call carries its tool name and its
  whole input; a tool result is tied to its `tool_use_id` and says `error` when
  it failed; the system prompt parses as a string and as an array of entries.
- Every block expands to `esc(block.text)`, exactly, in order, with an explicit
  guard that the fixture is longer than `PREVIEW_CHARS` so the case cannot pass
  vacuously.
- The lane→query mapping is pinned by value for all four cases, and the request
  `fetchLaneContext` puts on the wire is pinned by value including the cursor's
  moment, the live head and the clamp.
- Failure and edge behaviour: a rejected fetch, an answer with no record, no
  lane, no session, a lane the filter cannot identify (no request fired at all),
  a truncated body, a non-object body, a message with no content, an unknown
  content part, escaping of hostile text, no `NaN` and no `undefined`, and no
  `data-lane` anywhere in the panel.
- Wiring is pinned at source level in `page.test.mjs` (the imports, the
  container's position between timeline and views, the toggle-to-deselect, the
  guards after the await and before the write, the debounce, the live refetch,
  the return-to-live refetch, forgetting the lane on session change, and the
  page opening with no lane). String assertions over `app.js` are what this
  project can do without a DOM or a dependency; findings 1 and 2 are the two
  hops of the chain where that method still reads nothing.

### Nothing in the diff that no criterion asked for

Increment 5's files, handoffs aside: `public/context.js` (new), the lane
`<button>` and the `selectedKey` parameter in `public/timeline.js`, the panel
state, loader and click branches in `public/app.js`, the `.lane` button reset and
the `.context-*`/`.ctx-*` rules in `public/styles.css`, one README paragraph, and
the three test files. Round 2 added no behaviour: it moved the request building
and the held-answer mapping out of `app.js` into `context.js` unchanged (I
diffed `f244f56..HEAD` — 20 lines out of `app.js`, the same logic in
`laneContentRequest`/`fetchLaneContext`/`laneContextInput`) and extended the two
test files. The blocks beyond the five named kinds — `thinking`, `field`
(`tools`, `model`, `max_tokens`, `stream`), `other`, `raw` — are more than the
criterion enumerates, but dropping them would make the panel's sizes lie about
what fills the context, so I do not raise them. No prose, flag or view was added
that no criterion asked for, and nothing from the deliberately excluded
increment (the per-lane tool list) was built ahead of time.

### Beyond the criteria (blast radius)

- **The round-2 move creates no import cycle and breaks no rule.**
  `context.js` now imports `resolveCursor` from `./timeline.js`, which imports
  `./format.js` and nothing else; `app.js` imports both. No `document`, `fetch`
  or `location` reaches `context.js` — the api function is injected — so
  `node --test` can import it, and `independence.test.mjs` covers the file for
  both project rules.
- **`app.js` has no dangling import.** `laneContentQuery` was dropped from its
  import list and has no remaining reference there; `resolveCursor` is still
  imported and still used by `paintCursor`, which `page.test.mjs:306-312`
  requires.
- **Callers of what changed.** `renderTimeline`'s third parameter defaults to
  `null`, so the two-argument calls the earlier increments' cases make still
  render with every lane `aria-current="false"`. `renderContextPanel` is called
  from `renderLanePanel` only. Nothing outside `tools/argus-ui/public` and its
  tests references the new module.
- **The collector is untouched by this increment**, and the route the panel uses
  already existed: `/api/content/at` with `session`, `at`, and one of
  `main`/`span`/`agent`. `tools/argus-ui/src/server.mjs` forwards any `/api/`
  path with its query string intact, so no route of its own was needed.
- **No document made stale.** `tools/argus-ui/README.md` gained the paragraph
  that describes exactly this criterion; `tools/argus/README.md`,
  `skills/argus/SKILL.md` and the root `README.md` describe the collector, its
  API and how to start the interface, none of them lane selection.
  `tools/argus-ui/CLAUDE.md`'s "one test file per `src/` module" is not broken by
  a fourth test file over a `public/` module, which is the pattern
  `timeline.test.mjs` already set.
- **Observation, not a finding — a live refresh collapses the expanded blocks
  when a newer request arrives.** The expansion key is `"<seq>:<index>"`
  (`context.js:276`), so as soon as live mode moves the panel to a newer record
  every block shuts. Defensible (it is a different context) and no criterion
  speaks to it, but the case named "expanding a block is remembered, so a live
  refresh does not collapse it" promises more than the code does.
- **Observation, not a finding — the whole body is refetched every refresh.**
  `refresh()` awaits `loadLaneContext()` on every cycle (≈400 ms after each
  ingest) even when the cursor is parked and the record has not changed, and
  `argus env` allows bodies up to 2,000,000 chars. No user-visible failure I can
  reproduce here; on the record for whoever measures the UI next.
- **Observation, not a finding — no test crosses the UI/collector boundary for
  the three filter names.** The project rule forbids importing `tools/argus`, so
  `main`/`span`/`agent` agreeing with the collector's route is something I
  verified by reading both sides, not something either suite checks. They agree
  today; a rename on the collector side would be caught by neither suite.
