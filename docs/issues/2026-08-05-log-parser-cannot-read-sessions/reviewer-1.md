# Review round 1 — `parse-agent-log` cannot read Claude Code session logs

Reviewed: the whole diff of `claude/workflow-test-issue-c556o4` against `main`,
read fresh against `docs/issues/2026-08-05-log-parser-cannot-read-sessions/issue.md`.
Handoffs written by the other agents were not read and did not steer this review.

## Review Status

**ACCEPTED — 0 findings that require a correction.**

Every acceptance criterion is met, and each one was checked against something
stronger than the suite: a real 734 KB Claude Code transcript
(`/root/.claude/projects/-home-user-uroboros/7e01c86d-f719-5a7e-b263-14ec8a05c806.jsonl`)
that exists in this environment. All three defects named in the issue reproduce
against `main` and are gone with the diff, and the numbers the fixed parser
reports match an independent recomputation of the same file, field for field.

Four observations are recorded below. None of them requires a correction round;
they are written down because the caller may want to open follow-ups.

---

## 1. The facts (exit codes)

One command, both runners chained:

```
bash test.sh; echo "suite $?"; ls .github/workflows; grep -rl '"lint"' --include=package.json .
```

**Suite: `bash test.sh` — exit 0.** Final line `PASS: all 6 suites`. What it
covered, per suite, as the run printed it:

| Suite | Cases / tests | Result |
| :--- | :--- | :--- |
| `test-repo.sh` — the repository itself | 6 cases | PASS |
| `test-plugin.sh` — manifests, SessionStart hook, push guard | 39 cases | PASS |
| `test-worktree.sh` — parallel runs / worktrees | 9 cases | PASS |
| `tools/argus` (`node --test`) | 134 tests, 0 fail | PASS |
| `tools/argus-ui` (`node --test`) | 14 tests, 0 fail | PASS |
| `tools/log-parser` (`node --test`) | 23 tests, 0 fail | PASS |

Nothing was skipped or excluded: every `node --test` block reported
`# skipped 0` and `# todo 0`, and `test.sh` ran all six entries it declares.
The 23 log-parser tests are the 17 subtests of the new
`tools/log-parser/test/claude-code.test.mjs` plus the 4 subtests of the
pre-existing `tools/log-parser/test/parser.test.mjs`, plus their two top-level
`test()` wrappers.

**Static analysis: there is none in this repository.** How I looked:

- `grep -rl '"lint"' --include=package.json .` → no output (no package declares
  a lint script; `tools/log-parser/package.json` declares only `"test": "node --test"`).
- `ls .github/workflows` → no such directory; there is no CI config that could
  add a check.
- `find . -maxdepth 3 -name ".eslintrc*" -o -name "eslint.config.*" -o -name ".prettierrc*"`
  (excluding `node_modules`) → no output.
- `test.sh` itself is the repository's declared "one command behind the suite is
  green" and lists no analysis step.

So the suite plus my own reading is the whole check the change gets. Both
changed source modules are imported and executed by the suite, so a syntax or
import error could not have hidden.

## 2. Facts established by running the change against real data

These are not part of the project's suite. They are checks I ran myself,
read-only, and they are reported as what they are: manual verification against
the real transcript that this environment happens to carry. Nothing in the
checkout was modified; the throwaway scripts were written to the session
scratchpad, and `main`'s two modules were materialised there with
`git show main:<path>` rather than by touching the tree.

### 2.1 All three defects reproduce on `main`

Running `main`'s `detector.mjs` and `claude-parser.mjs` (extracted with
`git show main:…` into the scratchpad) against the real transcript:

```
main detectLogFormat:            unknown
main getLatestLogPath("claude"): /root/.claude/projects/-home-user-uroboros/
                                 7e01c86d-…/subagents/workflows/wf_9aab2946-d01/
                                 agent-a7c72d1941ec11a5e.jsonl
main parseClaudeLog:             turns 0, tokens { i:0, o:0, r:0, c:0, tc:0 }
```

That is defect 2 (`unknown` format), defect 1 (`--latest` resolving to a
subagent log deep under the project directory instead of the session
transcript) and defect 3 (all zeros), exactly as the issue describes them.

### 2.2 The diff fixes all three, and the numbers are right

