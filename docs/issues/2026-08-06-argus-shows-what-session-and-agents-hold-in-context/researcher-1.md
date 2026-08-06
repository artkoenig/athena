# Research handoff — correction round 1

The reviewer raised one finding: `docs/issues/2026-08-06-argus-shows-what-session-and-agents-hold-in-context/reviewer.md`, "Finding 1 — the per-agent Tools table reports 0 failures for a tool that failed".
This round fixes that one finding and nothing else. Everything the reviewer
checked and passed stays as it is.

## The defect, restated from the code

`tools/argus/src/store.mjs` writes every tool figure to two buckets — the
session and the agent — except one. In the `SPAN.tool` branch (lines 469-491)
`calls`, `durationMsTotal` and a present `result_tokens` go to both
`this.#tool(session, ...)` and `this.#tool(agent, ...)`. In the
`EVENT.toolResult` branch (lines 634-654) `stats.failures++` writes to the
session bucket alone, and that is the only `failures++` in the file. So
`agent.tools[].failures` is 0 for every agent, every tool, always, while
`agent.counts.toolFailures` (fed by the `SPAN.toolExecution` branch, line 492)
is not — one panel says "1 failed" over a table row saying "0 failures".

The same asymmetry hits a second field in the same branch pair: the result-token
fallback (`#applyResultTokenFallback` / `#applyResultBytesFallback`, lines
326-353) applies its estimate to the session's tool stats only, so
`agent.tools[].resultTokens` is 0 whenever the CLI omits `result_tokens` —
which per the comment at lines 83-95 is every real call. It is served on
`GET /api/sessions/:id/agents`. Both fields are wrong for the same reason: the
`tool_use_id` join was written before the agent axis existed and never learned
about it. Fix both in the one join.

The event carries no attribution of its own, so the join is the only route: the
`claude_code.tool` span carries `agent_id`/`query_source` and `tool_use_id`, the
`claude_code.tool_result` event carries `tool_use_id`, `tool_name` and
`success`. Spans and logs travel on independent OTLP pipelines, so either side
may arrive first — the existing pending-map pair already handles both orders and
the fix keeps that shape.

## Implementation plan

All production code changes are in `tools/argus/src/store.mjs`. No other source
file changes.

### 1. Replace the two pending maps with one join pair

In `newSession` (lines 150-156) replace

```js
    pendingToolSpanStats: new Map(),
    pendingToolResultBytes: new Map(),
```

with two maps that carry the whole join, keyed by `tool_use_id`:

- `pendingToolSpans` — `tool_use_id -> the `claude_code.tool` span record`, set
  when the span arrives before its result event.
- `pendingToolResults` — `tool_use_id -> { bytes: number|null, failed: boolean }`,
  set when the result event arrives before its span.

Keep the existing comment's point (the two signals flush independently, so
arrival order is never guaranteed) and extend it to say the entry is deleted the
moment the two meet.

**Store the span record, never a stats object.** The current code parks a
reference to the session's tool-stats object, which is safe only because session
buckets are never replaced. An agent bucket is: `agentBucketFor` folds an
id-keyed bucket (`id:a7`) into the named one as soon as a record carries both
`agent_id` and `agent.name`, and `mergeAgent` copies numbers into a fresh stats
object and deletes the orphan (`tools/argus/src/agents.mjs:186-195, 197-209`).
A parked stats reference would then point into a discarded bucket and the
increment would vanish. Parking the span record and re-resolving the bucket at
join time follows the fold instead. Re-calling `this.#agent(session, span)` for
the same record is idempotent: it only does `Math.min`/`Math.max` on the
timestamps and `Set.add` on the ids.

### 2. Register the span unconditionally

