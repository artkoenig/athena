# Researcher handoff — argus shows what the session and each agent hold in context

## What this change is

argus gains a second axis of aggregation: inside a session, one bucket per
**agent** — the main session plus every subagent that ran in it. Each agent
carries its own tokens, cost, models, tool calls, wall time, a context
occupancy series with one entry per model call, an index of the raw request
bodies of those calls, and whatever `claude_code.subagent_completed` said about
it. Three new JSON routes serve that, and `argus-ui` gains an "Agents" tab that
shows the curve, the figures and the content per agent.

## Facts this plan rests on

The issue's measured table is taken as given. One lookup was made beyond it:
the Claude Code monitoring documentation (`code.claude.com/docs/en/monitoring-usage`),
because the issue does not say which switch gates the assistant response text
nor which records carry the attribution attributes. It states:

- `agent.name`, `query_source` appear on `api_request`, `api_error`,
  `api_refusal`, `api_request_body`, `api_response_body`, `assistant_response`
  and on the `cost`/`token` metrics. **Not** on `user_prompt` and **not** on
  `tool_result`.
- `query_source` values: `main`, `repl_main_thread`, `subagent`, `auxiliary`,
  `compact`, or a subagent name. It is also on the `llm_request` **span**.
  (The measured main-session value `sdk` is not in that list; treat it as main.)
- `agent_id` (and `parent_agent_id`) are on the `llm_request` span and the
  `claude_code.tool` span, absent on the main session.
- `agent.name` is `"custom"` for user-defined agents and third-party plugins
  unless `OTEL_LOG_TOOL_DETAILS=1`.
- `OTEL_LOG_ASSISTANT_RESPONSES=1` gates the `response` attribute, falling back
  to `OTEL_LOG_USER_PROMPTS` when unset. That is a fifth switch the issue does
  not name; it is named where responses are missing.
- `OTEL_LOG_TOOL_CONTENT=1` puts tool input/output on a **span event** named
  `tool.output` on the `claude_code.tool` span, not on the `tool_result` log
  event, and needs `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`. That is why the
  measured run saw no tool result text: it was looking at the event.
- `OTEL_LOG_RAW_API_BODIES` may also be `file:<dir>`, in which case the event
  carries `body_ref` (a path) instead of `body`. Treat `body_ref` as "the
  payload is not in the telemetry" and say so; never read that path.

No command was run for this plan and no test was executed.

## Technical decisions

**An agent is identified by its name, and `agent_id` is joined onto that name.**
Resolution is one pure function over a record's attributes (below). Records that
carry only `agent_id` (spans) open an id-keyed bucket; as soon as any record
carries that same `agent_id` together with a name, the id-keyed bucket is merged
into the named one. Nothing is guessed: the join is on an identifier the CLI
puts on both records.

**A record naming no agent is the main session**, per the acceptance criterion.
So `user_prompt` and `tool_result` events, which carry no attribution at all,
land on the main session — except that per-agent tool calls are counted from
`claude_code.tool` spans, which do carry `agent_id`. Consequence to state in the
README: without traces, every tool call is attributed to the main session.

**Two lifetimes, as the store already has them.** Per-agent *figures* (counts,
tokens, cost, models, occupancy, peak, body metadata, completions) are
cumulative and survive raw eviction. Per-agent *content* (prompt text, response
text, tool arguments, request payloads) is never copied into the agent: the
agent keeps the record's `seq`, and the read path joins against the existing
raw log/span windows. That is what makes acceptance criterion 12 true by
construction — bodies fall under the existing windows and retention because
they are only ever in them.

**Rejected: a separate window or a separate cap for request bodies.** It would
be a third lifetime to reason about and the criterion asks for the opposite.

**Rejected: deriving occupancy from `llm_request` spans.** The `api_request`
event carries model, all three token figures and the agent name in one record;
spans carry no agent name. Using both would double the series. Events only, and
when the session exported no `api_request` events the panel says
`OTEL_LOGS_EXPORTER=otlp` is what is missing.

**Rejected: parsing a truncated body, or repairing it.** Truncated is served as
truncated with the real `body_length`, `parsed: null`.

**Rejected: extending an existing tab** (the issue leaves this call to the
researcher). No existing tab answers anything per agent; Overview is the session
total and must stay readable as one. The Agents tab is a new tab in the same
detail pane, so it is reachable without leaving the session.

**Rejected: touching `scripts/demo-emit.mjs`, `argus env`, and
`claude_code.api_response_body`.** Out of scope; do not add them.

## Module map

