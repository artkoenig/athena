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

## Increment 2 — Round 1

**No file changed. The round's plan asks for no production edit, and I made
none.** `researcher.md`'s Increment 2 — Round 1 section states it twice
("**This round changes no production file.**"; "the implementer's work this
round is to confirm the command below is green and change nothing"), because
the reviewer's finding was a missing guard rather than broken behaviour: the
landing behaviour of criterion 1 was already correct in `public/app.js` and the
correction was three new source-level cases in
`tools/argus-ui/test/page.test.mjs`, which the test-author has already landed.

So my whole work this round was to run the list and confirm it is green.

### The tests are not mine, and I ran them first

Per the test plan, the three cases of this round are regression pins expected to
pass on their first run against the code as it stands. I ran the command before
touching anything, it was green, and there was therefore nothing to implement:
no case failed, so no case demanded a change. I edited no test and wrote none.

### Commands run

- `npm --prefix tools/argus-ui test` (from the repository root; runs
  `node --test "test/*.test.mjs"` over all five files: `config`,
  `independence`, `page`, `server`, `timeline`) — **37 tests, 37 pass, 0 fail,
  0 skipped, 0 todo, exit 0.**

That is the whole list for this round. `tools/argus` and `./test.sh` are off it
by the plan's own decision, and I ran neither. There is no linter and no
formatter in this repository, so nothing else was run.

The count matches the plan's arithmetic exactly: the suite stood at 34 cases at
the reviewer's run, and the test-author's three new `page.test.mjs` cases bring
it to 37. The three are visible in the TAP output as `ok 8 - the page loads with
no technical view open`, `ok 9 - selecting a session returns to the timeline`
and `ok 10 - the timeline is rendered above the technical views`.

`git status --short` is empty apart from this handoff: no production file, no
test file and no configuration file was modified in this round.

### Problems hit

None. Nothing was red before the run, nothing is red after it, and no command
reported a failure or a skip.

### Notes for the reviewer, acted on nowhere

1. **The three notes I filed in Increment 2's handoff still stand**, and this
   round touched none of them: the 15s repaint interval only fires for
   `state.tab === 'overview'` and so no longer repaints the landing view;
   `loadTimeline()` runs on every refresh for every session; and — note 3 —
   nothing pinned the arrangement inside `renderDetail`. Note 3 is precisely
   what this round closes: cases 8–10 now pin the state literal, `selectSession`
   and the call order in `renderDetail` at source level. Notes 1 and 2 remain
   open observations, outside this round's scope.
2. **The test-author's open question about case 2** (`selecting a session
   returns to the timeline`) is a question about the plan's prose, not about the
   code: neither half of the reviewer's named reproduction touches
   `selectSession`, so that case pins a fact no named mutation breaks. It still
   pins fact 2 of the three the plan's "What the finding asks for" section lists,
   and it passes. I changed nothing over it and note it only so the reviewer
   knows it is a known, reported looseness rather than a fresh gap.
3. **No blocking question.** The round's brief was unambiguous: change nothing,
   run one command, report it.

## Increment 3

Built the activity-and-context density on the lanes, exactly as the Increment 3
section of `researcher.md` plans it: four files, no new file, no collector
change, no dependency. `tools/argus` was not opened.

### The tests are not mine, and I ran them first

I ran `npm --prefix tools/argus-ui test` before touching a line. **24 tests, 20
pass, 4 fail, exit 1** — and all four failures were this increment's, for the
reason the test-author predicted:

- `test/timeline.test.mjs` failed to load at all:
  `SyntaxError: The requested module '../public/timeline.js' does not provide an
  export named 'ACTIVITY_BUCKETS'`. That one failure stood for all 21 unit cases
  of the increment, none of which registered individually.
- `test/page.test.mjs`: `not ok 13 - the page asks the collector for the tool
  calls, incrementally`, `not ok 14 - selecting a session forgets the previous
  session's tool calls`, `not ok 15 - the timeline is composed with its density,
  not around it`.

Nothing else was red. I edited no test and wrote none.

### What I changed

**`tools/argus-ui/public/timeline.js`** — the four new constants (`TOOL_EVENT`,
`REQUEST_EVENT`, `ACTIVITY_BUCKETS = 120`, `MIN_CURVE_WIDTH_PCT = 0.6`), the new
pure functions, and a richer `renderTimeline`:

- `laneKeyOf(record)` — the lane-key rule lifted out of `buildLanes`'s body
  unchanged; `buildLanes` now calls it, so the key exists in one place only.
- `contextPoints(records, window, maxBodyLength)` — SVG-coordinate points in
  0…100, `y = 100` throughout when nothing reported a size, so a zero peak never
  divides by zero.
- `areaPolygon(points)` — the polygon closed on the baseline, widened to
  `MIN_CURVE_WIDTH_PCT` and capped at 100 when a lane holds a single request;
  `''` for an empty array, and every number through `toFixed(3)`.
- `activityMarks(items, window)` — one entry per (bucket, kind) over
  `ACTIVITY_BUCKETS` columns, sorted by `leftPct` then `kind`.
- `buildDensity(view, { content, tools })` — returns a new view, leaving its
  argument untouched. Requests are attributed by `laneKeyOf`, tool calls by a
  `spanId → lane.key` map with `'main'` as the fallback, and a key that matches
  no lane is dropped rather than inventing a lane. Each lane gains `context`,
  `activity`, `requests`, `toolCalls`, `peakBodyLength`; the view gains
  `maxBodyLength`.
- `renderTimeline` — the `<svg class="lane-curve">` is written *before* the bar
  inside `.lane-track`, so the curve is literally behind it; `.lane-mark` spans
  follow it; `.lane-meta` carries `data-peak` / `data-requests` / `data-tools`
  plus a title, and prints `<duration> · <fmtNum(peak)>`; a `.timeline-legend`
  row sits above the axis. Every added field is read as `lane.context ?? []`,
  `lane.peakBodyLength ?? 0` and so on, so `renderTimeline(buildLanes(…))` —
  increment 2's call shape — still renders a bare lane with no curve and no
  mark.

**`tools/argus-ui/public/app.js`** — `state` gains `toolMarks: []` and
`toolSeq: 0`; `loadTimeline()` issues its `/api/content` request and an
incremental `/api/events` request for `TOOL_EVENT` in one `Promise.all`, each
with its own `.catch(() => null)` so either failure costs only its own half;
tool items are appended as `{ seq, timeMs, spanId }` and nothing else, raising
`state.toolSeq` to the largest `seq` seen; `selectSession` resets both;
`renderDetail` composes `renderTimeline(buildDensity(buildLanes(…), …))`.

**`tools/argus-ui/public/styles.css`** — `--meta-w: 120px` on `.timeline` (84px
in the ≤900px block), `.timeline-axis` and `.lane` switched from the literal
`64px` to `var(--meta-w)`, `.lane-track` 16px → 26px, `.lane-bar` moved to the
floor of the track (`top: auto; bottom: 0; height: 5px`), and new `.lane-curve`,
`.lane-mark` and `.timeline-legend` rules. No new custom property and no new
colour: the fills are `var(--accent-soft)`, `color-mix(… var(--violet) 20% …)`,
`var(--teal)` and `var(--warn)`, all already defined in both themes.

**`tools/argus-ui/README.md`** — the **Timeline** bullet now says the lanes are
marked where an agent made an API request or called a tool and shaded behind
with the size of the context it was carrying.

`CLAUDE.md` and `test/independence.test.mjs` are untouched, as the plan says:
no new file under `public/`, so there is nothing to add to the guard.

### Commands run

- `npm --prefix tools/argus-ui test` (from the repository root, before any edit;
  `node --test "test/*.test.mjs"` over `config`, `independence`, `page`,
  `server`, `timeline`) — **24 tests, 20 pass, 4 fail, exit 1**, the four listed
  above.
- `node --test tools/argus-ui/test/timeline.test.mjs` (mid-implementation, to
  check the unit half before wiring the page) — **38 tests, 38 pass, exit 0**.
- `node --test tools/argus-ui/test/page.test.mjs` (mid-implementation) —
  **9 tests, 9 pass, exit 0**.
- `npm --prefix tools/argus-ui test` (final) — **61 tests, 61 pass, 0 fail,
  0 skipped, 0 todo, exit 0**.

That single `npm --prefix tools/argus-ui test` is the whole of what counts as
done for this increment. `tools/argus` and `./test.sh` are off the list by the
plan's own decision and I ran neither. There is no linter and no formatter in
this repository, so nothing else was run.

Nothing red is left open: the four failures I started with were this
increment's, and all four are green.

### Problems hit

None that changed the plan. Two details the plan left to the implementer, both
settled the way its own test cases read:

1. **The last vertex of `areaPolygon` when the points are already wide enough.**
   The plan lists the vertices as `x0,100`, every `x,y`, an optional widened
   repeat, then `xEnd,100`, without saying what `xEnd` is when no widening
   happens. I read it as the last point's own `x`, which is what closes a
   two-point area on the baseline under its last point.
2. **The lane meta's visible text.** The plan pins the `data-*` attributes and
   leaves the sentence open; I print `<duration> · <fmtNum(peak)>`, and just the
   duration when a lane has no requests, so the old lane meta is unchanged for a
   bare lane.

### Notes for the reviewer, acted on nowhere

1. **The context curve spans only a lane's requests, not its lane bar.** With
   two requests at 12.5% and 37.5% of the window, the shaded area runs
   12.5…37.5% and the lane bar runs the full lifetime beneath it. That follows
   the plan exactly (points are placed at record times and closed on the
   baseline), but it means a long lane with two early requests shows a short
   hill at its left rather than a curve across its width. Whether that reads as
   intended is a question for the eye, not for `node --test`.
2. **`state.toolMarks` grows for as long as one session stays selected.** The
   watermark makes each refresh cheap, but the array is only ever cleared by
   `selectSession`; a session left open for hours accumulates one small object
   per tool call. The plan chose this and the entries are three fields each, so
   it is bounded in practice — recorded, not changed.
3. **The two notes I filed in Increment 2's handoff still stand.** The 15s
   repaint interval only fires for `state.tab === 'overview'` and so still never
   repaints the landing view, and `loadTimeline()` still runs on every refresh
   for every session — now with a second request alongside the first, though the
   `sinceSeq` watermark is what keeps that one cheap. Both are outside this
   increment's criteria.
4. **The test-author reported no gap in this increment's plan**, and I found
   none either: every expected value in the 21 unit cases followed from the
   plan's own formulas.

## Increment 3 — Round 1

Built the one finding's fix and nothing else: `loadTimeline` no longer writes a
fetch answer into page state without checking that the session it asked for is
still selected, and the tool-mark accumulation moved out of it into a pure,
de-duplicating `mergeToolMarks` in `public/timeline.js`.

### Tests first

Ran the list before touching a production file, and it failed exactly where the
test-author's handoff said it would:

- `npm --prefix tools/argus-ui test` — 27 top-level tests, 23 pass, 4 fail,
  exit 1. The four: `test/timeline.test.mjs` as a whole
  (`SyntaxError: The requested module '../public/timeline.js' does not provide an
  export named 'mergeToolMarks'`, which is cases 1–9 plus every pre-existing case
  in that file), and cases 10, 11 and 12 in `test/page.test.mjs` (no guard, no
  `mergeToolMarks(` call, no `mergeToolMarks` in the `./timeline.js` import).

That is red for the absence the finding names, not for a mistake in a test. I
edited no test and wrote none.

### What changed

**`tools/argus-ui/public/timeline.js`** — two edits.

1. New exported `mergeToolMarks(marks, items)`, placed after `buildDensity` and
   before `renderTimeline`, byte-identical to the plan's snippet including its
   doc comment. It keeps only `{ seq, timeMs, spanId }`, drops an item without a
   finite `seq`, de-duplicates by `seq`, returns the highest `seq` *held* as the
   watermark, and copies rather than mutating its input.
2. The module header comment now names `GET /api/events` alongside
   `GET /api/sessions/<id>` and `GET /api/content`, as the plan asks.

**`tools/argus-ui/public/app.js`** — three edits.

1. The `./timeline.js` import gains `mergeToolMarks`. The line went multi-line
   because it passed the file's width; the names are otherwise unchanged.
2. `loadTimeline` gains the guard after the two awaited fetches and delegates
   the accumulation:
   ```js
   if (state.selectedSessionId !== id) return;
   state.content = content?.items ?? [];
   const merged = mergeToolMarks(state.toolMarks, tools?.items ?? []);
   state.toolMarks = merged.marks;
   state.toolSeq = merged.seq;
   ```
   The two parallel fetches, the `sinceSeq` argument and the per-half `.catch`
   are untouched.
3. The no-session early return calls a new one-line-bodied
   `clearTimelineIndexes()` declared just above `loadTimeline`, instead of
   resetting the three fields inline. This is the one edit the plan did not ask
   for; see the note below for why it was needed.

`selectSession`, `renderDetail`, `styles.css`, `README.md` and everything under
`tools/argus` are untouched, as the plan requires.

### Commands run

- `npm --prefix tools/argus-ui test` (baseline, before any change) — 27
  top-level tests, 23 pass, 4 fail, exit 1.
- `npm --prefix tools/argus-ui test` (after the `timeline.js` and first two
  `app.js` edits) — 73 tests, 72 pass, 1 fail, exit 1. The one failure was case
  10, on `'the guard must come before state is written'`.
- `npm --prefix tools/argus-ui test` (final) — 73 tests, 73 pass, 0 fail,
  exit 0. Nothing skipped, nothing excluded.

That single command is the whole of what counts as done for this round.
`tools/argus` and `./test.sh` were not run: the plan puts both off the list.

### The one deviation from the plan, and why

Case 10 asserts
`loadTimeline.indexOf('await') < search(/state\.selectedSessionId\s*!==\s*id/) < indexOf('state.content =')`.
`indexOf` finds the *first* `state.content =` in the function, and the
pre-existing no-session early return — untouched by the plan — opens with
`state.content = [];` before the awaits. So with the plan's implementation
applied literally, case 10 stayed red on its ordering assertion while the guard
itself was in place: the plan's own prose did not account for that earlier
occurrence.

I could reach the case's intent without weakening anything, so I did rather than
leave it red: the three-field reset moved into `clearTimelineIndexes()` above
`loadTimeline`, so the only `state.content =` inside `loadTimeline` is the write
of the answer, which the guard now precedes. Behaviour is identical — the same
three fields are reset on the same branch — and the assertion now means what it
says: no fetch answer reaches page state before the guard has run.

Reviewer's call whether the extraction belongs in `app.js` or whether the case
should have compared against the post-await write instead. I did not edit the
test either way.

### Notes for the reviewer, acted on nowhere

1. **The guard drops a same-session answer only in the case that cannot arise.**
   `state.selectedSessionId !== id` lets two overlapping refreshes for one
   session both land, which is deliberate per the plan — `mergeToolMarks` makes
   that harmless — but it also means the *older* of two same-session answers can
   overwrite `state.content` with a staler list. `state.content` is a full
   re-fetch each time, not an accumulation, so the next refresh (at most one SSE
   tick away) corrects it. The plan weighed and rejected a request token; I did
   not revisit that.
2. **`state.toolSeq` can now go backwards.** Deriving the watermark from what is
   held means dropping every mark (only `selectSession` does that) resets it to
   0, which is the property that makes the fix self-healing. Worth knowing when
   reading the collector-side `sinceSeq` contract, which the plan states returns
   only strictly greater seqs.
3. **Earlier rounds' notes still stand** — the 15s repaint interval never
   repainting the landing view, `state.toolMarks` growing while one session
   stays selected, and the context curve spanning a lane's requests rather than
   its bar. All outside this round's finding.
4. **The test-author's handoff reported no gap in this round's plan.** The one I
   hit is the case-10 ordering above; everything else in the plan mapped
   one-to-one onto the code.

## Increment 3 — Round 2

**No file changed.** The plan for this round is explicit that the production
code is correct and that the finding is a missing constraint: it names
`tools/argus-ui/test/timeline.test.mjs` as the only file edited, the four new
cases as the whole of the work, and `public/timeline.js`, `public/app.js`,
`public/styles.css`, `test/page.test.mjs`, both READMEs and everything under
`tools/argus` as untouched. The test-author had already landed those four cases
(commit `50abda0`). So my work this round was to run the list and fix only what
it reported, and it reported nothing.

### What I ran

- `npm --prefix tools/argus-ui test` — 77 cases, 77 pass, 0 fail, 0 skipped,
  exit 0. That is the whole of "what counts as done" for this round.

The four cases this round adds are numbers 74–77 in that run, all green:

| # | Test name | Result |
| --- | --- | --- |
| 74 | `a mark sits at the fraction of the track its moment sits at in the window` | pass |
| 75 | `a later moment always sits strictly right of an earlier one` | pass |
| 76 | `the rendered marks carry the positions their moments earned` | pass |
| 77 | `a mark keeps following its moment when the window does not start at zero` | pass |

The 73 cases the earlier rounds left green are still green; the count rose from
73 to 77 by exactly these four, and none of the pre-existing cases changed
result.

This is the outcome the plan predicted ("they are expected to pass on the first
run — `activityMarks` already computes what they assert"). No case came out red,
so the plan's fallback instruction — compare a red case against the verified
numbers before touching production code — never applied.

Not run, deliberately: `tools/argus`' own suite and `./test.sh`. The plan puts
both off this round's list, and nothing outside `tools/argus-ui/test` changed.

### Problems hit

None. Nothing was blocked, nothing was ambiguous, and no question is open.

### Notes for the reviewer, acted on nowhere

1. **This round produced no code diff, by design.** The only commit that carries
   it is the test-author's, plus this handoff. A reviewer expecting an
   implementation diff should read that as the plan being satisfied, not as work
   skipped: the plan's own "Implementation plan" section says "this round adds
   cases and changes no production file".
2. **Earlier rounds' notes still stand** and none of them is this round's
   finding: the 15s repaint interval never repainting the landing view,
   `state.toolMarks` growing while one session stays selected, the context curve
   spanning a lane's requests rather than its bar, and the two same-session
   overlapping-answer properties recorded in Round 1. All outside this round.
3. **The test-author's handoff reported no gap in this round's plan**, and I
   found none either — the four cases match the plan's case table one to one,
   including the deliberate one-bucket band in case 75 rather than an equality.

## Increment 4

Built the Increment 4 plan of `researcher.md` — the timeline's time cursor and
its live mode — in the four files the plan names, and nothing else. No test file
was opened for editing, no collector file was touched, and no dependency was
added.

### What I changed

**`tools/argus-ui/public/timeline.js`** — three new exported pure functions next
to the existing ones, and a second parameter on the renderer:

- `liveCursor()` returns a fresh `{ live: true, timeMs: null }` per call.
- `scrubCursor(timeMs, window)` returns `{ live: false, timeMs }` with the time
  clamped into `window.startMs`…`window.endMs`; a non-finite time falls back to
  `endMs`. It is `live: false` even for a scrub landing exactly on the head.
- `resolveCursor(cursor, window)` returns `{ live, timeMs, leftPct }` without
  touching its argument. `cursor?.live !== false` is live, so `null`,
  `undefined` and `{}` all resolve live; `leftPct` is `100` when the window has
  zero length, which is what keeps a one-instant session out of a division by
  zero.
- `renderTimeline(view, cursor = null)` resolves the cursor exactly once and
  renders two new blocks from that one result: a `.timeline-scrub` row (the
  `#timeline-cursor-time` readout carrying `data-time`, the
  `#timeline-scrub` range whose `min`/`max`/`value` are milliseconds, and the
  `[data-cursor-live]` button carrying `aria-pressed`), and a
  `.timeline-lanes` wrapper holding a `.timeline-cursor` overlay of two
  `[data-cursor-pos]` spans above the unchanged lane rows.

**`tools/argus-ui/public/app.js`** — `resolveCursor`, `scrubCursor` and
`liveCursor` join the `./timeline.js` import list; `state.cursor: { live: true,
timeMs: null }` sits next to `toolMarks`; `renderDetail` passes `state.cursor`
as the renderer's second argument; `selectSession` resets
`state.cursor = liveCursor()`; new top-level `paintCursor()` and
`scrubTo(input)` write the position straight into the DOM rather than
re-rendering; a module-level `scrubbing` flag is set by a `pointerdown`
listener on `#detail` and cleared by `pointerup`/`pointercancel` on `window`;
`scheduleRefresh` re-schedules itself instead of refreshing while `scrubbing`;
the delegated `click` handler gains a `[data-cursor-live]` branch that writes a
fresh live cursor and re-renders, and the delegated `input` handler gains a
`#timeline-scrub` branch ahead of its `#event-search` early return.

**`tools/argus-ui/public/styles.css`** — the plan's rules appended to the
timeline block after `.lane-meta`: `.timeline-scrub`, `.scrub-time`, the range
input, `.scrub-live` (with its `aria-pressed="true"` state), `.timeline-lanes`,
`.timeline-cursor`, `.timeline-cursor-line` and `.timeline-ahead`. No new custom
property and no new colour; the `calc()` insets read the `--label-w` /
`--meta-w` the responsive block already overrides.

**`tools/argus-ui/README.md`** — the **Timeline** bullet gains the time cursor,
the live mode, and that scrubbing leaves it and the **Live** control returns to
it.

### Files changed

- `tools/argus-ui/public/timeline.js`
- `tools/argus-ui/public/app.js`
- `tools/argus-ui/public/styles.css`
- `tools/argus-ui/README.md`

### The tests, run before anything was changed

Both files were red for exactly the reason the test plan and the test-author's
handoff predicted, and neither is mine to edit:

- `node --test tools/argus-ui/test/timeline.test.mjs` — the file failed to load,
  exit 1: `SyntaxError: The requested module '../public/timeline.js' does not
  provide an export named 'liveCursor'`. That one failure stood for all of the
  file's cases, the 18 new ones included.
- `node --test tools/argus-ui/test/page.test.mjs` — 20 tests, 12 pass, 8 fail,
  exit 1. The eight are cases 19–26 of the plan (the state literal's `cursor`,
  `renderDetail`'s second argument, `selectSession`'s reset, `scrubTo`,
  `paintCursor`, the live control in `wireEvents`, `scheduleRefresh`'s
  `scrubbing` guard, and the three cursor imports).

### Commands run after the change

- `node --test tools/argus-ui/test/timeline.test.mjs` — 69 tests, 69 pass,
  0 fail, exit 0.
- `node --test tools/argus-ui/test/page.test.mjs` — 20 tests, 20 pass, 0 fail,
  exit 0.
- **`npm --prefix tools/argus-ui test`** — the whole list of what counts as
  done: 103 tests, 103 pass, 0 fail, exit 0. Nothing skipped, nothing excluded.

Not run, deliberately: `npm --prefix tools/argus test` and `./test.sh`. Neither
is on this increment's list, nothing outside `tools/argus-ui` changed, and the
closing increment owns the full-suite run. There is no linter and no formatter
in this repository.

### Problems hit

None, and no question is blocking. Three notes for the reviewer:

1. **The plan's markup is followed to the attribute, because the cases read it
   by regex.** `id="timeline-cursor-time"` precedes `data-time=`,
   `data-cursor-pos` precedes its `style=`, and `data-cursor-live` precedes
   `aria-pressed=`; each element is emitted on one line so the `[^>]*` gaps in
   `timeline.test.mjs` cannot straddle a `>`. Reordering those attributes is
   correct code that turns cases 15–18 red, so it needs the test-author, not an
   edit here.
2. **The `esc()` around the numeric interpolations is the file's convention, not
   a safety need** — `active.timeMs`, `window.startMs` and `active.live` are a
   number and a boolean. I kept `esc()` for consistency with every other
   interpolation in `renderTimeline`; the plan's own snippet writes the
   percentages through `.toFixed(3)` and everything else through `esc`, which is
   what I did.
3. **`scheduleRefresh` re-schedules with the same delay while a drag is in
   flight**, exactly as the plan's snippet has it, so a very long drag costs one
   400 ms timer per 400 ms. That is the plan's accepted consequence ("the page
   stops refreshing for the drag's duration"), and case 25 pins only that the
   guard exists — nothing observes the deferral itself.

Outside this increment's scope, noticed and left alone: the drag, the thumb
alignment and the dimming are untestable in this project (no DOM harness, zero
dependencies) and are the review's to judge on screen; nothing here anticipates
increments 5 and 6, and no case pins them.

## Increment 4 — Round 1

No production file changed this round, and none needed to. The Round 1 plan
states it outright ("**No production file changes in this round.**"): the
reviewer's finding was a coverage hole, not a behaviour defect, so the correction
is the three new cases the test-author already wrote, and the implementer's work
is to run the list and fix only what it reports. It reported nothing.

### What I changed

Nothing but this handoff. `tools/argus-ui/public/app.js`,
`public/timeline.js`, `public/styles.css`, `public/index.html` and
`tools/argus-ui/README.md` are byte-identical to the state the test-author's
commit left them in — the plan names all five as staying exactly as they are, and
the wiring the finding is about (the `#detail` `input` listener routing
`#timeline-scrub` to `scrubTo`, the `#detail` `pointerdown` listener setting
`scrubbing`, and the `window` `pointerup`/`pointercancel` loop clearing it) is
already correct.

### Running the tests first, as the brief requires

The plan's "What is already red" section predicts nothing red before the change
and nothing red after it, and predicts the suite growing from 103 to 106 cases.
Measured, that is exactly what the suite does. The three cases this round is
about are green on the code as it stands, which is the intended outcome and not a
skipped correction:

| # | Case | Result |
| --- | --- | --- |
| 1 | `the scrub control's input reaches the scrub` | `ok 27`, passes |
| 2 | `a drag is registered before the next refresh can fire` | `ok 28`, passes |
| 3 | `releasing the pointer lets refreshes resume` | `ok 29`, passes |

I did not apply the plan's named deletions to check the cases are sensitive to
them. The plan says of those deletions "do not perform those deletions, and do not
touch `app.js`", and the test-author already measured each one (deleting the
`input` listener's `timeline-scrub` branch turns case 1 red; deleting the
`pointerdown` listener with the `pointerup`/`pointercancel` loop turns cases 2 and
3 red).