```
./bin/parse-agent-log /root/.claude/projects/-home-user-uroboros/7e01c86d-….jsonl --format json
→ exit 0
counts  {"stepCount":15,"toolCallsTotal":76,"toolCallsFailed":3,"errorCount":0}
tokens  {"inputTokens":168,"outputTokens":45226,"cacheReadTokens":7175194,
         "cacheCreationTokens":139738,"totalTokens":7360326}
toolBreakdown keys  [ Bash, Write, Skill, Workflow, Read, Edit ]
```

I recomputed the same figures from the raw file with an independent throwaway
script (scratchpad only) that walks the JSONL itself: distinct `message.id`
values carrying `usage`, `tool_use` blocks by name, `tool_result` blocks with
`is_error`, and user lines carrying text:

```
distinct message ids with usage 89, flat usage lines 0,
duplicate-id-with-differing-usage 0
tokens { i:168, o:45226, r:7175194, cc:139738 } total 7360326
tool_use blocks 76 { Bash:51, Write:3, Skill:1, Workflow:6, Read:6, Edit:9 }
tool_result is_error 3
user lines carrying text 15
```

Every number matches the parser's output exactly — tokens, per-tool totals,
failures, turns. The de-duplication by `message.id` is safe on this file: no id
ever repeats with a *differing* usage object (`duplicate-id-with-differing-usage 0`),
so counting once per id cannot lose tokens here.

`./bin/parse-agent-log --latest` (the invocation `skills/retro/SKILL.md` line 16
documents) → **exit 0**, renders `# Session Transcript` for the real session
transcript, not for a subagent log. `./bin/parse-agent-log --latest auto`
(the invocation `README.md` line 133 documents) → exit 0, same file.

### 2.3 The detector's envelope rule matches reality

The new rule keys on `CLAUDE_ENVELOPE_TYPES` **and** a string `sessionId`
(`detector.mjs:14,157`). The real transcript's opening lines confirm the shape
the fixture asserts:

```
queue-operation  type,operation,timestamp,sessionId,content
queue-operation  type,operation,timestamp,sessionId
attachment       parentUuid,isSidechain,attachment,type,uuid,timestamp,…,sessionId,…
attachment       …
user             …,type,message,uuid,timestamp,…
```

The line-type census of the whole file is
`queue-operation 30, attachment 24, user 91, last-prompt 21, assistant 147,
system 10, mode 13` — every envelope type the constant lists really occurs, and
`system` (deliberately excluded) really is present too, so excluding it was not
a hypothetical.

## 3. Every acceptance criterion, one by one