| Path | What it holds | Entry points |
| --- | --- | --- |
| `tools/argus/src/claude.mjs` | Claude Code attribute/event/metric names and pure attribute readers. `EVENT`, `attributionOf`, `num`, `bool`, `toolParametersOf`. | **edit**: add `EVENT.subagentCompleted`, `MAIN_AGENT_KEY`, `agentRefOf` |
| `tools/argus/src/agents.mjs` | **new**: the agent bucket — creation, merge, summarize, content assembly, body lookup. | `newAgent`, `agentBucketFor`, `summarizeAgents`, `collectAgentContent`, `readAgentBody` |
| `tools/argus/src/store.mjs` | `TelemetryStore`: ingest, per-session aggregation (`#applySpan`, `#applyLog`, `#applyMetric`), eviction, queries, `summarizeSession`. 1026 lines. | **edit**: `session.agents`, update the agent alongside the session in the three apply paths, plus `getSessionAgents`, `getAgentContent`, `getAgentBody` |
| `tools/argus/src/server.mjs` | HTTP: OTLP ingest under `/v1/*`, read API under `/api/*` in `handleApi`, SSE. | **edit**: three routes in `handleApi`, `agentCalls` in `/api/config` limits |
| `tools/argus/README.md` | User-facing page: routes table (~line 519), "Sensitive data" (~488), "How data is kept" (~457), "Limits" (~542), architecture listing (~502). | **edit** |
| `tools/argus-ui/public/app.js` | The whole front end: `state`, `TABS`, `renderDetail`, `renderTabBody`, per-tab renderers, `loadTabData`, `wireEvents`. No framework, no build. | **edit**: `agents` tab |
| `tools/argus-ui/public/styles.css` | All styling. Existing classes to reuse: `panel`, `kpi-grid`/`kpi`, `chip`, `table-scroll`, `attr-table`, `placeholder`, `muted`, `trace-pill`, `ghost-button`. | **edit**: the curve and the agent cards |
| `tools/argus-ui/README.md` | "What it shows" bullet list. | **edit**: one bullet |
| `skills/argus/SKILL.md` | The session-facing procedure and the route table. | **edit** |

Both tool projects are zero-dependency ESM (`.mjs`), Node ≥ 20.11, no build
step; `tools/argus-ui` must keep importing nothing from `tools/argus` (guarded
by `tools/argus-ui/test/independence.test.mjs`).

## Implementation plan

### 1. `tools/argus/src/claude.mjs`

Add to `EVENT`:

```js
subagentCompleted: 'claude_code.subagent_completed',
```

Add the agent resolver, with a doc comment naming where each attribute comes
from (the fact list above):

```js
export const MAIN_AGENT_KEY = 'main';
const MAIN_QUERY_SOURCES = new Set(['main', 'repl_main_thread', 'sdk', 'cli']);
const SYSTEM_QUERY_SOURCES = new Set(['auxiliary', 'compact']);
const UNNAMED_SUBAGENT_KEY = 'subagent';

/** @returns {{key: string, name: string|null, kind: 'main'|'subagent'|'system', agentId: string|null}} */
export function agentRefOf(attrs = {}) { … }
```

Resolution order, first match wins; empty strings count as absent:

1. `agent.name` non-empty → `{ key: <name>, name: <name>, kind: 'subagent' }`.
2. `query_source`:
   - in `MAIN_QUERY_SOURCES` → main.
   - matches `/^agent:(?:.*:)?(.+)$/` → subagent named by the capture
     (`agent:builtin:Explore` → `Explore`).
   - `subagent` → `{ key: 'subagent', name: null, kind: 'subagent' }`.
   - in `SYSTEM_QUERY_SOURCES` → `{ key: <value>, name: <value>, kind: 'system' }`.
   - anything else → subagent named by the value (the docs list a bare subagent
     name as a possible value and enumerate every non-name value).
3. `agent_id` non-empty → `{ key: 'id:' + agentId, name: null, kind: 'subagent' }`.
4. otherwise → `{ key: MAIN_AGENT_KEY, name: null, kind: 'main' }`.

`agentId` on the returned ref is always `attrs.agent_id || null`, whichever
branch matched — that is what the store learns the alias from.

### 2. `tools/argus/src/agents.mjs` (new)

Bounds, as module constants:

```js
export const MAX_AGENT_CALLS = 100;      // occupancy entries and body index entries per agent
const MAX_AGENT_COMPLETIONS = 50;
```

`MAX_AGENT_CALLS` is overridable per store through the new
`maxAgentCalls` option so a test can force the ring to roll over.

`newAgent(ref, atMs)` returns:

```js
{
  key, name, kind,
  agentIds: new Set(), querySources: new Set(),
  firstSeenMs: atMs, lastSeenMs: atMs,
  counts: { apiRequests: 0, apiErrors: 0, llmRequests: 0, userPrompts: 0,
            assistantResponses: 0, toolCalls: 0, toolFailures: 0 },
  tokensMetric: EMPTY_TOKENS(), tokensEvent: EMPTY_TOKENS(),
  costMetric: 0, costEvent: 0,
  models: new Map(),            // same shape as session.models (emptyModelStats)
  tools: new Map(),             // same shape as session.tools (emptyToolStats)
  occupancy: [],                // ring, MAX_AGENT_CALLS
  peakOccupancy: 0, lastOccupancy: 0,
  lastCachedPrefixTokens: 0, lastFreshTokens: 0,
  bodies: [],                   // ring, MAX_AGENT_CALLS — metadata only
  completions: [],              // ring, MAX_AGENT_COMPLETIONS
}
```

