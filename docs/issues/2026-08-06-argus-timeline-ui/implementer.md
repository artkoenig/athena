# Implementer handoff — argus timeline UI

## Increment 1

Implemented the plan's five-file change: the content flags in the env block, the
content vocabulary in `claude.mjs`, a bounded content index with two queries in
`store.mjs`, two routes plus a body-stripped event tail in `server.mjs`, and the
four README edits. Nothing outside `tools/argus` was touched. No test file was
opened for editing.

### Baseline: the planned tests were red for the right reason

Ran `npm --prefix tools/argus test` before changing anything: 118 tests, 106
pass, 12 fail, exit 1. The failures were exactly the ones `test-author.md`
records — `undefined !== '1'` on the env flags, `404` on the two content routes,
`the event tail must not ship the body`, the missing `describeEvent` size, and
`store.test.mjs` failing to load with
`SyntaxError: … does not provide an export named 'agentOf'`. The suite total is
118 rather than 154 in the baseline precisely because that load failure keeps
`store.test.mjs`'s own cases from being counted at all.

### What changed, file by file

**`tools/argus/src/claude.mjs`**

- `otelEnvFor()` sets `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_TOOL_DETAILS`,
  `OTEL_LOG_TOOL_CONTENT`, `OTEL_LOG_RAW_API_BODIES` to `'1'` and
  `CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH` to `'2000000'`, in the unconditional
  object, above the `if (traces)` branch. One comment covers the group and says
  that `OTEL_LOG_TOOL_CONTENT` rides on span events and is inert with
  `--traces false`. No opt-out option was added.
- New exports: `CONTENT_EVENTS` (the two body event names), `agentOf(attrs)`,
  `isSubagentSource(attrs)`, `contentMetaOf(log)`.
- `agentOf` returns `null` unless `query_source` starts with `agent:`; otherwise
  the segment after the second colon, falling back to the source segment when
  the name is redacted (`agent:custom` → `'custom'`), and a name containing a
  colon keeps everything after the second one.
- `contentMetaOf` returns exactly the field list the plan named. `bodyLength`
  goes through `num()` and `truncated` through `bool()` because both arrive as
  strings; `bodyChars` is `attrs.body.length`, `0` when the body is absent.
- `describeEvent` gained a case per body event, naming model, direction,
  `body_length`, a `(truncated)` marker and `query_source` — never the body.

**`tools/argus/src/store.mjs`**

- `DEFAULTS.maxContentChars = 128 * 1024 * 1024`.
- New state `this.contentLogs` (references to the same records in `this.logs`,
  ingest order) and `this.contentChars`, both reset in `clear()`.
- `#applyLog` indexes a `CONTENT_EVENTS` record into `contentLogs`, adds its
  chars, and bumps the new per-session `counts.contentRecords`. The record stays
  in `this.logs` as well.
- Eviction is consistent on all three paths: `#trim('logs', …)` now calls a new
  `#unindexContent(removed)`; `#dropSession(id)` subtracts and filters that
  session's content records; a new `#trimContent()`, called from `#evict()`,
  shifts oldest-first while over budget **and** `contentLogs.length > 1`, then
  removes the collected records from `this.logs` in one `filter` pass. Records
  are evicted whole; `attrs.body` is never gutted in place.
- New `listContent({sessionId, agent, mainOnly, spanId, eventName, limit})` —
  newest-first walk, reversed to ascending, `contentMetaOf` per record, no body.
- New `contentAt({sessionId, agent, mainOnly, spanId, eventName, atMs})` — the
  newest match with `timeMs <= atMs`, returned with `body`, else `null`.
- Two module-level helpers: `bodyCharsOf(log)` (the single definition of what a
  record costs, used by every index and eviction path) and `matchesContent(log,
  filters)` (the ANDed filter shared by both queries).

**`tools/argus/src/server.mjs`**

- `GET /api/content` → `{ items }` from `listContent`, params `session`,
  `agent`, `main=1`, `span`, `event`, `limit` (default 200, max 2000).
