# Test author handoff — correction round 1

Criterion: `docs/issues/2026-08-06-argus-shows-what-session-and-agents-hold-in-context/reviewer.md`,
"Finding 1 — the per-agent Tools table reports 0 failures for a tool that
failed". Work order: the Test Plan section of
`docs/issues/2026-08-06-argus-shows-what-session-and-agents-hold-in-context/researcher-1.md`.

All six planned cases are written, in `tools/argus/test/agents.test.mjs`,
appended after the existing tests, in the plan's order. Command used to run
just this file: `node --test tools/argus/test/agents.test.mjs`. Ran that
command once, exit code non-zero (5 of 29 subtests fail as expected, 24 pass —
the 23 pre-existing cases plus the one new case that is already green, see
case 5 below).

## Case-by-case

**1. A failed tool call counts against the agent that made it (span first).**
Test `a failed tool call counts against the agent that made it (span first)`,
`tools/argus/test/agents.test.mjs:537`. Fails today:
```
Expected values to be strictly equal:
0 !== 1
```
at `agents.test.mjs:558`, which is `assert.equal(bash.failures, 1)` — the
agent's `Bash` row reports 0 failures while the KPI and the session both
report 1, exactly the defect the finding names.

**2. The order the two signals arrive in does not matter.** Test
`the order the two signals arrive in does not matter`,
`tools/argus/test/agents.test.mjs:566`. Fails today, same shape:
```
Expected values to be strictly equal:
0 !== 1
```
at `agents.test.mjs:587`, `assert.equal(bash.failures, 1)`, this time with the
`tool_result` log ingested before the `claude_code.tool` span.

**3. A successful tool call adds no failure, and its result tokens reach the
agent.** Test
`a successful tool call adds no failure, and its result tokens reach the agent`,
`tools/argus/test/agents.test.mjs:590`. Fails today:
```
Expected values to be strictly equal:
0 !== 100
```
at `agents.test.mjs:612`, `assert.equal(bash.resultTokens, 100)` — the
agent-side result-token fallback (400 bytes at the estimator's fixed 4:1
ratio) is 0 today because `#applyResultBytesFallback` only ever touches the
session's tool-stats bucket.

**4. A real `result_tokens` attribute is not re-estimated on the agent
either.** Test
`a real result_tokens attribute is not re-estimated on the agent either`,
`tools/argus/test/agents.test.mjs:619`. Fails today:
```
Expected values to be strictly equal:
0 !== 1
```
at `agents.test.mjs:641`, `assert.equal(bash.failures, 1)` — `resultTokens`
and `resultTokensEstimated` already read correctly on the agent side by
coincidence (the span's own `result_tokens: 42` never touches the fallback
path at all, on the session or the agent), so those two assertions pass; the
join failure is what is still missing.

**5. A failed tool call with no span reaches no agent.** Test
`a failed tool call with no span reaches no agent`,
`tools/argus/test/agents.test.mjs:644`. Passes today, unlike the other five —
see "Plan gap" below.

**6. A failure joins the named bucket after the id-only bucket was folded
into it.** Test
`a failure joins the named bucket after the id-only bucket was folded into it`,
`tools/argus/test/agents.test.mjs:657`. Fails today:
```
Expected values to be strictly equal:
0 !== 1
```
at `agents.test.mjs:679`, `assert.equal(bash.failures, 1)`.

## Plan gap

The plan's "What is already red" section states "the six new cases are red
until the fix lands, which is their point." Case 5 is not red: with no
`claude_code.tool` span at all, no agent ever gets a `tools` row today (the
whole per-agent tool-stats path is unreached without a span match), so
`every agent... has tools.length === 0` already holds before any fix, and
continues to hold after — a failure with no span still has nothing to join
against. I wrote the case as specified since the plan lists it explicitly as
one of the six and it still locks down real behaviour (no attribution in, no
attribution invented out), but it does not demonstrate the defect and will
not turn the implementer's run red-to-green the way the other five do.

## Full run

`node --test tools/argus/test/agents.test.mjs`: 29 subtests, 24 pass, 5 fail,
exit code non-zero. The 5 failing are cases 1, 2, 3, 4 and 6 above, each with
the "Expected values to be strictly equal" assertion failure quoted for it;
none is an import error, a typo or a setup failure — every failure is the
named assertion on `failures` or `resultTokens` returning 0 instead of the
expected non-zero value. The 24 passing are the 23 pre-existing cases in the
file (untouched) plus case 5.

## Left untested, as the plan directs

Did not add any case for `tools/argus-ui/public/app.js`'s `Failures` column,
the `SPAN.toolExecution` path feeding `counts.toolFailures`, session-level
`failures` counting, the two existing result-token fallback cases in
`store.test.mjs`, or persistence/replay — the plan marks all of these
deliberately untested for this round and I added no coverage for them.

## Boundaries kept

Read only `researcher-1.md` and `reviewer.md` from this issue directory (per
the correction-round rule that the reviewer's reproduction spec is the
criterion and `researcher-<X>.md` carries the test plan for it); did not open
`tools/argus/src/store.mjs` or any other production file. Touched only
`tools/argus/test/agents.test.mjs`.
