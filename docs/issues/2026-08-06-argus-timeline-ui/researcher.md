# Researcher handoff — a session timeline as the argus UI's central view

## Round 1

### Findings the issue asked for

Both were verified against the Claude Code monitoring reference
(`https://code.claude.com/docs/en/monitoring-usage`, fetched 2026-08-06). Quote
these findings in the code comments where they explain a decision.

**1. The flag for request/response bodies exists: `OTEL_LOG_RAW_API_BODIES`.**
Documented values: `1` for inline bodies, or `file:<dir>` for untruncated
bodies on disk. With `=1` the CLI emits `claude_code.api_request_body` and
`claude_code.api_response_body` log events. Attributes:

| Attribute        | Meaning                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------ |
| `body`           | JSON-serialized Messages API request/response, inline mode only, truncated at the content limit |
| `body_ref`       | Absolute path to `<dir>/<uuid>.request.json`, file mode only                                |
| `body_length`    | Untruncated length (UTF-16 code units in inline mode)                                       |
| `body_truncated` | `"true"` when inline truncation happened, absent otherwise                                  |
| `model`          | Model identifier                                                                            |
| `query_source`   | Subsystem that issued the request                                                            |

The request body is the whole conversation: system prompt, every prior turn,
tool results, tool definitions. Extended-thinking content is always redacted by
the CLI, whatever else is set — so a thinking block arrives as a redaction
marker and there is nothing to recover.

**A second flag is required and the issue does not name it:
`CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH`.** Content-bearing attributes, raw API
bodies included, are truncated at 61440 UTF-16 units (60 KB) by default. 60 KB
is roughly 15k tokens of context JSON, so on any real agent turn the body
arrives cut in half and is not valid JSON. The flag raises that limit and needs
Claude Code ≥ 2.1.214; an older CLI ignores an unknown variable, so setting it
costs nothing there. **Set it to `1048576`** (1 MB ≈ 260k tokens of JSON, which
covers a full context window) and say in the comment why that number.

**2. Subagent attribution is incomplete, in one specific place.** What the CLI
actually attributes:

| Record                                  | Attribution it carries                          |
| --------------------------------------- | ----------------------------------------------- |
| `api_request`, `api_error`, `api_refusal` event | `agent.name` **and** `query_source`      |
| `api_request_body`, `api_response_body` event   | `query_source` only — **no `agent.name`** |
| `assistant_response` event              | `query_source`                                   |
| `claude_code.llm_request` span          | `query_source`, `agent_id`, `parent_agent_id`    |
| `claude_code.tool` span                 | `agent_id`, `parent_agent_id`, `tool_use_id` — **no `query_source`** |
| `tool_result`, `tool_decision` event    | **nothing** — no `agent.name`, no `query_source`, no `agent_id`; only `tool_use_id` |
| `cost.usage`, `token.usage` metric      | `agent.name`, plus a *categorical* `query_source` (`main`/`subagent`/`auxiliary`) |

`query_source` on **events and the llm_request span** is the subsystem name —
`repl_main_thread`, `compact`, or a subagent name. On **metrics** the same key
carries a category instead, so metric points must never be fed into lane
resolution.

Consequences for the lanes, all of them designed for below:

- Request bodies are attributable by `query_source` alone. That is a name, not
  an instance id, so two subagents of the same type running at once share one
  lane. Accepted; do not try to split them.
- Tool calls have to be joined: the `claude_code.tool` span carries
  `agent_id` + `tool_use_id`, the `tool_result` event carries `tool_use_id`.
  Without traces (`CLAUDE_CODE_ENHANCED_TELEMETRY_BETA`) there is no join and
  no tool is attributable to any subagent lane at all. `argus env` sets the
  traces flag by default, so this only bites a session configured by hand.
- `agent_id` (span) and `query_source` (event) are two different namespaces for
  the same agent. They are bridged by the `llm_request` span, which carries
  both. That bridge is the load-bearing trick of the whole lane design.

