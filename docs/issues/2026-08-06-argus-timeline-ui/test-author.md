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
