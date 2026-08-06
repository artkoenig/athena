# Implementer handoff — argus shows what the session and each agent hold in context

The plan is implemented in full and `bash ./test.sh` is green: 5 suites, exit 0,
nothing skipped and nothing excluded. No test was written or edited.

## Commands run

Confirming red before any edit, exactly as the test-author recorded:

- `node --test tools/argus/test/claude.test.mjs` — 1 entry (whole-file import
  failure on `agentRefOf`), 0 pass, 1 fail, exit 1.
- `node --test tools/argus/test/agents.test.mjs` — 23 tests, 0 pass, 23 fail,
  exit 1.
- `node --test tools/argus/test/server.test.mjs` — 22 tests, 17 pass, 5 fail,
  exit 1.

After implementing:

- `node --test tools/argus/test/claude.test.mjs` — 14 tests, 14 pass, exit 0.
- `node --test tools/argus/test/agents.test.mjs` — 23 tests, 23 pass, exit 0.
- `node --test tools/argus/test/server.test.mjs` — 22 tests, 22 pass, exit 0.
- `npm --prefix tools/argus test` — 170 tests, 170 pass, exit 0.
- `npm --prefix tools/argus-ui test` — 14 tests, 14 pass, exit 0.
- `node --check tools/argus-ui/public/app.js` — exit 0 (syntax only; the front
  end has no test file, per the plan's "Not tested, deliberately").
- **`bash ./test.sh`** — the closed list from the plan. 5 suites: repository
  (8 cases), worktree (4 cases), `tools/argus` (170 tests), `tools/argus-ui`
  (14 tests), `tools/log-parser` (23 tests). `PASS: all 5 suites`, exit 0.

`test.sh` is mode 644 in this checkout, so `./test.sh` fails with
`Permission denied` (exit 126) and it has to be invoked as `bash ./test.sh`.
That is pre-existing and unrelated to this change — do not `chmod` it as part of
this issue; it is a note for whoever owns the repository's own suite.

- `rm -rf ~/.claude/plugins/cache/uroboros` — run in the same turn as the
  `skills/argus/SKILL.md` edit, as the shared brief requires.

## What changed, by file

**`tools/argus/src/claude.mjs`** — added `EVENT.subagentCompleted`,
`MAIN_AGENT_KEY` and `agentRefOf(attrs)`, the one pure function that answers
which agent a record belongs to. Resolution order is the plan's: `agent.name`,
then `query_source` (main sources, `agent:…:<name>`, bare `subagent`,
`auxiliary`/`compact`, anything else as a bare name), then `agent_id`, then the
main session. `agentId` is returned on every branch — that is the join the store
learns aliases from.

**`tools/argus/src/agents.mjs`** (new) — the agent bucket and its read paths:
`newAgent`, `agentBucketFor` (with alias learning and alias use), `mergeAgent`,
`summarizeAgents`, `summarizeCapture`, `collectAgentContent`, `readAgentBody`,
plus the bounded-ring helper `pushRing`. `MAX_AGENT_CALLS` is 100 and
`MAX_AGENT_COMPLETIONS` is 50.

`emptyModelStats` and `emptyToolStats` **moved here** from `store.mjs`, and so
did `mergeUsage`/`hasTokens` and the new `summarizeModels`/`summarizeTools`
table builders that `summarizeSession` used to inline. There is exactly one copy
of each and the import runs one way only, `store.mjs → agents.mjs`, so there is
no cycle. `summarizeSession` now calls `summarizeModels`/`summarizeTools`; its
output is byte-for-byte what it was, which the pre-existing store tests confirm.

**`tools/argus/src/store.mjs`** — `DEFAULTS.maxAgentCalls`, `session.agents`,
`session.agentByAgentId` and the `session.capture` block; `#agent()` resolves the
bucket once at the top of `#applySpan`, `#applyLog` and `#applyMetric`, and every
place the session is updated the agent is updated beside it. New:
`#applyOccupancy` (one context entry per `api_request`), `#applySubagentCompleted`
(re-attributes to `agent_type` when the event resolves to the main session), the
`api_request_body` metadata index, the capture flags, `summarizeSession`'s
`agentCount`, and the three query methods `getSessionAgents`, `getAgentContent`,
`getAgentBody`. `#model`/`#tool` take any bucket with a `models`/`tools` map; the
`result_tokens` fallback and `#delta` stay session-level, as planned.

**`tools/argus/src/server.mjs`** — the three routes in `handleApi`, placed after
the single-session match so `/api/sessions/:id` still wins its own path, each
segment through `decodeURIComponent`; and `limits.agentCalls` in `/api/config`.

**`tools/argus-ui/public/app.js`** — the `agents` tab: state fields, the tab
entry after Overview with an `agentCount` badge, the `loadTabData` branch,
`loadAgentBody` (fetched only on click, and re-clicking the same row closes it),
the agent picker, the KPI grid, the inline-SVG stacked context curve with a
`<title>` per bar, the models/tools/runs tables, the request-body list with its
parsed / truncated / evicted / `body_ref` renderings, the content list, and the
`[data-agent]` / `[data-body-seq]` click delegation. Every interpolated value
goes through `esc()`. Nothing is imported from `tools/argus`.

**`tools/argus-ui/public/styles.css`** — `.switch-hint`, `.context-curve` and its
legend, `.body-list`/`.body-row`/`.body-detail`/`.body-block`/`.body-raw`, and
`.content-list`/`.content-item`/`.content-head`. Existing classes (`panel`,
`kpi`, `chip`, `table-scroll`, `attr-table`, `placeholder`, `muted`,
`trace-pill`) are reused, not duplicated.

**Docs** — `tools/argus/README.md` (three routes, `src/agents.mjs`, the per-agent
lifetime and the `--max-logs 2000` advice, the request-body warning and
`OTEL_LOG_ASSISTANT_RESPONSES` under "Sensitive data", three new "Limits"
entries), `tools/argus-ui/README.md` (one "What it shows" bullet),
`skills/argus/SKILL.md` (a "See what was in the context" section and the three
routes in the route table).

## The test-author's four open questions, answered by the code

All four assumptions in `test-author.md` turned out to be the shape I built, so
no test needed adjusting and none was touched:

1. **`context` is a real sub-object** on the summarized agent, holding `series`,
   `peakOccupancy`, `lastOccupancy`, `lastCachedPrefixTokens`, `lastFreshTokens`
   and `lastCachedPrefixRatio`. The internal bucket keeps the flat `occupancy`
   array the plan's §2 names; `summarizeAgents` is what nests and renames it.
   `lastCachedPrefixRatio` is `null`, not `0`, when the agent made no model call.
2. **`agent.durationMs`** is reported, computed as `lastSeenMs - firstSeenMs`,
   mirroring the session's own convention. `firstSeenMs`/`lastSeenMs` are served
   too.
3. **`session.counts.apiRequests`** already existed on the session before this
   change; nothing had to be added for case 11.
4. **Span events carry `.attrs`**, confirmed against `src/otlp/decode.mjs` line
   155. The content item's `output` is a copy of that event's attribute object.

## Notes for the reviewer

- **`capture.requestBodies.seen` counts `api_request_body` events, not
  `api_request` events.** The plan's §3 wrote `seen: apiRequests`, but the
  capture block it defines two paragraphs earlier has no such field — it has
  `requestBodyEvents`, and every other entry in the report counts the records of
  the kind that would carry the content. I read `apiRequests` as a slip and used
  `requestBodyEvents`. No test pins it either way (case 29 asserts `seen === 0`
  in a fixture where both counts are 0). If the intent was "0 of 12 model calls
  captured a body", this is a one-line change.
- **`SPAN.toolBlocked` rejections are counted per agent too**, which the plan
  does not name either way. The span carries `agent_id`, so it can be attributed;
  `EVENT.toolDecision` cannot and stays session-only.
- **Model `errors` on `llm_request` spans are per-agent**, and so is the
  `result_tokens` value when the CLI does send it. Only the *estimated* fallback
  (joined from a `tool_result` event that carries no attribution) stays
  session-level, exactly as the plan says.
- **The front end is unverified beyond `node --check` and reading.** The plan
  records that deliberately — there is no DOM harness and adding one would need a
  dependency both `CLAUDE.md` files forbid. The rendering wants a read.
- **Nothing was left red and nothing was left open.** No question blocks this
  handoff.
