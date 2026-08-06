# Test-author handoff — argus timeline UI

## Increment 1

Wrote every case in the Increment 1 test plan of `researcher.md`, in the four
files it named, in their existing style. No production file was opened —
expected shapes came entirely from the plan's prose (the `contentMetaOf`
field list, the `listContent`/`contentAt` signatures, the route contracts).
Ran each file with `node --test tools/argus/test/<file>.test.mjs` and confirm
below that every new case fails for the reason the plan predicts: a flag not
yet set, a route not yet built, an export not yet defined — never a mistake
in the test itself.

### Criterion 1 — `argus env` (both formats) includes the content flags

| # | Case | Test | Result |
| --- | --- | --- | --- |
| 1 | `otelEnvFor` sets the four flags plus the raised content ceiling | `tools/argus/test/claude.test.mjs`: `'the env block includes the content flags by default: user prompts, tool details, tool content and raw api bodies'` | fails: `Expected values to be strictly equal: undefined !== '1'` on `env.OTEL_LOG_USER_PROMPTS` |
| 2 | Same five present with `{ traces: false }` | `tools/argus/test/claude.test.mjs`: `'the content flags are not gated behind traces: content is not a tracing feature'` | fails: same `undefined !== '1'` |
| 3 | Shell format prints a line for each `OTEL_LOG_*` flag | `tools/argus/test/config.test.mjs`: `'argus env (default shell format) prints a line for each content flag'` | fails: `'OTEL_LOG_USER_PROMPTS missing from the shell format'`, actual stdout quoted in the failure has no `OTEL_LOG_*` line at all today |
| 4 | `--format settings` nests the same four flags under `env` | `tools/argus/test/config.test.mjs`: `'argus env --format settings nests the same four content flags under env'` | fails: `undefined !== '1'` on `parsed.env.OTEL_LOG_USER_PROMPTS` |

### Criterion 2 — the collector stores and serves the content-bearing records

Store cases, `tools/argus/test/store.test.mjs`, built on a new `bodyLog(attributes, timeMs)`
wrapper around the file's existing `log(...)` helper (string `body_length`/`body_truncated`,
`session.id` folded into attrs exactly like the other fixtures):

| # | Case | Test | Result |
| --- | --- | --- | --- |
| 5 | one ingested body is listed with parsed metadata, no `body` key | `'an ingested api_request_body event is listed with parsed metadata and never with its body'` | — |
| 6 | `contentAt` at the exact record time includes it | `'contentAt returns the exact body for a record whose time matches the boundary exactly'` | — |
| 7 | `contentAt` picks the nearest at-or-before record, `null` before the first | `'contentAt returns the newest record at or before the requested time, and null before the first record'` | — |
| 8 | main vs. subagent filtering, redacted `agent:custom` resolves to `'custom'` | `'main and subagent content records are told apart by query_source, and a redacted name still resolves to something'` | — |
| 9 | two same-type subagents told apart by `spanId` | `'two concurrent subagents of the same type are distinguished by spanId, not by query_source alone'` | — |
| 10 | oldest content evicted whole once `maxContentChars` is exceeded, from both `listContent` and `queryEvents`, non-content log untouched | `'content records are evicted oldest-first once the total exceeds maxContentChars, whole from both indexes'` | — |
| 11 | a single body bigger than the whole budget is still kept | `'a single body larger than the whole content budget is still kept, never dropped'` | — |
| 12 | `clear()` resets `contentChars`/`contentLogs` bookkeeping | `'clear() resets content bookkeeping along with everything else'` | — |
| 13 | `maxSessions` eviction drops a session's content too | `'dropping the oldest session under maxSessions removes its content records too'` | — |

Result for cases 5–13, all at once: the whole file fails to load —

```
SyntaxError: The requested module '../src/claude.mjs' does not provide an export named 'agentOf'
```

