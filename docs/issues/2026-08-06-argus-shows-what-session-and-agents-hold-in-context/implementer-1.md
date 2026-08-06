# Implementation handoff — correction round 1

Built the plan in
`docs/issues/2026-08-06-argus-shows-what-session-and-agents-hold-in-context/researcher-1.md`,
which fixes the reviewer's "Finding 1 — the per-agent Tools table reports 0
failures for a tool that failed". Nothing outside that finding was touched.

## Tests first

Ran `node --test tools/argus/test/agents.test.mjs` before changing any
production code: 29 subtests, 24 pass, 5 fail, exit code 1. The five reds are
cases 1, 2, 3, 4 and 6, each failing on the assertion the test author's handoff
names, every one of the form `0 !== 1` (or `0 !== 100` for case 3) on an
agent-side `failures` or `resultTokens` field. Case 5 passed before the change,
as `test-author-1.md` reported it would; it still passes after.

## What changed

Two files, both under `tools/argus/src/`.

### `tools/argus/src/store.mjs`

1. **`newSession`** — replaced `pendingToolSpanStats` and
   `pendingToolResultBytes` with `pendingToolSpans` (`tool_use_id` -> the
   `claude_code.tool` span record) and `pendingToolResults` (`tool_use_id` ->
   `{ bytes: number|null, failed: boolean }`). The comment keeps the point that
   spans and logs flush on independent OTLP pipelines so arrival order is never
   guaranteed, and adds that the entry is deleted the moment the two meet.
2. **`#applyResultTokenFallback` / `#applyResultBytesFallback` replaced by three
   methods**: `#registerToolSpan(session, span)`,
   `#registerToolResult(session, toolUseId, sizeBytesAttr, failed)` and
   `#applyToolJoin(session, span, { bytes, failed })`. The first two park their
   half when the other has not arrived and call the third when it has, deleting
   the parked entry first so a retransmitted event cannot count a failure twice.
   `#applyToolJoin` re-resolves `this.#agent(session, span)` and both tool
   buckets from the parked span record — never a parked stats reference — so the
   `id:a7` -> named fold in `agentBucketFor`/`mergeAgent` is followed rather than
   pointed past. It adds `estimateTokensFromBytes(bytes)` to `resultTokens` and
   `resultTokensEstimated` on the session and the agent when
   `attrs.result_tokens === undefined` and `bytes !== null`, and increments
   `failures` on the agent bucket only.
3. **`SPAN.tool` branch** — `calls`, `durationMsTotal` and the present-
   `result_tokens` path are unchanged and still write both buckets. The
   `else this.#applyResultTokenFallback(...)` became an unconditional
   `this.#registerToolSpan(session, span)`, so a span carrying its own
   `result_tokens` still registers and can receive the failure. Deleted the
   comment claiming the fallback "stays session-level and is not duplicated",
   which the fix makes false, and replaced it with one saying why registration
   is unconditional.
4. **`EVENT.toolResult` branch** — every session-level line is unchanged
   (`session.capture.*`, `session.todos.callsSeen`, `stats.failures++`,
   `session.lastError`, `#applyTodo`). The `#applyResultBytesFallback(...)` call
   became `this.#registerToolResult(session, attrs.tool_use_id,
   attrs.tool_result_size_bytes, !bool(attrs.success))`, which registers on the
   failure even when the event carries no `tool_result_size_bytes`. Rewrote the
   comment above it: per-agent tool *calls* still come from the spans, and a
   failure reaches its agent through the `tool_use_id` join, never by counting
   this event.

### `tools/argus/src/agents.mjs`

One comment word in `emptyToolStats`: the `resultTokensEstimated` comment
pointed at `#applyResultTokenFallback`, a method this change deletes, and now
points at `store.mjs #applyToolJoin`. The plan lists this file as unchanged; I
changed only this dangling cross-reference that my own rename broke, and no
code. Flagging it explicitly so the reviewer can judge it.

Nothing under `agents/`, `skills/` or `workflows/` changed, so
`rm -rf ~/.claude/plugins/cache/uroboros` was not run, as the plan states.

## What the plan said must not change, and did not

`session.tools[].failures` is still incremented in the `EVENT.toolResult` branch
alone and the join never adds to it. `agent.counts.toolFailures` still comes
from the `SPAN.toolExecution` branch alone. `session.counts.toolFailures`,
`toolFailuresFromEvents` and the `summarizeSession` shape are untouched. A
failed `tool_result` with no matching span parks in `pendingToolResults` and
reaches no agent.

## Commands run

Both commands the plan lists as what counts as done, from the repository root,
and nothing else. No linter and no formatter was run; the plan records that the
repository has none.

- `npm --prefix tools/argus test --silent` — the whole `tools/argus` suite,
  `node --test "test/*.test.mjs"`, 176 tests, 176 pass, 0 fail, exit 0. Nothing
  skipped or excluded.
- `bash test.sh` — the whole repository suite, 5 suites, all pass, exit 0.
  Invoked as `bash test.sh` per the plan; the executable bit was not set.

Also ran `node --test tools/argus/test/agents.test.mjs` before the change (29
subtests, 24 pass, 5 fail, exit 1) to confirm the reds, as recorded above.

## Notes for the reviewer

- No test was edited or written. `tools/argus/test/agents.test.mjs` is
  byte-identical to the test author's commit; `git status` shows only the two
  `src/` files as modified.
- Nothing left red. The one pre-existing red the earlier reviewer recorded,
  `./test.sh` exiting 126 for the missing executable bit, was not exercised: the
  plan directs `bash test.sh` and forbids setting the bit.
- The plan's "What is already red" claim that all six new cases are red is
  wrong for case 5, exactly as `test-author-1.md` reported; case 5 was green
  before and after. No action taken.
- No blocking question.
