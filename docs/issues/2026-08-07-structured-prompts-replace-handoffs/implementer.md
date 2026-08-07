# Implementer handoff — structured prompts replace the handoffs

## Round 1

I built the whole plan. Every planned test passes except driver case W4, which
is unsatisfiable as written — proof below. That is the one thing blocking a
green `./test.sh`, and it is a test defect, not an implementation gap.

### The blocker: driver case W4 cannot pass for any implementation

`test-repo.sh`'s driver defines its markers as

```js
const PLAN_MARKER = 'PLAN-MARKER';
const TESTPLAN_MARKER = 'TESTPLAN-MARKER';
```

and W4 asserts, on the test-author's prompt:

```js
assertTrue(testsCall.prompt.includes(TESTPLAN_MARKER), "the test-author's prompt does not carry the test plan");
assertTrue(!testsCall.prompt.includes(PLAN_MARKER),    "the test-author's prompt carries the implementation plan");
```

`'TESTPLAN-MARKER'.indexOf('PLAN-MARKER') === 4` — the second marker contains
the first as a substring. So any prompt that satisfies the first assertion
necessarily fails the second, whatever the workflow script does. I verified it
directly:

```
$ node -e "console.log('TESTPLAN-MARKER'.includes('PLAN-MARKER'))"
true
```

The contradiction is inherited from the researcher's test plan, which named
those two literals (`researcher.md`, "The cases", section B: `plan:
'PLAN-MARKER'`, `testPlan: 'TESTPLAN-MARKER'`). W5 and W6 are unaffected: they
assert `!includes(TESTPLAN_MARKER)` on prompts that carry only `PLAN-MARKER`,
and `'PLAN-MARKER'` does not contain `'TESTPLAN-MARKER'`.

The behaviour W4 is meant to pin *is* implemented and I checked it by hand: the
test-author's prompt is built from `plan.testPlan` alone and never touches
`plan.plan`, `plan.moduleMap`, `plan.environment` or `plan.checks`. Making the
case provable needs two markers where neither is a substring of the other — for
example `IMPLPLAN-MARKER` and `TESTPLAN-MARKER`. I may not edit a test, so I
left it red and report it here. **For the reviewer: this is a question, not a
finding I can close.** Everything else in the suite is green.

### What I changed

| Path | What I did |
| --- | --- |
| `skills/agent-brief/assets/backlog.mjs` | **New.** The only writer of `backlog.json`: `init`, `record`, `close`, `read`, dispatched on `process.argv[2]`, atomic write via `<path>.tmp` + `rename`, zero dependencies, no hard-coded repository path. Exit 2 for a usage error (unknown command, missing argument, payload that is not JSON), exit 1 for a well-formed call the state answers no to (no backlog there, no such increment, status outside `done\|blocked\|dropped`). `record` prints `recorded <label>` and nothing of the file. `init` merges: an increment kept keeps its recorded `steps`, one absent from the payload is dropped, `run.steps` is untouched. `close` sets status and note and empties that increment's `steps`. |
| `test.sh` | One `run` line for the recorder suite. |
| `workflows/loop.js` | Rewritten channel. `handoff()`/`section()` gone; `load-state` dispatch, `recorded` map, the `step()` wrapper, planner `decompose`/`close:<id>`, the seven new schemas, the per-role slice builders, the per-step record instruction, `blockedOnHuman`, publish always dispatched. The pre-loop research/tests block is gone: one `for (let round = 0; round <= MAX_CORRECTIONS; round++)` loop, the same shape as the incremental one. |
| `workflows/agile-loop.js` | The same mechanism. `handoff()`/`heading()`/`section()`/`plannerHandoff()` gone; `scope()` and `baseline()` kept. `replan:<id>` label, `MAX_BLOCKED` derived from the statuses, `MAX_ATTEMPTS` left session-local with the comment the plan asked for. |
| `skills/agent-brief/SKILL.md` | "Commit, never push" → "Commit your step, then push it", with the retry schedule. "Your handoff" → "Your step return": the fields your page names, the `backlog.mjs record` call, how to find the helper, commit, push. The append-a-section and reading-someone-else's-file paragraphs are gone. `description` and the "Your brief" paragraph follow. |
| `agents/researcher.md` | Handoff-file line gone; "What the handoff contains" → "What you return", naming `plan`, `moduleMap`, `environment`, `testPlan`, `needsTests`, `checks`, `questions`, `summary`. Correction rounds now take the findings from the prompt. |
| `agents/test-author.md` | Step 1 reads `issue.md` and takes the test plan from its prompt; handoff section → the `TESTS` fields, `openQuestions` separated from `questions`; `description` names the return. |
| `agents/implementer.md` | Brief is the injected slice; handoff section → the `BUILD` fields. |
| `agents/reviewer.md` | Findings file section → the `VERDICT` fields, `findings` now an array of claim/reproduction/criterion. New section "You never read `backlog.json`". Check 2's diff exclusion is now `backlog.json`. |
| `agents/planner.md` | Reads `backlog.json`, writes it with `init`, closes with `close`; the later-call brief comes from the prompt; the two-files section is one file; its own handoff section is gone. |
| `README.md` | Both diagrams and the prose at l. 58–76 and 105–117: the run state replaces the prose handoffs, the planner opens and closes the plain loop too, the shed is named. |
| `rulebook.md` | Issue Mode step 4 gains the planner, resume and the `blockedOnHuman` handling; step 5 no longer points at a findings file. |
| `skills/retro/SKILL.md` | One paragraph: the record of a run is the log, `backlog.json` and the git history, and no agent writes a prose report. |
| `.claude/rules/agents.md` | "how it writes and commits its handoff" → "how it records, commits and pushes its step return". |