That is the correct failure for this state of the repository: `agentOf`,
`isSubagentSource`, `contentMetaOf`, `CONTENT_EVENTS`, `listContent`,
`contentAt` and the `maxContentChars` option are all named by the plan as new
and are genuinely absent from `src/claude.mjs`/`src/store.mjs` today (checked
by `grep -n '^export' src/claude.mjs`, which lists none of them) — not a typo
on this end. Once the implementer adds `agentOf`, the import will resolve and
each of the nine cases will fail (or pass) on its own merits; until then the
whole file reports this one `SyntaxError` for all nine at once, which is the
expected shape of a "not implemented yet" failure for a file that imports a
symbol that does not exist.

Server cases, `tools/argus/test/server.test.mjs`, using a new
`contentLogsPayloadJson(sessionId, overrides)` fixture (OTLP/JSON logs export
carrying one `claude_code.api_request_body` record) alongside the file's
existing `withServer` helper:

| # | Case | Test | Result |
| --- | --- | --- | --- |
| 14 | POST then `GET /api/content?session=…` returns metadata, no body | `'POST of an api_request_body log is served by GET /api/content, without the body'` | fails: `TypeError: Cannot read properties of undefined (reading 'length')` — `/api/content` does not exist yet, so `listed.items` is `undefined` |
| 15 | `GET /api/content/at` at the record time returns the full body | `'GET /api/content/at at the record time answers with the full body'` | fails: `404 !== 200` |
| 16 | `GET /api/content/at` before the first record: `200`, `item === null` | `'GET /api/content/at before the first record answers 200 with a null item, not 404'` | fails: `404 !== 200` |
| 17 | `GET /api/content/at` without `session`: `400` | `'GET /api/content/at without a session is a 400'` | fails: `404 !== 400` |
| 18 | `/api/events` strips the body but keeps `content` metadata; `/api/content/at` still serves the whole body afterwards | `'/api/events strips the body but keeps its length, and /api/content/at still serves the whole body afterwards'` | fails: `'the event tail must not ship the body'` — today's `/api/events` still ships `attrs.body` in full |
| 19 | `/api/config` reports `OTEL_LOG_RAW_API_BODIES` | extended the existing `'/api/config returns a ready-to-paste agent environment'` case with `assert.equal(config.env.OTEL_LOG_RAW_API_BODIES, '1')` | fails: `undefined !== '1'` |

One tail case, `tools/argus/test/claude.test.mjs`:

| # | Case | Test | Result |
| --- | --- | --- | --- |
| 20 | `describeEvent` on an `api_request_body` record names the size, never the body text | `'describeEvent on an api_request_body record never lets the body text leak into the summary'` | fails: `'the summary has to name the size instead of the text'` — today's `describeEvent` falls through to the generic `actual: 'claude_code.api_request_body'` summary, which names neither the size nor (correctly) the secret text |

### Commands run

- `node --test tools/argus/test/claude.test.mjs` — 9 tests, 6 pass (pre-existing), 3 fail (new), exit 1.
- `node --test tools/argus/test/config.test.mjs` — 11 tests, 9 pass (pre-existing), 2 fail (new), exit 1.
- `node --test tools/argus/test/store.test.mjs` — fails to load: `SyntaxError`, exit 1 (see above; covers cases 5–13).
- `node --test tools/argus/test/server.test.mjs` — 22 tests, 16 pass (pre-existing), 6 fail (new + the extended `/api/config` case), exit 1.
- `grep -n '^export' tools/argus/src/claude.mjs` — read-only check that `agentOf` and friends are not yet exported, used only to confirm the store-file failure is a real gap and not a typo in the test.

None of the above is `npm --prefix tools/argus test` or `./test.sh` — the plan
reserves the full-suite run for the implementer once the code exists.

### Deliberately not written

Matches the plan's own list exactly, nothing added or dropped:

- Recordings made without the content flags — out of contract by the issue's decision.
- `OTEL_LOG_RAW_API_BODIES=file:<dir>` — not set by `argus env`.
- The CLI's own truncation ceiling and redaction rules — measured, not tested here beyond case 1's floor check.
- `json` and `dotenv` env formats — same object through the same renderer as cases 3–4.
- Persistence and replay of content records — no new code, no new case.
- `tools/argus-ui` — untouched by this increment.

### Gaps and conflicts found in the plan