`agent.name` is redacted to `"custom"` for user-defined agents unless
`OTEL_LOG_TOOL_DETAILS=1` — which this change now sets, so uroboros's own
agents arrive under their real names.

### Implementation plan

Four pieces, in this order: env block, collector queries, HTTP routes, UI.

#### 1. `tools/argus/src/claude.mjs` — the env block

In `otelEnvFor`, add to the base `env` object (unconditionally, not behind the
`traces` branch — these gate log content, not spans):

```
OTEL_LOG_USER_PROMPTS: '1'
OTEL_LOG_TOOL_DETAILS: '1'
OTEL_LOG_TOOL_CONTENT: '1'
OTEL_LOG_RAW_API_BODIES: '1'
CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH: '1048576'
```

Do **not** set `OTEL_LOG_ASSISTANT_RESPONSES`: it follows `OTEL_LOG_USER_PROMPTS`
when unset, so setting it adds a line that changes nothing. Note that in the
comment so the next reader does not "fix" the omission.

`renderEnv` in `bin/argus.mjs` serializes whatever `otelEnvFor` returns, so all
four formats (`shell`, `json`, `dotenv`, `settings`) pick the new keys up with
no change there.

Also extend `describeEvent` with cases for `EVENT.apiRequestBody` /
`EVENT.apiResponseBody`, so the event tail shows `<model> · <body_length> chars`
(plus ` · truncated` when `body_truncated`) instead of a bare event name.

#### 2. `tools/argus/src/context.mjs` — new module, body → message blocks

Exports `parseRequestBody(attrs)`, taking a log record's attributes and
returning:

```js
{
  parsed: boolean,      // false when there was no JSON to read
  bodyLength: number,   // from body_length, else the string length
  truncated: boolean,   // body_truncated
  bodyRef: string|null, // body_ref, file mode
  model: string|null,
  totalChars: number,
  blocks: [{ index, role, type, name, toolUseId, chars, text }]
}
```

Block extraction from an Anthropic Messages API request:

- `system`: a string becomes one block; an array becomes one block per entry.
  `role: 'system'`, `type: 'text'`.
- `tools`: one block, `role: 'system'`, `type: 'tools'`, `name: 'tools (<n>)'`,
  `text` = the pretty-printed tool definitions. Tool schemas are a large and
  invisible part of what fills a context, which is exactly what this view is
  for.
- `messages[]`: `content` as a string becomes one `type: 'text'` block; an
  array becomes one block per content block:
  - `text` → `type: 'text'`
  - `tool_use` → `type: 'tool_use'`, `name` = the tool name, `toolUseId` =
    `id`, `text` = pretty-printed `input`
  - `tool_result` → `type: 'tool_result'`, `toolUseId` = `tool_use_id`, `text`
    = the result content flattened to text
  - `thinking` / `redacted_thinking` → `type: 'thinking'`, `text` = whatever
    arrived (the CLI has already redacted it)
  - `image` / `document` → `type: 'image'`, `text` = a placeholder naming the
    media type and the byte count. Never inline base64 — but set `chars` to the
    original length so the size accounting stays honest.
  - anything else → `type` = the block's own `type`, `text` = the pretty-printed
    block.
- `role` on each message block is the message's role verbatim (`user`,
  `assistant`).
- `chars` per block is `text.length` of the value as extracted.

Failure modes, all of which must return a value rather than throw:

- `body` present but not parseable (truncated body, most commonly): `parsed:
  false` and a single block `{ role: 'raw', type: 'raw', text: <the exact
  string> }`. The exact text stays reachable, which is what criterion 7 asks.
- `body` absent and `body_ref` present (file mode): `parsed: false`, `blocks:
  []`, `bodyRef` set. **The collector never reads that file** — it may be
  running on another machine than the agent. Say so in the comment.
- neither present: `parsed: false`, `blocks: []`.

#### 3. `tools/argus/src/store.mjs` — lanes and slices