### Commands run

The plan's "What counts as done" list is one command, and it is the only command
I ran.

- `npm --prefix tools/argus-ui test` (`node --test "test/*.test.mjs"`, from the
  repository root) — **106 tests, 106 pass, 0 fail, 0 skipped, 0 todo, exit 0**.
  It covers every file in `tools/argus-ui/test/`: `page.test.mjs` (including the
  three new cases above), `timeline.test.mjs`, `server.test.mjs`,
  `config.test.mjs` and `independence.test.mjs`. Nothing was excluded and nothing
  was skipped.

Deliberately not run, because the plan puts them off the list: `./test.sh` (the
closing increment owns the full-suite run) and `tools/argus`' own suite (nothing
outside `tools/argus-ui` is touched by this round). No linter and no formatter
exist in this repository, so there is none to run.

### Problems hit

None, and no question is blocking. Two notes for the reviewer, neither acted on:

- **This round's commit carries no code.** The only tracked file it changes is
  this handoff, because the test-author's commit `3953c3e` already landed the
  three cases and the helper, and the plan forbids any production edit. If the
  reviewer expected a code diff to review, the thing to review is that commit
  plus the fact that the suite is green at 106 without one.
- **Outside this round's scope, noticed and left alone:** the reviewer's second
  item — an in-flight `refresh()` that can still replace the slider mid-drag —
  is recorded in the plan as an observation and explicitly not a finding ("**No
  action, no test, no code change for it.** Do not widen the guard"). I widened
  nothing and wrote nothing for it.

## Increment 5

Built the Increment 5 plan of `researcher.md` — selecting a lane at a time shows
that agent's context as a message list. One new module, three edited files and
one README sentence, all in `tools/argus-ui`; nothing in `tools/argus` changes,
as finding 5 of the plan established. The suite named in "What counts as done"
is green.

### The tests came first, and they are not mine

I ran the plan's one command before touching anything and reproduced the
test-author's baseline exactly: `npm --prefix tools/argus-ui test` — **126 tests,
105 pass, 21 fail, exit 1**. The 21 reds were the ones their handoff itemises:
`context.test.mjs` failing to load whole (`ERR_MODULE_NOT_FOUND` for
`public/context.js`, standing in for its 29 cases), 2 in `timeline.test.mjs` (a
lane row is a `<div>`, no `aria-current`), 16 in `page.test.mjs` (every Increment
5 wiring case), and 2 in `independence.test.mjs` (`public/context.js` is
missing). Every one failed because the behaviour did not exist yet. I wrote no
test and edited no test file.

### What I changed

| File | Change |
| --- | --- |
| `tools/argus-ui/public/context.js` | **New.** `contextBlocks(body)` and `renderContextPanel({lane,item,pending,expanded})`, plus an exported `PREVIEW_CHARS`. Pure: it imports `esc`, `fmtClock`, `fmtNum` and `shortId` from `./format.js` and touches no `document`, `fetch` or `location`. |
| `tools/argus-ui/public/timeline.js` | `renderTimeline(view, cursor = null, selectedKey = null)` — a third optional parameter; the lane row is now `<button type="button" class="lane" … aria-current="…">` with its three children byte-identical. Nothing else in the module changed. |
| `tools/argus-ui/public/app.js` | The selection mechanism: `renderContextPanel` imported from `./context.js`; `selectedLane`, `laneContext` and `expanded` added to the state literal; new `laneView`, `clearLaneContext`, `loadLaneContext`, `renderLanePanel`, `scheduleLaneContext`; `renderDetail` renders `<div id="lane-panel"></div>` between the timeline and the views, passes `state.selectedLane` to `renderTimeline` and calls `renderLanePanel()`; `refresh` awaits `loadLaneContext()` after `loadTimeline()`; `selectSession` resets all three new keys; `scrubTo` schedules a debounced fetch; the `click` listener gains a lane branch, a `summary[data-block]` branch, and a `loadLaneContext()` in the existing `data-cursor-live` branch. |
| `tools/argus-ui/public/styles.css` | The button reset, `:hover`, `:focus-visible` and `[aria-current="true"]` on `.lane`, and a new `context` section (`.context-panel`, `.context-head`, `.context-title`, `.context-meta`, `.ctx-block`, its `summary`, `.ctx-label` with one colour per kind, `.ctx-preview`, `.ctx-size`, `.ctx-text` with `max-height: 50vh`). No new custom property and no new colour. |
| `tools/argus-ui/README.md` | The **Timeline** bullet gains one sentence about clicking a lane. |

Two places where I had to settle something the plan left open, both recorded
rather than smuggled:

1. **A `system` array entry's payload is `entry.text`, not the entry object.**
   The plan's one-text rule ("string payload verbatim, anything else pretty
   JSON") applied to the wrapper `{type:'text',text,cache_control}` would give
   JSON, but case 3 (`the exact full text survives the parse, unescaped and
   uncut`) requires the block's `text` to be the entry's own text character for
   character. The wrapper carries only a type and a caching hint, neither of
   which is context, so the entry's text is the payload; a comment in
   `context.js` says so.
2. **`loadLaneContext` clears through a helper.** The plan says the no-session /
   no-lane early exit "writes `state.laneContext = { key: null, item: null }`",
   but case 40 takes `indexOf('state.laneContext =')` and requires both staleness
   guards to sit *before* it. An early literal write is the first occurrence and
   turns that case red. The early exit therefore calls `clearLaneContext()`, and
   the only `state.laneContext =` inside `loadLaneContext` is the guarded one.
   Same reason the "lane not in the view" case became `filter = null` instead of
   a second early write: one write site, after both guards.

### Commands run

The plan's "What counts as done" list is one command, and it is the only command
that counts. Both runs below are of that command.

- `npm --prefix tools/argus-ui test` (`node --test "test/*.test.mjs"`, from the
  repository root), **before any change** — 126 tests, 105 pass, 21 fail, 0
  skipped, exit 1. The baseline above.
- `npm --prefix tools/argus-ui test`, **after the change** — **154 tests, 154
  pass, 0 fail, 0 skipped, 0 todo, exit 0**. The count rises by 28 because
  `context.test.mjs` now loads and reports its 29 cases individually instead of
  one module-load failure. Nothing was excluded and nothing was skipped.

Working runs, kept off that list and reported for completeness: `node --test`
on `context.test.mjs`, `timeline.test.mjs`, `page.test.mjs` and
`independence.test.mjs` individually while implementing (all exit 0 at the end),
and `node --input-type=module --check` on `app.js` and `context.js` — a parse
check only, because no test imports `app.js` and a syntax error there would be
invisible to the suite.

Deliberately not run, because the plan puts them off the list: `./test.sh` (the
closing increment owns the full-suite run) and `tools/argus`' own suite (no file
outside `tools/argus-ui` changed). There is no linter and no formatter in this
repository.

