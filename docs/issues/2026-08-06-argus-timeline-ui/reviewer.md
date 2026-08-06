# Review — argus session timeline UI

## Round 0

**Status: 1 finding requiring correction.** The suite is red, and the red case
is one this change added.

### Commands run

- `bash test.sh` — all five suites, exit 1.
  - `the repository itself` — PASS, 10 cases.
  - `parallel runs: worktrees` — PASS, 4 cases.
  - `tools/argus` — 163 cases, 162 pass, **1 fail**.
  - `tools/argus-ui` — 14 cases, exit 0.
  - `tools/log-parser` — 23 cases, exit 0.
  - Nothing skipped or excluded. No run at the merge base was needed: the
    failing case is new in this diff (`git diff main -- tools/argus/test/server.test.mjs`),
    so the red cannot pre-date the change.

### Finding 1 — `bash test.sh` exits 1; the new `/api/events` body case can never pass

Criterion missed: **"`./test.sh` is green."** It also leaves criterion 2
("content-bearing records are exposed over the JSON API like the existing
signals") without a working check, because the case meant to verify it fails
for a reason unrelated to the behaviour.

Reproduction (no new file needed; the case is in the tree):

1. `bash test.sh`.
2. `tools/argus` reports
   `not ok 97 - a claude_code.api_request_body record is exposed over /api/events with its body attribute intact`,
   `tools/argus/test/server.test.mjs:404`, failing at line 416 with
   `the body attribute must survive the round trip, untruncated`.

Why it fails, and why no production change can fix it: the case builds
`bodyText = JSON.stringify({ system: 'hi', messages: [] })`, i.e. the literal
`{"system":"hi","messages":[]}`, and then asserts
`JSON.stringify(events.items[0]).includes(bodyText)`. In the serialized item
the attribute appears as a JSON string, with every inner quote escaped —
`"body":"{\"system\":\"hi\",\"messages\":[]}"` — so the unescaped literal is
never a substring of it. The assertion is unsatisfiable for any body text
containing a `"` character, which every Messages API body does.

The behaviour under test is in fact correct: nothing in `tools/argus/src/`
truncates or strips an attribute (`rg 'truncat|substring'` finds only comments
and the protobuf reader), `#applyLog` only reads `attrs.body` for the content
budget (`tools/argus/src/store.mjs:495`), and `/api/events` spreads the record
including `attrs` (`tools/argus/src/server.mjs:247-253`). So the correction
belongs in the test, not in the collector.

Spec for the corrected case (for the test-author; I wrote no test):

- Ingest the same `claude_code.api_request_body` record and read
  `/api/events?event=claude_code.api_request_body`.
- Assert on the value rather than on the serialized haystack:
  `events.items[0].attrs.body` **equals** `bodyText` — an equality that also
  pins "untruncated", since a cut body would differ in length.
- Keep an oversized-body edge if the untruncated claim is to be pinned harder:
  a body well past the 61 440-unit CLI default (e.g. 200 000 characters) must
  come back with `attrs.body.length === 200000`, which is the property the
  criterion actually cares about and which the current small fixture would not
  have caught either way.

### Criteria walked, one by one

- **1 — `argus env` carries the content flags in both formats.** Met.
  `otelEnvFor` sets `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_TOOL_DETAILS`,
  `OTEL_LOG_TOOL_CONTENT`, `OTEL_LOG_RAW_API_BODIES` and
  `CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH` outside the `traces` branch
  (`tools/argus/src/claude.mjs:283-306`). Tested twice at the unit level
  (`claude.test.mjs`, including with `traces: false`) and once end to end
  through the CLI for `shell` and `json` (`config.test.mjs`). `dotenv` and
  `settings` are not asserted, but `renderEnv` serializes the same object for
  every format, so a break there could not hit one format alone. I cannot
  verify the flag *names* against the CLI's documentation from inside the
  repository; that verification was the researcher's, and I take it as given.
- **2 — collector stores and serves the content.** Met in the code; the one
  case that verifies the exposure is Finding 1. `GET /api/sessions/:id/timeline`
  and `GET /api/sessions/:id/context` exist (`server.mjs:211-229`), and the
  store keeps the raw record with its `body`.
- **3 — opening a session lands on the timeline, technical views subordinate.**
  Met in the code: `state.technicalTab` starts `null`, `renderTabBody` paints
  nothing while it is, the timeline is rendered above the tab strip, and
  clicking the open tab closes it again (`app.js:233-292, 1276-1284`). No
  automated test — see "The tests" below.
- **4 — one lane for the main session, one per subagent, each spanning its
  lifetime.** Met, and well covered store-side: own lane per `query_source`,
  the `llm_request` bridge from `agent_id`, an orphan `agent_id` given its own
  lane instead of being folded into main, and a lane bracketing only its own
  records.
- **5 — activity plus a context curve per lane.** Met. Activity blocks come
  from `claude_code.tool` and `claude_code.llm_request` spans, the curve from
  the input+cache token sum of `api_request` events (output deliberately
  excluded, tested). The curve is drawn as a filled polygon against the maximum
  over all lanes (`app.js:286-300`), so lanes stay comparable.
- **6 — scrub anywhere, live mode, leaving and returning to it.** Met in the
  code: the range input spans `firstMs..lastMs`, `input` sets `live = false`
  and debounces the slice fetch, the `Live` button restores `live` and jumps to
  `lastMs`, and `loadTimeline` re-pins `atMs` to the head while live
  (`app.js:352-372, 1097-1108, 1259-1273, 1319-1338`). No automated test.
- **7 — selecting a lane shows the nearest request body at or before the
  moment, as a structured, collapsed, expandable block list.** Met.
  `getContextAt` picks the newest body at or before `atMs` within the lane
  (tested, including the empty slice and the per-lane isolation), `context.mjs`
  turns the body into ordered blocks with sizes (tested: system array, tools,
  tool_use/tool_result, thinking passed through, images never inlined but
  charged their real size, truncated body kept verbatim as one raw block), and
  the UI renders one line per block with a `<pre hidden>` toggled on click.
- **8 — tools used up to that moment, with parameters, per lane.** Met and
  tested: `tool_result` events joined to a lane through the tool span's
  `tool_use_id`, cut at `atMs`, ascending, with `toolParametersOf` parameters;
  the no-span case falls to the main lane, as documented.
- **9 — no fallback or test for flagless recordings.** Held. Nothing in the
  diff renders a compatibility path, and no case pins behaviour for a recording
  without the flags. The "no spans recorded" notice in the timeline is about
  `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA`, which `argus env` sets, not about the
  content flags.
- **10 — `./test.sh` green.** **Not met.** Finding 1.

### The tests against the intent

Store, context-parsing, config and env behaviour are covered case by case and
the cases assert the asked-for behaviour rather than the shape of the code:
lane attribution, the token sum that excludes output, the open-span end, the
content budget evicting oldest-first while the newest body stays queryable and
the aggregates survive, and every documented degradation (no spans → main lane,
orphan `tool_use_id` → main lane).

Criteria 3, 6 and the rendering halves of 5 and 7 have no test that would fail
if the behaviour broke. I record that as an observation and not as a finding:
those behaviours live in `tools/argus-ui/public/app.js`, which is browser code
against a live DOM; `tools/argus-ui/CLAUDE.md` forbids adding a dependency
without asking the human, so no DOM harness exists, and `public/app.js` has
never been under test in this project. Checking them with string assertions
over the source would pin the implementation rather than the behaviour, which
is worse than the gap. If the human wants the timeline's landing state and the
scrub/live transitions pinned, that needs a decision about a DOM harness first
— that is a question for the human, not a correction for this round.

### Beyond the criteria — blast radius

Traced, and nothing further found:

- **The interface reaches the new routes without a change.**
  `tools/argus-ui/src/server.mjs:52` proxies every path under `/api/` and
  `/v1/`, so `…/timeline` and `…/context` pass through unmodified.
- **`/api/config` now advertises the content flags too** (`server.mjs:180`
  calls the same `otelEnvFor`), which is the copy block the UI shows — that is
  consistent with criterion 1, not a leak of scope.
- **Persistence.** With the flags on by default and `--persist` the default,
  bodies land on disk. `JsonlPersistence` rotates at `persistMaxBytes` instead
  of dropping (`src/persist.mjs:126`) and the measurement root writes its own
  `.gitignore` of `*` (`src/persist.mjs:36`), so the README's claim holds.
- **Store bookkeeping.** `contentBytes` is recomputed from scratch after every
  removal path — count trim, content eviction, session eviction — and reset in
  `clear()`; I found no path that leaves it stale.
- **Documentation.** `tools/argus/README.md` "Sensitive data" is rewritten to
  say the flags are now on, and `skills/argus/SKILL.md` points at it. I found
  no other page still claiming argus records structure only.

### Observations that need no correction

- `tools/argus/README.md:421-424` still attributes prompt and answer flow to
  `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA`. That wording pre-dates this change and
  was already imprecise (prompts follow `OTEL_LOG_USER_PROMPTS`); the paragraph
  points at "Sensitive data", which is now correct.
- `--max-content-bytes` / `UROBOROS_OBS_MAX_CONTENT_BYTES` is user-facing
  surface no criterion asked for. It is the memory bound that storing 1 MB
  bodies by default requires, and it is documented in the README table and the
  `--help` block, so I do not treat it as scope creep.
- The `compact` "auxiliary" lane is a lane kind beyond "main plus one per
  subagent". Charging compaction to the main lane would misattribute it, so
  this serves criterion 4 rather than exceeding it.
- Expanded context blocks collapse again on the next SSE-driven repaint, since
  `renderDetail` rebuilds the panel's markup. It only bites while live, where
  the context is changing anyway, and scrubbing — the state in which a reader
  studies a block — leaves live mode. Noted, not a finding.
- `.slice-context` and `.slice-tools` have no CSS rules of their own; they are
  plain containers inside the styled `.slice` grid. Every other class the
  timeline markup uses has rules in `public/styles.css`.

## Round 1

**Status: 4 findings requiring correction.** The suite is green. The findings
are in the timeline's live/scrub control (criterion 6), in the absence of any
check for criteria 3 and 6, and in two claims the new documentation makes.

### Commands run

- `bash test.sh` — all five suites, **exit 0**.
  - `the repository itself` — PASS, 10 cases.
  - `parallel runs: worktrees` — PASS, 4 cases.
  - `tools/argus` — 164 cases, 164 pass, 0 fail, 0 skipped.
  - `tools/argus-ui` — 14 cases, 0 fail, 0 skipped.
  - `tools/log-parser` — 23 cases, 0 fail, 0 skipped.
  - Nothing skipped or excluded, no merge-base run needed (nothing is red).

Round 0's Finding 1 is gone: `tools/argus/test/server.test.mjs:404-421` now
asserts `events.items[0].attrs.body === bodyText` instead of a substring of the
serialized item, and an oversized-body case (200 000 characters, `server.test.mjs:423-445`)
pins the untruncated claim. Both pass.

### Finding 1 — the `Live` control lies after a scrub, and a live refresh tears the scrubber out from under the pointer

Criterion missed: **"The timeline can be scrubbed backward and forward to any
point of the recorded session, and offers a live mode that follows the newest
data as it arrives; scrubbing away from the head leaves live mode, and a
control returns to it."**

One cause: the scrub handler repaints everything about the scrub row *except*
the control that shows the mode, while the SSE refresh path repaints
everything including the input being dragged.

Reproduction A — the control claims live mode after live mode was left
(a session that has stopped emitting, i.e. the ordinary "scrub back through a
finished run"):

1. Open a finished session in the argus UI. `state.live` is `true`, so
   `renderTimeline` writes `<button class="scrub-live" data-live aria-pressed="true">Live</button>`
   (`tools/argus-ui/public/app.js:363`), which `styles.css` paints with the
   accent border and background (`.scrub-live[aria-pressed="true"]`).
2. Drag the scrubber. The `input` handler
   (`tools/argus-ui/public/app.js:1319-1338`) sets `state.live = false` and then
   updates only `.lane-playhead`, `.scrub-clock` and — debounced — `#slice-panel`
   via `paintSlice()`. It never touches the button.
3. No further telemetry arrives, so no `ingest` SSE event fires, so
   `scheduleRefresh` (`app.js:1225-1231`) never runs and `renderDetail`
   (`app.js:1174`) is never called again.
4. Result: live mode is off, and the only control that says so still reads
   `aria-pressed="true"` and stays visually engaged, indefinitely. The user
   gets no signal that they left live mode, and the control that returns to it
   is indistinguishable from the state it would return from.

Reproduction B — the same repaint asymmetry the other way round, on a session
that *is* emitting:

1. Open a session of a running agent. `argus env` sets
   `OTEL_LOGS_EXPORT_INTERVAL=1000` and `OTEL_METRIC_EXPORT_INTERVAL=1000`
   (`tools/argus/src/claude.mjs:322-327`), so the collector emits an `ingest`
   SSE event roughly once a second.
2. Press and hold the scrubber thumb and drag.
3. Each `ingest` calls `scheduleRefresh()` → `refresh()` → `renderDetail()`,
   which assigns `detail.innerHTML = …` wholesale (`app.js:218`). That destroys
   and recreates `#timeline-scrub` under the pointer; the element's implicit
   pointer capture dies with it and the thumb stops following the mouse.
   `refresh()` restores focus by id (`app.js:1177-1185`), which restores
   keyboard arrows but cannot restore a mouse drag.
4. Result: on a live session the drag is interrupted about once a second, which
   is exactly the situation the criterion pairs scrubbing with. The code's own
   comment says this must not happen — `app.js:408-410`: "Scrubbing must not
   replace the range input it is being dragged with, so a scrub never
   re-renders the whole detail pane." The scrub path honours it; the refresh
   path does not.

What a correction has to achieve (not how): after a scrub, the `Live` control
must show that live mode is off, and a refresh arriving while the session is
being scrubbed must not replace the range input.

### Finding 2 — criteria 3 and 6 have no check that would fail if they broke

Criteria missed as *verifiable* behaviour: **"Opening a session in the argus UI
lands on the timeline view"** (3) and the whole of criterion 6 (scrub, live,
leaving and returning). The rendering halves of criteria 5 and 7 are in the
same position.

The gap, concretely: every behaviour named in those criteria lives in
`tools/argus-ui/public/app.js`. `tools/argus-ui/test/` holds exactly
`config.test.mjs`, `server.test.mjs` and `independence.test.mjs`; the only one
that names `public/app.js` is `independence.test.mjs`, and it names it to check
that the file imports nothing outside the project — not what it renders. So
deleting the `renderTimeline()` call from `renderDetail`, or setting
`state.technicalTab` back to `'overview'`, or dropping `state.live = false`
from the scrub handler, all leave `bash test.sh` green. Finding 1 is what that
gap costs: a defect in the one criterion that is pure state transition, shipped
green.

This is not a request for a particular test style or file layout. Either
criterion 6's transitions (open → live at head; scrub → live off, `atMs` at the
scrubbed value; `Live` → live on, `atMs` back at `lastMs`) and criterion 3's
landing state (`technicalTab === null` on a freshly selected session, timeline
rendered) get a check that fails when they break — `tools/argus-ui/CLAUDE.md`
forbids adding a dependency without asking the human, so a DOM library is not
an option and whatever check is built has to be dependency-free — or the
impossibility is put to the human as a question and recorded, which is also an
acceptable resolution of this finding. What is not acceptable is leaving the
two criteria with neither.