Content records need no new storage: `api_request_body` /`api_response_body`
already land in `this.logs` through `#applyLog`'s default branch. Two new query
methods build everything at read time from the raw windows, so nothing new is
indexed on the ingest path. Consequence to state in the comment: a session
whose raw records have been evicted has no timeline any more, exactly like its
traces.

**Lane resolution.** Put the rule in `claude.mjs` next to the other domain
knowledge — export `MAIN_LANE_ID = 'main'`, `AUXILIARY_QUERY_SOURCES = new
Set(['compact'])`, and `laneOfQuerySource(value)` returning
`{ id, kind }` where `kind` is `'main'` for `repl_main_thread`/absent,
`'auxiliary'` for the set above, `'agent'` otherwise.

`getTimeline(sessionId)` → `null` for an unknown session, else:

```js
{
  sessionId, firstMs, lastMs, laneCount, spansSeen,
  lanes: [{
    id, label, kind,            // kind: 'main' | 'agent' | 'auxiliary'
    agentName,                  // agent.name seen on api_request events, else null
    firstMs, lastMs, requests, toolCalls, maxContextTokens,
    activity: [{ startMs, endMs, kind: 'tool'|'llm', label }],
    context: [{ atMs, tokens }],
  }]
}
```

Built in one pass over `this.spans` and `this.logs` filtered by `sessionId`:

1. From `claude_code.llm_request` spans, build `agentId -> laneId` from
   `attrs.agent_id` + `attrs.query_source`. This is the bridge between the two
   namespaces.
2. From `claude_code.tool` spans, build `tool_use_id -> laneId` (through the
   map from step 1) for the tool_result events, which carry no attribution of
   their own.
3. Events: lane from `attrs.query_source`. Spans: lane from `attrs.agent_id`
   through the map, main lane when `agent_id` is absent. An `agent_id` that
   never appeared on an llm_request span gets its own lane, id
   `agent:<agent_id>`, labelled `agent <first 8 chars>` — the gap is shown, not
   folded into main.
4. `activity` blocks from `claude_code.tool` spans (label = `tool_name`) and
   `claude_code.llm_request` spans (label = `model`), `startMs`/`endMs` from the
   span, `endMs` falling back to `startMs` for an open span.
5. `context` samples from `claude_code.api_request` **events**: `tokens =
   input_tokens + cache_read_tokens + cache_creation_tokens`. Output tokens are
   deliberately excluded — they are generation, not context. Samples ascending
   by time.
6. `firstMs`/`lastMs` per lane = min/max over everything attributed to it; the
   timeline's own bounds come from the session entry's `firstSeenMs`/`lastSeenMs`.
7. Lane order: main lane first, then by `firstMs` ascending. Cap `activity` and
   `context` at 2000 entries per lane (keep the newest); a real session is far
   below that and the cap only exists so one cannot be unbounded.
8. `spansSeen` is `false` when the session has no spans at all — the UI uses it
   to explain empty activity rows.

`getContextAt(sessionId, { laneId = MAIN_LANE_ID, atMs = Date.now(), toolLimit = 200 })`
→ `null` for an unknown session, else:

```js
{
  laneId, atMs,
  context: null | { atMs, ...parseRequestBody(attrs) },
  tools: [{ atMs, name, toolUseId, success, durationMs, parameters }]
}
```

- `context`: the **newest** `claude_code.api_request_body` event in that lane
  with `timeMs <= atMs`, run through `parseRequestBody`. `null` when the lane
  has none at or before that time.
- `tools`: `claude_code.tool_result` events in that lane with `timeMs <= atMs`,
  ascending, last `toolLimit` kept. `parameters` from the existing
  `toolParametersOf(attrs)`. A `tool_use_id` with no matching tool span falls to
  the main lane, per the rule above.

