# Test author handoff — `parse-agent-log` cannot read Claude Code session logs

## 0. What I wrote

| Path | Kind | Status |
| --- | --- | --- |
| `/home/user/uroboros/tools/log-parser/test/claude-code.test.mjs` | New test suite, 17 sub-tests | New file |
| `/home/user/uroboros/tools/log-parser/test/fixtures/claude-code-session.jsonl` | New fixture, 11 lines, 7165 bytes, synthetic | New file |
| `/home/user/uroboros/tools/log-parser/test/fixtures/claude-code-toolpath.jsonl` | New fixture, 3 lines, templated | New file |

Nothing else was touched. In particular:

- `tools/log-parser/test/parser.test.mjs` is **unchanged**. All four of its
  sub-tests are green today and must stay green. The dispatcher's §5.4 asked for
  an extra assertion inside its `normalizeSession` sub-test; I put that coverage
  into my own file instead (sub-test 12, "regression: the old flat shape …") so
  that the existing regression net stays exactly as it was and the implementer
  has one file of mine and one file of the old suite, neither of which he edits.
- No production file was read for behaviour and none was modified. I did run the
  existing library against the existing fixtures to confirm the *public output
  contract* (field names in `metrics`, field names on a turn) so that my
  assertions fail on missing behaviour and not on a misspelled property.

## 1. Current state — every new test run and checked

`cd /home/user/uroboros/tools/log-parser && node --test`

```
    ok 1 - fixture guard: the first line carrying a role starts beyond byte 4096
    not ok 2 - detectLogFormat: queue-operation opening, first message line past 4096 bytes
    ok 3 - detectLogFormat: nested-shape transcript without envelope lines
    not ok 4 - detectLogFormat: a transcript of envelope lines only is still claude
    ok 5 - detectLogFormat: unrelated jsonl stays unknown
    ok 6 - detectLogFormat: an empty file is unknown and does not throw
    not ok 7 - parseClaudeLog: nested shape yields turns, prompts, thinking and text
    not ok 8 - parseClaudeLog: tool calls per turn, failure marked from is_error
    not ok 9 - metrics: all four usage fields, counted once per message id
    not ok 10 - metrics: counts and per-tool breakdown
    not ok 11 - parseClaudeLog: a .jsonl path mentioned by an ordinary tool is not a transcript
    ok 12 - regression: the old flat shape (obj.role / obj.usage) still counts
    not ok 13 - getLatestLogPath: picks the newest session transcript, never a subagent or plugin file
    not ok 14 - getLatestLogPath: nothing to find yields null
    not ok 15 - CLI: --format json exits 0 and reports the numbers
    not ok 16 - CLI: --format all exits 0 and renders the summary
    not ok 17 - renderers still take what the parser produces
    ok 1 - detectLogFormat            <- existing suite, untouched
    ok 2 - parseClaudeLog             <- existing suite, untouched
    ok 3 - parseGeminiLog             <- existing suite, untouched
    ok 4 - normalizeSession and renderers  <- existing suite, untouched

# tests 23   # pass 10   # fail 13
```

(13 = the 12 failing sub-tests plus their failing parent `Claude Code session transcripts`.)

`bash /home/user/uroboros/test.sh` ends in `FAIL: 1 of 6 suite(s)` — the
log-parser suite, and only that one. Every other suite in the repository is
already green, so nothing I wrote disturbed anything outside `tools/log-parser`.

### 1.1 Each failure, and why it is the right failure