None. The plan's five files, expected shapes and case list were concrete
enough to write every case to a specific, checkable expectation; no case
needed a guess.

## Increment 1 — Round 1

Wrote the five cases from the Round 1 test plan of `researcher.md` — the
reviewer's reproduction spec for this round, and nothing else. Added the two
fixture helpers the plan named, exactly as specified, touching no other line of
either fixture: `responseBodyLog` in `tools/argus/test/store.test.mjs` (a
sibling of `bodyLog`, spread with `eventName` overridden, exactly as the plan's
snippet has it), and the `eventName`/`requestId` overrides on
`contentLogsPayloadJson` in `tools/argus/test/server.test.mjs` (`overrides.eventName
?? 'claude_code.api_request_body'`, plus a `request_id` attribute appended only
when `overrides.requestId` is given). No production file was opened to author
these five cases; expected shapes came from the plan's prose and from the
existing request-body cases in each file, read only for their style (test-name
sentence shape, `assert.ok(!('body' in …))` for absence checks).

This round's cases are regression pins, not failing tests: the plan states the
implementation already handles `claude_code.api_response_body` on every path
the reviewer's finding named and predicts every case is green on first run with
no production edit. I ran each file with the plan's single-file command and
confirm that prediction:

| # | Case | Test name | File | Result |
| --- | --- | --- | --- | --- |
| 1 | `listContent` indexes a response body and the `eventName` filter discriminates it from a request body | `'an api_response_body record is indexed alongside a request body, and the eventName filter discriminates between them'` | `tools/argus/test/store.test.mjs` | passes |
| 2 | `contentAt` with an explicit `eventName` returns the response body; the same call with no `eventName` still defaults to `api_request_body` | `'contentAt with an eventName filter returns the matching body, and the default filter still means api_request_body'` | `tools/argus/test/store.test.mjs` | passes |
| 3 | `GET /api/content` and `GET /api/content/at` serve a response body when filtered by `event=claude_code.api_response_body`, and `/api/content/at` without `event=` returns `item: null` for a session holding no request body | `'an api_response_body log is served by GET /api/content and GET /api/content/at when filtered by event, and the default event still means api_request_body'` | `tools/argus/test/server.test.mjs` | passes |
| 4 | `GET /api/events` strips a response body's `body` from `attrs` and still carries `content.bodyChars` | `'an api_response_body log does not ship its body through the polled event tail either'` | `tools/argus/test/server.test.mjs` | passes |
| 5 | `describeEvent` on an `api_response_body` record never leaks the body text and names the size instead | `'describeEvent on an api_response_body record never lets the body text leak into the summary either'` | `tools/argus/test/claude.test.mjs` | passes |

### Commands run

- `node --test tools/argus/test/store.test.mjs` — 39 tests, 39 pass, exit 0 (9 pre-existing content cases plus the round-0 and round-1 non-content cases, plus these 2 new).
- `node --test tools/argus/test/server.test.mjs` — 24 tests, 24 pass, exit 0.
- `node --test tools/argus/test/claude.test.mjs` — 10 tests, 10 pass, exit 0.

None of the above is `npm --prefix tools/argus test` or `./test.sh` — the plan
reserves the full-suite run for the implementer, and nothing outside these three
files was touched this round.

### Proving the cases are not vacuous

Since the plan predicts every case green against the current implementation,
"prove the failures" for this round means proving the cases actually catch the
reviewer's reproduction, not proving they fail today. I applied that
reproduction myself — in `tools/argus/src/claude.mjs`, changed
`export const CONTENT_EVENTS = new Set([EVENT.apiRequestBody, EVENT.apiResponseBody]);`
to `new Set([EVENT.apiRequestBody]);` — reran the three files, and reverted the
edit immediately afterward; `git status`/`git diff` on that file afterward show
it byte-identical to before (`nothing to commit, working tree clean`). This is
the one and only time production code was touched during this round, done only
to verify sensitivity, never to author or pass a test, and undone before this
handoff was written.

Under that reproduction:

- `store.test.mjs`: 37 pass, 2 fail — `not ok 38` (case 1) and `not ok 39`
  (case 2), both because the response body is no longer indexed once
  `CONTENT_EVENTS` drops it.
- `server.test.mjs`: 22 pass, 2 fail — `not ok 23` (case 3) and `not ok 24`
  (case 4).
- `claude.test.mjs`: unaffected, 10 pass, 0 fail — `describeEvent`'s own case
  for `EVENT.apiResponseBody` does not consult `CONTENT_EVENTS`, so case 5
  stays green under this reproduction; the plan does not claim otherwise (it
  names cases 1, 3 and 4 as the ones the reproduction turns red, and case 5 is
  a `describeEvent` case, not an indexing case).

One correction to the plan's own count, reported here rather than acted on: the
plan says the reproduction "turns three of them red at once" (cases 1, 3 and
4). Measured, it turns four red — case 2 also fails, because `contentAt` called
with `eventName: 'claude_code.api_response_body'` finds no match once indexing
stops for that event, and the case's `response.body` access then fails against
`null`. Both counts support the round's conclusion (the new cases do catch the
regression), so no case was rewritten over this; it is left for the researcher
to correct the count if it matters elsewhere.

### Deliberately not written

Matches the round's own list exactly, nothing added or dropped:

- An `event=` case for the request body on top of the existing round-0
  coverage — not asked for; cases 1 and 2 already prove the filter
  discriminates using both event names in one store.
- The two "beyond the criteria" review notes (span-carried tool content
  unstripped/unbudgeted; `/api/events?search=` stringifying bodies) — filed as
  notes, not findings or corrections; no case for either.
