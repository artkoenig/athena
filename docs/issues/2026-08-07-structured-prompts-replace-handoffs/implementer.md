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

## Round 1

Both judgment commands are green. Two production files changed: the one
production text the reviewer's finding 2 named, and the shed the reviewer's
finding 5 named. Findings 1, 3 and 4 are repairs inside the guards, which the
test-author owns and had already landed when I started — I ran them, confirmed
they were green, and touched nothing of theirs.

### Running the planned tests first

Before any edit of mine:

- `bash test-repo.sh` — 42 cases, **exit 1**, `FAIL: 1 of 42 cases`. The single
  failure is the plan's case 8, the word guard, red on exactly the line finding
  2 names:
  `/home/user/uroboros/agents/planner.md:55:this run will never do. Say in your handoff which criterion went where.`
- `node --test skills/agent-brief/assets/backlog.test.mjs` — 15 tests, 13 pass,
  **2 fail**, exit 1. The two are the plan's cases 10 and 11, both on the
  missing-key assertion (`the shed run step carries no return key at all`,
  `the run step shed by the first close stays shed after the second`), which is
  finding 5's defect. This command is not on the judgment list; I ran it to see
  those two cases fail in isolation, as the test-author's handoff says it is
  for.

That is exactly the red the researcher's "What is already red" and the
test-author's handoff both predicted, and nothing else was red.

### What I changed

| Path | What I did |
| --- | --- |
| `agents/planner.md` | Line 55: "Say in your handoff which criterion went where." → "Say in your `summary` which criterion went where." — the field the page's own "What you return" section already describes. The `close` bullet now says the shed takes the returns of the run's own steps too, keeping their labels. |
| `skills/agent-brief/assets/backlog.mjs` | `close()` now walks `backlog.run.steps` after emptying the increment's `steps` and does `delete step.return` on every entry, guarded by `backlog.run && Array.isArray(backlog.run.steps)` so a backlog with no `run` key is untouched. The header comment (the third of its three subtle rules) and the comment over `close()` say the run's steps shed too, and the `close()` comment states why the entry survives with its label: a workflow resumes on `recorded.has(label)`, so a `{label, at}` stub still skips its step while dropping the entry would re-dispatch the opening cut after every close. |

No other file was opened for editing. `workflows/loop.js` and
`workflows/agile-loop.js` are unchanged this round, as the plan says.

### Commands I ran

The two the plan's "What counts as done" names, from the repository root, and
nothing else. There is no linter and no formatter in this repository.

- **`bash test-repo.sh` — exit 0.** `PASS: 42 cases`. Nothing skipped or
  excluded.
- **`bash test.sh` — exit 0.** `PASS: all 6 suites`: `test-repo.sh` 42 cases,
  `test-worktree.sh` 4 cases, the recorder suite 15 tests (15 pass, 0 fail),
  `tools/argus` 135 tests, `tools/argus-ui` 14 tests, `tools/log-parser` 23
  tests. Nothing skipped or excluded.

Invoked as `bash test.sh` and `bash test-repo.sh`, not `./…`: neither file is
executable in this checkout, and the plan's Environment section says so and
says not to `chmod` them.

The single-file run above (`node --test
skills/agent-brief/assets/backlog.test.mjs`, 15 tests, exit 0 after the change)
is not part of the judgment; `test.sh` reaches that suite.

### Deviations from the plan

None. Every change is the one its finding named, in the file and at the line the
module map gives.

### Notes for the reviewer

- The plan says `skills/agent-brief/SKILL.md` needs no change because it never
  describes `close`. I confirmed that by reading it: it names `backlog.mjs
  record` and the push, and says nothing about closing an increment. So the
  shed's new half is documented in `agents/planner.md` alone, which is the page
  of the only agent that calls `close`.
- The residue the plan calls out by design holds in the code: `close` sheds
  before the planner records its own close return, so exactly one run-level full
  return exists at any moment. Nothing in this round tests that directly, and
  the plan does not ask for it — recorder case 11 pins the repeat, not the
  residue.
- This file now carries two sections headed `## Round 1`: the earlier one is the
  first build, this one is the correction round. My prompt named the heading and
  told me to leave every earlier section as it stands, so I did not renumber the
  first.

## Round 2

