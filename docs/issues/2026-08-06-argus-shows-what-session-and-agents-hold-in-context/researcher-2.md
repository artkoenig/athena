# Research — correction round 2

Both findings of `reviewer-1.md` sit in one function: `agentRefOf` in
`tools/argus/src/claude.mjs`. It decides which agent a record belongs to from
`agent.name` and `query_source`, and the vocabulary it assumes is not the
vocabulary the CLI sends. Everything downstream of it is correct given its
answer, so this round rewrites that decision, adds one read-time fold that
follows from it, and corrects the one interface sentence that promised
something the CLI cannot do.

Tests are needed: the reviewer named the test gap that let Finding 1 through,
and Finding 2 needs a failing case before the fix. The Test Plan at the end is
the whole testing brief for this round; nothing from earlier rounds carries
over.

## What the CLI actually sends

Re-verified in this round against the installed binary `/opt/claude-code/bin/claude`
with `grep -ao`. These are facts to build on, not guesses to check.

**Classification.** The CLI's own classifier is

```js
function TU(e){ if(e===void 0)return;
  if(e.startsWith("repl_main_thread")||e==="sdk")return"main";
  if(e.startsWith("agent:")||e==="hook_agent")return"subagent";
  return"auxiliary" }
```

so the main conversation of a terminal session sends `repl_main_thread` **or**
`repl_main_thread:outputStyle:<style>` (the CLI appends the active output
style), everything starting with `agent:` or equal to `hook_agent` is a
subagent, and every other value — `compact`, `auxiliary`, `hook_prompt`,
`side_question`, `web_search_tool`, `web_fetch_apply`, `repl_sampling`,
`auto_mode`, `compact_fab_check`, `auto_mode_critique`,
`auto_mode_setup_propose`, `chrome_mcp` — is auxiliary. There is no value that
is a bare subagent name.

**Two vocabularies.** The token and cost metrics carry `query_source: TU(...)`,
i.e. only `main`, `subagent` or `auxiliary`. The `claude_code.api_request` event
carries the raw string. So one agent's metrics say `main` while its events say
`repl_main_thread:outputStyle:Explanatory`.

**Subagent sources are built as** `agent:builtin:<agentType>` for a built-in
agent and `agent:custom:<agentType>` for every other one
(`LUe(e,t){if(t)return e?`agent:builtin:${e}`:"agent:default";return e?`agent:custom:${e}`:"agent:custom"}`).
For a plugin agent the `agentType` itself contains the plugin prefix, e.g.
`agent:custom:uroboros:researcher` — the CLI's own parser reads the **whole**
remainder as the agent name and takes the part before the first colon as the
plugin. `agent:plugin:acme:Digger`, which the current code and its tests assume,
is a form the CLI never emits.

**Redaction.** `KTy` redacts the agent name on log events and metrics unless the
agent is built in or belongs to a plugin from an official/bundled marketplace:

```js
if(r!==void 0) if(e?.startsWith("agent:builtin:")) a.attributionAgent=r;
else { let l = o!==void 0 && Xbo.has(o); a.attributionAgent = l ? r : "custom" }
```