`emptyModelStats` and `emptyToolStats` are private to `store.mjs` today; export
them from `store.mjs` and import them here, or move both into `agents.mjs` and
import them back into `store.mjs` — either is fine, but only one copy may exist.

`agentBucketFor(session, record, ref)`:

- Look up `session.agents.get(ref.key)`, creating it when absent.
- Widen `firstSeenMs`/`lastSeenMs` from the record's times
  (`record.startMs || record.timeMs`, and `record.endMs || …` for the upper bound).
- Record `ref.agentId` in `agent.agentIds` and `attrs.query_source` in
  `agent.querySources`.
- **Alias learning**: when `ref.agentId` is set and `ref.key !== 'id:' + ref.agentId`,
  write `session.agentByAgentId.set(ref.agentId, ref.key)` and, if a bucket
  `'id:' + ref.agentId` exists, merge it into this one and delete it.
- **Alias use**: before creating a bucket for key `'id:<x>'`, check
  `session.agentByAgentId.get(x)` and use that key instead when known.

`mergeAgent(target, source)`: add every counter, every token figure and every
cost; merge the `models`/`tools` maps field by field; concatenate the three
rings, sort by `atMs` ascending, and trim to their bound; take the max of
`peakOccupancy`; take the `last*` fields from whichever agent has the later
`lastSeenMs` among those that recorded a model call; widen first/last seen;
union the id and query-source sets.

`summarizeAgents(session)` returns the array the API serves (shape below),
sorted main first, then `subagent` by `firstSeenMs`, then `system`. It reuses
`mergeUsage` from `store.mjs` for tokens/cost so per-agent figures follow the
same metrics-beat-events rule the session total follows. `label` is computed
here:

- `main` → `main session`
- named subagent → the name
- key `subagent` → `subagent (name not exported)`
- key `id:<x>` → `subagent ${x.slice(0, 8)}`
- system → the query source value

`collectAgentContent(store, session, agentKey, { limit })` — read path, no
state of its own:

1. Build `toolResultByUseId`: one pass over `store.logs`, keeping this
   session's `EVENT.toolResult` records keyed by `attrs.tool_use_id`.
2. Prompt and response items: this session's `EVENT.userPrompt` and
   `EVENT.assistantResponse` logs whose `agentRefOf(attrs)` key (after alias
   resolution through `session.agentByAgentId`) equals `agentKey`. Fields:
   `{ kind: 'prompt'|'response', seq, atMs: log.timeMs, text: attrs.prompt ?? attrs.response ?? null, length: num(attrs.prompt_length ?? attrs.response_length) }`.
3. Tool items: this session's `SPAN.tool` spans resolving to `agentKey`. Fields:
   `{ kind: 'tool', seq, atMs: span.startMs, durationMs, toolName: attrs.tool_name, toolUseId: attrs.tool_use_id ?? null, detail: attrs.file_path ?? attrs.full_command ?? null }`,
   plus, from the joined `tool_result` when there is one:
   `success: bool(...)`, `arguments: toolParametersOf(...)`,
   `inputBytes: num(attrs.tool_input_size_bytes)`,
   `resultBytes: num(attrs.tool_result_size_bytes)`, `resultAvailable: true`,
   and `output`: the attrs of the span event named `tool.output` when present,
   else `null`.
4. Tool items with no span: any `tool_result` log of this session whose
   `tool_use_id` matched no `SPAN.tool` span in the window is emitted **on the
   main agent only** — that is the traces-off case, and those events carry no
   attribution.
5. Sort ascending by `(atMs, seq)`, keep the last `limit`, return
   `{ items, truncated: <cut anything>, windowed: true }`.

`readAgentBody(store, session, agent, seq)`:

- No entry with that `seq` in `agent.bodies` → return `null` (server: 404
  `unknown request body`).
- Entry found but no log with that `seq` left in `store.logs` → return
  `{ ...entry, available: false }` (server: 404, `error: 'request body is no
  longer buffered'`, with `bodyLength`, `truncated`, `atMs`).
- Otherwise `{ ...entry, available: true, body, parsed, parseError }`:
  - `body = typeof attrs.body === 'string' ? attrs.body : null`; when the event
    carries `body_ref` instead, `body` stays `null` and `bodyRef` is returned so
    the UI can say the payload went to a file.
  - `truncated = bool(attrs.body_truncated) || bodyLength > deliveredBytes`,
    with `deliveredBytes = Buffer.byteLength(body ?? '')` and
    `bodyLength = num(attrs.body_length, deliveredBytes)`.
  - `parsed`: `null` when truncated or when `body` is `null`; otherwise
    `JSON.parse(body)` inside a `try`, with `parseError` set to the error
    message and `parsed: null` on failure.

