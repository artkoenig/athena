# Implementer handoff — a session timeline as the argus UI's central view

## Round 1

Everything in the researcher's plan is built. 25 of the 26 planned cases pass.
Case 4 is still red and I did not make it pass: it asserts something no
implementation can satisfy, for a reason I show below. That is the one open
question for the reviewer.

### What counts as done, and what it said

One command, the one the plan names, run from the repository root:

- `bash test.sh` — 5 suites (repository 10 cases, worktrees 4 cases,
  `tools/argus` 163 tests, `tools/argus-ui` 14 tests, `tools/log-parser` 23
  tests). **exit 1**, `FAIL: 1 of 5 suite(s)`. The single failure is
  `tools/argus`: 162 pass, 1 fail — case 4,
  `a claude_code.api_request_body record is exposed over /api/events with its
  body attribute intact`. Nothing was skipped or excluded. Every other suite is
  green.

Baseline before I changed anything, same command: exit 1, `tools/argus` 157
tests, 135 pass, **22 fail** — exactly the 22 new cases the test-author listed,
each failing for the missing-behaviour reason they recorded (`store.getTimeline
is not a function`, `ERR_MODULE_NOT_FOUND` for `src/context.mjs`, `404 !== 200`
on the two new routes, `undefined !== '1'` on the env flags). I confirmed the
reasons before writing a line. No pre-existing case was red then, and none is
red now.

There is no linter and no formatter in this repository, so I ran nothing else.

### The one failing case, and why I left it alone

`tools/argus/test/server.test.mjs:404`, case 4. It ingests a body event whose
`body` attribute is `JSON.stringify({ system: 'hi', messages: [] })` and then
asserts:

```js
JSON.stringify(events.items[0]).includes(bodyText)
```

**This assertion cannot be true for any implementation.** `bodyText` is
`{"system":"hi","messages":[]}` — a string containing double quotes. Serializing
any object that holds it escapes those quotes, so the substring is never present:

```
attrs.body === bodyText : true
JSON.stringify(item)    : {"attrs":{"body":"{\"system\":\"hi\",\"messages\":[]}"}}
substring check         : false
```

The behaviour the case means to check **already holds, and held before this
change**: `/api/events` spreads the whole record (`{ ...event, summary,
attribution }`), so `items[0].attrs.body` comes back byte-for-byte identical and
untruncated. The case's own first assertion, `events.items.length === 1`, passes;
only the substring check fails. I verified the attribute survives decode
unchanged.

The only way to make the literal assertion pass is to add a field holding
`JSON.parse(attrs.body)` — the parsed object, so that re-serializing it
reproduces the exact input string. That is a contrivance with no purpose, it
changes the response shape of a route the plan says nothing about, and the plan
explicitly keeps body parsing out of the transport layer. I did not do it, and I
did not touch the test.

**This is the test-author's own open question, unresolved.** Their handoff asks
whether `/api/events` should get a documented field name for raw attributes.
It already has one — `attrs` — and the reviewer's call is whether the case
should assert `events.items[0].attrs.body === bodyText` instead. That is a
one-line test change I am not permitted to make.

I am `done` with this one open. It is not caused by my change, it was red at
baseline for a different reason (the record was there, the assertion was not
reached differently), and no code of mine can close it.

### What I changed

**`tools/argus/src/claude.mjs`**
- `otelEnvFor`: five content flags added to the base `env` object, outside the
  `traces` branch — `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_TOOL_DETAILS`,
  `OTEL_LOG_TOOL_CONTENT`, `OTEL_LOG_RAW_API_BODIES` at `'1'`, and
  `CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH` at `'1048576'`. Comments carry the
  researcher's findings: why 1 MB, why `file:<dir>` is not used, why
  `OTEL_LOG_ASSISTANT_RESPONSES` is deliberately absent, and that
  `OTEL_LOG_TOOL_DETAILS` is what stops `agent.name` being redacted to
  `"custom"`.
- New lane exports: `MAIN_LANE_ID`, `AUXILIARY_QUERY_SOURCES`,
  `laneOfQuerySource(value)` → `{ id, kind }`. The comment records that
  `query_source` is a *name* on events and spans but a *category* on metrics, so
  metric points must never reach it.