**Memory guard — required, not optional.** Raising the content limit to 1 MB
against a 50 000-record log window is a 50 GB worst case. Add a store option
`maxContentBytes`, default `268_435_456` (256 MB), counted over the `body`
attribute of content-bearing logs. In `#evict`, after the existing trims, drop
records from the front of `this.logs` while the total is over budget. Keep it
simple and correct: recompute the total by summing `this.logs` whenever
something was actually removed (`#trim`, `#dropSession`, `clear`), rather than
maintaining a counter that has to be right in five places. Plumb the option in
`tools/argus/src/config.mjs` beside its siblings:
`maxContentBytes: parseCount(flags['max-content-bytes'] ?? env.UROBOROS_OBS_MAX_CONTENT_BYTES, 268_435_456)`,
and list it in the CLI help block and the `Environment` section of `HELP` in
`bin/argus.mjs`.

#### 4. `tools/argus/src/server.mjs` — two routes

Inside `handleApi`, next to the existing `^\/api\/sessions\/([^/]+)$` match
(which is anchored, so it will not swallow these):

- `GET /api/sessions/:id/timeline` → `store.getTimeline(id)`, 404
  `{ error: 'unknown session' }` when null.
- `GET /api/sessions/:id/context?lane=<laneId>&at=<ms>` →
  `store.getContextAt(id, { laneId: searchParams.get('lane') ?? 'main', atMs:
  intParam(searchParams, 'at', Date.now()) })`, same 404. The lane id travels as
  a query parameter because it is a free-form string.

`tools/argus-ui/src/server.mjs` needs **no change**: it proxies everything under
`/api/`.

#### 5. `tools/argus-ui/public/app.js` + `styles.css` — the view

Decision 2 rules out "one more tab". The session detail becomes: header, then
the timeline, then a subordinate strip of the technical views.

State additions: `timeline`, `slice`, `selectedLaneId`, `atMs`, `live` (default
`true`), and `technicalTab` (default `null`) replacing the current
`state.tab = 'overview'` default. `TABS` keeps its six entries and is rendered
under a `Technical views` heading below the timeline; clicking the open tab
closes it again, so nothing but the timeline is open when a session is opened.

`renderTimeline()` draws, in this order:

- **Scrubber**: `<input type="range" id="timeline-scrub" min=firstMs max=lastMs
  step=1 value=atMs>`, a `fmtClock(atMs)` readout, and a `Live` button
  (`data-live`) that is highlighted while `state.live`. An `input` event sets
  `state.live = false` and `state.atMs`, then re-renders the playhead and
  refetches the slice, debounced ~120 ms (the same pattern as the event-search
  input). The `Live` button sets `state.live = true` and `atMs = timeline.lastMs`.
  On every SSE-driven refresh, `atMs` follows `timeline.lastMs` while
  `state.live`.
- **One row per lane**: a fixed-width label column (like the waterfall's
  `.span-label`) carrying the lane label, its kind and its counts, plus a track.
  In the track, positions are percentages of `(lastMs - firstMs)`:
  - the context curve as an inline `<svg viewBox="0 0 100 100"
    preserveAspectRatio="none">` holding a `<polygon>` closed to the baseline,
    `y = 100 - tokens / maxTokens * 100`, where `maxTokens` is the maximum over
    **all** lanes so lanes stay comparable;
  - activity blocks as absolutely positioned elements over it, minimum width
    0.4% (the rule the waterfall already uses), coloured by `kind`;
  - a playhead line at `x(atMs)` spanning all rows.
  - The row is a `<button data-lane="…">` so selecting a lane is one click and
    stays keyboard-reachable.
- **The selection panel**, from `state.slice`: the context as a message list —
  one line per block with role, type, name and `fmtNum(chars)`, expandable to
  the exact full text (toggle a hidden sibling, the same mechanism as the event
  detail rows) — and below it the tool list with tool name, time and the call's
  parameters.

Edges the page must handle: `firstMs === lastMs` (no span to scale by) renders a
placeholder instead of dividing by zero; a lane with no context at the chosen
time renders "No context recorded at this point"; `spansSeen === false` renders
the lanes with curves and an empty activity row.

