# Review round 1 — argus shows what the session and each agent hold in context

Status: **2 findings require a correction.**

Both are in one place: `agentRefOf` in `tools/argus/src/claude.mjs` decides which
agent a record belongs to from `query_source`, and the vocabulary it assumes is
not the vocabulary Claude Code sends. Everything downstream of it — buckets,
figures, curves, the Agents tab — is correct given its answer.

## Commands run

- `npm --prefix tools/argus test --silent` — the collector suite, 176 cases,
  exit 0 (`# pass 176`, `# fail 0`, 0 skipped, 0 todo).
- `bash test.sh` — the whole repository: repository checks (8 cases), worktree
  checks (4 cases), `tools/argus` (176 cases), `tools/argus-ui` (14 cases),
  `tools/parse-agent-log` (23 cases). Exit 0, `PASS: all 5 suites`, nothing
  skipped or excluded.

Pre-existing fact, not caused by this change and not a finding: `./test.sh`
cannot be invoked directly. `git ls-tree main -- test.sh` reports mode `100644`,
so the executable bit is absent on the default branch too; `bash test.sh` is the
invocation that runs, and it is the one named for this change.

All evidence about what the CLI emits below was read out of the installed binary
`/opt/claude-code/bin/claude` (Claude Code, the build this checkout runs
against) with `grep -ao`. Every quoted fragment can be re-found with the grep
given beside it.

## Finding 1 — the main session is bucketed as a subagent whenever an output style is active