### 3. `tools/argus/src/store.mjs`

- `DEFAULTS` gains `maxAgentCalls: 100`.
- `newSession` gains `agents: new Map()`, `agentByAgentId: new Map()` and a
  `capture` block:

```js
capture: {
  promptEvents: 0, promptText: false,
  responseEvents: 0, responseText: false,
  toolResultEvents: 0, toolArguments: false, toolOutputContent: false,
  requestBodyEvents: 0, requestBodies: false,
}
```

- In `#applySpan`, `#applyLog` and `#applyMetric`, resolve the agent once at the
  top (`const ref = agentRefOf(record.attrs); const agent = agentBucketFor(session, record, ref);`)
  and update the agent wherever the session is updated:
  - `SPAN.llmRequest` → `agent.counts.llmRequests`, and the same
    `#model(agent, attrs.model)` update the session gets (`requests`,
    `durationMsTotal`, ttft, errors). `#model` and `#tool` take any bucket with
    a `models`/`tools` map — widen their parameter name, nothing else changes.
  - `SPAN.tool` → `agent.counts.toolCalls`, `#tool(agent, attrs.tool_name).calls`.
    Leave the `result_tokens` fallback machinery session-level; do not duplicate it.
  - `SPAN.toolExecution` failure → `agent.counts.toolFailures`.
  - `EVENT.userPrompt` → `agent.counts.userPrompts`; `capture.promptEvents++`,
    `capture.promptText ||= typeof attrs.prompt === 'string' && attrs.prompt !== ''`.
  - `EVENT.assistantResponse` → new `agent.counts.assistantResponses`;
    `capture.responseEvents++`, `capture.responseText ||= …attrs.response…`.
    The session gains no new counter for this.
  - `EVENT.apiRequest` → `agent.counts.apiRequests`, the same token/cost
    accumulation into `agent.tokensEvent`/`agent.costEvent` and into
    `#model(agent, …).tokensEvent/costEvent`, **and** the occupancy entry:

    ```js
    const occupancy = tokens.input + tokens.cacheRead + tokens.cacheCreation;
    agent.occupancy.push({ atMs: log.timeMs, model: attrs.model ?? null,
      inputTokens: tokens.input, cacheReadTokens: tokens.cacheRead,
      cacheCreationTokens: tokens.cacheCreation, outputTokens: tokens.output, occupancy });
    if (agent.occupancy.length > maxAgentCalls) agent.occupancy.shift();
    agent.peakOccupancy = Math.max(agent.peakOccupancy, occupancy);
    agent.lastOccupancy = occupancy;
    agent.lastCachedPrefixTokens = tokens.cacheRead;
    agent.lastFreshTokens = tokens.input + tokens.cacheCreation;
    ```

  - `EVENT.apiError` / `EVENT.apiRefusal` → `agent.counts.apiErrors`,
    `#model(agent, …).errors`.
  - `EVENT.toolResult` → `capture.toolResultEvents++`,
    `capture.toolArguments ||= toolParametersOf(attrs) !== null`. Tool counts
    per agent stay span-derived (these events carry no attribution).
  - `EVENT.apiRequestBody` → `capture.requestBodyEvents++`,
    `capture.requestBodies = true`, and push the metadata entry
    `{ seq: log.seq, atMs: log.timeMs, model: attrs.model ?? null, bodyLength,
      deliveredBytes, truncated, hasPayload: typeof attrs.body === 'string' }`
    onto `agent.bodies`, trimmed to `maxAgentCalls`.
  - `EVENT.subagentCompleted` → attribute with `agentRefOf`, but when that
    resolves to the main session and `attrs.agent_type` is non-empty, use
    `agent_type` as the subagent name: the event is by definition about a
    subagent. Push
    `{ atMs, agentType, source: attrs['agent.source'] ?? null, isBuiltIn: bool(attrs.is_built_in),
       isAsync: bool(attrs.is_async), model: attrs.model ?? null, finalModel: attrs.final_model ?? null,
       modelSwapped: bool(attrs.model_swapped), totalTokens: num(attrs.total_tokens),
       totalToolUses: num(attrs.total_tool_uses), durationMs: num(attrs.duration_ms) }`
    onto `agent.completions`, trimmed.
  - Metrics `METRIC.token` / `METRIC.cost` → add the **same** `delta` the
    session gets into `agent.tokensMetric[type]` / `agent.costMetric` and into
    `#model(agent, attrs.model)`. `#delta` stays session-level: its series key
    already includes the agent attributes, so the value is per-series correct.
  - In `#applySpan`, set `capture.toolOutputContent = true` when a `SPAN.tool`
    span carries a span event named `tool.output`.