Styles go in a new `/* ------------------------------ timeline ---------------- */`
section of `public/styles.css`, using the existing custom properties
(`--accent`, `--violet`, `--teal`, `--panel`, `--border`). No new colour
literals outside `:root`.

Extend `tools/argus/scripts/demo-emit.mjs` to emit a subagent (an
`llm_request`/`tool` span pair carrying `agent_id`, `api_request` events with
`query_source`) and `api_request_body` events with a small synthetic Messages
API body. Without it the timeline cannot be looked at without burning a real
agent run, and `npm run demo` is the repository's established way of filling the
store.

#### 6. Documentation that becomes false with this change

- `tools/argus/README.md`, "Sensitive data": it currently says `argus env`
  **deliberately does not** set these flags. That is now the opposite of the
  truth. Rewrite it to say what is now switched on by default and what that
  means for the measurement directory.
- `tools/argus/README.md`, "Wiring up an agent": the example export block must
  match what `argus env` prints.
- `tools/argus/README.md`, "HTTP API" table: the two new routes.
- `tools/argus/README.md`, "Architecture" list: `src/context.mjs`.
- `tools/argus/README.md`, "Limits": the timeline is built from the raw window,
  and tool calls are attributable to a subagent lane only when traces are on.
- `tools/argus-ui/README.md`: the session view is the timeline now.
- `skills/argus/SKILL.md`, "What this is not": it promises the tool sees "model
  requests, tokens, cost, tool calls, errors — and nothing else". Correct that
  one sentence — the measurement now holds the conversation itself. One
  paragraph, no more; the README owns the detail.

### Rejected alternatives

- **A separate content store or a new signal path.** Body events are ordinary
  log records and already arrive, are already persisted by `persist.mjs`, and
  are already served by `/api/events`. A second store would duplicate eviction,
  persistence and replay for nothing.
- **Precomputing lanes on the ingest path.** Attribution needs a join across
  spans and logs that arrive on independent pipelines in either order (the same
  problem `#applyResultTokenFallback` already works around). Resolving lanes at
  query time makes ordering irrelevant and costs one linear pass over a bounded
  buffer.
- **Keying lanes on `agent_id` alone.** It is the better identity — per
  instance, not per name — but it exists only on spans, so every event-derived
  record (bodies, api_requests) would be unattributable.
- **Parsing bodies in the browser.** `tools/argus-ui` may not import from
  `tools/argus` (`test/independence.test.mjs` enforces it), so the parser would
  either be duplicated or untestable — the UI has no test harness at all.
- **`OTEL_LOG_RAW_API_BODIES=file:<dir>`.** Untruncated and cheap on memory, but
  the bodies then live on the agent's disk and the collector — possibly on
  another host — only gets a path. The parser reports `bodyRef` when it meets
  one, and that is all it does.
- **A fallback rendering for recordings without the content flags.** Ruled out
  by decision 5. Nothing may test or promise behaviour for that case.

### Module map