### Finding 3 — the README promises behaviour for recordings without the content flags, and the promise is wrong

Criterion missed: **"Recordings made without the content flags are out of
contract: no fallback rendering, no compatibility notice is required, and no
test pins behavior for them"**, with decision 5: "the degradation question was
dropped rather than decided, so nothing may test or promise behavior for that
case."

`tools/argus/README.md:529-531` is such a promise:

> **To record structure without content**, do not export the five flags above —
> set the rest of the block by hand instead of using `argus env`. The timeline
> then draws lanes and activity, and the context panel stays empty; nothing
> else changes.

It is prose no criterion asked for, about the one case the issue put out of
contract. It is also inaccurate on its own terms, which is why it cannot stand
as a harmless aside:

- Without `OTEL_LOG_TOOL_DETAILS=1` the `tool_result` events carry no
  `tool_input`, so `toolParametersOf` returns `null`
  (`tools/argus/src/claude.mjs:83-99`) and the "Tools used up to here" panel —
  criterion 8's half of the slice — shows tool names with an empty Parameters
  column. That is not "the context panel stays empty".
- The implementer's own note at `tools/argus/src/claude.mjs:289-291` says the
  same flag is what makes `agent.name` arrive under its real value, "without it
  the CLI redacts a user-defined agent's name to `custom`" — so lane labels
  change too (`store.mjs` sets `lane.agentName` from `agent.name`).

