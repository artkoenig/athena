# Test-author handoff — argus shows what the session and each agent hold in context

Every case in the researcher's test plan is written and confirmed red. Read
this file case by case against the researcher's numbering; do not edit
production code from here — that is the implementer's job, working from
`researcher.md` and this file's open questions.

## A. `tools/argus/test/claude.test.mjs` (existing file, cases added)

Run: `node --test tools/argus/test/claude.test.mjs`

The whole file fails at import, because `agentRefOf` does not exist yet:

```
SyntaxError: The requested module '../src/claude.mjs' does not provide an export named 'agentRefOf'
```

That one failure covers all 8 cases below, since the file cannot load. Test
names, each written verbatim from the plan's case sentence:

1. `a record with no attribution attributes belongs to the main session`
2. `agent.name names the subagent a record belongs to`
3. `query_source alone names a subagent`
4. `a bare subagent source becomes one unnamed bucket`
5. `auxiliary and compact are their own kind, not the main session`
6. `an agent_id with no name keys the agent by its id and keeps the id`
7. `empty attribute values do not name an agent`
8. `the subagent completion event is known by name`

All 8 are written exactly as case 1–8 describe them, importing `agentRefOf`
and `EVENT` alongside the file's existing imports.

## B. `tools/argus/test/agents.test.mjs` (new file, 23 cases)

Run: `node --test tools/argus/test/agents.test.mjs` — 23 tests, 0 pass, 23
fail, all with `store.getSessionAgents is not a function`,
`store.getAgentContent is not a function` or `store.getAgentBody is not a
function` (none of the three new query methods exist yet, so every case reaches
one of them and stops there — no case fails for an unrelated reason). The
fixture helpers (`metric`, `log`, `span`, `NOW`) are copied verbatim from
`test/store.test.mjs` as the plan says each file owns its own; `requestBody`
is the one new helper for `claude_code.api_request_body` events.

Test name → plan case → observed error:

9. `a session splits into the main session and the subagents that ran in it` — `store.getSessionAgents is not a function`
10. `records naming no agent are the main session, never an unknown one` — `store.getSessionAgents is not a function`
11. `the session total is the sum of its agents` — `store.getSessionAgents is not a function`
12. `per-agent tokens prefer metrics over events, like the session total` — `store.getSessionAgents is not a function`
13. `an agent_id is joined onto the name as soon as one record carries both` — `store.getSessionAgents is not a function`
14. `an agent_id that is never named stays an agent of its own, labelled by its id` — `store.getSessionAgents is not a function`
15. `occupancy is one entry per model call and sums input, cache read and cache creation` — `store.getSessionAgents is not a function`
16. `peak and last occupancy, and the cached prefix of the last prompt, are reported` — `store.getSessionAgents is not a function`
17. `an agent that made no model call reports no series and no ratio` — `store.getSessionAgents is not a function`
18. `peak occupancy survives the series rolling over` — `store.getSessionAgents is not a function`
19. `a request body is indexed per agent and served from the raw window` — `store.getSessionAgents is not a function`
20. `a truncated payload is served as truncated with its real length and is never parsed` — `store.getSessionAgents is not a function`
21. `a payload shorter than its stated length counts as truncated without the flag` — `store.getSessionAgents is not a function`
22. `an untruncated payload that will not parse reports the error rather than a half object` — `store.getSessionAgents is not a function`
23. `a payload whose record has rolled out is reported as gone, with its size intact` — `store.getSessionAgents is not a function`
24. `an unknown body seq and an unknown agent are answered with null` — `store.getAgentBody is not a function`
25. `a subagent reports what subagent_completed said about it` — `store.getSessionAgents is not a function`
26. `two runs of the same subagent are one agent with two completions` — `store.getSessionAgents is not a function`
27. `content is returned per agent in the order it entered that context` — `store.getAgentContent is not a function`
28. `a tool call with no span is listed under the main session` — `store.getAgentContent is not a function`
29. `the capture report names the switch behind every content kind` — `store.getSessionAgents is not a function`
30. `tool output content is detected on the span event, not on the event` — `store.getSessionAgents is not a function`
31. `an agent's wall time covers its own records only` — `store.getSessionAgents is not a function`

## C. `tools/argus/test/server.test.mjs` (existing file, cases added)

Run: `node --test tools/argus/test/server.test.mjs` — 22 tests, 17 pass (all
pre-existing), 5 fail. A local `logRecord(sessionId, eventName, attrs, timeMs)`
helper was added, matching `test/store.test.mjs`'s `log()` shape but
parameterised by session id, since this file otherwise builds OTLP wire
payloads rather than calling `store.ingest` with bare records — the plan's
convention for this file explicitly calls for the latter on the new cases.