- `GET /api/content/at` → `{ item }`, `400 {error:'session required'}` without
  `session`, otherwise always 200 with `item` possibly `null`. `event` defaults
  to `EVENT.apiRequestBody`, `at` to `Date.now()`.
- `/api/events` replaces `attrs` with a **copy** minus `body` and adds
  `content: contentMetaOf(event)` for `CONTENT_EVENTS` records only. The stored
  record is not mutated.
- `/api/config` reports `limits.contentChars`. The SSE frame was not touched.

**`tools/argus/README.md`** — the four planned edits: the five new lines in the
sample env block; "Sensitive data" rewritten to say `argus env` now sets these
by default, why, and what it means for memory and the `--persist` directory
(the `user.email`/`user.account_uuid`/`organization.id` sentence kept); the two
new routes in the HTTP API table; the task-id "Limits" bullet reworded to say
the id rides in a span event the store does not read, so the limit no longer
rests on the flag being off.

### Commands run

- `npm --prefix tools/argus test` (baseline, before any edit) — 118 tests, 106
  pass, 12 fail, exit 1. Red exactly as `test-author.md` recorded.
- `node --test tools/argus/test/{store,claude,server,config}.test.mjs`
  (mid-work check over the four files the plan names) — 79 tests, 79 pass,
  exit 0.
- `npm --prefix tools/argus test` (final) — **154 tests, 154 pass, 0 fail, 0
  skipped, 0 todo, exit 0.** Nothing excluded.

That one command is the whole "what counts as done" list in `researcher.md`.
`./test.sh` and the `argus-ui` suite were deliberately not run: the plan
reserves them for the closing increment, and nothing outside `tools/argus`
changed. There is no linter and no formatter in this repository.

### Nothing left red

No failure remains, so there is nothing to attribute to untouched code.

### Notes for the reviewer

Neither of these is a blocking question; both are things I noticed and did not
act on, because they are outside this increment.

1. **`intParam` refuses a negative `at`.** `GET /api/content/at?at=-1` falls
   back to `Date.now()` rather than answering with a `null` item, because
   `intParam` treats `value < 0` as absent. Epoch-ms timestamps are never
   negative in practice and the plan explicitly routes `at` through `intParam`,
   so I left it. Case 16 passes because it scrubs to a positive time before the
   first record.
2. **`contentAt` walks `contentLogs` in ingest order, not sorted by time.** The
   plan's data model is "references in ingest order", and every measured export
   arrives in time order per session, so newest-first equals latest-time-first.
   A record arriving out of order (a late flush from a different pipeline) could
   in principle be selected over a nearer one. Sorting on every call would cost
   O(n log n) per scrub; the plan chose the walk, and a later increment that
   sees out-of-order content in practice is the right place to revisit it.