| Path | What it holds / what changes |
| ---- | ---------------------------- |
| `tools/argus/src/claude.mjs` | Metric/event/span name constants (`EVENT.apiRequestBody` already exists), `otelEnvFor` (the env block), `describeEvent`, `attributionOf`, `toolParametersOf`, `num`/`bool`. Add the content flags, the lane-resolution helper and the two `describeEvent` cases. |
| `tools/argus/src/context.mjs` | **New.** `parseRequestBody(attrs)` — Messages API body → message blocks. |
| `tools/argus/src/store.mjs` | `TelemetryStore`: ingest (`#applySpan`, `#applyLog`, `#applyMetric`), eviction (`#evict`, `#trim`, `#dropSession`), queries (`getSession`, `getTrace`, `queryEvents`, …). Add `getTimeline`, `getContextAt`, the `maxContentBytes` budget. |
| `tools/argus/src/server.mjs` | `createServer`: OTLP ingest on `/v1/*`, read API in `handleApi`, SSE in `handleStream`. Add the two routes. |
| `tools/argus/src/config.mjs` | `resolveConfig` (defaults < env < flags), `parseArgs`, `endpointFor`. Add `maxContentBytes`. |
| `tools/argus/bin/argus.mjs` | CLI: `HELP` text, `renderEnv`, `start`/`env`/`check` dispatch, store construction (`new TelemetryStore(config)`). Help text only. |
| `tools/argus/scripts/demo-emit.mjs` | Synthetic OTLP emitter. Add a subagent and body events. |
| `tools/argus/src/otlp/decode.mjs` | OTLP → flat records; `canonicalEventName` prefixes bare `event.name` values. **No change** — body attributes pass through as ordinary attributes. |
| `tools/argus/src/persist.mjs` | JSONL append and replay of normalized records. **No change.** |
| `tools/argus-ui/public/app.js` | The whole front end: `state`, `renderDetail`, `TABS`, `renderTabBody`, the per-tab renderers, `loadTabData`, `refresh`, `wireEvents`, `connectStream`, `boot`. The timeline view lives here. |
| `tools/argus-ui/public/styles.css` | All styles, sectioned by comment banners. New timeline section. |
| `tools/argus-ui/public/index.html` | Static shell only; the detail pane is filled by `app.js`. **No change needed.** |
| `tools/argus-ui/src/server.mjs` | Static files plus a reverse proxy for `/api/` and `/v1/`. **No change.** |
| `skills/argus/SKILL.md`, `tools/argus/README.md`, `tools/argus-ui/README.md` | User-facing pages listed under "Documentation that becomes false". |

### Environment

- Node v22.22.2 is installed. Both packages declare `engines.node >= 20.11`.
- **No install step.** Both packages have zero runtime dependencies by rule, and
  `node_modules` is not needed for any command below.
- **There is no linter and no formatter** in this repository — no eslint,
  prettier or config for either. Nothing to run, nothing to satisfy but the
  style of the file being edited.
- **There is no build step.** `public/` is served exactly as written.
- `test.sh` is **not executable** (mode 644), so `./test.sh` fails with
  permission denied. Run it as `bash test.sh`.
- Adding a runtime dependency to either package is forbidden by
  `tools/argus/CLAUDE.md` and `tools/argus-ui/CLAUDE.md` and goes to the human
  first. This change needs none.
- Network access is not required by any test; every server binds `127.0.0.1`
  port 0 and asks the OS which port it got.

### Test plan

Tests are needed. All of them are `node:test` cases in `tools/argus`; the
interface gets none, for the reason under "What is left untested".

#### Conventions the cases must follow

- `import test from 'node:test'` and `import assert from 'node:assert/strict'`.
  Case names are lowercase sentences describing the behaviour that is fixed
  ("a tool span attributes its tool_result to the agent's lane"), never the
  function name.
- Nothing is faked or mocked anywhere in this suite: real store objects, real
  HTTP on loopback. Fixtures are plain objects built by the file's own helpers.
- `test/store.test.mjs` already defines module-level helpers that every new case
  must reuse: `log(eventName, attributes, timeMs)`, `span(name, attributes,
  extra)`, `metric(name, value, attributes, extra)`, the constant `SESSION =
  'sess-1'` and `NOW = Date.now()` — fixtures have to sit near "now" or
  retention evicts them on ingest. `span()` takes `extra.spanId`,
  `extra.parentSpanId`, `extra.startMs`, `extra.endMs` as offsets from `NOW`;
  give every span in a case its own `spanId`.
- `test/server.test.mjs` defines `withServer(options, run)`, which binds port 0
  and closes the server in a `finally`, plus the payload builders
  `tracePayload(sessionId)` (protobuf) and `logsPayloadJson(sessionId)`
  (OTLP/JSON). New route cases post an OTLP/JSON payload built the same way and
  then `fetch` the route.
- `test/config.test.mjs` calls `resolveConfig` directly for option cases and
  `promisify(execFile)(process.execPath, [bin, 'env', '--format', …])` for
  cases about printed output.