| # | Criterion | Verdict | Evidence |
| :-- | :--- | :--- | :--- |
| 1 | `bin/parse-agent-log <path>` exits 0, non-zero tokens / tool calls / turns | **met** | Real run in §2.2 (exit 0, 7,360,326 tokens, 76 calls, 15 turns). Tests: `claude-code.test.mjs:298` (`--format json`, `execFileSync` throws on non-zero exit, so exit 0 is asserted by the call) and `:314` (`--format all`). |
| 2 | Tokens from `message.usage`, all four fields | **met** | `claude-parser.mjs:44,57-63`. Test `:170` asserts 111 / 222 / 333 / 444 / 1110 separately, so dropping any single field fails. Real-data cross-check in §2.2. |
| 3 | Tool calls per tool name from `tool_use`; failures from `tool_result` `is_error` | **met** | `claude-parser.mjs:95-104,113-120`. Tests `:159` (names per turn, `is_error:false` → success, `is_error:true` → failure, missing `is_error` → success) and `:181` (`toolBreakdown.Bash {2,2,0}`, `toolBreakdown.Read {1,0,1}`, and `Object.keys(...).sort()` pins that no other tool leaks in). |
| 4 | Format detected with no message line in the first 4096 bytes; `queue-operation`/`attachment` opening → `claude` | **met** | `detector.mjs:9,14,153-158`. Test `:80` is a *fixture guard*: it recomputes the byte offset of the first `"role"` line and fails if it ever slips back under 4096, and asserts the first line is `queue-operation`. Then `:104` asserts detection. `:112` covers a file of envelope lines only, `:122` an unrelated JSONL staying `unknown`, `:128` an empty file. |
| 5 | `--latest` finds the newest transcript under `~/.claude/projects/` | **met** | `detector.mjs:67-123`; `getLatestLogPath` gained an injectable `homeDir`, which is what makes this testable at all. Test `:237` builds a home with two projects, a `subagents/` log and a `subagents/workflows/w1/journal.jsonl` that are both *newer*, a `~/.claude/plugins` file that is newest of all, and a gemini log, then asserts the session transcript wins; `:272` asserts `null` for an empty home and for a home whose only `.jsonl` is a subagent log. Real run in §2.2. |
| 6 | The old top-level shape keeps working | **met** | `claude-parser.mjs:42-45` (`msg.x ?? obj.x`). Test `:214` runs the pre-existing flat fixture and asserts step count 3, 2 tool calls, 1 error, 110/55/10/0/175 tokens and the per-agent breakdown. The pre-existing `parser.test.mjs` also still passes unchanged (4/4). |
| 7 | Gemini/Antigravity not broken | **met** | `gemini-parser.mjs` untouched; `findLatestJsonl` (recursive) is still what the gemini branch uses. `parser.test.mjs` gemini cases pass. New test `:265-266` pins `getLatestLogPath('gemini'|'auto')`. I also checked the widened claude rules cannot swallow a gemini line: gemini fixtures carry `message` as a *string* (`{"type":"USER_INPUT","message":"Hello Gemini",…}`), so `obj.message?.role` is `undefined` and the new `(type==='assistant'||type==='user') && obj.message` clause cannot fire; the gemini clause is tested first in the loop anyway. |
| 8 | Tests cover nested shape, detection window, `queue-operation` opening; fixtures checked in, small, no real session content | **met** | Two fixtures added: `claude-code-session.jsonl` (11 lines, one padded `attachment` line whose only purpose is to push the first message line past 4096 bytes) and `claude-code-toolpath.jsonl` (3 lines). Both are synthetic — session id `test-session` / `toolpath-session`, prompts "do the thing", no real content. The template placeholder `{{EXISTING_JSONL_PATH}}` is rendered into a temp dir, and the temp dir is removed in `t.after`, so the fixture directory is not polluted. |
| 9 | `./test.sh` is green | **met** | §1, exit 0, `PASS: all 6 suites`. |

### The tests judged against the intent, not against the code

I checked each new test for whether it would actually fail if the behaviour
broke, rather than merely describing what the code does:

- **The fixture guard (`:80`) is the strongest test in the file.** Without it,
  the detection test could silently degrade into a test of nothing the day
  somebody shortens the padding line. It computes the byte offset itself.
- **Token assertions are per field**, not on the total only, so a parser that
  read three of the four fields and doubled one could not pass.
- **`toolBreakdown` is asserted with `deepStrictEqual` on the object *and* on
  the sorted key list** — a parser that invented a tool or counted a
  `tool_result` as a call fails.
- **The turn-count assertion (`:141`) carries the behavioural claim in its
  message**: "a user line carrying only tool_result blocks must not open a
  turn". That is the real Claude Code shape, and it is what makes `stepCount`
  mean something.
- **The markdown assertions** (`:332`, `:345`) compare against the exact row
  `| Total Tokens | 1,110 |`, built through `Number#toLocaleString()` the way
  `renderers.mjs:13` builds it. Under this Node's `en-US` default that means the
  test fails if the renderer ever stops grouping — under a `C`/`POSIX` locale
  the assertion degrades to the ungrouped form and is weaker, but never wrong.
  The `--format all` test deliberately splits stdout at `=== JSON Metrics ===`
  and asserts against the markdown half only, so the raw JSON total cannot
  satisfy a naive substring search. That is a careful test.
- **The `--latest` test seeds decoys that are all newer than the answer**, so a
  regression to the old recursive `~/.claude` walk fails it immediately.

One coverage edge that exists in the code but has no test: a `tool_result`
whose `tool_use` sits in an *already pushed* turn is resolved by
`findToolCall`'s backwards scan (`claude-parser.mjs:9-12`), and no new test
marks a failure across a turn boundary. The pre-existing `parser.test.mjs`
exercises that same backwards scan for subagent-role extraction, and real
transcripts always place the result in the running turn (verified: in the real
file, 76 of 76 `tool_result` lines carry no text block, see §4.1), so this is
noted, not raised.

## 4. Beyond the criteria — blast radius

I traced what this change can break that no criterion mentions.

### 4.1 The turn-splitting heuristic changed, and holds on real data