### Problems hit

No blocking question. Three notes for the reviewer:

- **Case 17 (`the one line is a one-line preview`) cannot pass under the plan's
  literal preview rule, and I implemented the reading that satisfies it.** The
  plan says the preview is the text "with every run of whitespace collapsed to
  one space, trimmed, cut to 120 characters, with `…` appended when it was cut".
  The case's input is `'a\n\n   b'.repeat(30)` — 210 raw characters, but only 90
  once the whitespace runs collapse, so under the plan's ordering it is never
  cut and never gets the `…` the case asserts. I therefore measure the cut on
  the text itself and flatten what survives it: `text.slice(0, 120)`, whitespace
  collapsed, trimmed, plus `…` when `text.length > 120`. Every one of the case's
  four assertions holds (single line, no double space, at most 121 characters,
  ends with `…`), the result is never longer than the plan's limit, and the
  ellipsis now means what a reader expects it to mean — "the block holds more
  text than this line shows". A comment in `previewOf` states the reasoning. If
  the reviewer prefers the plan's literal ordering, the case has to change with
  it, and that is the test-author's to do, not mine.
- **The two conflicts the test-author flagged needed no action from me.** Case 10
  (`a system given as a plain string still parses`) as written pins only that the
  top-level `system` string yields one block carrying `'be brief'` — which the
  plan's own algorithm does — and case 26 pins `data-truncated="true"` plus the
  raw block still carrying its text, which it does. Neither narrowed case is
  weaker than what I implemented; both would also pass against the plan's
  literal wording.