Both judgment commands are green. Four files changed: the two workflow scripts
(finding 1), `skills/agent-brief/SKILL.md` (finding 3) and `rulebook.md`
(finding 1's documentation half). Finding 2 is a missing test, and its repair —
driver mode `w10` — is the test-author's and was already green when I started.

### Running the planned tests first

Before any edit of mine, `bash test-repo.sh` — 47 cases, **exit 1**,
`FAIL: 3 of 47 cases`. The three are exactly the three the plan's "What is
already red" predicts:

- `the shared brief does not tell a repeated step what its first run may have
  left behind` — the grep case, red because `already committed` was in no line
  of `skills/agent-brief/SKILL.md`.
- `loop.js: a run resumed after a question for the human works that step again
  with the question in its prompt` — mode `w9`, red on all four of its
  assertions, the first reading
  `expected ["load-state","research:i1.0","tests:i1.0","implement:i1.0","review:i1.0","close:i1","publish"] got ["load-state","publish"]`.
- `agile-loop.js: …` the same mode, the same four assertions, with `replan:i1`
  in the expected sequence.

Nothing else was red. I did not run `bash test.sh` as a baseline: the plan's
"What is already red" records it exit 0 in the reviewer's round-1 run, and my
final run of it below confirms it.

### What I changed

| Path | What I did |
| --- | --- |
| `workflows/loop.js` | The resume loader now triages: a recorded step whose return carries a non-empty `questions` goes into a new `carriedQuestions` map instead of `recorded`, so it is worked again rather than replayed, with the plan's comment above it and a `log` line when the map is non-empty. New `answeredBlock(label)` beside `recordStep()`, returning the question the step asked and the pointer to `## Decisions` in `issue.md`, and `''` for every other label. `answeredBlock(<that step's label>) +` inserted immediately after the `Issue directory: ${dir}\n` fragment of all six recorded dispatches: `decompose`, `research`, `tests`, `implement`, `review`, `close`. `load-state` and `publish` got none. |
| `workflows/agile-loop.js` | The same three changes, word for word, at the same six kinds of dispatch — `decompose`, `research`, `tests`, `implement`, `review`, `replan`. |
| `skills/agent-brief/SKILL.md` | One paragraph appended to the end of "Your step return", in the plan's wording: a step worked again may meet what its interrupted first run already committed, so read the working tree and `git log` first and finish or correct what is there. |
| `rulebook.md` | Issue Mode step 4, the `blockedOnHuman` line, replaced whole with the plan's sentence: the restart works the step that asked again, with the question in its prompt and the answer in `issue.md`, and skips every other recorded step. Line 52 and `README.md` line 78 are untouched, as the plan says. |

`skills/agent-brief/assets/backlog.mjs` and its suite are unchanged this round,
as the plan says, and I opened neither. No file outside the module map was
edited.

The word "handoff" is in none of the text I wrote; `test-repo.sh`'s word guard
over the workflow scripts is still green.

### Commands I ran

The two the plan's "What counts as done" names, from the repository root, and
nothing else. There is no linter and no formatter in this repository.

- **`bash test-repo.sh` — exit 0.** `PASS: 47 cases`, the plan's own sanity
  figure. Nothing skipped or excluded.
- **`bash test.sh` — exit 0.** `PASS: all 6 suites`: `test-repo.sh` 47 cases,
  `test-worktree.sh` 4 cases, the recorder suite 15 tests (15 pass, 0 fail),
  `tools/argus` 135 tests, `tools/argus-ui` 14 tests, `tools/log-parser` 23
  tests. Nothing skipped or excluded.

Invoked as `bash …`, not `./…`: neither file is executable in this checkout,
and the plan's Environment section says so and says not to `chmod` them.

### Deviations from the plan

1. **The paragraph in `skills/agent-brief/SKILL.md` is line-wrapped one word
   earlier than the plan's own block quote.** The plan's wrapping breaks the
   line between "already" and "committed", and the test-author's guard is
   `grep -q 'already committed'` over that file, which a wrapped phrase does not
   satisfy — I saw it fail that way once and rewrapped. The words are the
   plan's, unchanged; only the line break moved.

### Notes for the reviewer

- The plan's implementer dispatch site was `` `Issue directory: ${dir}\nYour
  brief is the plan below.\n\n` `` — one template literal carrying two lines. I
  split it into `` `Issue directory: ${dir}\n` + answeredBlock(buildLabel) +
  `Your brief is the plan below.\n\n` ``, which is what the plan asks for in as
  many words, so the block lands above the brief rather than inside it.
- `answeredBlock()` is declared beside `recordStep()`, above the `const
  carriedQuestions` it reads. That is safe because it is a hoisted function
  declaration and no dispatch happens before the loader runs; it is what the
  plan's module map places there.
- The two knock-on facts the plan states hold in the code and neither is tested
  here: a re-dispatched step records under the same label, so `backlog.mjs
  record` overwrites the stale return with the question rather than duplicating
  it, and a human who restarts without answering gets the same question and the
  same regular exit.