Nothing migrated. Old issue directories keep their prose files and no code reads
them.

### Commands I ran

Only what the plan's "What counts as done" names. There is no linter and no
formatter in this repository, so nothing else was run.

- **`./test.sh` (baseline, before any change of mine) — exit 1.** `FAIL: 1 of 5
  suite(s)`: `test-repo.sh` at `FAIL: 22 of 37 cases`; `test-worktree.sh` (4
  cases), `tools/argus` (135), `tools/argus-ui` (14) and `tools/log-parser` (23)
  all exit 0. This is the first run of it anyone made — the researcher recorded
  no baseline — and it confirms the 22 red cases are exactly the new ones the
  test-author wrote, with nothing pre-existing red.
- **`bash test.sh` (final) — exit 1.** `FAIL: 1 of 6 suite(s)`. The one failing
  suite is `test-repo.sh` at `FAIL: 1 of 37 cases`, and that one case is W4
  above. Per suite: `test-repo.sh` 36 of 37 cases pass, exit 1; `test-worktree.sh`
  4 cases, exit 0; the new recorder suite 12 cases, exit 0; `tools/argus` 135
  cases, exit 0; `tools/argus-ui` 14 cases, exit 0; `tools/log-parser` 23 cases,
  exit 0. Nothing was skipped or excluded.

I invoked it as `bash test.sh` rather than `./test.sh`: the file is not
executable in this checkout, and `./test.sh` returns `Permission denied` without
running anything. Same script, same arguments.

Two runs that are not the judgment and that the plan authorises for proving a
case red or a fact settled:
`node --test skills/agent-brief/assets/backlog.test.mjs` (12 cases, exit 0) and
`node --test skills/agent-brief/assets/` (exit 1, `Cannot find module`).

### Deviations from the plan

1. **`test.sh` names the recorder suite as a file, not as a directory.** The
   plan's `node --test skills/agent-brief/assets/` does not work in this Node
   v22.22.2 build — it resolves the bare directory as a module — which the
   test-author also recorded. `test.sh` therefore runs
   `node --test "$root/skills/agent-brief/assets/backlog.test.mjs"`, with a
   comment saying why. Grep case G8 still passes: the string
   `skills/agent-brief/assets` is in the line.
2. **The closing planner's return is not required to carry the re-cut.**
   `loop.js` gives its `close:<id>` call a small schema of `questions` and
   `summary`, because that loop never re-cuts. `agile-loop.js` gives `replan:<id>`
   the `BACKLOG` schema, but the script treats the returned `increments` as
   optional: it closes the worked increment in its own list first and adopts the
   planner's list only when one comes back non-empty. The plan did not name a
   schema for either call, and driver case W1 for `agile-loop.js` feeds
   `{ summary: 'closed' }` there, so a script that required `increments` would
   crash on it.
3. **The recorded state, not the `decompose` return, decides what is still
   open.** The plan says an increment whose status is not `todo` is never worked;
   it does not say where the script reads that status from. Both scripts take
   their increment list from the parsed `backlog.json` when the state loader
   returned one, and from the `decompose` return only when it did not. Driver
   case W3 requires this: its `decompose` return holds a `todo` increment while
   the file it comes with holds the same increment `done`.
4. **The plain loop's `Load state` and `Close` are named phases.** The plan
   listed the labels but not the phase names; `meta.phases` gained the two
   entries so a run's phase list still matches what it dispatches.

### Notes outside my scope

- `skills/agent-brief/SKILL.md`'s `description` said the researcher,
  test-author, implementer and reviewer preload the brief. The planner does too,
  and has since it was added. I corrected it in the same sentence I had to
  rewrite anyway; flagging it because no criterion asked for it.
- The `meta` blocks of both workflows still build their strings by
  concatenation. The plan explicitly leaves that to
  `2026-08-07-agile-loop-optimizations`, and I did not touch it beyond adding
  the phase entries the array already invited.
- `test-repo.sh`'s driver runs each workflow through
  `new AsyncFunction('args', 'agent', 'log', 'phase', src)`. Both scripts pass,
  which is also the proof that neither uses `require`, a file API or anything
  else outside those four parameters — so the "the agent records, the script
  never does" decision holds in code, not only in prose.