Violates acceptance criterion 1 ("an agent is the main session plus every
subagent that ran inside it") and criterion 2 ("the agent a record belongs to is
resolved from the attributes listed above").

**Where.** `tools/argus/src/claude.mjs`, `MAIN_QUERY_SOURCES` and the final
branch of `agentRefOf`:

```js
const MAIN_QUERY_SOURCES = new Set(['main', 'repl_main_thread', 'sdk', 'cli']);
...
// The docs enumerate every non-name value above, so anything left is a
// subagent name sent bare.
return ref(source, source, 'subagent');
```

The membership test is exact, but the CLI builds the REPL's query source by
appending the active output style. In the binary:

```
grep -ao 'outputStyle:\${.\{0,120\}' /opt/claude-code/bin/claude
  →  outputStyle:${t}`:"repl_main_thread:outputStyle:custom"
grep -ao 'LKg=new Set(\[.\{0,600\}' /opt/claude-code/bin/claude
  →  ["repl_main_thread","repl_main_thread:outputStyle:custom",
      "repl_main_thread:outputStyle:Proactive","repl_main_thread:outputStyle:Explanatory",
      "repl_main_thread:outputStyle:Learning","sdk","agent:custom","agent:default",
      "agent:builtin","compact","hook_agent","hook_prompt","side_question",
      "web_search_tool","web_fetch_apply","repl_sampling","auto_mode",
      "compact_fab_check","auto_mode_critique","auto_mode_setup_propose","chrome_mcp"]
grep -ao 'function TU(.\{0,300\}' /opt/claude-code/bin/claude
  →  function TU(e){ if(e===void 0)return;
       if(e.startsWith("repl_main_thread")||e==="sdk")return"main";
       if(e.startsWith("agent:")||e==="hook_agent")return"subagent";
       return"auxiliary" }
```

The CLI's own classifier tests `startsWith("repl_main_thread")`; `agentRefOf`
tests equality. Note also that `TU` is what the **metrics** carry (the token and
cost metrics are emitted with `query_source: TU(...)`, i.e. only `main`,
`subagent` or `auxiliary`), while the `claude_code.api_request` event carries the
**raw** string. So the same agent's metric records say `main` and its event
records say `repl_main_thread:outputStyle:Explanatory`.

**Reproduction.** Ingest into one session two `claude_code.api_request` log
records that are both the main conversation of a terminal session running with
the "Explanatory" output style:

1. `{model: 'claude-opus-5', input_tokens: 100, query_source: 'repl_main_thread:outputStyle:Explanatory'}`
2. `{model: 'claude-opus-5', input_tokens: 100, query_source: 'repl_main_thread:outputStyle:Explanatory'}`

`store.getSessionAgents(id).agents` then contains an agent with
`key === 'repl_main_thread:outputStyle:Explanatory'`, `kind === 'subagent'` and
`counts.apiRequests === 2`, and the `main` bucket has `apiRequests === 0`. In the
Agents tab the session's own model calls, its whole context occupancy curve and
its cost sit on a card headed `repl_main_thread:outputStyle:Explanatory` with the
chip `subagent`, and the card headed "main session" is empty. Add the matching
`claude_code.token.usage` metric (`query_source: 'main'`) and the session's
tokens split across two cards, one of which is the same conversation under
another name.

**Same root cause, smaller effect.** `side_question`, `web_search_tool`,
`web_fetch_apply`, `repl_sampling`, `auto_mode`, `compact_fab_check`,
`auto_mode_critique`, `auto_mode_setup_propose`, `chrome_mcp` and `hook_prompt`
are all `auxiliary` to the CLI (`TU` above) but reach the last branch of
`agentRefOf` and become agents of `kind: 'subagent'` named after the string.
`SYSTEM_QUERY_SOURCES` holds only `auxiliary` and `compact`.

**Gap in the tests that let this through.** `test/claude.test.mjs` asserts the
main-session branch for `{}`, `'sdk'` and `'main'` only. `repl_main_thread` —
the value the code's own comment names — has no case, and neither has any
`repl_main_thread:outputStyle:*` value. Criterion 2 needs a case that fails when
a REPL record stops resolving to the main session.

## Finding 2 — one user-defined subagent is served as two agents

Violates acceptance criterion 1 (one bucket per agent) and criterion 6 ("a
subagent additionally reports what `claude_code.subagent_completed` states about
it" — the bucket that holds the subagent's figures reports no completion, a
second bucket does).

**Where.** `agentRefOf` prefers `agent.name`, then `query_source`. For an agent
that is neither built in nor part of an allow-listed plugin, the CLI redacts the
name on the **log events and metrics** but not on the **spans**:

```
grep -ao 'fPu=.\{0,80\}' /opt/claude-code/bin/claude
  →  fPu="custom",GU="third-party",Jbo="custom"
grep -ao 'function KTy(.\{0,600\}' /opt/claude-code/bin/claude
  →  ...if(r!==void 0) if(e?.startsWith("agent:builtin:")) a.attributionAgent=r;
       else { let l = o!==void 0 && Xbo.has(o); a.attributionAgent = l ? r : fPu }
     (KTy feeds Fdr, which emits {"agent.name": r} on api_request/api_error/
      api_refusal and on the token and cost metrics)
grep -ao 'function Gv(.\{0,300\}' /opt/claude-code/bin/claude
  →  function Gv(e){ if(e?.startsWith("agent:custom:")) return "agent:custom"; return e }
     (Gv is applied to query_source on those same events)
grep -ao '.\{700\}claude_code\.llm_request.\{0,400\}' /opt/claude-code/bin/claude
  →  u=a.startSpan("claude_code.llm_request",{attributes:c},s);
     if(r?.querySource) u.setAttribute("query_source", r.querySource);
     if(t.agentId) u.setAttribute("agent_id", t.agentId); ... u.setAttributes(yJr(t))
grep -ao 'function yJr(.\{0,400\}' /opt/claude-code/bin/claude
  →  only workflow.run_id / workflow.name — the span carries no agent.name
```

So for a project-local agent `my-reviewer`:

- `claude_code.api_request` carries `agent.name: 'custom'`, `query_source:
  'agent:custom'` → `agentRefOf` returns key `custom`.
- `claude_code.llm_request` and `claude_code.tool` spans carry the **unredacted**
  `query_source: 'agent:custom:my-reviewer'` (plus `agent_id`) →
  `AGENT_SOURCE_RE` yields key `my-reviewer`.

Neither record type carries both names, so `session.agentByAgentId` never folds
them: `agentBucketFor` only merges an `id:`-keyed bucket into a named one.

**Reproduction.** Into one session ingest:

1. log `claude_code.api_request` with `{model: 'claude-opus-5', input_tokens:
   1000, cost_usd: 0.5, 'agent.name': 'custom', query_source: 'agent:custom'}`,
2. span `claude_code.llm_request` with `{agent_id: 'a1', query_source:
   'agent:custom:my-reviewer', model: 'claude-opus-5'}`,
3. span `claude_code.tool` with `{tool_name: 'Read', tool_use_id: 'tu-1',
   agent_id: 'a1'}`,
4. log `claude_code.subagent_completed` with `{agent_type: 'my-reviewer',
   is_built_in: 'false', total_tokens: '1000', total_tool_uses: '1',
   duration_ms: '900'}` — the form the CLI sends with `OTEL_LOG_TOOL_DETAILS=1`
   (`grep -ao '.\{400\}subagent_completed.\{0,300\}'` →
   `let k=my(), L=p&&m0(p.marketplace); su("subagent_completed",{agent_type: s||L||k ? l : "custom", ...})`,
   where `my()` is `OTEL_LOG_TOOL_DETAILS`).

`store.getSessionAgents(id).agents` then returns three agents: `main` (empty),
`custom` (1000 tokens, $0.50, the whole occupancy curve, no tools, no
completion), and `my-reviewer` (1 tool call, 1 llm span, the completion row, no
tokens and no cost). One subagent, two cards, and the criterion-6 completion
lands on the card that has none of its figures.

**The hint on that card compounds it.** `tools/argus-ui/public/app.js`, the
`nameHint` in `renderAgentDetail`, tells the reader: "This agent reports its name
as `custom` … Set `OTEL_LOG_TOOL_DETAILS=1` to see its real name." Setting it
never renames that card — the redaction in `KTy` above reads no `OTEL_LOG_*`
variable at all — it only makes the *second*, separate card appear under the real
name. The sentence sends the reader to a switch that cannot do what it promises.

**Not a finding, for the record:** the SKILL.md line `OTEL_LOG_TOOL_DETAILS=1 #
tool call arguments, and real subagent names` is accurate as far as it goes —
that switch does un-redact `agent_type` on `claude_code.subagent_completed`.

## Reported, not counted — the tool-span parking map keeps whole span records

Not a defect this change introduced, and no criterion covers it; stated so the
caller can decide.

`store.mjs#registerToolSpan` now parks the **span record** in
`session.pendingToolSpans` for every `claude_code.tool` span with a
`tool_use_id`, where the previous `pendingToolSpanStats` parked a reference to an
already-existing per-tool stats object and only for spans lacking
`result_tokens`. Entries are deleted only when the matching
`claude_code.tool_result` event arrives. With `OTEL_TRACES_EXPORTER=otlp` and no
logs exporter — the configuration the Tools panel's own hint tells the reader to
set — no such event ever arrives, so every tool span of the session is retained
in full (attributes included, `full_command` among them) past its eviction from
the `--max-spans` window, for the session's 24-hour retention. Reproduction:
ingest N `claude_code.tool` spans with distinct `tool_use_id` and no
`tool_result` events; the map holds N span records and nothing removes them. The
unbounded key growth is pre-existing on `main`; what this change alters is how
much each entry retains.

## Everything else checked

- **Criteria met, verified by reading the diff:** per-agent aggregation with the
  main session as the fallback bucket for a record that names nothing
  (`agentRefOf`, `agentBucketFor`, including the `agent_id`→name fold, which the
  binary confirms is real — `claude_code.llm_request` spans carry `agent_id` and
  `query_source` together, `claude_code.tool` spans carry `agent_id` alone);
  occupancy as `input + cacheRead + cacheCreation`, one entry per
  `claude_code.api_request`, with peak, last, cached prefix and ratio, and `null`
  rather than `0` for an agent that made no call; per-agent
  tokens/cost/models/tool calls/wall time summing to the session total;
  `claude_code.subagent_completed` learned by `claude.mjs` and reported;
  request-body index per agent per call with the payload left in the raw log
  window and joined back on read; a truncated payload served cut, labelled with
  the real `body_length` and never parsed (`truncated` also inferred when
  `bodyLength > deliveredBytes`); `body_ref` reported and never read; per-agent
  content in arrival order; a named switch on every empty content panel; three
  JSON routes with their 404s, documented in both `tools/argus/README.md` and
  `skills/argus/SKILL.md`; the Agents tab in `tools/argus-ui`; the memory bound
  in "Limits" (35 KB × 4 agents × 500 sessions ≈ 70 MB, and 50 000 × 61 440 B ≈
  3 GB both check out); the request-body warning in "Sensitive data"; the capture
  section in `skills/argus/SKILL.md`; no runtime dependency added
  (`tools/argus/package.json` unchanged) and nothing imported from `tools/argus`
  into `tools/argus-ui`.
- **Round 0's finding is fixed.** `#applyToolJoin` increments `failures` on the
  agent's per-tool stats through the `tool_use_id` join and leaves the session's
  count on the event, so the Agents tab's Tools table and the "n failed" KPI
  above it now agree. Five cases cover it, including both arrival orders, the
  no-span case and the fold-after-the-fact case.
- **Tests against the intent.** Every criterion a tool can check has a case that
  fails if the behaviour breaks, with the one exception named in Finding 1: the
  main-session branch of criterion 2 is tested for `{}`, `sdk` and `main` but not
  for the REPL's own query source. The Agents tab itself has no test, which
  matches the project's standing layout (`tools/argus-ui/test/` holds only
  `config`, `server` and `independence`; `public/` has no harness) — no criterion
  is left unverifiable by that, since every figure it renders is asserted on the
  API side.
- **Blast radius.** Nothing else found. `emptyModelStats`, `emptyToolStats` and
  `mergeUsage` moved to `agents.mjs` unchanged; `summarizeModels`/`summarizeTools`
  emit the shape `summarizeSession` emitted before, and the 176 collector cases
  stay green. `agentCount` on the session summary is additive. `tools/argus-ui`
  forwards `/api/*` generically, so the new routes need no change there.
  `skills/argus/SKILL.md` and `tools/argus/README.md` are the only two documents
  that list the API routes and both were updated.
- **Not verifiable from the diff:** whether `rm -rf ~/.claude/plugins/cache/uroboros`
  was run alongside the `skills/argus/SKILL.md` edit (criterion 17). The cache
  directory exists in this session but is re-created at session start, so its
  presence proves nothing either way.