So "nothing else changes" contradicts the diff's own documentation of the flag.

### Finding 4 — "reopened with `--open` has it back" is not true for the sessions the timeline is for

No criterion covers persistence; this is blast radius of criterion 1 (the
content flags on by default) landing on a claim this diff introduces.

`tools/argus/README.md:611-615` says the timeline ages out of the raw window
and then:

> A measurement written with `--persist` and reopened with `--open` has it back.

Reproduction: `argus env` now sets `CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH=1048576`
(`claude.mjs:302`), so one `claude_code.api_request_body` record is up to 1 MB
and `api_response_body` adds its own. `JsonlPersistence` rotates `logs.jsonl`
at `persistMaxBytes` (default 64 MB, `src/persist.mjs:23`, `#append` at
`persist.mjs:116-127`), `#rotate` deletes generation 1 before renaming
(`persist.mjs:82-92`), and `#read` replays only generations 1 and 0
(`persist.mjs:98-101`). A session past ~128 MB of log JSONL — a few hundred
model turns, which is what a full uroboros run is — has its earliest bodies
deleted from disk. Reopening that directory with `--open` replays only the
tail, and the beginning of the timeline is gone for good.

Note the sizes point the wrong way: the in-memory content budget is 256 MB
(`config.mjs`, `--max-content-bytes`), the on-disk retention is 64 MB × 2
generations = 128 MB. The documented remedy holds strictly *less* content than
the window it is offered as the remedy for. Either the sentence stops promising
recovery unconditionally, or the disk retention has to cover what memory holds.