and `Gv` redacts the source beside it: `agent:custom:my-reviewer` → `agent:custom`.
`Xbo` is filled only for marketplaces classified `official` or `default-bundle`,
so a project-local agent **and** a plugin installed from a user marketplace
(uroboros's own agents included) both report `agent.name: 'custom'` and
`query_source: 'agent:custom'` on every event and metric.

**What is not redacted.** `claude_code.llm_request` and `claude_code.tool` spans
carry the raw `query_source` plus `agent_id`; `claude_code.api_request_body`
carries the raw `query_source` (`HMo` passes `i.querySource` with no `Gv`);
`claude_code.subagent_completed` carries the real `agent_type` when
`OTEL_LOG_TOOL_DETAILS=1` and the literal `"custom"` otherwise. No event or
metric carries `agent_id`, and no span carries `agent.name` — the two names are
never on one record.

**Consequence.** For a redacted agent the events and metrics cannot be
attributed to one subagent at all: they say only "some custom subagent". Where
exactly one custom subagent is known in the session, that is a deduction, not a
guess. Where two or more are known, the telemetry does not say which, and this
change does not invent an answer.

## Implementation plan

Four edits, in this order.

### 1. `tools/argus/src/claude.mjs` — rewrite the attribution rules

Export two new constants beside `MAIN_AGENT_KEY`:

```js
/** What the CLI writes instead of the name of an agent it will not name. */
export const REDACTED_AGENT_NAME = 'custom';
/** The one bucket every record with a redacted agent name falls into. */
export const REDACTED_AGENT_KEY = 'redacted:custom';
```

Replace `MAIN_QUERY_SOURCES`, `SYSTEM_QUERY_SOURCES` and `AGENT_SOURCE_RE` with:

```js
const MAIN_QUERY_SOURCES = new Set(['main', 'sdk', 'cli']);
const MAIN_SOURCE_PREFIX = 'repl_main_thread';
const AGENT_SOURCE_RE = /^agent:(?:builtin|custom|default):(.+)$/;
const REDACTED_AGENT_SOURCE = 'agent:custom';
const UNNAMED_SUBAGENT_KEY = 'subagent';
```

Rewrite `agentRefOf` to decide in this order, keeping its return shape
`{key, name, kind, agentId}` and keeping `agentId` on every branch:

| # | Condition on the attributes | Result |
| - | --------------------------- | ------ |
| 1 | `query_source` matches `AGENT_SOURCE_RE` | `key` and `name` are the **whole** captured remainder, `kind: 'subagent'` |
| 2 | `agent.name` is a non-empty string other than `REDACTED_AGENT_NAME` | `key` and `name` are that value, `kind: 'subagent'` |
| 3 | `agent.name === REDACTED_AGENT_NAME` or `query_source === REDACTED_AGENT_SOURCE` | `key: REDACTED_AGENT_KEY`, `name: null`, `kind: 'subagent'` |
| 4 | `query_source` is in `MAIN_QUERY_SOURCES` or starts with `MAIN_SOURCE_PREFIX` | `key: MAIN_AGENT_KEY`, `name: null`, `kind: 'main'` |
| 5 | `query_source === 'hook_agent'` | `key: 'hook_agent'`, `name: null`, `kind: 'subagent'` |
| 6 | `query_source` is `'subagent'` or starts with `'agent:'` | `key: UNNAMED_SUBAGENT_KEY`, `name: null`, `kind: 'subagent'` |
| 7 | any other non-empty `query_source` | `key` and `name` are that value, `kind: 'system'` |
| 8 | no source and an `agent_id` | `key: 'id:<agentId>'`, `name: null`, `kind: 'subagent'` |
| 9 | nothing | `key: MAIN_AGENT_KEY`, `name: null`, `kind: 'main'` |

Rule 1 before rule 2 because the source is the copy no redaction touched. Rule
7 replaces the current fallback, which turned every auxiliary source into a
subagent named after itself: the CLI enumerates no bare-name source, so an
unrecognised value is auxiliary, exactly as `TU` decides it.

Rewrite the doc comment above `agentRefOf` to state the redaction and the two
vocabularies; delete the comment sentence "The docs enumerate every non-name
value above, so anything left is a subagent name sent bare", which is the false
premise this round removes.

### 2. `tools/argus/src/agents.mjs` — fold the redacted bucket at read time

Import `REDACTED_AGENT_KEY` from `./claude.mjs`.

Add, with a comment saying why the fold is a read-time step and not an ingest-time
one — at ingest the session has only the records that already arrived, and traces
and logs are exported on independent schedules, so a bucket merged early would
mis-attribute the records of a second custom agent that had not appeared yet:

```js
/** The single named custom subagent a redacted record can only belong to, or null. */
export function redactedFoldTarget(session) {
  if (!session.agents.has(REDACTED_AGENT_KEY)) return null;
  const named = [...session.agents.values()].filter((agent) =>
    [...agent.querySources].some((source) => source.startsWith('agent:custom:')),
  );
  return named.length === 1 ? named[0].key : null;
}
```

Add a `cloneAgent(agent)` helper that deep-copies a bucket: spread the object,
then fresh `Set`s for `agentIds` and `querySources`, fresh objects for `counts`,
`tokensMetric` and `tokensEvent`, fresh arrays for `occupancy`, `bodies` and
`completions`, and fresh `Map`s for `models` and `tools` whose entries copy each
stats field the way `mergeStats` reads it — a number is copied by value, anything
else by `{ ...value }`.

Change `summarizeAgents(session)` to compute `redactedFoldTarget(session)` first;
when it returns a key, drop the `REDACTED_AGENT_KEY` bucket from the list and
replace the target bucket with `mergeAgent(cloneAgent(target), redacted)` before
summarizing. `mergeAgent` already merges counts, tokens, cost, model and tool
stats, occupancy, bodies, completions, first/last seen, ids and sources, and
already re-sorts the rings by time — it needs no change. Nothing is mutated in
the store, so two reads of the same session give the same answer.

Change `agentKeyOf(session, attrs)` so that a ref resolving to
`REDACTED_AGENT_KEY` returns `redactedFoldTarget(session)` when that is not
null: the assistant-response records of a folded agent must reach the same
content list as its tool spans.

Add to `labelOf`: `agent.key === REDACTED_AGENT_KEY` gives
`'custom subagents (names redacted)'`.

Add one field to the object `summarizeAgent` returns:
`nameRedacted: agent.key === REDACTED_AGENT_KEY`. It is what the interface keys
its hint off, and it is false on every other card, the folded one included.

### 3. `tools/argus/src/store.mjs` — two small follow-ons

In `#applySubagentCompleted`, a completion whose `agent_type` is
`REDACTED_AGENT_NAME` names no agent: bucket it as
`{key: REDACTED_AGENT_KEY, name: null, kind: 'subagent', agentId: attrs.agent_id || null}`
instead of as an agent called `custom`. Any other `agent_type` keeps today's
behaviour. Import `REDACTED_AGENT_NAME` and `REDACTED_AGENT_KEY` from
`./claude.mjs`.

In `summarizeSession`, make `agentCount` count what a reader will see:
`session.agents.size - (redactedFoldTarget(session) ? 1 : 0)`. Import
`redactedFoldTarget` from `./agents.mjs`.

Leave `getAgentBody` alone: `claude_code.api_request_body` carries the
unredacted source, so a captured payload is indexed on the named bucket already
and never on the redacted one.

### 4. `tools/argus-ui/public/app.js` — replace the hint that cannot come true

The `nameHint` in `renderAgentDetail` currently fires on `agent.name === 'custom'`
and tells the reader to set `OTEL_LOG_TOOL_DETAILS=1` to see the real name. That
switch does not un-redact events or metrics; it only makes a second card appear.
Fire the hint on `agent.nameRedacted` instead, and write a sentence that says:
the CLI withholds the name of any subagent that is not built in and not from an
official marketplace, so these records can only be pooled; the real names appear
on traces (`OTEL_TRACES_EXPORTER=otlp`), on `claude_code.api_request_body`
(`OTEL_LOG_RAW_API_BODIES=1`) and on `claude_code.subagent_completed`
(`OTEL_LOG_TOOL_DETAILS=1`), and when exactly one such subagent is known its
records are shown under its own name. The hint must not promise that any switch
renames this card. The exact wording is yours; keep it inside the existing
`switchHint(...)` helper so it renders like the other hints.

### 5. `tools/argus/README.md` — document the rule

Add a subsection `### Which agent a record belongs to` at the end of "What comes
out of it" (before `## Options`), in the README's voice and under ten lines:
attribution is read from `query_source`, then `agent.name`, then `agent_id`, and
a record naming nothing is the main session; the CLI replaces the name of a
subagent that is neither built in nor from an official marketplace with `custom`
on events and metrics, while traces, request bodies and (with
`OTEL_LOG_TOOL_DETAILS=1`) the completion event keep the real name; those
redacted records are pooled in one bucket, and when the session shows exactly
one named custom subagent they are served as that agent's.

Change nothing else in `README.md`, and change no file under `skills/`,
`agents/` or `workflows/`. Run `rm -rf ~/.claude/plugins/cache/uroboros` once in
the turn you finish the edits anyway: round 0 changed `skills/argus/SKILL.md`
and the reviewer could not verify the cache was cleared then.

### Alternatives rejected

- **Key every `agent:custom:*` record by the redacted key** so events and spans
  always meet. One bucket per session for all custom agents: in an uroboros
  session that is five agents on one card, and it throws away names the spans
  do carry. Rejected.
- **Fold the redacted bucket into the first named custom agent at ingest.** A
  second custom agent appearing later cannot un-merge what was already merged,
  and logs and traces arrive on independent schedules, so this silently books
  one agent's tokens onto another. Rejected in favour of the read-time fold,
  which sees the whole session every time it runs.
- **Join `claude_code.api_request` events to `claude_code.llm_request` spans on
  `request_id`/`client_request_id`.** Both records carry both identifiers, so
  this would attribute events per agent even with several custom agents running.
  It needs a second parking map with its own retention behaviour — the reviewer
  already flagged the retention of the existing one — and it still leaves the
  token and cost metrics unattributable, since those carry no request id.
  Too large for a correction round; noted here as the way to go further.
- **Derive the occupancy curve from `llm_request` spans, which are unredacted.**
  It would double-count every call whenever logs and traces are both exported.
  Rejected.
- **Drop `'cli'` from the main sources.** No CLI build emits it; it costs
  nothing, and dropping it would send a hypothetical main session into a system
  bucket. Kept.

## Module map

| Path | What it holds | Entry points this round |
| ---- | ------------- | ----------------------- |
| `tools/argus/src/claude.mjs` | Claude Code domain knowledge: event/span/metric names, attribution | `agentRefOf` (l. 230), `MAIN_QUERY_SOURCES` (l. 203), `AGENT_SOURCE_RE` (l. 209), `MAIN_AGENT_KEY` (l. 195) |
| `tools/argus/src/agents.mjs` | per-agent buckets, merging, summaries, content and body read paths | `agentBucketFor` (l. 162), `mergeAgent` (l. 214), `labelOf` (l. 267), `summarizeAgent` (l. 276), `summarizeAgents` (l. 309), `agentKeyOf` (l. 360) |
| `tools/argus/src/store.mjs` | ingest, session aggregation, JSON API queries | `#applySubagentCompleted` (l. 414), `getSessionAgents` (l. 962), `summarizeSession` (l. ~1160-1197, `agentCount` l. 1193) |
| `tools/argus-ui/public/app.js` | the whole interface, served as written | `renderAgentDetail` (l. 456), `nameHint` (l. 475) |
| `tools/argus/README.md` | user-facing page of the collector | "What comes out of it" (l. 421), "Options" (l. 429) |
| `tools/argus/test/claude.test.mjs` | unit cases for `claude.mjs` | agent-ref cases, l. 51-113 |
| `tools/argus/test/agents.test.mjs` | integration cases driving a real `TelemetryStore` | helpers `metric`/`log`/`span`/`requestBody`, l. 6-61 |

## Environment

- Node ≥ 20.11, already installed. Both projects have zero runtime dependencies
  and no build step, so nothing has to be installed before anything runs.
- The whole repository suite: `bash test.sh`. `./test.sh` cannot be invoked
  directly — the file is mode `100644` on the default branch too — so `bash` in
  front of it is not optional.
- One package suite: `npm --prefix tools/argus test` and
  `npm --prefix tools/argus-ui test`.
- One test file: `node --test tools/argus/test/claude.test.mjs` (and the same
  with `agents.test.mjs`), from the repository root.
- There is no linter and no formatter in this repository.

## Test Plan

### Whether

Tests are needed. Finding 1 exists because `repl_main_thread` had no case at
all; Finding 2 changes what the store serves for a whole class of session. Both
get a failing case before the fix.

### What

**Criterion 2 — the agent a record belongs to is resolved from the attributes,
and a record naming no agent is the main session.**

1. The REPL's own query source is the main session: `repl_main_thread` and
   `repl_main_thread:outputStyle:Explanatory` resolve to `main`, alongside the
   `{}`, `sdk` and `main` cases already covered.
2. The auxiliary vocabulary is not a set of subagents: `auxiliary`, `compact`,
   `hook_prompt`, `side_question`, `web_search_tool`, `web_fetch_apply`,
   `repl_sampling`, `auto_mode`, `compact_fab_check`, `auto_mode_critique`,
   `auto_mode_setup_propose` and `chrome_mcp` each resolve to `kind: 'system'`
   keyed by the source itself.
3. A subagent source names the whole remainder: `agent:builtin:Explore` →
   `Explore`, `agent:custom:uroboros:researcher` → `uroboros:researcher`.
   `agent:plugin:acme:Digger` is a form the CLI does not emit; the case
   asserting it is replaced by these two rather than kept.
4. The redaction placeholder is not a name: `{'agent.name': 'custom',
   query_source: 'agent:custom'}` (the event form) and `{'agent.name': 'custom',
   query_source: 'subagent'}` (the metric form) both resolve to key
   `redacted:custom`, `name: null`, `kind: 'subagent'`.
5. An unredacted source outranks a redacted name: `{'agent.name': 'custom',
   query_source: 'agent:custom:my-reviewer'}` → key and name `my-reviewer`.
6. Edge, kept from the current file: empty strings name nothing (`main`), a bare
   `agent_id` keys `id:<id>` and carries the id, `agent.name` plus `agent_id`
   keys the name and carries the id, `subagent` alone is the one unnamed bucket.
7. Integration: a REPL session running an output style is one agent. Two
   `claude_code.api_request` events with
   `query_source: 'repl_main_thread:outputStyle:Explanatory'` plus a
   `claude_code.token.usage` metric with `query_source: 'main'` give exactly one
   agent, `main`, with `counts.apiRequests === 2` and the metric's tokens on it.

**Criterion 1 — one bucket per agent — and criterion 6 — a subagent reports its
completion.**

8. The reviewer's reproduction, in one session: the `claude_code.api_request`
   event with the redacted attribution, the `claude_code.llm_request` span with
   `agent:custom:my-reviewer` and `agent_id: 'a1'`, the `claude_code.tool` span
   with `agent_id: 'a1'`, and the `claude_code.subagent_completed` event with
   `agent_type: 'my-reviewer'`. Two agents come back — `main` and `my-reviewer` —
   with the tokens, the cost, the occupancy entry, the tool call, the llm span
   and the completion all on `my-reviewer`, and no agent keyed `custom` or
   `redacted:custom`.
9. The same records ingested spans-first give the same answer: the fold is a
   read, so arrival order cannot change it.
10. Without `OTEL_LOG_TOOL_DETAILS` the completion still lands on the agent that
    holds the figures: the same fixture with `agent_type: 'custom'` puts the
    completion row on `my-reviewer`.
11. The session total stays the sum of its agents across the fold, and
    `agentCount` on the session summary equals the number of agents served.
12. Two custom subagents are not guessed apart: two `claude_code.llm_request`
    spans naming `agent:custom:alpha` and `agent:custom:beta` plus one redacted
    `claude_code.api_request` give three agents, where the redacted tokens sit
    on the bucket keyed `redacted:custom` with `nameRedacted === true` and the
    label `custom subagents (names redacted)`, and neither `alpha` nor `beta`
    has been credited with them.
13. An agent's content follows the fold: with the fixture of case 8 plus a
    `claude_code.assistant_response` event carrying the redacted attribution,
    `store.getAgentContent(SESSION, 'my-reviewer')` returns that response
    alongside the tool call.

**Left untested, deliberately.** The interface change in
`tools/argus-ui/public/app.js`: `public/` has no test harness in that project
(`test/` holds `config`, `server` and `independence` only), and every figure the
card renders is asserted on the API side. The README subsection: prose. The
plugin-cache deletion: nothing a test can observe. The `agent:default` and
`hook_agent` sources: they resolve through the same two lines as cases 2 and 6
and no criterion turns on them.

### How

All cases are `node:test` with `node:assert/strict`, the framework both files
already use. No mocking, no fixtures on disk: the collector is driven through
its real ingest path.

Cases 1-6 are unit cases in `tools/argus/test/claude.test.mjs`. They call
`agentRefOf(attrs)` directly and assert `key`, `name` and `kind` field by field,
which is what every case in that file does today. Test names are lowercase
sentences naming the rule, not the function. Cases 1, 3 and 6 are edits to the
tests already there (`a record with no attribution attributes belongs to the
main session`, `query_source alone names a subagent`, `auxiliary and compact are
their own kind, not the main session`), extended rather than duplicated; cases
2, 4 and 5 are new tests. Import `REDACTED_AGENT_KEY` from `../src/claude.mjs`
and assert against the constant rather than retyping the literal.
Run with `node --test tools/argus/test/claude.test.mjs`.

Cases 7-13 are integration cases in `tools/argus/test/agents.test.mjs`. Use the
file's own helpers: `log(eventName, attrs)`, `span(name, attrs, {spanId})`,
`metric(name, value, attrs)` and the `SESSION` constant, a fresh
`new TelemetryStore()` per test, `store.ingest('logs' | 'traces' | 'metrics', [...])`,
then `store.getSessionAgents(SESSION)` and `agents.find((agent) => agent.key === …)`.
Give each ingest of a different signal its own `store.ingest` call when the case
is about arrival order, the way `an agent_id is joined onto the name as soon as
one record carries both` does. Attribute values may be strings — the store
coerces — and the `subagent_completed` fixture should send `total_tokens`,
`total_tool_uses` and `duration_ms` as strings, which is how the CLI sends them.
Assert numbers exactly, never a range.
Run with `node --test tools/argus/test/agents.test.mjs`.

Concrete fixture for cases 8-11, to be reused across them:

```js
log('claude_code.api_request', {
  model: 'claude-opus-5', input_tokens: 1000, cost_usd: 0.5,
  'agent.name': 'custom', query_source: 'agent:custom',
})
span('claude_code.llm_request',
  { agent_id: 'a1', query_source: 'agent:custom:my-reviewer', model: 'claude-opus-5' },
  { spanId: 'llm-1' })
span('claude_code.tool', { tool_name: 'Read', tool_use_id: 'tu-1', agent_id: 'a1' },
  { spanId: 'tool-1' })
log('claude_code.subagent_completed', {
  agent_type: 'my-reviewer', is_built_in: 'false',
  total_tokens: '1000', total_tool_uses: '1', duration_ms: '900',
})
```

Expected for case 8: `agents.length === 2`; the `my-reviewer` agent has
`tokensTotal === 1000`, `costUsd === 0.5`, `counts.toolCalls === 1`,
`counts.llmRequests === 1`, `counts.apiRequests === 1`,
`context.series.length === 1`, `completions.length === 1` with
`completions[0].agentType === 'my-reviewer'`, `nameRedacted === false` and
`label === 'my-reviewer'`; and
`agents.some((agent) => agent.key === 'redacted:custom' || agent.key === 'custom') === false`.

### What counts as done

```
bash test.sh
```

That is the closed list. It runs the repository checks, the worktree checks,
`tools/argus`, `tools/argus-ui` and `tools/log-parser`, which is every suite
this change can reach plus the acceptance criterion "`./test.sh` is green".
Nothing else is to be run for the review; the per-file and per-package commands
in "Environment" are there for iterating while writing, not for judging.

### What is already red

Nothing, as far as reading says: the reviewer ran `bash test.sh` at the end of
round 1 and reported exit 0 with `PASS: all 5 suites`, nothing skipped or
excluded, and no commit has landed since. I ran none of it myself. The first
run belongs to whoever runs it downstream.

I did run `grep -ao` over the installed `claude` binary — a read, not a test —
because every rule in this plan depends on what that binary emits and no other
source in the repository states it.