- `summarizeSession` gains `agentCount: session.agents.size` and nothing else.
- New query methods, each returning `null` for an unknown session or agent:
  `getSessionAgents(id)` → `{ sessionId, capture: summarizeCapture(session), agents: summarizeAgents(session) }`;
  `getAgentContent(id, agentKey, { limit })`; `getAgentBody(id, agentKey, seq)`.
- `summarizeCapture(session)` builds the switch report:

```js
{
  prompts:       { switch: 'OTEL_LOG_USER_PROMPTS', present, seen: promptEvents },
  responses:     { switch: 'OTEL_LOG_ASSISTANT_RESPONSES', fallbackSwitch: 'OTEL_LOG_USER_PROMPTS', present, seen: responseEvents },
  toolArguments: { switch: 'OTEL_LOG_TOOL_DETAILS', present, seen: toolResultEvents },
  toolContent:   { switch: 'OTEL_LOG_TOOL_CONTENT', requires: 'CLAUDE_CODE_ENHANCED_TELEMETRY_BETA', present, seen: toolResultEvents },
  requestBodies: { switch: 'OTEL_LOG_RAW_API_BODIES', present, seen: apiRequests },
}
```

### 4. `tools/argus/src/server.mjs`

In `handleApi`, after the existing single-session match:

- `^\/api\/sessions\/([^/]+)\/agents$` → `store.getSessionAgents(id)`; 404
  `{ error: 'unknown session' }` when null.
- `^\/api\/sessions\/([^/]+)\/agents\/([^/]+)\/content$` →
  `store.getAgentContent(id, key, { limit: intParam(searchParams, 'limit', 200, 2000) })`;
  404 `{ error: 'unknown agent' }` when null.
- `^\/api\/sessions\/([^/]+)\/agents\/([^/]+)\/body\/(\d+)$` →
  `store.getAgentBody(id, key, Number(seq))`; 404 `{ error: 'unknown request body' }`
  when null, 404 `{ error: 'request body is no longer buffered', … }` when
  `available === false`, else 200.

Every path segment goes through `decodeURIComponent`. `/api/config`'s `limits`
gains `agentCalls: store.options.maxAgentCalls`. Nothing else in the server
changes; the token gate and the method gate already cover these paths.

### 5. `tools/argus-ui/public/app.js`

- `state` gains `agents: null`, `capture: null`, `selectedAgentKey: null`,
  `agentContent: null`, `agentBody: null`.
- `TABS` gains `{ id: 'agents', label: 'Agents' }` directly after Overview, with
  a count badge from `session.agentCount`.
- `loadTabData()` for `agents`: fetch `/api/sessions/:id/agents`, pick
  `selectedAgentKey` (keep the current one when it is still there, else the
  first), then fetch that agent's `/content?limit=200`. `agentBody` is loaded
  only on click and reset when the agent or session changes.
- `renderAgentsTab()`:
  - An agent picker row reusing `trace-pill` markup: label, kind chip, tokens,
    cost, model-call count.
  - A KPI grid (`kpi()` helper) for the selected agent: tokens, cost, model
    calls, tool calls, peak occupancy, last occupancy, cached prefix
    (`lastCachedPrefixTokens` and the percentage, `–` when `lastOccupancy` is 0),
    wall time.
  - The context curve as an inline SVG built as a string — one stacked bar per
    occupancy entry, segments in order cache read / input / cache creation, a
    `<title>` per bar with the exact figures and the clock time, y-axis scaled
    to `peakOccupancy`. No library, no canvas.
  - The models table and the tools table for that agent, same markup as the
    Overview tables.
  - A completions table when `completions.length`, with every field the store
    recorded.
  - A "Request bodies" panel listing `bodies` (time, model, size, a `truncated`
    chip); clicking one loads
    `/api/sessions/:id/agents/:key/body/:seq` and renders, for a parsed payload,
    the `system` blocks, the `tools` array (name plus description) and the
    `messages` history; for a truncated one, the raw string in a `<pre>` under a
    banner naming the real `bodyLength` and the delivered bytes; for an evicted
    one, the sentence that the payload has rolled out of the buffer while its
    size is still known.
  - A "Context content" panel rendering the content items in order: prompt,
    response, tool call with its arguments and its `tool.output` when present.
- **Missing-switch lines.** Wherever a panel would be empty because a switch is
  off, render the switch name instead of an empty box, using `capture`:
  prompts → `OTEL_LOG_USER_PROMPTS`; responses →
  `OTEL_LOG_ASSISTANT_RESPONSES=1` (or `OTEL_LOG_USER_PROMPTS=1`); tool
  arguments → `OTEL_LOG_TOOL_DETAILS`; tool output → `OTEL_LOG_TOOL_CONTENT`
  together with `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA`; request bodies →
  `OTEL_LOG_RAW_API_BODIES`. An agent whose name is `custom` gets a line saying
  `OTEL_LOG_TOOL_DETAILS=1` is what would name it. An agent with an empty
  occupancy series gets a line saying the series is built from
  `claude_code.api_request` events and needs `OTEL_LOGS_EXPORTER=otlp`.