- **Beyond the criteria, noticed and left alone:** the `<pre class="ctx-text">`
  of every block is written into the DOM on each repaint, so a 70 KB `tools`
  block is serialised whether or not it is expanded. It is correct and bounded
  by the same 2 MB the body itself is, and rendering only expanded blocks would
  change the markup the suite pins (one `<pre>` per block, case 20). Not this
  increment's scope; recorded so nobody has to rediscover it if the panel ever
  feels slow on a very large context.

## Increment 5 — Round 1

Built the Increment 5 — Round 1 plan of `researcher.md`. Two production files
changed, both for finding 2 only: `laneContentQuery` is now a pure, exported
function of `public/context.js`, and `loadLaneContext` in `public/app.js`
delegates to it. Findings 1 and 3 needed no production change — the plan says so
and the suite confirms it. Nothing in `tools/argus` changed and no documentation
changed. The one command in "What counts as done" is green.

### The tests came first, and they are not mine

I ran the plan's one command before touching anything and reproduced the
test-author's baseline exactly: `npm --prefix tools/argus-ui test` — **126 tests,
123 pass, 3 fail, exit 1**. The three reds were the ones their handoff itemises:

- `not ok 2 - test/context.test.mjs` — the whole file fails to load with
  `SyntaxError: The requested module '../public/context.js' does not provide an
  export named 'laneContentQuery'`, standing in for the file's 33 cases (the 29
  round-0 cases, the fixture-updated kind-sequence case, and R1–R7).