In the `SPAN.tool` branch, keep `calls`/`durationMsTotal` and the present-
`result_tokens` path exactly as they are (both buckets), and replace the
`else this.#applyResultTokenFallback(...)` call with an unconditional join
registration for any span carrying a `tool_use_id`. A span whose
`result_tokens` is present must still register, because the join now also
carries the failure. Delete the comment at lines 478-479 ("…so it stays
session-level and is not duplicated"), which the fix makes false.

### 3. Register the result and apply the join

In the `EVENT.toolResult` branch, keep every session-level line unchanged —
`session.capture.*`, `session.todos.callsSeen`, `stats.failures++`,
`session.lastError`, `#applyTodo` — and replace the
`#applyResultBytesFallback(...)` call with a registration of
`{ bytes, failed }`, where `bytes` is `num(attrs.tool_result_size_bytes, NaN)`
kept only when finite (otherwise `null`) and `failed` is `!bool(attrs.success)`.
Registering on the failure alone matters: a failed tool result often carries no
`tool_result_size_bytes`, and today's `#applyResultBytesFallback` returns early
in that case, so the failure would never reach the join.

Rewrite the comment at lines 636-638. Per-agent tool *calls* still come from the
spans, and that sentence stays true; what has to be added is that a failure
reaches the agent through the `tool_use_id` join rather than by counting this
event, which carries no attribution.

The apply step, given the parked span record and the result entry:

- resolve `const agent = this.#agent(session, span)` and
  `const agentStats = this.#tool(agent, span.attrs.tool_name)`; resolve
  `const stats = this.#tool(session, span.attrs.tool_name)` the same way.
- if `span.attrs.result_tokens === undefined` and `bytes !== null`, add
  `estimateTokensFromBytes(bytes)` to `resultTokens` and
  `resultTokensEstimated` on **both** `stats` and `agentStats`.
- if `failed`, increment `agentStats.failures` only.

Delete both entries from their maps when they meet, so a retransmitted event
cannot count a failure twice.

### 4. What must not change

- `session.tools[].failures` keeps coming from the `EVENT.toolResult` branch
  directly. The join must not add to it, or the session table doubles.
- `agent.counts.toolFailures` keeps coming from the `SPAN.toolExecution` branch
  alone. The join must not touch it, or the KPI doubles.
- `session.counts.toolFailures`, `toolFailuresFromEvents` (store.mjs:1164) and
  the whole `summarizeSession` shape stay as they are.
- A failed `tool_result` whose `tool_use_id` matches no `claude_code.tool` span
  stays on the session and reaches no agent. Without a span there is no
  attribution, and there is no contradiction on screen either: with no span the
  agent has no row for that tool and no `counts.toolFailures` for it.

### Alternatives rejected

- **Drop the `Failures` column from the agent tools table**
  (`tools/argus-ui/public/app.js:594,602`), the reviewer's other way out.
  Rejected: the data is there and the join that recovers it already exists, so
  this would hide an answer the collector can give, and the agent table would
  stop matching the session table column for column.
- **Count the failure off the `claude_code.tool.execution` span**, which does
  carry the agent. Rejected: that span carries no `tool_name` (see
  `tools/argus/scripts/demo-emit.mjs:250-268` and the fixture at
  `tools/argus/test/store.test.mjs:144-148`), so it cannot name the row to
  increment.
- **Compute per-agent failures at read time in `summarizeAgent`**, walking the
  raw windows the way `collectAgentContent` does. Rejected: `summarizeAgent`
  takes no store, and every other agent figure is cumulative on purpose so it
  survives eviction of the raw window.
- **Cap the pending maps.** Rejected as out of scope: an entry is deleted on
  join, the unjoined remainder is the pre-existing behaviour of the token
  fallback (which already registers on effectively every tool span, since the
  CLI never sends `result_tokens`), and a cap would change the token-fallback
  behaviour this finding does not touch.

## Module map

- `tools/argus/src/store.mjs` — the only file to change. `newSession` (97-172)
  holds the per-session buckets and the pending maps; `#tool`/`#model`/`#agent`
  (296-319) resolve a bucket; `#applyResultTokenFallback` /
  `#applyResultBytesFallback` (321-353) are the join being replaced;
  `#applySpan` (422-515) holds the `SPAN.tool` and `SPAN.toolExecution`
  branches; `#applyLog` (548-668) holds the `EVENT.toolResult` branch;
  `getSessionAgents` (932-940) and `summarizeSession` (1132) are the read paths.
- `tools/argus/src/agents.mjs` — not changed. `emptyToolStats` (56-67) defines
  the `failures`/`resultTokens`/`resultTokensEstimated` fields,
  `agentBucketFor` (162-195) and `mergeAgent` (214-247) implement the id → name
  fold the join has to survive, `summarizeTools` (106-115) serves the table.
- `tools/argus/src/claude.mjs` — not changed. `agentRefOf` (230-251), `num`,
  `bool`, `SPAN`, `EVENT`.
- `tools/argus-ui/public/app.js` — not changed. `renderAgentTools` (584-610)
  renders the column that was always zero; it starts showing real numbers with
  no edit.
- `tools/argus/README.md`, `skills/argus/SKILL.md` — not changed. Neither
  documents per-tool field semantics (only the three routes, already correct).

Nothing under `agents/`, `skills/` or `workflows/` changes, so
`rm -rf ~/.claude/plugins/cache/uroboros` is not needed this round.

## Environment

Node ≥ 20.11, already installed. `tools/argus` has zero runtime and zero dev
dependencies, so no `npm install` is needed before any command below.

- Run the whole `tools/argus` suite: `npm --prefix tools/argus test --silent`
  (`node --test "test/*.test.mjs"`).
- Run one test file: `node --test tools/argus/test/agents.test.mjs`.
- Run the whole repository suite: `bash test.sh`. Not `./test.sh` — the file is
  mode `100644` in git on `main`, so invoking it directly exits 126
  (`Permission denied`). Do not set the executable bit; no criterion asks for
  it and the reviewer already recorded it as pre-existing.
- There is no linter, no formatter and no build step in this repository.

## Test plan

**Whether.** Tests are needed. The finding is a behaviour defect, so it gets a
failing test first: the cases below must fail against the current
`tools/argus/src/store.mjs` and pass after the fix.

**How, for every case below.** Level: unit, against `TelemetryStore` through its
public ingest and read API. File: `tools/argus/test/agents.test.mjs` (per-agent
behaviour lives there; `store.test.mjs` owns the session-level view and keeps
its existing fallback cases untouched). Framework: `node:test` with
`node:assert/strict`, both already imported at the top of the file. Conventions
in that file, to follow: the `log(eventName, attrs, timeMs)`,
`span(name, attrs, extra)` and `metric(...)` helpers at lines 9-61 build the
records; `SESSION` is `'sess-1'` and every fixture attribute set is merged over
`{'session.id': SESSION}` by those helpers; `NOW` is captured once at module
load and span offsets are given as `{spanId, parentSpanId, startMs, endMs}` in
`extra`, because a span older than the retention window is evicted on ingest;
every test constructs its own `new TelemetryStore()` with no shared setup and no
`beforeEach`; nothing is mocked or faked — real records go in through
`store.ingest('traces'|'logs'|'metrics', [...])`; test names are lower-case
declarative sentences stating the behaviour ("the session total is the sum of
its agents"). Command that runs just this file:
`node --test tools/argus/test/agents.test.mjs`.

**What.** Six cases, all new, all in `tools/argus/test/agents.test.mjs`,
appended after the existing tests.

1. **A failed tool call counts against the agent that made it (span first).**
   Ingest traces: `span('claude_code.tool', {tool_name: 'Bash', tool_use_id: 'tu-1', agent_id: 'a1', query_source: 'agent:builtin:Explore'}, {spanId: 'tool-1'})`
   and `span('claude_code.tool.execution', {success: 'false', agent_id: 'a1', query_source: 'agent:builtin:Explore'}, {spanId: 'exec-1', parentSpanId: 'tool-1'})`.
   Then ingest logs:
   `log('claude_code.tool_result', {tool_name: 'Bash', tool_use_id: 'tu-1', success: 'false', error_type: 'ENOENT'})`.
   Expected, from `store.getSessionAgents(SESSION)`: the `Explore` agent's
   `tools` row for `Bash` has `calls === 1` and `failures === 1`, and its
   `counts.toolFailures === 1` — the row and the KPI agree, which is what the
   finding is about. From `store.getSession(SESSION)`: the `Bash` row still has
   `failures === 1`, unchanged. The `main` agent, which the unattributed
   `tool_result` opens, has `tools.length === 0`.
2. **The order the two signals arrive in does not matter.** The same three
   records as case 1, with the `logs` ingest call before the `traces` one.
   Expected: identical assertions on the `Explore` agent's `Bash` row
   (`calls === 1`, `failures === 1`). This is the edge that the two independent
   OTLP pipelines make real.
3. **A successful tool call adds no failure, and its result tokens reach the
   agent.** Ingest
   `span('claude_code.tool', {tool_name: 'Bash', tool_use_id: 'tu-2', agent_id: 'a1', query_source: 'agent:builtin:Explore'}, {spanId: 'tool-2'})`,
   then
   `log('claude_code.tool_result', {tool_name: 'Bash', tool_use_id: 'tu-2', success: 'true', tool_result_size_bytes: 400})`.
   Expected: the `Explore` agent's `Bash` row has `calls === 1`,
   `failures === 0`, `resultTokens === 100` and `resultTokensEstimated === 100`;
   the session's `Bash` row still has `resultTokens === 100` and
   `resultTokensEstimated === 100`. This is the repeat edge that would catch a
   fix that increments on every join instead of on a failure only.
4. **A real `result_tokens` attribute is not re-estimated on the agent either.**
   Ingest
   `span('claude_code.tool', {tool_name: 'Bash', tool_use_id: 'tu-3', result_tokens: 42, agent_id: 'a1', query_source: 'agent:builtin:Explore'}, {spanId: 'tool-3'})`,
   then
   `log('claude_code.tool_result', {tool_name: 'Bash', tool_use_id: 'tu-3', success: 'false', tool_result_size_bytes: 999_999})`.
   Expected: the `Explore` agent's `Bash` row has `resultTokens === 42`,
   `resultTokensEstimated === 0` and `failures === 1`. This is the agent-side
   twin of `store.test.mjs:243`, and it pins that registering the span
   unconditionally did not turn the CLI's own figure into an estimate.
5. **A failed tool call with no span reaches no agent.** Ingest logs only:
   `log('claude_code.tool_result', {tool_name: 'Bash', tool_use_id: 'tu-9', success: 'false'})`.
   Expected: `store.getSession(SESSION)`'s `Bash` row has `failures === 1`,
   while every agent in `store.getSessionAgents(SESSION)` has
   `tools.length === 0`. This is the empty edge — no attribution in, no
   attribution out — and it pins that the join does not invent a bucket.
6. **A failure joins the named bucket after the id-only bucket was folded into
   it.** Ingest traces:
   `span('claude_code.tool', {tool_name: 'Bash', tool_use_id: 'tu-7', agent_id: 'a7'}, {spanId: 'tool-7'})`
   — with no `query_source` this opens the `id:a7` bucket. Then ingest logs:
   `log('claude_code.api_request', {model: 'claude-opus-5', input_tokens: 10, 'agent.name': 'Explore', query_source: 'agent:builtin:Explore', agent_id: 'a7'})`,
   which teaches the session that `a7` is `Explore` and folds the orphan away.
   Then ingest logs:
   `log('claude_code.tool_result', {tool_name: 'Bash', tool_use_id: 'tu-7', success: 'false'})`.
   Expected: no agent key starts with `id:`, and the `Explore` agent's `Bash`
   row has `calls === 1` and `failures === 1`. This is the case that fails if
   the implementation parks a stats reference instead of the span record.

**Left untested, deliberately.** The `Failures` column in
`tools/argus-ui/public/app.js` — `public/` has no test harness in this
repository and `tools/argus-ui/test/` holds only `config`, `server` and
`independence`; the column reads the field this change fixes and needs no edit.
The `SPAN.toolExecution` path feeding `counts.toolFailures`, the session-level
`failures` counting and the two existing result-token fallback cases in
`store.test.mjs` — all unchanged by this fix and already covered there.
Persistence and replay — they carry raw records only
(`tools/argus/src/persist.mjs:159-163`), so renaming a session-internal map
cannot reach them.

**What counts as done.** These two commands, run from the repository root,
and nothing else:

- `npm --prefix tools/argus test --silent`
- `bash test.sh`

**What is already red.** I ran neither command and no other. From reading: the
six new cases are red until the fix lands, which is their point; nothing else in
`tools/argus/test/` asserts a per-agent tool `failures` or `resultTokens` value,
so no existing case has to be edited, and `store.test.mjs:196-259` keeps passing
because every session-level line stays where it is. The one pre-existing red the
reviewer recorded is `./test.sh` exiting 126 for the missing executable bit,
which is why the list says `bash test.sh`.