32. `the agents route serves the per-agent aggregation of one session` — fails: `404 !== 200` (the route does not exist, every unmatched `/api/*` path 404s).
33. `the agents route answers 404 for a session it does not know` — fails: body is `{ error: 'unknown endpoint' }`, expected `{ error: 'unknown session' }`.
34. `the content route serves one agent's records in order and 404s an unknown agent` — fails: `404 !== 200`.
35. `the body route serves one payload and marks a truncated one` — fails: `TypeError: Cannot read properties of undefined (reading 'find')`, because `body.agents` is undefined (the `/agents` route 404s before the body route is even reached).
36. `the config route names the per-agent bound` — fails: `store.options.maxAgentCalls` is `undefined`, expected `100`. (This case initially passed vacuously — `config.limits.agentCalls` and `store.options.maxAgentCalls` were both `undefined` before either side of the plan's assertion existed, so `undefined === undefined` was a false green. I added an explicit assertion that `store.options.maxAgentCalls` is `100` — the default the plan's `DEFAULTS` section names — ahead of the comparison, so the case is genuinely red now.)

## What was not written, and why

Per the plan's "Not tested, deliberately" section, nothing was written for:
`tools/argus-ui/public/app.js` and `styles.css` (no DOM harness, reviewed by
reading), the README/SKILL.md prose, agent eviction with its session (no
separate path), and the token gate on the new routes (same `if (!ok)` branch
every `/api/` path already goes through).

## Open questions for the researcher

1. **`context.series` vs. bare `series`/`peakOccupancy` — is there one
   `context` sub-object on the summarized agent, or are these fields flat?**
   Case 15 names the field `context.series`. Cases 16–18 then refer to
   `peakOccupancy`, `lastOccupancy`, `series` without the `context.` prefix,
   while `newAgent`'s shape in the implementation plan (§2) has `occupancy`,
   `peakOccupancy`, `lastOccupancy`, `lastCachedPrefixTokens`,
   `lastFreshTokens` as flat top-level fields on the *internal* bucket, with
   no `context` object and no field named `series` at all. I read 16–18 as
   continuing case 15's naming by shorthand and wrote every occupancy
   assertion in `agents.test.mjs` against `agent.context.series`,
   `agent.context.peakOccupancy`, `agent.context.lastOccupancy`,
   `agent.context.lastCachedPrefixTokens`, `agent.context.lastFreshTokens`,
   `agent.context.lastCachedPrefixRatio` — i.e. I assumed `summarizeAgents`
   nests these six fields under a `context` key that does not appear in §2's
   internal-bucket shape, distinct from the internal `occupancy` array. If the
   implementer's shape differs (e.g. flat fields, or the array kept as
   `occupancy` rather than renamed to `series`), cases 15–18 need their
   property paths adjusted to match — the values and assertions themselves are
   not otherwise in question.

2. **`agent.durationMs` — is per-agent wall time reported under this name?**
   The plan never gives the field name for an agent's wall time in the
   summarized shape (only `firstSeenMs`/`lastSeenMs` on the internal bucket
   are named, in §2). Case 31 needs some reported duration; I asserted
   `explore.durationMs === 200`, mirroring the session's own `durationMs`
   convention (visible in `store.test.mjs`'s span tests) as the plan's chosen
   style. If the summarized shape instead exposes only `firstSeenMs`/
   `lastSeenMs` and expects the reader to subtract, this assertion needs
   updating to match.

3. **`session.counts.apiRequests`** — case 11 needs a session-level counter to
   sum the agents' `counts.apiRequests` against. `store.test.mjs`'s existing
   assertions only ever read `session.counts.interactions`, `.llmRequests`,
   `.toolCalls`, `.toolFailures` — never `.apiRequests` — so its presence on
   the session (as opposed to only on the per-agent `counts` the plan names
   explicitly in §2) is not confirmed anywhere I was given. I wrote the
   assertion against `session.counts.apiRequests` because case 9 already
   established `agent.counts.apiRequests` as a real field and case 11 reads
   as directly comparable; if the session object does not carry this counter,
   the comparison needs a different session-side figure.

4. **The `tool.output` span event's attribute key** — case 30 needs a
   `claude_code.tool` span carrying a span event named `tool.output`, and the
   plan says the content item's `output` should carry "that event's
   attributes" (§2, `collectAgentContent` step 3). Nothing in what I was
   given states whether a span event's attributes live under `.attrs`
   (matching every other record's convention used throughout `store.mjs` and
   its tests) or `.attributes` or something else. I used `.attrs` in the
   fixture, matching the convention. If span events use a different key, the
   fixture's `events: [{ name: 'tool.output', timeMs, attrs: {...} }]` needs
   its key renamed to match.

None of these four are conflicts with the plan's intent — they are shape
details the plan's module map left to the implementation, and I could not
resolve them without opening `src/store.mjs` or `src/agents.mjs`, which is out
of bounds for this role. Flag them back to whoever reconciles the test plan
with the implementation; if the implementer's shape differs from my
assumption, the fix is a one-line property-path change in the four affected
cases, not a rewrite.

## Commands run

- `node --test tools/argus/test/claude.test.mjs` — 1 test entry (whole-file
  import failure), 0 pass, 1 fail, exit 1.
- `node --test tools/argus/test/agents.test.mjs` — 23 tests, 0 pass, 23 fail,
  exit 1.
- `node --test tools/argus/test/server.test.mjs` — 22 tests, 17 pass, 5 fail,
  exit 1.

No other command was run. `./test.sh` and the linter are the implementer's to
run once the code exists.