### Criteria walked, one by one

- **1 — `argus env` carries the content flags.** Met. `otelEnvFor`
  (`claude.mjs:283-306`) sets `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_TOOL_DETAILS`,
  `OTEL_LOG_TOOL_CONTENT`, `OTEL_LOG_RAW_API_BODIES` and
  `CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH` outside the `traces` branch, so
  `--traces false` keeps them (tested). `config.test.mjs` runs the real binary
  for `shell` and `json`; `dotenv` and `settings` go through the same `env`
  object in `renderEnv` (`bin/argus.mjs:81-98`), so no format can lose a key
  alone. I cannot check the flag *names* against the CLI's documentation from
  inside the repository; that verification was the researcher's.
- **2 — collector stores and serves the content.** Met and now tested:
  `/api/events` returns `attrs.body` byte-for-byte, small and at 200 000
  characters, and `/api/sessions/:id/{timeline,context}` answer 200 with lanes
  and parsed blocks and 404 for an unknown session.
- **3 — opening a session lands on the timeline; technical views subordinate.**
  Met in the code (`app.js:236-252`, `renderTabBody` returning early on a null
  `technicalTab`, `selectSession` resetting it, clicking the open tab closing
  it). Unverifiable by any test — Finding 2.
- **4 — one lane for main, one per subagent, spanning its lifetime.** Met, and
  covered store-side: own lane per `query_source`, the `llm_request` bridge from
  `agent_id`, an orphan `agent_id` given its own lane, a lane bracketing only
  its own records, single-lane session, unknown session → null.
