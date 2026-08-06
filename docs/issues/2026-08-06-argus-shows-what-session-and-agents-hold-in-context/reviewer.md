# Review round 0 — argus shows what the session and each agent hold in context

Status: **1 finding requires a correction.**

## Commands run

- `bash test.sh` — the whole repository suite: repository checks (8 cases),
  worktree checks (4 cases), `tools/argus` (170 cases), `tools/argus-ui`
  (14 cases), `tools/parse-agent-log` (23 cases). Exit 0, `PASS: all 5 suites`,
  nothing skipped or excluded.
- Pre-existing fact, not caused by this change: `./test.sh` exits 126
  (`Permission denied`). `test.sh` is mode `100644` in git and was last touched
  on `main` by ed592de, so the executable bit is missing on the default branch
  too. `bash test.sh` is the invocation that runs. No acceptance criterion asks
  for the bit to be set; reported and dropped.

## Finding 1 — the per-agent Tools table reports 0 failures for a tool that failed

Violates no acceptance criterion. It is a figure the change adds that can never
be anything but zero, and it contradicts the KPI directly above it in the same
panel.

**Where.** `tools/argus/src/store.mjs:643` increments `stats.failures` on the
session's tool bucket only — the `EVENT.toolResult` branch takes
`this.#tool(session, attrs.tool_name)` and has no agent counterpart, unlike
every other branch in the file, which now writes to both buckets. `failures` is
incremented in exactly one place in `store.mjs`, so an agent's
`tools[].failures` is 0 for every agent, every tool, always.
`tools/argus-ui/public/app.js:594` renders a `Failures` column from that field
and `app.js:601` marks it `bad` when non-zero.

**Reproduction.** Into one session ingest:

1. span `claude_code.tool` with `{tool_name: 'Bash', tool_use_id: 'tu-1', agent_id: 'a1', query_source: 'agent:builtin:Explore'}`,
2. span `claude_code.tool.execution` with `{success: 'false', agent_id: 'a1'}`,
3. log `claude_code.tool_result` with `{tool_name: 'Bash', tool_use_id: 'tu-1', success: 'false'}`.

Then `store.getSessionAgents(id)` returns the `Explore` agent with
`counts.toolFailures === 1` but `tools.find(t => t.name === 'Bash').failures
=== 0`, while `store.getSession(id).tools` reports `failures: 1` for `Bash`. In
the Agents tab this is one screen saying "tool calls 1 · 1 failed" over a table
row saying "Bash · 1 call · 0 failures".

**Note for whoever corrects it.** The join the fix needs already exists in the
file: `#applyResultTokenFallback` / `#applyResultBytesFallback` pair a
`claude_code.tool` span with its `tool_result` event by `tool_use_id`, which is
the same join that would attribute a failure to an agent. Dropping the column
from the agent table is the other way out. Which of the two is the
implementer's call.

## Everything else checked

- **Criteria met, verified by reading the diff and the tests:** per-agent
  aggregation with the main session as the fallback bucket
  (`claude.mjs#agentRefOf`, `agents.mjs#agentBucketFor`, including the
  `agent_id` → name fold); occupancy series, peak, last, cached prefix and
  ratio; per-agent tokens/cost/models/tool calls/wall time with the session
  total as their sum; `claude_code.subagent_completed` learned by `claude.mjs`
  and reported on the subagent; request-body index per agent per call with the
  payload left in the raw log window; a truncated payload served cut, labelled
  with the real `body_length` and never parsed; per-agent content in arrival
  order; a named switch on every empty content panel; three new JSON routes
  documented in `tools/argus/README.md` and `skills/argus/SKILL.md`; the Agents
  tab in `tools/argus-ui`; the memory bound and its cost in "Limits"; the
  request-body warning in "Sensitive data"; the capture section in
  `skills/argus/SKILL.md`; no new runtime dependency and no import from
  `tools/argus` into `tools/argus-ui`.
- **The five switches are real.** `OTEL_LOG_ASSISTANT_RESPONSES` is not in the
  issue's list of four, so I checked it against the installed CLI binary:
  `grep -ac OTEL_LOG_ASSISTANT_RESPONSES /opt/claude-code/bin/claude` finds it,
  as it finds the other four and `subagent_completed`, `api_request_body`,
  `agent.name`, `agent_id`, `query_source`, `body_length`, `body_truncated` and
  `tool.output`. Naming it beside `OTEL_LOG_USER_PROMPTS` as its fallback is
  accurate, not invented prose.
- **Tests against the intent.** Every criterion that a tool can check has a case
  that fails if the behaviour breaks: `test/agents.test.mjs` covers the split,
  the no-agent fallback, the sum, the metric-over-event preference, the id/name
  join, the id-only bucket, the occupancy arithmetic, peak survival across a
  roll-over, all four body states (whole, flagged truncated, short-of-stated
  truncated, unparseable), the rolled-out payload, completions, content order,
  the unspanned tool call, and the capture report; `test/claude.test.mjs` covers
  `agentRefOf` per attribute including empty strings; `test/server.test.mjs`
  covers all three routes, their 404s and the config bound. The Agents tab
  itself is untested, which matches the project's standing convention that
  `public/` has no test harness (`tools/argus-ui/test/` holds only
  `config`, `server` and `independence`); no criterion is left unverifiable by
  that.
- **Blast radius.** Nothing else found. `emptyModelStats`, `emptyToolStats` and
  `mergeUsage` moved from `store.mjs` to `agents.mjs` field for field, and
  `summarizeSession` now builds `models`/`tools` through `summarizeModels`/
  `summarizeTools`, which emit the identical shape — the 170 existing
  `tools/argus` cases stay green. `agentCount` on the session summary is
  additive. `tools/argus-ui` forwards `/api/*` generically
  (`src/server.mjs:52`), so the new routes need no change there. `SKILL.md` and
  `tools/argus/README.md` are the only two files that list the API routes and
  both were updated; no other document went stale.
- **Not verifiable from the diff:** whether `rm -rf ~/.claude/plugins/cache/uroboros`
  was run alongside the `skills/argus/SKILL.md` edit. The cache directory exists
  in this session, but it is re-created at session start, so its presence proves
  nothing either way. Stated as a fact, not counted as a finding.