- `describeEvent`: cases for `EVENT.apiRequestBody` / `EVENT.apiResponseBody`,
  rendering `<model> · <body_length> chars` plus ` · truncated`.

**`tools/argus/src/context.mjs` — new.** `parseRequestBody(attrs)`, exactly the
shape the plan specifies. System string/array, tools as one block named
`tools (<n>)`, per-message and per-content-block extraction for `text`,
`tool_use`, `tool_result`, `thinking`/`redacted_thinking`, `image`/`document`
(placeholder text, `chars` set to the real payload size) and an
anything-else fallback. Never throws: a truncated body yields `parsed: false`
and one `raw` block holding the exact string; `body_ref` yields the path and an
empty block list and no file is ever opened; neither attribute yields an empty
result.

**`tools/argus/src/store.mjs`**
- `#resolveLanes(spans)`: builds `agent_id -> lane` from `llm_request` spans and
  `tool_use_id -> lane` from `tool` spans. Module-level `laneOfSpan` and
  `laneOfLog` apply it. An `agent_id` never seen on an `llm_request` span gets
  lane id `agent:<agent_id>`, label `agent <first 8>`.
- `getTimeline(sessionId)`: `null` for an unknown session, otherwise the
  documented object. The main lane is always present, even when every record
  belongs to a subagent. Lane order is main first, then `firstMs` ascending.
  Activity from `tool`/`llm_request` spans with `endMs` falling back to
  `startMs`; context samples from `api_request` events summing
  `input + cache_read + cache_creation` and excluding output. Both capped at
  2000, newest kept. `spansSeen` is `false` when no span arrived.
- `getContextAt(sessionId, { laneId, atMs, toolLimit })`: newest
  `api_request_body` in the lane at or before `atMs` run through
  `parseRequestBody`, plus that lane's `tool_result` events ascending, last 200.
- Content budget: `maxContentBytes`, default `268_435_456`. `this.contentBytes`
  is added to in `#applyLog` and recomputed by summing `this.logs` after any
  removal (`#trim` for logs, `#dropSession`, `clear`). `#evictContent` runs in
  `#evict` after the existing trims and drops from the front while over budget.

**`tools/argus/src/server.mjs`** — two routes in `handleApi`, placed before the
trace match and after the anchored session match:
`GET /api/sessions/:id/timeline` and `GET /api/sessions/:id/context?lane=&at=`,
both 404 `{ error: 'unknown session' }` on `null`.

**`tools/argus/src/config.mjs`** — `maxContentBytes` from
`--max-content-bytes` / `UROBOROS_OBS_MAX_CONTENT_BYTES`, default `268_435_456`.

**`tools/argus/bin/argus.mjs`** — the flag in the CLI help block and the variable
in the `Environment` list. Help text only; `renderEnv` needed no change and all
four formats pick the new keys up on their own.

**`tools/argus/scripts/demo-emit.mjs`** — emits `api_request_body` events with a
synthetic Messages API body on every model call, and a subagent stretch
(`llm_request` span with `agent_id` + `query_source`, a `tool` span carrying the
same `agent_id` and a `tool_use_id`, an `api_request` event with `agent.name`,
and a `tool_result`) on about 60% of turns. `tool_input` added to the main-thread
`tool_result` records so the slice panel has parameters to show. One correction
of an existing inaccuracy: the main-thread `api_request` event now carries
`query_source: 'repl_main_thread'` rather than `'main'` — `'main'` is the
*metric-side* category, and the metrics still emit it. The old value would have
been read as a lane name.