- `test/claude.test.mjs` calls the exported functions directly, no fixtures.

#### Cases, per acceptance criterion

**AC1 — `argus env` carries the content flags.**
File `tools/argus/test/claude.test.mjs`, framework `node:test`, level unit.
Run it with `node --test tools/argus/test/claude.test.mjs`.

1. `otelEnvFor('http://localhost:4318')` returns `OTEL_LOG_USER_PROMPTS`,
   `OTEL_LOG_TOOL_DETAILS`, `OTEL_LOG_TOOL_CONTENT`, `OTEL_LOG_RAW_API_BODIES`
   each `'1'`, and `CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH` above the 61440 default
   (assert `Number(...) > 61440`, not the literal — the exact ceiling is the
   implementer's).
2. `otelEnvFor(endpoint, { traces: false })` still carries all five: they gate
   log content, not spans.

File `tools/argus/test/config.test.mjs`, level integration (runs the CLI).
Run it with `node --test tools/argus/test/config.test.mjs`.

3. `argus env` (shell format) prints an `export OTEL_LOG_RAW_API_BODIES="1"`
   line, and `argus env --format json` parses to an object holding the same five
   keys — one case covering "both formats" the criterion names.

**AC2 — content records are stored and served.**
File `tools/argus/test/server.test.mjs`, level integration.
Run it with `node --test tools/argus/test/server.test.mjs`.

4. POST an OTLP/JSON logs payload holding a `claude_code.api_request_body`
   record with `body`, `body_length`, `query_source`; `GET
   /api/events?event=claude_code.api_request_body` returns it with the `body`
   attribute intact — content is exposed like any other signal.
5. `GET /api/sessions/<id>/timeline` answers 200 with a `lanes` array after
   that ingest; `GET /api/sessions/nope/timeline` answers 404.
6. `GET /api/sessions/<id>/context?lane=main&at=<ms>` answers 200 with a
   `context` holding parsed `blocks`; unknown session answers 404; a lane with
   nothing at or before `at` answers 200 with `context: null` (an empty slice is
   not an error).

**AC4 — one lane for the main session, one per subagent, each spanning its
lifetime.** File `tools/argus/test/store.test.mjs`, level unit.
Run it with `node --test tools/argus/test/store.test.mjs`.

7. Ingest `api_request` events with `query_source: 'repl_main_thread'` and
   `query_source: 'researcher'`, plus an `llm_request` span carrying
   `agent_id: 'a-1'` and `query_source: 'researcher'`: `getTimeline` returns
   exactly two lanes, the main lane first, kinds `'main'` and `'agent'`, and the
   researcher lane's `firstMs`/`lastMs` bracket its own records only.
8. A `claude_code.tool` span carrying `agent_id: 'a-1'` and no `query_source`
   lands its activity block in the researcher lane — the llm_request bridge.
9. A `claude_code.tool` span whose `agent_id` never appeared on an llm_request
   span becomes its own lane (id prefixed `agent:`), not part of the main lane.
10. A `query_source: 'compact'` event produces a lane of kind `'auxiliary'`.
11. A session with only main-session records has exactly one lane; an unknown
    session id returns `null`.

**AC5 — activity and the context curve.** Same file, same command.

12. Context samples come from `api_request` events and count
    `input + cache_read + cache_creation` tokens with `output_tokens` excluded;
    they are ascending by time and `maxContextTokens` equals the largest sample.
13. Activity blocks carry `startMs`, `endMs`, `kind` (`'tool'`/`'llm'`) and a
    label (`tool_name` / `model`); a span still open (`endMs` 0) yields a block
    that does not end before it starts.

**AC7 — the context as of a chosen moment.** Same file, same command.

14. Three `api_request_body` events at t1 < t2 < t3 in one lane:
    `getContextAt({ atMs: t2 + 1 })` returns the t2 body, `atMs: t3 + 1000`
    returns t3, `atMs: t1 - 1` returns `context: null`.
15. A body belonging to another lane is never returned for the lane asked for.

File `tools/argus/test/context.test.mjs`, **new**, level unit.
Run it with `node --test tools/argus/test/context.test.mjs`.

16. A body with `system` as a string, `tools`, a user text message, an assistant
    message with a text block and a `tool_use` block, and a user message with a
    `tool_result` block, parses into blocks in source order with the right
    `role`, `type`, `name`, `toolUseId` and a `chars` equal to the block's own
    text length.
17. `system` given as an array of `{type:'text'}` entries yields one block per
    entry.
18. A `thinking` block survives as `type: 'thinking'` with whatever text
    arrived — the CLI has already redacted it and nothing here may pretend
    otherwise.
19. An `image` block does not put its base64 payload into `text`, but `chars`
    still reflects the original size.
20. Edge — truncated body: `body` holding a prefix of valid JSON plus
    `body_truncated: 'true'` returns `parsed: false`, `truncated: true` and one
    `raw` block whose `text` is byte-for-byte the attribute value.
21. Edge — file mode: `body_ref` set and `body` absent returns `parsed: false`,
    `blocks: []` and the `bodyRef` path; no file is read.
22. Edge — neither attribute present returns `parsed: false` and `blocks: []`
    rather than throwing.

**AC8 — the tools an agent used up to that moment.**
File `tools/argus/test/store.test.mjs`, same command.

23. `tool_result` events joined to a subagent lane through their tool span's
    `tool_use_id`: `getContextAt` returns them ascending, only those at or
    before `atMs`, each with `name` and `parameters` decoded from `tool_input`.
24. Edge — a `tool_result` whose `tool_use_id` matches no span falls to the main
    lane, and a session with no spans at all attributes every tool call to the
    main lane (the documented consequence of running without traces).

**Memory guard.** File `tools/argus/test/store.test.mjs`, same command.

25. `new TelemetryStore({ maxContentBytes: <small> })`: ingesting body events
    past the budget drops the oldest records — `store.logs.length` shrinks and
    the newest body is still queryable — while the session aggregates survive.

File `tools/argus/test/config.test.mjs`, same command.

26. `resolveConfig` reads `--max-content-bytes` and
    `UROBOROS_OBS_MAX_CONTENT_BYTES`, with the flag winning over the variable.

#### What is left untested, and why

- **The whole interface** (`tools/argus-ui/public/app.js`, `styles.css`): the
  timeline drawing, the scrubber, live mode, lane selection, block expansion.
  There is no DOM harness in this repository and adding one means adding a
  runtime dependency, which both projects forbid. `public/` has never had a
  case and this change does not make it testable. The existing argus-ui suite
  still covers what it always covered: the proxy, the config, and the
  independence rule that no file under `public/` may import from
  `tools/argus` — which the timeline work could plausibly break, so that suite
  belongs in the run.
- **AC3 and AC6** (landing on the timeline; scrubbing and live mode) are
  interface behaviour only and are therefore covered by no case. They are
  reviewed by reading.
- **AC9** — recordings made without the content flags: by decision 5, no case
  may pin behaviour for them. Do not write one.
- **Retention of the timeline across eviction**: no case. It follows from
  building the timeline out of the raw windows, which case 25 already exercises
  from the other side.

#### What counts as done

One command, run from the repository root:

```
bash test.sh
```

It runs the repository suite, the worktree suite, `tools/argus`,
`tools/argus-ui` and `tools/log-parser`, and it is the command acceptance
criterion 10 names. Nothing else is to be run: no single-file run belongs in the
verdict, and there is no linter to invoke.

#### What is already red

I ran none of this and took no baseline — a run buys no fact I could not state
from reading. The first run belongs to whoever runs it downstream. I know of no
case that is red before this change; every case listed above is new or an
addition to a file whose existing cases this change does not touch, with one
exception to watch: `test/server.test.mjs`'s `/api/config` case asserts specific
keys of the env block and adding keys does not break it.