| # | Sub-test | Failure today | Why this is "behaviour missing", not a broken test |
| --- | --- | --- | --- |
| 2 | detection past 4096 bytes | `+ 'unknown'  - 'claude'` | `detectLogFormat` reads only the first 4096 bytes; the fixture's first `role` line begins at byte 4625 (asserted by sub-test 1). Import and call both work — only the answer is wrong. |
| 4 | envelope-only transcript | `+ 'unknown'  - 'claude'` | `queue-operation` / `mode` / `last-prompt` are not recognised signals yet. |
| 7 | nested shape → turns | `a user line carrying only tool_result blocks must not open a turn: 0 !== 2` | `parseClaudeLog` returns **zero** turns for the nested shape. The call itself succeeds; it just extracts nothing. |
| 8 | tool calls / is_error | `Cannot read properties of undefined (reading 'toolCalls')` | Consequence of the same zero-turn result (`turns[0]` is `undefined`). It will report properly once turns exist. |
| 9 | four usage fields | `0 !== 111` | `message.usage` is never read. |
| 10 | counts + toolBreakdown | `0 !== 2` (stepCount) | Same root cause; `toolBreakdown` is `{}`. |
| 11 | `.jsonl` path in ordinary tool output | `0 !== 1` | Today it fails because the nested shape yields no turns at all. After the nested shape is read it becomes a real guard against the recursion hazard (§3.7 of the dispatcher handoff). |
| 13 | `--latest` search root | `+ '/root/.claude/projects/…/subagents/workflows/wf_9aab2946-d01/agent-a1bb82fb293a93ee7.jsonl'  - '/tmp/log-parser-home-…/.claude/projects/proj-b/session-b.jsonl'` | Two defects in one line: the `homeDir` argument is ignored (it answered from the machine's real home) and a subagent log won. |
| 14 | null cases | `no ~/.claude at all` — a real path came back instead of `null` | Same ignored `homeDir`. |
| 15 | CLI `--format json` | `Command failed: … Error: Unknown log format.` (exit 2) | Acceptance criterion 1, end to end. |
| 16 | CLI `--format all` | `Command failed: … Error: Unknown log format.` | Same, through the second output format the retro skill uses. |
| 17 | renderers | `assert.ok(md.includes('1110'))` falsy | The renderer runs fine; the numbers handed to it are zeros. |

### 1.2 The five green sub-tests are deliberate guards, not filler

They pass today and must still pass afterwards. They are the "do not break it
while fixing it" half of the acceptance criteria and each of them is a plausible
casualty of the change:

- **1 — fixture guard.** Asserts the fixture's first `"role"` line starts beyond
  byte 4096 and that line 1 is a `queue-operation`. Without it, someone could
  shorten the padding later and sub-test 2 would keep passing while proving
  nothing.
- **3 — nested transcript without envelope lines** is already `claude` today
  (a `type:"user"` line inside the window). The rewrite of `detectLogFormat`
  must not lose that.
- **5 — unrelated jsonl is `unknown`.** The detection widening must not turn the
  format guess into a coin flip. `{"hello":"world"}` stays `unknown`.
- **6 — empty file.** Boundary of the new bounded read: zero bytes must give
  `unknown` and must not throw (a `Buffer.alloc(0)` / `readSync` slip would).
- **12 — the old flat shape.** Pins every number `claude-sample.jsonl` produces
  today, including the subagent recursion via `invoke_subagent`. See §3.

## 2. Fixtures

### 2.1 `test/fixtures/claude-code-session.jsonl` (checked in, read directly, no template)

Synthetic throughout; no content from any real session. 11 lines, 7165 bytes.
The padding is a run of 4300 `x` characters inside the `attachment` line, which
puts the first line carrying a `role` at byte **4625**.

| # | line | purpose |
| --- | --- | --- |
| 1 | `{"type":"queue-operation","operation":"enqueue","sessionId":"test-session","timestamp":"2026-08-05T09:00:00.000Z","content":"do the thing"}` | the envelope opening the issue names |
| 2 | `{"type":"attachment",…,"attachment":{"type":"hook_success","hookName":"SessionStart:startup","content":"xxxx…(4300)"}}` | pushes the first message line past 4096 bytes |
| 3 | `{"type":"user",…,"message":{"role":"user","content":"do the thing"}}` | opens turn 1, string content |
| 4 | `{"type":"assistant",…,"message":{"id":"msg_1","usage":{10,20,30,40},"content":[{"type":"thinking",…}]}}` | nested usage, first half of a split response |
| 5 | `{"type":"assistant",…,"message":{"id":"msg_1","usage":{10,20,30,40},"content":[tool_use t1 Bash, tool_use t2 Read]}}` | **same id, same usage repeated** — the dedup trap |
| 6 | `{"type":"user",…,"message":{"role":"user","content":[tool_result t1 is_error:false, tool_result t2 is_error:true]}}` | one success, one failure; must not open a turn |
| 7 | `{"type":"assistant",…,"message":{"id":"msg_2","usage":{1,2,3,4},"content":[{"type":"text","text":"done"}]}}` | second message id inside turn 1 |
| 8 | `{"type":"user",…,"message":{"role":"user","content":"and now the second thing"}}` | opens turn 2 |
| 9 | `{"type":"assistant",…,"message":{"id":"msg_3","usage":{100,200,300,400},"content":[{"type":"text","text":"finished"}]}}` | text arrives **before** the tool_use line |
| 10 | `{"type":"assistant",…,"message":{"id":"msg_3","usage":{100,200,300,400},"content":[tool_use t3 Bash]}}` | same id again; a `=` assignment on `assistantText` blanks `"finished"` here |
| 11 | `{"type":"user",…,"message":{"role":"user","content":[tool_result t3]}}` | **no `is_error` key at all** — the absent-key boundary |

The numbers this pins, all asserted with `assert.strictEqual`:

| metric | expected | what a regression looks like |
| --- | --- | --- |
| `tokens.inputTokens` | 111 | 221 if `msg_1` and `msg_3` are counted twice |
| `tokens.outputTokens` | 222 | 442 |
| `tokens.cacheReadTokens` | 333 | 663 |
| `tokens.cacheCreationTokens` | 444 | 884 |
| `tokens.totalTokens` | 1110 | 2210 |
| `counts.stepCount` | 2 | 4–5 if tool-result lines open turns |
| `counts.toolCallsTotal` | 3 | |
| `counts.toolCallsFailed` | 1 | 0 if `is_error` is ignored, 2 if the absent key is read as a failure |
| `counts.errorCount` | 0 | 1+ if tool failures are pushed into `turn.errors` as well (double-reporting) |
| `toolBreakdown.Bash` | `{total:2, success:2, failed:0}` | |
| `toolBreakdown.Read` | `{total:1, success:0, failed:1}` | |
| `Object.keys(toolBreakdown)` | exactly `['Bash','Read']` | |
| `Object.keys(agentBreakdown)` | exactly `['main']` | a stray subagent recursion shows up here |

The round numbers per message id (10/20/30/40, 1/2/3/4, 100/200/300/400) are
chosen so that the sums 111/222/333/444 are only reachable by counting each
`message.id` once.

### 2.2 `test/fixtures/claude-code-toolpath.jsonl` (templated, like the existing fixtures)

Three lines, nested shape, no envelope. A `Read` tool call whose `tool_result`
content is `"file://{{EXISTING_JSONL_PATH}}\nthe file mentions a jsonl path"`.
The test substitutes the path of the checked-in `claude-subagent.jsonl`, so the
mentioned file genuinely exists on disk. Expected: 1 turn, 1 tool call,
5/5 tokens, `agentBreakdown` exactly `['main']`. If the parser recurses into any
`.jsonl` path it finds in tool output, this becomes 2 turns, 15 input tokens and
a second agent — see dispatcher §3.7.

The templating happens in `t.before` into a `mkdtemp` scratch directory, not
beside the fixtures, so no `*.tmp.jsonl` is left in the repository and the two
suites cannot collide.

## 3. Coverage requirements — criterion by criterion

| Acceptance criterion | Covered by | Notes |
| --- | --- | --- |
| `bin/parse-agent-log <transcript>` exits 0 and reports non-zero tokens, tool calls and turns | 15 (`--format json`), 16 (`--format all`) | `execFileSync` throws on any non-zero exit, so "exits 0" is asserted by the call not throwing. Numbers are pinned exactly, not merely "non-zero". |
| Tokens come from `message.usage`, all four fields | 9, 15 | Each of the four fields asserted separately, plus `totalTokens`. |
| Tool calls counted per tool name from `tool_use`; failures from `tool_result` `is_error` | 8, 10, 15 | Three boundaries in one fixture: `is_error:false`, `is_error:true`, key absent. Per-name breakdown asserted as a whole object and the key set is pinned. |
| Detection works when no message line is in the first 4096 bytes; `queue-operation` opening is `claude` | 1, 2, 4 | 1 guards the fixture; 4 is the harder boundary — a file with *only* envelope lines. |
| `--latest` finds the newest session transcript under `~/.claude/projects/` | 13, 14 | A fake home where the two newest `.jsonl` on disk are a plugin cache (T+60) and a workflow journal (T+50), and neither may win; the answer must be `proj-b/session-b.jsonl` (T+20) over `proj-a/session-a.jsonl` (T+10). |
| The old top-level shape keeps working | 12, plus the whole untouched `parser.test.mjs` | 12 pins 110/55/10/0/175 tokens, 3 steps, 2 tool calls, 1 error, and both agent breakdowns — measured against today's behaviour, so any drift is a regression. |
| The Gemini/Antigravity path is not broken | 13 (gemini + auto), `parser.test.mjs` `parseGeminiLog` and `detectLogFormat` | 13 asserts `getLatestLogPath('gemini', home)` still finds a log three directories deep (recursive walk kept) and that `getLatestLogPath('auto', home)` picks that Gemini file over the Claude session because it is newer (T+30 vs T+20) — one assertion covering both the Gemini branch and the `auto` comparison. |
| Tests cover the nested shape, the detection window, and a `queue-operation` opening; fixtures checked in, small, no real session content | the two fixtures above | 7165 + 1 KB, entirely synthetic. |
| `./test.sh` is green | the run itself | Today: `FAIL: 1 of 6 suite(s)`, the log-parser suite. |

### 3.1 Boundaries covered beyond the plain reading of the criteria

- **Empty file** into `detectLogFormat` (sub-test 6) — the zero end of the new
  bounded read.
- **Two-line unrelated JSON** (5) — the negative end; widening detection must not
  make everything `claude`.
- **Envelope-only transcript** (4) — detection with *no* message line anywhere in
  the file, not just outside the first window.
- **`is_error` absent** (8, line 11 of the fixture) — must be a success. Test
  `!!block.is_error`, never `=== false`.
- **Repeated `message.id`** (5/10 of the fixture, sub-test 9) — the "repeat" case
  of the token criterion.
- **A `tool_result` whose tool call sits in the currently open turn** (t1/t2 in
  turn 1) — the existing lookup only searched already-closed turns.
- **Empty home / subagent-only home** (14) — `getLatestLogPath` must return
  `null`, not throw and not fall back to a real path.
- **A project directory that contains only `subagents/`** (14) — a subagent log is
  not a session transcript, so `null`.

## 4. Signature the tests require

`getLatestLogPath(provider, homeDir)` — the second parameter must exist and must
be the root the search is derived from (defaulting to `os.homedir()` when
absent, so `bin/parse-agent-log.mjs` keeps working with one argument). Sub-tests
13 and 14 build a fake home with `fs.mkdtempSync` + `fs.realpathSync` and set
every mtime explicitly with `fs.utimesSync`; they cannot fake a home any other
way. If the implementer prefers a different injection point, these two tests
would have to change — and the implementer may not change them, so: this
signature is the contract.

Everything else is called exactly as it is today:
`detectLogFormat(path)` (**synchronous**, no `await` anywhere in either suite),
`parseClaudeLog(path)`, `normalizeSession(turns, format, provider)`,
`renderMarkdown(transcript)`.

## 5. Judgement calls and open questions

These are the places where the acceptance criteria do not decide the outcome.
I say plainly which way I went and why, so a reviewer can overrule me cheaply.

### 5.1 Turn segmentation — asserted, but not stated in the issue

The issue only asks for "non-zero … turns". It does not say what a turn is. I
asserted `turns.length === 2` and `counts.stepCount === 2`, i.e. **a user line
that carries only `tool_result` blocks does not open a new turn**, following
dispatcher §3.5 (66 of 78 user lines in a real transcript are pure tool-result
carriers; the old rule would report ~66 turns for 14 prompts). This is the only
reading under which the reported turn count means anything, and the existing
fixture stays green under it because its line 3 mixes `tool_result` blocks with a
`text` block. **If the reviewer disagrees, this is the assertion to challenge.**

### 5.2 `session.startTime` — deliberately not asserted

The dispatcher's §5.3 asks for `metrics.session.startTime === '2026-08-05T09:00:01.000Z'`
(the user line that opens turn 1), but its own §4.5 captures the timestamp at the
top of the line body, before any turn opens — which for this fixture yields
`'2026-08-05T09:00:00.000Z'` from the `queue-operation` line. The two paragraphs
contradict each other, no acceptance criterion mentions timestamps at all, and a
guessed expectation here would fail a correct implementation. **I pinned
nothing about `startTime`, `endTime` or `durationMs`.** If real session times in
the retro matter, that needs its own criterion.

### 5.3 Merged assistant text — asserted, from the dispatcher not the issue

Sub-test 7 asserts `turns[1].assistantText.includes('finished')`. Fixture lines
9 and 10 are one response split in two, text first and `tool_use` second, so an
overwriting `currentTurn.assistantText = …` blanks it. Not named in any
criterion; it is dispatcher §4.6 and it is the same defect family (a split
nested response read wrongly). Observable through the library API and through
`renderMarkdown`.

### 5.4 Narrowed subagent recursion — asserted, from the dispatcher not the issue

Sub-test 11. Not named in any criterion either, but it directly threatens
criterion 1: once the parser reads the nested shape, every `.jsonl` path
appearing in ordinary tool output becomes a candidate transcript, and the retro
numbers would silently absorb unrelated sessions. The old fixture's
`invoke_subagent` recursion must keep working (sub-test 12 pins its numbers), so
the two tests together say: recurse for `invoke_subagent`, for nothing else.

### 5.5 Not tested, on purpose

- **The 1 MB detection cap and its truncated final line.** A fixture that large
  does not belong in the repository, and the criterion only names the 4096-byte
  window. Whatever cap is chosen, sub-tests 2 and 4 pin the behaviour that
  matters.
- **A `tool_result` whose `tool_use` sits in an earlier, already-closed turn.**
  Plausible in a real log, not decided by any criterion, and I could not pin an
  expected turn attribution without guessing.
- **`session.id` and `model`.** Real transcripts carry `sessionId` and
  `message.model`; the issue says this fixes reading, not reporting, so I
  assert nothing about them. (The fixture does carry both, so filling them
  later needs no fixture change.)
- **Per-agent aggregation across `subagents/`** — out of scope per the issue.
- **Anything against the machine's own `~/.claude`.** No test reads a real
  transcript; the manual smoke check in dispatcher §6 stays manual.

## 6. How to run

```
cd /home/user/uroboros/tools/log-parser && node --test
# or
npm --prefix /home/user/uroboros/tools/log-parser test
# the fact:
bash /home/user/uroboros/test.sh
```
