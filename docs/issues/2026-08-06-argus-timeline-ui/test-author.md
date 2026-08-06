# Test-author handoff — a session timeline as the argus UI's central view

## Round 1

All 26 numbered cases from the researcher's test plan are written, in the
files and with the module-level helpers (`log`, `span`, `metric`, `SESSION`,
`NOW`, `withServer`, `tracePayload`, `logsPayloadJson`) the plan named for
reuse. Every new file/test was run with the single-file command the plan
specifies and fails for a missing-behaviour reason (a missing method, a
missing module, a route that 404s, an assertion the not-yet-built feature
can't satisfy) — never an import typo or a syntax error in the test itself.

### AC1 — `argus env` carries the content flags

File `tools/argus/test/claude.test.mjs`, run with
`node --test tools/argus/test/claude.test.mjs`.

- Case 1 → `the env block turns on the content flags: prompts, tool details, tool content, raw bodies, and a raised content limit`. Fails:
  ```
  Expected values to be strictly equal:
  undefined !== '1'
  ```
  (asserting `env.OTEL_LOG_USER_PROMPTS === '1'`, first of the five flags.)
- Case 2 → `the content flags survive with traces off, because they gate log content and not spans`. Same failure shape, against `otelEnvFor(endpoint, { traces: false })`.

File `tools/argus/test/config.test.mjs`, run with
`node --test tools/argus/test/config.test.mjs`.

- Case 3 → `argus env prints the content flags in both the shell and the json format`. Fails:
  ```
  The input did not match the regular expression /export OTEL_LOG_RAW_API_BODIES="1"/. Input:
  'export CLAUDE_CODE_ENABLE_TELEMETRY="1"\n' + ... (no content-flag lines at all)
  ```
  Confirms `--format shell` and `--format json` are both accepted today (the
  command runs and produces output); only the new keys are missing.

### AC2 — content records are stored and served

File `tools/argus/test/server.test.mjs`, run with
`node --test tools/argus/test/server.test.mjs`.

- Case 4 → `a claude_code.api_request_body record is exposed over /api/events with its body attribute intact`. Fails: `the body attribute must survive the round trip, untruncated — content is exposed like any other signal` (assertion `false`). See "Question" below on how this case is written.
- Case 5 → `the timeline route answers with lanes after ingest, and 404 for an unknown session`. Fails: `404 !== 200` on `GET /api/sessions/s-timeline/timeline` — the route does not exist yet, so even the ingested session 404s.
- Case 6 → `the context route answers parsed blocks, 404 for an unknown session, and null context for an empty slice`. Fails: `404 !== 200` on `GET /api/sessions/s-context/context?lane=main&at=...` — same reason.

### AC4 — one lane for the main session, one per subagent

File `tools/argus/test/store.test.mjs`, run with
`node --test tools/argus/test/store.test.mjs`.

- Case 7 → `a subagent identified by query_source and agent_id gets its own lane, bracketing only its own records`. Fails: `store.getTimeline is not a function`.
- Case 8 → `a tool span with agent_id but no query_source lands its activity in the agent lane via the llm_request bridge`. Fails: `store.getTimeline is not a function`.
- Case 9 → `a tool span whose agent_id never appeared on an llm_request span gets its own lane, not the main one`. Fails: `store.getTimeline is not a function`.
- Case 10 → `a query_source of compact produces an auxiliary lane`. Fails: `store.getTimeline is not a function`.
- Case 11 → split into two tests, as the plan's bullet covers two assertions:
  - `a session with only main-session records has exactly one lane`. Fails: `store.getTimeline is not a function`.
  - `an unknown session id resolves to no timeline`. Fails: `store.getTimeline is not a function`.

### AC5 — activity and the context curve

Same file, same command.

- Case 12 → `context samples sum input, cache_read and cache_creation tokens, excluding output, ascending by time`. Fails: `store.getTimeline is not a function`.
- Case 13 → `activity blocks carry kind and label from tool and llm spans, and an open span does not end before it starts`. Fails: `store.getTimeline is not a function`.

### AC7 — the context as of a chosen moment

Same file for cases 14–15; `tools/argus/test/context.test.mjs` (new) for cases 16–22.

- Case 14 → `the context at a chosen moment is the newest body at or before it, per lane`. Fails: `store.getContextAt is not a function`.
- Case 15 → `a body belonging to another lane is never returned for the lane asked for`. Fails: `store.getContextAt is not a function`.

File `tools/argus/test/context.test.mjs`, **new**, run with
`node --test tools/argus/test/context.test.mjs`.

- Cases 16–22 → `a full request body parses into blocks in source order, with role, type, name, toolUseId and chars`; `a system array yields one block per entry`; `a thinking block survives verbatim as type thinking`; `an image block never inlines its payload into text, but chars still reflects the original size`; `a truncated body returns one raw block holding the exact text`; `file mode reports the bodyRef path and never reads the file`; `a body with neither body nor body_ref returns an empty result rather than throwing`. All seven fail together, because the module does not exist yet:
  ```
  Error [ERR_MODULE_NOT_FOUND]: Cannot find module
  '/home/user/uroboros/tools/argus/src/context.mjs' imported from
  '/home/user/uroboros/tools/argus/test/context.test.mjs'
  ```
  This is the whole file's failure reason — every one of the seven cases is
  red for the same, correct cause: `context.mjs` does not exist yet.

### AC8 — the tools an agent used up to that moment

File `tools/argus/test/store.test.mjs`, same command.

- Case 23 → `tool_result events join a subagent lane through their tool span's tool_use_id, ascending and only up to the chosen moment`. Fails: `store.getContextAt is not a function`.
- Case 24 → split into two tests, as the plan's bullet covers two assertions:
  - `a tool_result whose tool_use_id matches no span falls to the main lane`. Fails: `store.getContextAt is not a function`.
  - `a session with no spans at all attributes every tool call to the main lane`. Fails: `store.getTimeline is not a function` (checking `timeline.spansSeen === false` first).

### Memory guard

File `tools/argus/test/store.test.mjs`, same command.

- Case 25 → `ingesting body events past the content budget drops the oldest records while the newest stays queryable and aggregates survive`. Fails: `the budget must have evicted some records` (assertion `false`) — `maxContentBytes` is not wired into `#evict` yet, so nothing is dropped.

File `tools/argus/test/config.test.mjs`, same command.

- Case 26 → `the content budget is read from --max-content-bytes and UROBOROS_OBS_MAX_CONTENT_BYTES, with the flag winning`. Fails:
  ```
  Expected values to be strictly equal:
  + actual - expected
  + undefined
  - 1000
  ```
  (`resolveConfig` does not read `UROBOROS_OBS_MAX_CONTENT_BYTES` yet.)

### What I did not write, and why

- **The whole interface** (`app.js`, `styles.css`): no case, per the plan's own "What is left untested" — no DOM harness exists and adding one means a runtime dependency, forbidden.
- **AC3 and AC6** (landing on the timeline; scrubbing and live mode): no case, per the plan — interface behaviour, reviewed by reading.
- **AC9** (recordings without content flags): no case, per decision 5 — nothing may pin behaviour for that case.
- **Retention of the timeline across eviction**: no case, per the plan — it follows from case 25 exercised from the store side.
- I did not run `bash test.sh` or any other full-suite/linter command — the plan reserves that for whoever runs it downstream, and my brief is single-file runs only.

### Decisions I made where the plan left small things open

- **Lane id for an agent-kind lane** (cases 7, 8, 15, 23): the plan doesn't spell out the literal id, but its own rationale ("Request bodies are attributable by query_source alone. That is a name, not an instance id...") and the rejected-alternatives note ("Keying lanes on agent_id alone... it exists only on spans") both point at the lane id being the `query_source` string itself. I used `laneId: 'researcher'` throughout on that basis. If the implementer picks a different id scheme for agent lanes (e.g. a prefix), cases 7, 8, 15 and 23 will need their `laneId` literal adjusted — the behaviour they pin (one lane per `query_source` name, bridged through `agent_id`) does not change.
- **Auxiliary lane id** (case 10): the plan gives no id for a `compact` lane, only its `kind`. I asserted `kind === 'auxiliary'` without pinning an id.
- **`--format shell` as the explicit flag value** (case 3): the plan names "shell format" and "`--format json`" side by side without saying whether shell is the flag's default or must be spelled out; I passed `--format shell` explicitly, which the implementation plan text elsewhere confirms is one of the four literal format names (`shell`, `json`, `dotenv`, `settings`).
- **Source key for a `thinking` content block** (case 18): the plan says "text = whatever arrived" without naming the JSON key. I built the fixture on Anthropic's Messages API shape (`{ type: 'thinking', thinking: '...' }`), matching the extraction style the plan already spells out for `tool_use` (`input`) and `tool_result` (`content`). Flagging this because if the implementer's `context.mjs` reads a different key for this one block type, only this fixture's shape needs adjusting — the assertion (`type: 'thinking'`, `text` equal to whatever arrived, untouched) stays correct either way.

### A question for the researcher

- **AC2 case 4** — the plan says `GET /api/events?event=claude_code.api_request_body` must return the ingested record "with the `body` attribute intact," but neither the plan nor anything else in my brief names the field path `/api/events` uses to expose a record's raw attributes (the one existing test I could read shows only `items[0].summary` and `items[0].attribution.model`, both derived/normalized fields, not a raw-attribute passthrough). I wrote the assertion as a substring check on the whole serialized event item (`JSON.stringify(events.items[0]).includes(bodyText)`) rather than guess a field name like `.attrs.body` or `.attributes.body`. This proves content round-trips somewhere in the response but not that it lives at a specific, stable path — worth the researcher's or implementer's call on whether `/api/events` should get a documented field name for raw attributes as part of this change.

### Command run to prove every case red

Each file was run individually with the command the plan names:

- `node --test tools/argus/test/claude.test.mjs` — 8 tests, 6 pass (pre-existing), 2 fail (both new), exit 1.
- `node --test tools/argus/test/config.test.mjs` — 11 tests, 9 pass (pre-existing), 2 fail (both new), exit 1.
- `node --test tools/argus/test/server.test.mjs` — 20 tests, 17 pass (pre-existing), 3 fail (all new), exit 1.
- `node --test tools/argus/test/store.test.mjs` — 42 tests, 28 pass (pre-existing), 14 fail (all new), exit 1.
- `node --test tools/argus/test/context.test.mjs` — new file, fails to load (`ERR_MODULE_NOT_FOUND` for `src/context.mjs`), exit 1.

No pre-existing case in any of these files broke — the researcher's note that
`test/server.test.mjs`'s `/api/config` case tolerates new env keys held; I did
not touch it.

## Round 1

Correction round for the reviewer's Finding 1 (`reviewer.md`, Round 0):
`tools/argus/test/server.test.mjs`'s body-round-trip case asserted an
unescaped literal against a serialized-then-escaped haystack, which no
Messages-API body containing a `"` could ever satisfy. Only this file
changed; no production file was touched, matching the researcher's plan for
this round.

### What I wrote

Replaced the case at the old lines 404–421 with the two the plan specifies,
both in `tools/argus/test/server.test.mjs`, same command:
`node --test tools/argus/test/server.test.mjs`.

- **Case 1 → `a claude_code.api_request_body record is exposed over
  /api/events with its body attribute intact`.** Kept the plan's required
  name verbatim. Ingests one `claude_code.api_request_body` record for
  session `s-body` with `bodyText = JSON.stringify({ system: 'hi', messages:
  [] })`, reads `GET /api/events?session=s-body&event=claude_code.api_request_body`,
  and asserts `events.items[0].attrs.body === bodyText` — equality on the
  value, not a substring check on the serialized item. Filters by `session=`
  as the plan asks, so the second case's record can never be seen by this
  one.
- **Case 2 → `an oversized request body comes back from /api/events
  uncut`.** Ingests a second record, session `s-body-big`, body
  `JSON.stringify({ system: 'x'.repeat(200000), messages: [] })` — well past
  the CLI's 61 440-unit default — and asserts both
  `events.items[0].attrs.body.length === bodyText.length` and
  `events.items[0].attrs.body === bodyText`.

Both reuse `bodyEventPayload` and `withServer` exactly as they already exist
in the file; no helper was added, per the plan. Both carry a third-argument
message stating what must hold, in the file's existing voice.

### Result: the corrected case is green, as the plan said it would be

The plan states plainly that this is not a red-first case: "the corrected
case is expected to pass against the untouched collector on its first run
... I have read the path end to end and expect green." I ran
`node --test tools/argus/test/server.test.mjs` from the repository root and
both new cases pass on the untouched collector:

```
# Subtest: a claude_code.api_request_body record is exposed over /api/events with its body attribute intact
ok 17 - a claude_code.api_request_body record is exposed over /api/events with its body attribute intact
# Subtest: an oversized request body comes back from /api/events uncut
ok 18 - an oversized request body comes back from /api/events uncut
...
1..21
# tests 21
# suites 0
# pass 21
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

21 tests total (20 before this round, minus the one replaced case, plus the
two new ones = 21), all pass, exit 0. No pre-existing case in the file broke.
This matches the plan's own account exactly, so there is nothing to flag as
an unexpected red: the fix was a test-only repair of an unsatisfiable
assertion, confirmed correct by reading `#applyLog`, `/api/events` and
`describeEvent` (as the plan's "What is wrong, and what the fix is" section
lays out), not by chasing a failure that was never expected to appear.

### What I did not write, and why

Nothing else — the plan states "Nothing from Round 0's test plan is asked
for again... every other case in the tree stays exactly as it is," and this
round's "What" section names exactly these two cases and no more. I left
Round 0's 26 cases, including the ones in this same file, untouched.

### Decisions I made where the plan left small things open

- **Case order and exact wording of the assertion messages**: the plan gives
  the field path (`attrs.body`) and the two expected equalities but not the
  literal message strings; I wrote messages that state what each equality
  proves, matching the file's existing voice, per its convention.
- **Query string on the read**: the plan's prose doesn't spell out
  `session=` on the `GET /api/events` call for either case, only that "the
  two cases [get] different session ids and filter by `session=` so neither
  sees the other's record" in the "How" section — I applied that literally
  to both cases' fetch URLs.

### No questions this round

The Round 0 question about the field path `/api/events` uses for raw
attributes (`attrs.body`) is answered by this round's plan itself, in "What
is wrong, and what the fix is": `/api/events` spreads the stored record, so
`attrs` reaches the client verbatim. No open question remains from this
round.

## Round 2

Correction round for the reviewer's Round 1 findings (`reviewer.md`, Round 1).
This round's test plan is Finding 2's answer: nine cases against a new
DOM-free module, `tools/argus-ui/public/timeline.js`, which does not exist yet
— the implementer's round writes it. Findings 3 and 4 are prose-only README
corrections and get no test, per the plan. Nothing from Round 0's or Round 1's
test plan was touched.

### What I wrote

One new file, `tools/argus-ui/test/timeline.test.mjs`, importing
`../public/timeline.js`, run with
`node --test tools/argus-ui/test/timeline.test.mjs`. Nine `test()` cases, one
per numbered item in this round's plan, each named for the behaviour the
plan's own bolded lead-in or narrative names:

1. **Case 1 (criterion 3's landing state)** →
   `a freshly opened session lands on its timeline, live, with no technical view open`.
   Asserts `freshSessionView()` deep-equals
   `{ timeline: null, slice: null, selectedLaneId: 'main', atMs: 0, live: true, technicalTab: null }`.
2. **Case 2** →
   `a technical view opens, closes on a second click, and gives way to another`.
   `toggleTechnicalTab` from `null` → `'events'` → `null` → `'traces'`.
3. **Case 3** →
   `a live view follows the head, and picks a lane that exists`. `pinToTimeline`
   against `{ firstMs: 1000, lastMs: 3000, lanes: [{ id: 'main' }, { id: 'sub' }] }`:
   default selection `'main'` at `atMs: 3000`; `'sub'` stays `'sub'`; `'gone'`
   falls to the first lane's id (`'main'` in this fixture); `lanes: []` and
   `lanes` omitted entirely both fall to the literal `'main'`, no throw.
4. **Case 4** →
   `a scrubbed moment survives the next timeline, clamped into the recorded range`.
   `live: false, atMs: 2000` (inside `[1000, 3000]`) stays 2000; `atMs: 10`
   clamps to 1000; `atMs: 9999` clamps to 3000; `atMs: 0` (never scrubbed)
   jumps to `lastMs`.
5. **Case 5** → `scrubbing leaves live mode`. `scrubTo(view, '2500')` on a live
   view sets `live: false`, `atMs: 2500` as a number, not the string a range
   input hands over.
6. **Case 6** →
   `the Live control returns to live mode at the newest record`. `resumeLive`
   on `{ live: false, atMs: 2000, timeline: {...lastMs: 3000} }` sets
   `live: true, atMs: 3000`; with `timeline: null` sets `live: true` and
   leaves `atMs` unchanged.
7. **Case 7 (Finding 1a)** → `after a scrub the row says live mode was left`.
   `scrubTo` then `paintScrubRow` against the plan's stub root: `.scrub-live`
   `aria-pressed` `'false'`, `.scrub-clock` textContent `fmtClock(2000)`,
   `.lane-playhead` `style.left` `'50.000%'`; then `resumeLive` and repaint:
   `'true'`, `'100.000%'`, `fmtClock(3000)`.
8. **Case 8** → `a session with no axis has no playhead to move`.
   `playheadPercent(null, 5)` and `playheadPercent({firstMs:7,lastMs:7}, 7)`
   both `null`; `playheadPercent({firstMs:1000,lastMs:3000}, 0)` is `0`,
   `(…, 9999)` is `100`; `paintScrubRow` with a single-instant timeline leaves
   `.lane-playhead` `style.left` at its initial `''` while still writing the
   clock and `aria-pressed`.
9. **Case 9 (Finding 1b)** →
   `a refresh landing mid-drag is held back until the scrubber is let go`.
   `refreshHeldBack` false before any drag; true twice running after
   `scrubGrabbed`; `scrubReleased` reports `true` once (one was missed) then
   `false` on a second release; a drag with nothing held back reports `false`
   on release; a refresh already pending when the pointer lands
   (`scrubGrabbed(gate, { refreshPending: true })`) reports `true` on release.

I used the plan's own hand-written fake, `scrubRow()` — three nodes behind
`querySelector` for `.lane-playhead`, `.scrub-clock`, `.scrub-live` — verbatim,
for cases 7 and 8; the other seven cases need no fake, matching the plan's own
note ("Cases 7 and 8 use it; the other seven need nothing").

Cases 3, 4, 6, 8 and 9 each pin several related assertions listed under one
bolded lead-in in the plan (e.g. case 3's "With … With … With … Edge … Edge"
is one continuous narration, not the two-assertions-in-one-bullet pattern
Round 1 called out for splitting) — I kept each as a single `test()`, one per
plan item number, rather than fragmenting further; the plan's own numbering
(1 through 9) is what I used as the case boundary.

### Command run to prove every case red

```
node --test tools/argus-ui/test/timeline.test.mjs
```

```
TAP version 13
# node:internal/modules/esm/resolve:275
#     throw new ERR_MODULE_NOT_FOUND(
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/home/user/uroboros/tools/argus-ui/public/timeline.js' imported from /home/user/uroboros/tools/argus-ui/test/timeline.test.mjs
...
not ok 1 - tools/argus-ui/test/timeline.test.mjs
1..1
# tests 1
# pass 0
# fail 1
```

Exit 1. All nine cases fail together for the same, correct cause: the module
under test, `tools/argus-ui/public/timeline.js`, does not exist yet — exactly
the outcome the plan predicted ("written first, the cases below fail because
`public/timeline.js` does not exist yet"), the same shape Round 0's
`context.test.mjs` had before `context.mjs` existed. No pre-existing case
anywhere in `tools/argus-ui` or `tools/argus` was touched or run beyond this
one new file, per my brief (single-file runs only).

### What I did not write, and why

- **The markup `renderDetail`/`renderTimeline`/`renderSlicePanel` produce, and
  which DOM event is wired to which transition** — Finding 2's stated residue;
  needs a DOM harness, which is a dependency and the human's call, left open
  in the plan as a recorded question.
- **Findings 3 and 4** (the two README corrections) — prose, no case asked
  for, per the plan's own "Findings 3 and 4 are prose and get no test —
  nothing a tool can check, and pinning a README sentence would break on a
  better one."
- **Everything Round 0 and Round 1 already cover** — the plan states plainly
  that no case from either earlier round is asked for again, and I touched no
  file besides the one new one.
- **Recordings without the content flags** — decision 5 forbids pinning them;
  restated by this round's plan and still true.
- I did not run `bash test.sh` or any other full-suite command — that stays
  reserved for whoever runs it downstream, and my brief is single-file runs
  only.

### Decisions I made where the plan left small things open

- **Test count and boundaries.** The plan numbers nine cases with narrative
  sub-parts under several of them (cases 3, 4, 6, 8, 9); I wrote exactly nine
  `test()` calls, one per numbered case, since the plan's own "What" section
  presents each number as one behaviour with edges, not as several
  independently-billed assertions (contrast Round 1's case 11/24, which the
  researcher explicitly called "two assertions" and asked to be split).
- **Assertion messages.** The plan gives the expected values and the fixture
  shapes but not literal message strings; I wrote messages in the file's
  existing voice (`config.test.mjs`'s "the interface must not fight the
  collector for 4318" is the model the plan names), stating what the
  assertion pins and, where relevant, which finding it guards.
- **`toggleTechnicalTab`'s return value.** The plan's signature comment gives
  only the mutation (`view.technicalTab = …`), no return value; I asserted on
  the mutated `view.technicalTab` only, not on any return.
- **Fixture reuse across the sub-parts of one case.** Where a case's plan text
  builds several small views from the same base (e.g. case 4's four `atMs`
  variants against one `timeline` shape), I built a fresh `{ ...freshSessionView(), ... }`
  object per variant rather than mutating and reusing one, so an assertion
  failure in one variant cannot leave a later variant's starting state
  ambiguous.

### No questions this round

The plan's own open question (Finding 2: should `argus-ui` take a DOM test
dependency) is addressed to the human, not to me, and I have nothing to add to
it — the module and the nine cases match the plan's exported API and test list
exactly, with no case too vague to pin and no case whose expectation
contradicts the criterion it claims to cover.