- `not ok 31 - app.js takes the context panel from its module` (R9), at
  `test/page.test.mjs:349`, on the assertion message `app.js must import
  laneContentQuery from context.js, so the function the unit cases test is the
  one the page runs`.
- `not ok 37 - the panel asks the collector for the nearest request at the
  cursor's moment, for that lane only` (R8), on the assertion that
  `loadLaneContext`'s source matches `/laneContentQuery\(/`.

Every one failed because the behaviour did not exist yet — a missing export and
a call site that did not call it — never because of a mistake in a test. I wrote
no test and edited no test file; `git status` before my first edit showed the
test files already committed and untouched by me.

### What I changed

| File | Change |
| --- | --- |
| `tools/argus-ui/public/context.js` | New exported `laneContentQuery(lane)` between `contextBlocks` and `renderContextPanel`, with the plan's doc comment verbatim: `null` for a falsy lane, `{ main: '1' }` for `kind === 'main'`, `{ span: lane.spanId }` when a span is present, `{ agent: lane.agent }` when only a name is, and `null` when the lane identifies nothing. The module header's first sentence now describes the whole module — which record a lane asks for, how the body parses into blocks, and how those blocks render. Nothing else in the file moved. |
| `tools/argus-ui/public/app.js` | Line 11 is now `import { laneContentQuery, renderContextPanel } from './context.js';`. Inside `loadLaneContext`, the `const lane = …` line, the three-line comment above the filter and the six-line ternary chain are replaced by the single line `const filter = laneContentQuery(view.lanes.find((entry) => entry.key === key));`. Nothing was put in the comment's place — a comment naming `laneContentQuery` would satisfy R8's source assertion without the code calling anything. Every other line of `loadLaneContext` is byte for byte as it was: the id/key capture, `laneView()`, `resolveCursor(state.cursor, view).timeMs`, the `.catch(() => null)`, both staleness guards and the single `state.laneContext` write, in that order. |

