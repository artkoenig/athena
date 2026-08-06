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