- **5 — activity plus a context curve per lane.** Met. The data half is tested
  (tool/llm activity blocks with kind and label, open span not ending before it
  starts, the input+cache token sum excluding output, ascending samples,
  `maxContextTokens`). The drawing half (`laneCurve`, `renderTimeline`) has no
  test — part of Finding 2's gap.
- **6 — scrub, live, leaving and returning.** **Not met** — Finding 1, and
  unverifiable — Finding 2.
- **7 — the nearest request body at or before the moment, as a structured,
  collapsed, expandable block list.** Met. `getContextAt` picks the newest body
  at or before `atMs` within the lane (tested, including the empty slice and
  per-lane isolation); `context.mjs` produces ordered blocks with sizes (tested:
  system string and array, tool schemas, tool_use/tool_result, thinking passed
  through verbatim, image charged its real size but never inlined, truncated
  body kept as one raw block, `body_ref` reported and never read, empty attrs).
  The rendering (one line per block, `<pre hidden>` toggled) is in the
  Finding 2 gap.
- **8 — tools used up to that moment, with parameters, per lane.** Met and
  tested: `tool_result` joined to a lane through the tool span's `tool_use_id`,
  cut at `atMs`, ascending, parameters from `toolParametersOf`; no-span and
  orphan `tool_use_id` both fall to the main lane.