- `wireEvents()`: delegate clicks on `[data-agent]` (select agent, reload
  content) and `[data-body-seq]` (load one payload) inside `#detail`, in the
  same style as the existing `[data-trace]` / `[data-span]` handlers. Every
  interpolated value goes through `esc()`.

### 6. Documentation

- `tools/argus/README.md`:
  - HTTP API table: the three routes.
  - Architecture listing: `src/agents.mjs`.
  - "How data is kept": the per-agent index is cumulative and bounded at 100
    model calls per agent (≈35 KB per agent, so ≈70 MB at the 500-session
    ceiling with four agents each); the request payloads themselves are kept
    **only** in the raw log window, so `--max-logs` is what bounds them — at the
    default 50 000 records with `OTEL_LOG_RAW_API_BODIES=1` and the CLI's 61 440-byte
    cap that is up to ≈3 GB, and `--max-logs 2000` (≈120 MB) is the setting to
    use when capturing bodies. A payload whose record has rolled out is served
    as gone, with its size intact.
  - "Sensitive data": a captured request body is the **entire** prompt of that
    call — system blocks, tool definitions, the whole message history including
    file contents and tool arguments — and with persistence on it is written to
    disk as JSONL. Name `OTEL_LOG_ASSISTANT_RESPONSES` alongside the four
    switches already listed.
  - "Limits": tool calls are attributed per agent from `claude_code.tool` spans,
    so without traces they all count as the main session; `tool_result` and
    `user_prompt` events carry no agent attribution at all; a body the CLI cut
    at 61 440 bytes is served cut and never parsed; `OTEL_LOG_RAW_API_BODIES=file:<dir>`
    puts the payload in a file the collector never reads.
- `tools/argus-ui/README.md`: one bullet in "What it shows" for **Agents**.
- `skills/argus/SKILL.md`: a short "See what was in the context" section — how
  to switch content capture on (the five `OTEL_LOG_*` variables, set beside the
  `argus env` block, before the session starts), what each then makes visible,
  that it is off by default because a request body carries the whole prompt
  including file contents, and the three new routes in the existing route table.
- Run `rm -rf ~/.claude/plugins/cache/uroboros` in the same turn as the
  `skills/argus/SKILL.md` edit.

## Environment

- Node v22.22.2 is installed; both projects require ≥ 20.11 and have zero
  runtime dependencies, so **no install step is needed** — `npm --prefix … test`
  works in a fresh checkout.
- There is no linter, no formatter and no CI workflow in this repository.
- `./test.sh` runs, in order: `test-repo.sh`, `test-worktree.sh`,
  `npm --prefix tools/argus test`, `npm --prefix tools/argus-ui test`,
  `npm --prefix tools/log-parser test`. It needs `git` (the worktree suite
  creates worktrees) and nothing else. It exits 1 if any suite fails.
- Single test file: `node --test tools/argus/test/<file>.test.mjs` from the
  repository root works, because each test file resolves its imports relative
  to itself.

## Test plan

Tests are needed. Everything in the collector half is a pure function of
ingested records and is testable through `TelemetryStore` and the HTTP surface.

### Not tested, deliberately

- **`tools/argus-ui/public/app.js` and `styles.css`.** The interface has no test
  file, no DOM harness and no way to get one without a dependency, which both
  `CLAUDE.md` files forbid. `test/independence.test.mjs` still checks that
  `public/app.js` imports nothing outside the project, and it runs as part of
  the ui suite. The rendering is reviewed by reading.
- **The README, the ui README and `SKILL.md`.** Prose.
- **Eviction of an agent with its session.** Agents live inside the session
  object, which `#dropSession` already deletes wholesale; there is no separate
  path to get wrong.
- **The token gate on the new routes.** It is the same `if (!ok)` branch that
  already covers every `/api/` path, ahead of any routing.

### Cases

All collector cases are `node:test` + `node:assert/strict`, one `test(...)` per
case with a sentence-shaped name in the present tense, as in the files today.

#### A. `tools/argus/test/claude.test.mjs` (existing file, add cases)

Convention: pure functions imported by name from `../src/claude.mjs`, asserted
with `assert.equal`/`assert.deepEqual` on literal attribute objects. Add
`agentRefOf` and `EVENT` to the import.

Run it: `node --test tools/argus/test/claude.test.mjs`

1. *a record with no attribution attributes belongs to the main session* —
   `agentRefOf({})` and `agentRefOf({ query_source: 'sdk' })` and
   `agentRefOf({ query_source: 'main' })` → key `main`, kind `main`, name null.