- A case for the `contentAt` ordering note ("last ingested" vs. "newest by
  timestamp") — explicitly recorded as not a finding.
- Recordings made without the content flags — out of contract, as in every
  earlier round.
- Everything the round-0 plan already covered — it is already in the suite and
  is not re-specified here; this round adds cases and removes none.

### Gaps and conflicts found in the plan

One count discrepancy, detailed above under "Proving the cases are not
vacuous": the plan states the reviewer's reproduction turns three cases red
(1, 3, 4); measured, it turns four red (1, 2, 3, 4), because case 2 also
depends on the response event being indexed. This does not change what any
case asserts and no case was rewritten over it — it is reported for the
researcher to reconcile, not acted on here.

## Increment 2

Wrote every case in the Increment 2 test plan of `researcher.md`, in the three
files it named: two new (`tools/argus-ui/test/timeline.test.mjs`,
`tools/argus-ui/test/page.test.mjs`) and one edited
(`tools/argus-ui/test/independence.test.mjs`, adding `public/timeline.js` and
`public/format.js` to its existence and ownership lists). No production file
was opened — expected shapes came entirely from the plan's prose: the
`buildLanes`/`laneGeometry`/`renderTimeline`/`DETAIL_VIEWS`/`renderDetailViews`
signatures and algorithm, the field lists for `session`/`content` records, and
the exact list of flag names criterion 4 forbids. Ran each file with
`node --test tools/argus-ui/test/<file>.test.mjs` and confirm below that every
new case fails for the reason the plan predicts.

### Criterion 1 — opening a session lands on the timeline, the technical views stay reachable and subordinate

| # | Case | Test | Result |
| --- | --- | --- | --- |
| 1 | `DETAIL_VIEWS` carries exactly the six ids, each with a non-empty label | `tools/argus-ui/test/timeline.test.mjs`: `'the timeline names exactly six technical views, each with a label'` | — |
| 2 | `renderDetailViews({ selected: null })` offers every view, opens none | `tools/argus-ui/test/timeline.test.mjs`: `'opening a session with nothing selected offers every technical view and opens none'` | — |
| 3 | `renderDetailViews({ selected: 'events' })` marks exactly one selected | `tools/argus-ui/test/timeline.test.mjs`: `'selecting one technical view marks exactly that one as selected'` | — |
| 4 | `app.js` imports `./timeline.js`, `index.html` loads `/app.js` as a module | `tools/argus-ui/test/page.test.mjs`: `'app.js imports the timeline module, and index.html loads app.js as a module'` | fails: `AssertionError: app.js must import timeline.js so the timeline is reached by the page, not tested as an island` |

Cases 1–3 fail together with the whole file, since `public/timeline.js` does
not exist yet:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
'/home/user/uroboros/tools/argus-ui/public/timeline.js' imported from
/home/user/uroboros/tools/argus-ui/test/timeline.test.mjs
```

That is the correct failure for this state of the repository: `buildLanes`,
`laneGeometry`, `renderTimeline`, `DETAIL_VIEWS` and `renderDetailViews` are
all named by the plan as new and are genuinely absent (there is no
`public/timeline.js` at all — checked by `ls tools/argus-ui/public/`, which
lists only `app.js`, `index.html`, `styles.css`) — not a typo on this end.
Once the implementer creates the module, the import will resolve and each of
the fourteen cases in that file (1–3 and 5–18 below) will fail or pass on its
own merits; until then the whole file reports this one `ERR_MODULE_NOT_FOUND`
for all of them at once.

### Criterion 2 — one lane for the main session, one per subagent, each spanning its lifetime

| # | Case | Test | Result |
| --- | --- | --- | --- |
| 5 | Empty content: one main lane spanning the session | `'with no content the main lane still spans the whole session'` | — |
| 6 | Main record plus three subagent records on one span: two lanes | `'a subagent spanning three records on one span gets its own lane'` | — |
| 7 | Same records newest-first: identical result | `'lane order does not depend on the order the api returned the records'` | — |
| 8 | Subagent past `lastSeenMs`: window widens, main lane does not | `'a subagent active past the session end widens the window but not the main lane'` | — |
| 9 | Records with `timeMs: 0` / missing mixed in: identical to case 6 | `'records with no usable time widen nothing and change no lane'` | — |
| 10 | `laneGeometry` exact arithmetic at two points | `'lane geometry is exact at round numbers'` | — |
| 11 | `laneGeometry` for a single-instant lane | `'a single-instant lane is still a visible bar that never overflows its track'` | — |
| 12 | `laneGeometry` against a zero-length window | `'lane geometry stays finite and in range against a zero-length window'` | — |
| 13 | `renderTimeline` markup: two `data-lane`, valid `style` | `'the rendered timeline carries one bar for the main session and one for the subagent, each with valid geometry'` | — |
| 14 | Hostile agent label escaped in markup | `'a hostile agent label is escaped in the rendered timeline, never raw'` | — |

All ten (5–14) are in `tools/argus-ui/test/timeline.test.mjs` and fail with the
same `ERR_MODULE_NOT_FOUND` quoted above, for the same reason: the module they
import does not exist yet.

### Criterion 3 — two concurrent subagents of one type get two lanes

| # | Case | Test | Result |
| --- | --- | --- | --- |
| 15 | Two spans, one agent name, overlapping in time: two lanes, `#1`/`#2` labels | `'two concurrent subagents of the same type get two lanes, told apart by span and numbered in the label'` | — |
| 16 | Same four records through `renderTimeline`: three `data-lane` | `'the rendered timeline never merges two concurrent same-type subagents into one bar'` | — |
| 17 | Two records on one span, one agent: still one agent lane | `'a lane is a span, not a record: two requests on one span still make one lane'` | — |
| 18 | Two different agent names on different spans: no `#1`/`#2` suffix | `'two different agent names on different spans get two lanes with no disambiguation suffix'` | — |

All four (15–18) are in `tools/argus-ui/test/timeline.test.mjs`, in the same
file and failing with the same `ERR_MODULE_NOT_FOUND`.

### Criterion 4 — the UI no longer advises a flag `argus env` sets

| # | Case | Test | Result |
| --- | --- | --- | --- |
| 19 | No file under `public/` names a flag `argus env` now sets | `tools/argus-ui/test/page.test.mjs`: `'no file under public names a flag argus env now sets by default'` | fails: `app.js names CLAUDE_CODE_ENHANCED_TELEMETRY_BETA`, `app.js names OTEL_TRACES_EXPORTER`, `app.js names OTEL_LOG_TOOL_DETAILS`, `index.html names CLAUDE_CODE_ENHANCED_TELEMETRY_BETA` |
| 20 | Flags `argus env` does not set stay advised in `app.js` | `tools/argus-ui/test/page.test.mjs`: `'flags argus env does not set are still advised in app.js'` | passes today, unforced — `OTEL_RESOURCE_ATTRIBUTES` and `CLAUDE_CODE_OTEL_DIAG_STDERR` are already in `app.js` and the plan does not ask that either be added; this case is a guard against case 19's edit taking them out as collateral damage, not a case that needs the implementation to change |

### Independence guard

`tools/argus-ui/test/independence.test.mjs` was edited, not authored fresh:
added `'public/timeline.js'` and `'public/format.js'` to the existence list in
the first case and to the `owned` list in the second, exactly as the plan
specifies. Both of its pre-existing cases now fail, correctly, because those
two files do not exist yet:

- `'the interface is a project of its own, with everything a project needs'`
  fails: `tools/argus-ui/public/timeline.js is missing`
- `'nothing in the interface reaches outside the interface'` fails: `the scan
  does not cover public/timeline.js — it is not there to check`

### Commands run

- `node --test tools/argus-ui/test/timeline.test.mjs` — 1 top-level test
  reported (the file fails to load), 0 pass, 1 fail, exit 1 — covers cases
  1–3 and 5–18, eighteen cases, all red via the one `ERR_MODULE_NOT_FOUND`.
- `node --test tools/argus-ui/test/page.test.mjs` — 3 tests, 1 pass
  (case 20), 2 fail (cases 4 and 19), exit 1.
- `node --test tools/argus-ui/test/independence.test.mjs` — 2 tests, 0 pass,
  2 fail, exit 1.
- `node --test tools/argus-ui/test/config.test.mjs tools/argus-ui/test/server.test.mjs`
  — 12 tests, 12 pass, exit 0 — run only to confirm the untouched suites are
  unaffected by these edits, not part of this increment's own list.

None of the above is `npm --prefix tools/argus-ui test` or `./test.sh` — the
plan reserves the full-suite run for the implementer once the code exists.

### Deliberately not written

Matches the plan's own list exactly, nothing added or dropped:

- That `renderDetail` puts the timeline above the nav, and that `state.tab`
  starts as `null` — DOM wiring in `app.js`, no harness for it and none to be
  added (jsdom is a dependency the project has zero of).
- Whether a lane bar is visually where it should be — geometry is pinned as
  numbers, pixels are not a thing `node --test` can see.
- The `/api/content` fetch itself — three lines of the existing `api()`
  helper, and `server.test.mjs` already proves the proxy forwards query
  strings intact.
- The 2000-record window — the collector's own cap, pinned in that project's
  suite.
- A subagent record with an empty `spanId` — under contract every content
  record carries a span; the key rule handles the case without a branch and
  nothing promises behaviour for it.
- Recordings made without the content flags — out of contract by the issue's
  own decision.
- `format.js` — a verbatim move of functions no case asserts today.
- Everything increment 1 covered — untouched here, and `tools/argus` is not
  on this increment's command list.

### Gaps and conflicts found in the plan

One documentation looseness, not acted on because no case needed it resolved:
the plan describes `renderTimeline`'s signature in prose as
`renderTimeline({ window, lanes })`, but `buildLanes` is specified to return a
flat `{ startMs, endMs, durationMs, lanes }` with no nested `window` key, and
the plan's own wiring line and test cases (`renderTimeline(buildLanes(…))`,
case 13, case 16) compose the two directly. I wrote cases 13 and 16 exactly as
the plan's own case descriptions specify the call
(`renderTimeline(buildLanes({ session: session(), content }))`), which settles
the question for testing purposes without guessing whether `renderTimeline`
internally destructures `startMs`/`endMs` or a nested `window` object. Left
for the researcher to tidy the prose if it matters for the implementer, since
no test I wrote depends on which reading is correct.

No other gap or conflict: every case in the plan mapped to a concrete,
checkable expectation from its own field lists and algorithm description.