- **9 — no fallback, notice or test for flagless recordings.** Held in the code
  and the tests; broken in the prose — Finding 3.
- **10 — `./test.sh` green.** Met: exit 0.

### Beyond the criteria — blast radius

- **The interface reaches the new routes unchanged.**
  `tools/argus-ui/src/server.mjs:52` proxies every path under `/api/` and
  `/v1/`, so `…/timeline` and `…/context` pass through.
- **`/api/config` now advertises the content flags**, because it calls the same
  `otelEnvFor`. Consistent with criterion 1.
- **Store bookkeeping.** `contentBytes` is added to on ingest and recomputed
  from scratch on every removal path — count trim, content eviction, session
  eviction — and reset in `clear()`. I found no path that leaves it stale.
  `#recountContentBytes` walks the whole log window, but only when something was
  actually dropped.
- **Persistence volume.** Finding 4.
- **`describeEvent` gained a case for the two body events**, so the event tail
  shows a length rather than a megabyte of JSON. Reasonable, and no other
  caller of `describeEvent` changes shape.
- **`scripts/demo-emit.mjs`** now emits subagent-attributed body events, so
  `npm run demo` still fills the view it is meant to demonstrate. No criterion
  asked for it; without it the demo session would show an empty central view,
  so I do not treat it as scope creep.
- Nothing else found.

### Observations that need no correction

- Expanded context blocks collapse again on the next SSE-driven repaint
  (`renderDetail` rebuilds the panel). Same root cause as Finding 1's
  reproduction B; fixing that one likely fixes this. Not counted separately.
- `tools/argus/README.md:421-424` still attributes prompt and answer flow to
  `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA`. That wording pre-dates this change.
- `--max-content-bytes` / `UROBOROS_OBS_MAX_CONTENT_BYTES` is surface no
  criterion asked for, but it is the memory bound that 1 MB bodies require, and
  it is documented in the README table and `--help`. Not scope creep.
- The `compact` "auxiliary" lane kind goes beyond "main plus one per subagent";
  charging compaction to main would misattribute it, so it serves criterion 4.
- Two subagents of the same name share one lane. Documented in the README as a
  limit of what the CLI exports, which is what the issue's assumption section
  asked for.