Net diff: 2 files, 28 insertions, 16 deletions. No CSS, no README, no test file,
no file outside `tools/argus-ui/public/`.

Nothing in the plan was left open for me to settle: the function body, its doc
comment, the import line and the replacement line were all given literally, and
I used them as written.

### Commands run

The plan's "What counts as done" list is one command, and it is the only command
that counts. Both runs below are of that command, from the repository root.

- `npm --prefix tools/argus-ui test` (`node --test "test/*.test.mjs"`), **before
  any change** — 126 tests, 123 pass, 3 fail, 0 skipped, 0 todo, exit 1. The
  baseline above.
- `npm --prefix tools/argus-ui test`, **after the change** — **161 tests, 161
  pass, 0 fail, 0 skipped, 0 todo, exit 0**. The count rises by 35 because
  `context.test.mjs` now loads and reports its cases individually instead of one
  module-load failure. Nothing was excluded and nothing was skipped.

Deliberately not run, because the plan puts them off the list: `./test.sh` (the
closing increment owns the full-suite run) and `tools/argus`' own suite (no file
outside `tools/argus-ui` changed). There is no linter and no formatter in this
repository, so there was nothing else to run.

### Problems hit

No blocking question, and nothing red anywhere. Two notes for the reviewer:

- **The plan's prediction that `page.test.mjs:404` goes red mid-change did not
  materialise as a separate event.** It predicted that removing the filter chain
  from `loadLaneContext` would drop `\bmain\b`, `\bspan\b` and `\bagent\b` from
  that function and turn the old case red, with R8 as its replacement. The
  test-author had already landed R8 before I started, so that case was red at my
  baseline for the *new* reason (no `laneContentQuery(` call) and went green with
  the change. The same holds for the kind-sequence case at `context.test.mjs`: the
  fixture change and its updated expected array arrived together in the
  test-author's commit, so it was never red on its own. Both are the plan's
  "red during this round by design", already resolved when I arrived.
- **Beyond the criteria, noticed and left alone:** with the chain gone,
  `loadLaneContext` no longer names any query key in its own source, so a reader
  of `app.js` has to open `context.js` to see what goes on the wire. That is the
  point of the change — the mapping is now pinned by value rather than by prose —
  and R8 forbids putting the explanation back as a comment there. Recorded only
  so nobody reads the missing comment as an oversight. The reviewer's four
  observations (the refetch cadence, the expansion set collapsing when the record
  changes, the wording of the existing case, the impossible `"agent:"` record)
  were left alone as the plan directs; the last is closed by
  `laneContentQuery`'s final `return null`.