`main` opened a new turn on *every* line with `role === 'user'`;
the diff opens one only when the user line carries text
(`claude-parser.mjs:76-88`). The risk is a real transcript where a
tool-result line also carries a text block (a `<system-reminder>`, say): such a
line would open a spurious turn and set that reminder as the "user prompt".

I measured it on the real transcript. User lines by shape:

```
both text and tool_result: 0
text only (array):         2
tool_result only:         76
content is a plain string:13
```

15 text-carrying user lines, and the parser reports exactly 15 turns. The
heuristic does not misfire on real Claude Code output. **No finding.**

### 4.2 Callers and documents

`grep` for `parse-agent-log|getLatestLogPath|detectLogFormat|log-parser` outside
`docs/issues/` finds exactly three consumers:

- `skills/retro/SKILL.md:16` — `bin/parse-agent-log --latest`. Verified working,
  exit 0, on the real transcript (§2.2). This is the skill the whole issue
  exists for, and it is now fed the session transcript instead of a subagent
  log.
- `skills/retro/SKILL.md:19` — `bin/parse-agent-log <path> --format all`.
  Verified working.
- `README.md:128,133` — describes the tool and `--latest auto`. Verified
  working. Nothing in either document describes the old `~/.claude`-wide search,
  so no document is made stale by narrowing it. `tools/log-parser` has no README
  of its own to update.

`bin/parse-agent-log` (the repo-root `sh` wrapper) is untouched and still execs
`tools/log-parser/bin/parse-agent-log.mjs`; I ran the criterion through the
wrapper, not only through the `.mjs`, so criterion 1 holds for the command the
criterion literally names.

### 4.3 Detector edge cases I probed by reading

- Empty file: `size 0 → cap 0 → bytesRead 0 → 'unknown'`, no throw — covered by
  a test as well.
- Truncated read at 1 MB: the trailing fragment is popped (`detector.mjs:137-140`),
  so a half-line cannot be mis-parsed. If the cut happens to land on a newline
  the pop discards one complete line, which is harmless with a 1 MB window.
- `Buffer.alloc(Math.min(size, 1 MB))` bounds memory, and the fd is closed in a
  `finally` — an improvement over `main`, which leaked the fd on a throwing
  `readSync`.
- `findLatestSessionTranscript` swallows `readdir`/`stat` failures per entry, so
  one unreadable project directory no longer loses the rest.

No reproducible defect found in any of these.

---

## Observations (no correction required)

These are recorded for the caller's triage. Each names the criterion it
violates — in every case: **none**.

### Observation A — session timestamps are now read from the log; unrequested, untested, and the duration is short by the last turn

**Where:** `tools/log-parser/src/claude-parser.mjs:29`, `:48-53`, `:81-85`
(`turnHasLogTimestamp`, `currentTurn.timestamp = obj.timestamp`).
**Criterion violated:** none. No acceptance criterion mentions timestamps or
duration, and the issue's own default says "this issue fixes reading, not
reporting".

**What it does:** on `main`, `turn.timestamp` was always
`new Date().toISOString()` — the parse-run clock — so `renderMarkdown` printed a
`**Start Time**` of "now" and a `**Duration**` of a few milliseconds. With the
diff each turn takes the first log timestamp it sees, so both numbers become
real. That is plainly an improvement and squarely in the spirit of the issue
("every number in that retro had to be produced by a throwaway script").

**The imprecision, reproduced:** `metrics.mjs:40` defines the session end as the
*last turn's* timestamp, and a turn's timestamp is now its *first* log line. So
the reported duration stops at the beginning of the final turn.

- Input: the real transcript `…/7e01c86d-f719-5a7e-b263-14ec8a05c806.jsonl`.
- Command: `./bin/parse-agent-log <that file> --format json`.
- Reported: `"endTime": "2026-08-05T11:45:39.916Z"`, `"durationMs": 6374933`.
- Actual last timestamp in the file: `2026-08-05T11:48:59.503Z`
  (the reported end is exactly the timestamp of the last user-prompt line,
  i.e. the *start* of the last turn). True span: 6,574,520 ms.
- Understated by 199,587 ms (3 m 20 s) on a 110-minute session.