**`tools/argus-ui/public/app.js`** — `state.tab` is gone; `state.technicalTab`
(default `null`) replaces it, with `timeline`, `slice`, `selectedLaneId`, `atMs`
and `live` (default `true`) beside it. `renderDetail` is now header → timeline →
`Technical views` heading → the six tabs → the open tab's body, and clicking the
open tab closes it. `renderTimeline` draws the scrubber (`#timeline-scrub`, a
`fmtClock` readout, a `Live` button), one `<button data-lane>` row per lane with
a fixed label column and a track holding an inline `<svg>` polygon closed to the
baseline (scaled by the maximum over *all* lanes), activity blocks at minimum
width 0.4%, and a playhead layer over the track column. `renderSlicePanel` shows
the context as one expandable line per block and the tool list below it.
`loadTimeline`/`loadSlice` fetch the two routes; `atMs` follows `timeline.lastMs`
while `state.live`. The scrub handler moves the playhead and clock immediately,
debounces the fetch at 120 ms, and repaints only `#slice-panel` — re-rendering
the whole detail pane would replace the range input mid-drag. `selectSession`
resets the whole timeline state so a new session opens live, on `main`, with no
technical view open.

**`tools/argus-ui/public/styles.css`** — new `timeline` and `the slice` sections
before the waterfall, plus a `--lane-label-w` override in the existing narrow
breakpoint. Only existing custom properties are used; no new colour literal
outside `:root`.

**Documentation.** `tools/argus/README.md`: the export block now matches what
`argus env` prints; "Sensitive data" is rewritten to say the flags are on by
default, what is in the measurement, that it is unencrypted on disk, that
thinking is redacted by the CLI, and how to record structure without content;
the two routes are in the HTTP API table; `src/context.mjs` is in the
architecture list; `--max-content-bytes` is in the options table; "Limits" gains
the raw-window lifetime of the timeline, the traces requirement for subagent
tool attribution, and the two-same-kind-subagents-share-a-lane consequence.
`tools/argus-ui/README.md`: the session view is the timeline, described, with
the technical views subordinate to it. `skills/argus/SKILL.md`: the "nothing
else" sentence in "What this is not" is corrected in one paragraph pointing at
the README.

### Verified by hand, since the interface has no test harness

I ran a collector on port 4399 and `demo-emit.mjs` against it. One session
produced 3 lanes — `main` (main, 10 requests, 14 tool calls, 24 activity blocks,
10 context samples, peak 43917 tokens), `researcher` and `test-author` (both
agent, 1 request, 1 tool call, 2 activity blocks each). `spansSeen` was `true`.
`GET /api/sessions/<id>/context?lane=researcher&at=<now>` returned the
researcher's own body parsed into 6 blocks totalling 3103 chars —
`system/text`, `system/tools/tools (6)`, `user/text`, `assistant/text`,
`assistant/tool_use/Glob`, `user/tool_result` — and 1 tool call. That exercises
the llm_request bridge, the tool-span join and the parser end to end.
`node --check tools/argus-ui/public/app.js` passes.

### Notes for the reviewer, outside what I was asked to change

- **Case 4 is the blocking question.** See above. My reading is that the
  assertion should be `events.items[0].attrs.body === bodyText`, which passes
  today and pins the field name the test-author asked about.
- **The test-author's lane-id guess was right.** An agent lane's id is the
  `query_source` string, so cases 7, 8, 15 and 23 needed no adjustment. The
  auxiliary lane's id is also its `query_source` (`compact`); case 10 only pins
  the kind, which is what I implemented.
- **The `thinking` key guess was right too.** `context.mjs` reads
  `block.thinking`, falling back to `block.data` for `redacted_thinking`, so
  case 18's fixture shape is the one the parser expects.
- **`query_source: 'main'` collides with `MAIN_LANE_ID`.** If a CLI ever sends
  the metric-side category on an *event*, `laneOfQuerySource('main')` returns
  `{ id: 'main', kind: 'agent' }`, which then merges into the existing main lane
  by id. The outcome is right by accident rather than by design. I left it: the
  plan defines the rule as `repl_main_thread`/absent → main and nothing else,
  and widening it is a decision I was not given. The demo emitter no longer
  produces the case.
- **No case covers the interface**, per the plan's own "What is left untested".
  AC3 and AC6 are reviewed by reading `renderTimeline`, `renderSlicePanel`,
  `loadTimeline`, `loadSlice` and the scrub/live/lane handlers in `wireEvents`.