2. *agent.name names the subagent a record belongs to* —
   `{ 'agent.name': 'Explore', query_source: 'agent:builtin:Explore' }` → key
   and name `Explore`, kind `subagent`.
3. *query_source alone names a subagent* — `{ query_source: 'agent:builtin:Explore' }`
   → `Explore`; `{ query_source: 'agent:plugin:acme:Digger' }` → `Digger`.
4. *a bare subagent source becomes one unnamed bucket* —
   `{ query_source: 'subagent' }` → key `subagent`, name null, kind `subagent`.
5. *auxiliary and compact are their own kind, not the main session* —
   `{ query_source: 'auxiliary' }` → key `auxiliary`, kind `system`.
6. *an agent_id with no name keys the agent by its id and keeps the id* —
   `{ agent_id: 'a10f6aaeff1f24fa1' }` → key `id:a10f6aaeff1f24fa1`, name null,
   `agentId` set. And `{ 'agent.name': 'Explore', agent_id: 'a10f…' }` → key
   `Explore` **with** `agentId` still returned.
7. *empty attribute values do not name an agent* — `{ 'agent.name': '',
   query_source: '' }` → main.
8. *the subagent completion event is known by name* —
   `EVENT.subagentCompleted === 'claude_code.subagent_completed'`.

#### B. `tools/argus/test/agents.test.mjs` (new file)

Convention: copy the `metric` / `log` / `span` fixture helpers from the top of
`test/store.test.mjs` (each test file in this project owns its own helpers) —
including the `NOW`-based span timestamps, because anything older than the
retention window is evicted on ingest. Drive everything through
`new TelemetryStore()` and `store.ingest(...)`, then assert on
`store.getSessionAgents(SESSION)`, `store.getAgentContent(...)` and
`store.getAgentBody(...)`. Add one helper for the request-body event.

Run it: `node --test tools/argus/test/agents.test.mjs`

9. *a session splits into the main session and the subagents that ran in it* —
   two `api_request` events without attribution and two with
   `{ 'agent.name': 'Explore', query_source: 'agent:builtin:Explore' }` →
   `agents` has exactly two entries, keys `main` and `Explore`, kinds `main`
   and `subagent`, `counts.apiRequests` 2 each, labels `main session` and
   `Explore`.
10. *records naming no agent are the main session, never an unknown one* — a
    `user_prompt` and a `tool_result` with no attribution → both counted on
    `main`; no key other than `main` exists.
11. *the session total is the sum of its agents* — same fixture as 9 with
    distinct token figures → sum of the agents' `tokensTotal` equals
    `getSession(SESSION).tokensTotal`, and the same for `costUsd` and for
    `counts.apiRequests`.
12. *per-agent tokens prefer metrics over events, like the session total* —
    `token.usage` metrics carrying `agent.name` plus `api_request` events with
    the same figures → the agent's `tokenSource` is `metrics` and nothing is
    double counted.
13. *an agent_id is joined onto the name as soon as one record carries both* —
    ingest a `claude_code.tool` span carrying only `agent_id: 'a1'` **first**,
    then an `llm_request` span carrying `agent_id: 'a1'` and
    `query_source: 'agent:builtin:Explore'` → one agent `Explore` with
    `counts.toolCalls` 1 and `counts.llmRequests` 1, and no `id:a1` entry.
14. *an agent_id that is never named stays an agent of its own, labelled by its
    id* — a lone tool span with `agent_id: 'a10f6aaeff1f24fa1'` → key
    `id:a10f6aaeff1f24fa1`, label `subagent a10f6aae`.
15. *occupancy is one entry per model call and sums input, cache read and cache
    creation* — four `api_request` events, two per agent, with the measured
    figures → `context.series` has two entries per agent in arrival order and
    `occupancy` equals the sum of the three token fields.
16. *peak and last occupancy, and the cached prefix of the last prompt, are
    reported* — last call `input 100, cacheRead 900, cacheCreation 0` after a
    larger earlier call → `peakOccupancy` is the earlier value,
    `lastOccupancy` 1000, `lastCachedPrefixTokens` 900, `lastFreshTokens` 100,
    `lastCachedPrefixRatio` 0.9.
17. *an agent that made no model call reports no series and no ratio* — an agent
    created by a tool span alone → `series` empty, `peakOccupancy` 0,
    `lastOccupancy` 0, `lastCachedPrefixRatio` null (the empty edge).
18. *peak occupancy survives the series rolling over* — `new TelemetryStore({ maxAgentCalls: 3 })`,
    five calls with the largest first → `series.length` 3, `peakOccupancy` still
    the largest, `lastOccupancy` the last (the limit edge).
19. *a request body is indexed per agent and served from the raw window* — an
    `api_request_body` event with a small valid JSON `body` and a matching
    `body_length` → `bodies[0]` has `bodyLength` and `truncated: false`, and
    `getAgentBody` returns `available: true`, the raw `body`, and `parsed`
    deep-equal to the object.