3. **`counts.contentRecords` is never decremented on eviction**, matching the
   existing behaviour of every other key in `counts` (they are cumulative for
   the life of the session entry, by the module's stated contract). So it
   answers "did this recording ever carry content", not "how many bodies are
   still in memory".

## Increment 1 — Round 1

**No production file changed this round, and none needed to.** The plan for this
round states it plainly: the five new cases are regression pins for
`claude_code.api_response_body`, the implementation already handles that event on
every path the reviewer's finding named, and every case is expected green on its
first run with no production edit. I ran the list and that is what happened.

### What I did

1. Read `researcher.md` (`## Increment 1 — Round 1`) and `test-author.md`
   (`## Increment 1 — Round 1`).
2. Confirmed the working tree was clean at `99a347b "Add Round 1 test cases for
   api_response_body content coverage"` — the test-author's five cases and two
   fixture helpers were already committed, and the production files were
   untouched (`git status --short`, no output).
3. Ran the one command the plan lists as what counts as done.

I edited no test and wrote no test, per my boundaries. I opened no production
file, because the run gave me nothing to fix.

### Commands run

- `npm --prefix tools/argus test` (from the repository root) — **159 tests, 159
  pass, 0 fail, 0 cancelled, 0 skipped, 0 todo, exit 0.** Nothing excluded.
  That is the round-0 total of 154 plus the five cases this round added.

That one command is the whole "what counts as done" list in `researcher.md` for
this round. `./test.sh` and the `argus-ui` suite were deliberately not run — the
plan reserves them for the closing increment, and nothing outside
`tools/argus/test` changed here. There is no linter and no formatter in this
repository, so there was nothing else to run.

### Nothing left red

No failure remains, so there is nothing to attribute to untouched code and
nothing left open.

### Notes for the reviewer

Neither is a blocking question; I am reporting them rather than acting on them.

1. **The plan's "turns three of them red at once" count is off by one, and the
   test-author already measured it.** `test-author.md` records that removing
   `EVENT.apiResponseBody` from `CONTENT_EVENTS` turns four cases red (1, 2, 3
   and 4), not three (1, 3 and 4), because `contentAt` with an explicit
   `eventName` of the response event also stops matching once indexing stops. I
   did not re-run that reproduction — deliberately mutating production code to
   check a sensitivity is not implementation work, and both counts support the
   round's conclusion that the new cases catch the regression. The discrepancy is
   in the researcher's prose only; no case and no production line depends on it.
2. **The three round-0 notes above still stand unchanged** (`intParam` refusing a
   negative `at`; `contentAt` walking `contentLogs` in ingest order rather than
   sorted by time; `counts.contentRecords` never decremented on eviction). This
   round touched nothing that bears on any of them, and none was filed as a
   correction.
3. **The reviewer's two "beyond the criteria" notes remain unaddressed by
   design** — span-carried tool content is still unstripped and unbudgeted, and
   `/api/events?search=` still stringifies bodies. The round's plan explicitly
   rules both out of scope and instructs that those surfaces not be edited here,
   so I left them alone.

## Increment 2

Implemented the plan's `tools/argus-ui` change: the formatting section moved into
its own module, a new pure timeline module, the landing view and advisory edits
in `app.js`, lane styles, the static empty state and the README. Nothing outside
`tools/argus-ui` was touched, `src/` and `bin/` were not opened for editing, and
no test file was edited.

### Baseline: the planned tests were red for the right reason

Ran `npm --prefix tools/argus-ui test` before changing anything: 18 tests, 13
pass, 5 fail, exit 1. The failures were exactly the ones `test-author.md`
records — `ERR_MODULE_NOT_FOUND` for `public/timeline.js` (which takes the whole
of `timeline.test.mjs`, cases 1-3 and 5-18, down as one failure), the missing
`./timeline.js` import in `app.js`, the four flag names still written into
`public/`, and both `independence.test.mjs` cases for the two files that did not
exist yet. Case 20 ("flags argus env does not set are still advised") passed
before the change and after it, as the test-author predicted.

### What changed

| File | Change |
| --- | --- |
| `tools/argus-ui/public/format.js` | **New.** `esc`, `fmtNum`, `fmtCost`, `fmtDur`, `fmtClock`, `fmtAgo`, `isLive`, `shortId`, moved verbatim out of `app.js` and exported. No body changed. |
| `tools/argus-ui/public/timeline.js` | **New.** `MIN_LANE_WIDTH_PCT`, `DETAIL_VIEWS`, `buildLanes`, `laneGeometry`, `renderTimeline`, `renderDetailViews`. Pure: it imports only `./format.js` and touches no `document`, `fetch` or `location`. |
| `tools/argus-ui/public/app.js` | Imports both new modules; `state.tab` now starts `null` and `state.content: []` was added; the `TABS` constant and its inline nav markup are gone; `renderDetail` renders head, timeline, `renderDetailViews`, `#tab-body`; `renderTabBody` gained a `case null` that writes the empty string; new `loadTimeline()` called from `refresh()` between `loadSession()` and `loadTabData()`; `selectSession` resets `tab` and `content`; the tab click handler toggles the open view closed; the three advisory sites (todos placeholder, traces placeholder, empty state) rewritten. |
| `tools/argus-ui/public/index.html` | The static empty state's muted paragraph, same wording as the rendered one. |
| `tools/argus-ui/public/styles.css` | New `timeline` block after the waterfall (`.timeline-panel`, `.timeline`, `.timeline-axis`, `.timeline-ticks`, `.timeline-tick`, `.lane`, `.lane-label`, `.lane-track`, `.lane-bar`, `.lane-meta`), plus a `--label-w` override in the existing `max-width: 900px` block. No new custom property and no new colour: bars use `var(--accent)` and `var(--violet)`. |
| `tools/argus-ui/README.md` | "What it shows" gained the **Timeline** bullet after Sessions; the **Events** bullet now reads "filterable event tail". |

### Two places where the code follows the tests over the plan's prose

1. **The axis ticks carry no inline `style`.** The plan describes ticks as
   absolute positions in percent, the waterfall's pattern. Case 13 asserts that
   *every* `style="…"` attribute in the rendered timeline contains both a `left:`
   and a `width:`, which a tick positioned as `style="left:50.000%"` violates. So
   `.timeline-ticks` is a flex row with `justify-content: space-between` and the
   ticks carry no inline style at all; only the lane bars do. Same five
   fractions, same `fmtClock` labels, same look.
2. **`renderTimeline` takes the flat result of `buildLanes`.** The plan's prose
   writes the signature as `renderTimeline({ window, lanes })` while `buildLanes`
   returns a flat `{ startMs, endMs, durationMs, lanes }` and both the plan's own
   wiring line and cases 13/16 compose them directly — the looseness the
   test-author reported. The implementation takes the flat shape and derives the
   window from it internally; `laneGeometry` keeps its documented
   `(lane, window)` signature, and the `window` it is passed is
   `{ startMs, endMs }`.

Also worth the reviewer's eye: `laneGeometry` clamps `leftPct` to 0…100 and caps
`widthPct` at `Math.max(0.6, 100 - leftPct)`, exactly as the plan specifies. That
leaves one reachable overflow the plan accepts by construction — a zero-length
lane starting exactly at the window end gets `leftPct === 100` and
`widthPct === 0.6`, so the bar runs 0.6% past its track. I implemented the plan
as written rather than adding an unplanned clamp; case 11 does not reach it.

### Commands run

- `npm --prefix tools/argus-ui test` (baseline, before any edit) — 18 tests, 13
  pass, 5 fail, exit 1.
- `npm --prefix tools/argus-ui test` (after the change) — 34 tests, 34 pass, 0
  fail, exit 0. That is the whole of this increment's list.
- `node --check` on a `.mjs` copy of `public/app.js` — a parse check only, since
  no suite loads that file as a module; exit 0.

`tools/argus` and `./test.sh` were not run: the plan puts both off this
increment's list, and nothing outside `tools/argus-ui` changed.

### Notes for the reviewer, acted on nowhere

1. **The 15s repaint interval no longer repaints anything on the landing view.**
   `boot()` ends with `setInterval(… if (state.session && state.tab === 'overview')
   renderTabBody(), 15_000)`, so with `state.tab === null` a session left open on
   its timeline gets no periodic repaint of the detail pane; the SSE `ingest`
   event still triggers a full `refresh()` whenever telemetry arrives, which is
   how the lanes grow. The plan does not mention the interval and I did not
   touch it.
2. **`loadTimeline()` runs on every refresh, for every session, tab or no tab.**
   That is what the plan's wiring specifies (the timeline is never hidden, so its
   data is never optional). It costs one `/api/content` request per refresh cycle.
3. **Nothing pins the arrangement inside `renderDetail`** — that the timeline
   sits above the nav, that `state.tab` starts `null`, that the click handler
   toggles. The plan lists all three as deliberately untested for want of a DOM
   harness, so they are a reading, and this is the round where they get read.
4. **No blocking question.** Every fact the increment needed was in
   `researcher.md`.