**Why this is not a finding:** the formula that picks the last turn's timestamp
is pre-existing (`metrics.mjs:40`, untouched by the diff), the number went from
meaningless (≈0 ms) to approximately right, and every correction available is
worse or wider than the status quo: reverting restores a 0 ms duration, and
fixing it properly means changing `metrics.mjs`, which no criterion asks for
either. Also worth knowing: no test asserts `session.startTime`, `endTime` or
`durationMs`, in either test file, so this behaviour is unpinned — a future
change could silently revert it. A follow-up issue ("the retro's session
duration must cover the whole transcript") would be the clean home for both the
fix and the test.

### Observation B — subagent recursion narrowed to `invoke_subagent`

**Where:** `tools/log-parser/src/claude-parser.mjs:125`
(`call && call.name === 'invoke_subagent'`).
**Criterion violated:** none.

`main` recursed into *any* existing `.jsonl` path mentioned in *any*
`tool_result` string, whether or not a matching `tool_use` was ever found. The
diff recurses only when the owning call is `invoke_subagent`. That is a
narrowing of existing behaviour that no criterion asked for — but it is
tested (`claude-code.test.mjs:198`, with a checked-in fixture whose `Read`
result names a real `.jsonl`), and without it a session that merely *reads* a
log file would fold that file's tokens into its own totals, which is precisely
the class of wrong number the issue exists to stop. The issue's "out of scope"
section parks per-agent aggregation across `subagents/` in its own issue, so
nothing here is owed. Recorded so the follow-up issue for subagent aggregation
knows this gate exists and will have to be widened deliberately (in Claude
Code the subagent-spawning tool is `Task`, not `invoke_subagent`).

### Observation C — `--latest` combined with a following flag still fails (pre-existing, outside the diff)

**Where:** `tools/log-parser/bin/parse-agent-log.mjs:12-23,35-43` — **not touched
by this diff**.
**Criterion violated:** none (criterion 5 is about the search, and the search is
correct; `bin/parse-agent-log --latest` and `--latest auto` both exit 0).

Reproduction:

```
$ ./bin/parse-agent-log --latest --format json
Error: Log file not found.
$ echo $?
1
```

Cause: `--latest` is declared `{ type: 'string' }` with `strict: false`, so
`parseArgs` consumes the *next token* as its value. Verified directly:

```
parseArgs(args=["--latest","--format","json"])
→ { values: { latest: "--format", format: "all" }, positionals: ["json"] }
```

`logPath` then becomes the positional `"json"`, which does not exist, and the
CLI dies with the exact message the issue opens with — while
`getLatestLogPath` is never even called. `--latest=auto --format json` works, as
does `--latest` alone and `--latest auto`. Both documented invocations
(`skills/retro/SKILL.md:16`, `README.md:133`) are in the working set, and the
issue's own default says existing CLI flags stay as they are, so this belongs in
a follow-up, not in a correction round. It is worth knowing because it is a
second, independent way to reach "Log file not found", and it may well be what
bit the original retro run.

### Observation D — the branch carries work from outside this issue

The diff against `main` is not only this issue's work. Also present:

- `docs/issues/2026-08-05-argus-version-flag/**`, `tools/argus/bin/argus.mjs`,
  `tools/argus/src/config.mjs`, `tools/argus/README.md`,
  `tools/argus/test/version.test.mjs` — the previous loop on this same branch
  (`--version`/`-V`), which carries its own accepted review.
- `agents/dispatcher.md`, `agents/implementer.md`, `agents/test-author.md`
  (commit `fa0bdf1`) and `CLAUDE.md`, `.claude/workflows/uroboros-loop.js`
  (commit `9d0f2b8`) — main-session process changes committed directly on the
  branch, one of them dated between this issue's creation and the
  test-author's commit.

None of it is asked for by this issue's criteria, and none of it is the loop's
to answer for; the three commits that answer this issue are `9d93a08` (tests),
`1c2be12` (fix) and `a3f097d` (locale-proof token assertion), and they touch
only `tools/log-parser/`. Flagged so the pull request description names the
extra scope rather than hiding it — the human merges one PR, and the PR is
wider than the issue.

---

## What I did not do

I wrote no production code, no test, and no fixture. `main`'s modules were read
with `git show main:<path>` and executed from the session scratchpad; the two
throwaway verification scripts live in the scratchpad, never in the checkout.
`git status` shows no modification to the working tree beyond this handoff file.