20. *a truncated payload is served as truncated with its real length and is
    never parsed* — `body` a cut, invalid-JSON string, `body_length: 110141`,
    `body_truncated: true` → `truncated: true`, `bodyLength: 110141`,
    `deliveredBytes` the actual byte length, `parsed: null`, `parseError: null`.
21. *a payload shorter than its stated length counts as truncated without the
    flag* — same without `body_truncated` → `truncated: true`, `parsed: null`.
22. *an untruncated payload that will not parse reports the error rather than a
    half object* — invalid JSON with a matching `body_length` → `parsed: null`,
    `parseError` a non-empty string.
23. *a payload whose record has rolled out is reported as gone, with its size
    intact* — `new TelemetryStore({ maxLogs: 2 })`, the body event followed by
    several other logs → `getAgentBody` returns `available: false` with
    `bodyLength` and `truncated` still set (the repeat/overflow edge).
24. *an unknown body seq and an unknown agent are answered with null* —
    `getAgentBody(SESSION, 'main', 999)` and
    `getAgentContent(SESSION, 'Nope')` → both `null`.
25. *a subagent reports what subagent_completed said about it* — a
    `claude_code.subagent_completed` event carrying `agent_type: 'Explore'`,
    `agent.source`, `is_built_in`, `is_async`, `model`, `final_model`,
    `model_swapped`, `total_tokens`, `total_tool_uses`, `duration_ms` → the
    `Explore` agent's `completions[0]` carries every one of them, coerced
    (`isBuiltIn` boolean, `totalTokens` number), and the main session has none.
26. *two runs of the same subagent are one agent with two completions* — two
    `subagent_completed` events for `Explore` → one agent, `completions.length`
    2 (the repeat edge).
27. *content is returned per agent in the order it entered that context* — a
    `user_prompt` (no attribution), an `assistant_response` with
    `agent.name: 'Explore'`, and a `claude_code.tool` span with `agent_id`
    learned as `Explore` whose `tool_result` carries `tool_input` → the
    `Explore` content is `[response, tool]` in ascending time with the tool
    item's `arguments` parsed from `tool_input` and `resultBytes` set; the
    `main` content is `[prompt]`.
28. *a tool call with no span is listed under the main session* — a
    `tool_result` event alone, traces off → it appears once, in `main`'s
    content, and nowhere else.
29. *the capture report names the switch behind every content kind* — a session
    with a `user_prompt` without `prompt`, a `tool_result` without `tool_input`
    and no body event → `capture.prompts.present` false with
    `switch: 'OTEL_LOG_USER_PROMPTS'`, `capture.toolArguments.present` false
    with `OTEL_LOG_TOOL_DETAILS`, `capture.requestBodies.present` false with
    `OTEL_LOG_RAW_API_BODIES`, and each `seen` count right. Then a second store
    with all three present → all `present` true.
30. *tool output content is detected on the span event, not on the event* — a
    `claude_code.tool` span with a span event named `tool.output` →
    `capture.toolContent.present` true, and the content item's `output` carries
    that event's attributes.
31. *an agent's wall time covers its own records only* — main records at
    `NOW`/`NOW+1000`, `Explore` records at `NOW+200`/`NOW+400` → `Explore`'s
    `durationMs` is 200.

#### C. `tools/argus/test/server.test.mjs` (existing file, add cases)

Convention: `withServer({}, async ({ base, store }) => …)` binds port 0 and
hands back both the base URL and the store; ingest fixtures directly through
`store.ingest(...)` and assert on `fetch` responses. Never hard-code a port.

Run it: `node --test tools/argus/test/server.test.mjs`

32. *the agents route serves the per-agent aggregation of one session* — ingest
    a main-session and a subagent `api_request` event, `GET
    /api/sessions/:id/agents` → 200, two agents, `capture` present.
33. *the agents route answers 404 for a session it does not know* — 404 with
    `{ error: 'unknown session' }`.
34. *the content route serves one agent's records in order and 404s an unknown
    agent* — `GET …/agents/main/content?limit=10` → 200 with `items`;
    `…/agents/Nope/content` → 404.
35. *the body route serves one payload and marks a truncated one* — a truncated
    `api_request_body` → 200 with `truncated: true`, the real `bodyLength` and
    `parsed: null`; an unknown seq → 404.
36. *the config route names the per-agent bound* — `GET /api/config` →
    `limits.agentCalls` is the store's `maxAgentCalls`.

### What is already red

Nothing was run for this plan — not the suite, not a single file, not as a
baseline. Every command below is left to whoever runs it downstream, and its
first run is the first run.

### What counts as done

```
./test.sh
```

That single command is the closed list: it is what the issue's acceptance
criterion names, and it already runs both argus suites plus the repository and
worktree suites. Nothing else is to be run — no separate lint, no separate
package invocation, no manual collector start.
