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
