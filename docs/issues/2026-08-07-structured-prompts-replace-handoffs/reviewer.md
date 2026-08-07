# Reviewer

## Round 0

**Status: 5 findings, correction needed.**

### The commands that count

- `./test.sh` — **exit 1**. Run as `bash test.sh`, because the file is not
  executable in this checkout (`-rw-r--r--`); invoked as `./test.sh` it exits
  126 with "Permission denied". Six suites, one red: `the repository itself`
  (`test-repo.sh`) reports `FAIL: 1 of 37 cases`. The other five suites are
  green — `parallel runs: worktrees` 4 cases, `skills/agent-brief/assets: the
  backlog recorder` 12 cases, `tools/argus` 116 cases, `tools/argus-ui` 47
  cases, `tools/log-parser` 23 cases. Nothing was skipped or excluded.

The red case is `loop.js: the test-author's prompt carries the test plan and
not the implementation plan`, and this change caused it: the case does not
exist on `origin/main`. It is finding 1.

`./test-repo.sh` was not run separately — `test.sh` runs it as its first
suite, so its result above is that command's result.

### Finding 1 — the suite is red, and the guard on the test-author's slice can never pass

**Claim.** `./test.sh` exits 1. The `test-repo.sh` case that guards the
test-author's slice asserts a substring that its own two markers share, so it
fails against a workflow that is in fact correct, and no implementation can
make it pass.

**Reproduction.** `bash test.sh` → `FAIL: 1 of 37 cases`, the failing line
being `FAIL — loop.js: the test-author's prompt carries the test plan and not
the implementation plan: the test-author's prompt carries the implementation
plan`. The driver in `test-repo.sh` sets `PLAN_MARKER = 'PLAN-MARKER'` (line
268) and `TESTPLAN_MARKER = 'TESTPLAN-MARKER'` (line 269), and mode `w4`
asserts `!testsCall.prompt.includes(PLAN_MARKER)` (line 413). The test-author
prompt in `workflows/loop.js` (lines 556-568) interpolates `plan.testPlan` and
never `plan.plan`, so the only marker in that prompt is `TESTPLAN-MARKER` —
and `node -e 'console.log("TESTPLAN-MARKER".includes("PLAN-MARKER"))'` prints
`true`. The assertion is therefore a false positive for any prompt that
carries the test plan at all.

**Criterion.** "`./test.sh` and `./test-repo.sh` are green." Also criterion 1
— "the workflow hands each agent exactly the slice its role needs — the
test-author the test plan" — which this case is the only guard for, and which
it cannot verify while the two markers overlap.

### Finding 2 — the planner page still tells the planner to write a handoff

**Claim.** `agents/planner.md` still instructs the planner to put the
criterion-to-increment mapping "in your handoff", a file the planner no longer
writes, so that mapping lands nowhere.

**Reproduction.** `agents/planner.md` line 55: "Say in your handoff which
criterion went where." The same page's "What you write" section (lines 94-110)
names exactly one file, `backlog.json`, and its "What you return" section
(lines 122-131) names `increments`, `questions` and `summary` — no handoff
exists to say it in. `grep -in handoff` across the repository outside
`docs/issues/` returns this line as the only surviving instruction of its kind
in `agents/`, `skills/`, `workflows/`, `rulebook.md` and `README.md`. The
existing guard at `test-repo.sh` lines 136-143 matches file *names*
(`planner.md`, `backlog.md`) and not the word, so it passes over this line.

**Criterion.** "Neither workflow writes or reads a prose handoff file any more
… no prompt, agent page or skill still instructs anyone to write or read one."

### Finding 3 — nothing verifies that the workflows instruct a push per step

**Claim.** Criterion 5 rests entirely on the `noDispatch` string in the two
workflow scripts, and no test fails if that instruction is deleted: the guard
meant to cover it matches an unrelated occurrence of the word "push".

**Reproduction.** The per-step push instruction is the tail of `noDispatch` in
`workflows/loop.js` lines 361-364 ("Record your step return, commit it with
your work, then push the commit.") and the identical string in
`workflows/agile-loop.js`. The guard at `test-repo.sh` lines 202-209 is
`grep -qi 'push' "$f"` over `SKILL.md`, `loop.js` and `agile-loop.js`. Delete
`, then push the commit` from `noDispatch` in both scripts and every case still
passes, because both scripts independently contain "Push the current branch and
make sure an open pull request exists for it" in the Publish prompt
(`loop.js` line 657, `agile-loop.js` line 766) and a `pushed` field in the
`PUSH` schema. The driver cases `w1`-`w7` assert nothing about push at all.

**Criterion.** "Every step's commit is pushed, so the state survives a
container reset."

### Finding 4 — `agile-loop.js` is unguarded on the per-role slices and on the human-question exit

**Claim.** The four driver cases that check what each role's prompt carries and
what a question for the human does are run against `workflows/loop.js` only, so
the same behaviour in `workflows/agile-loop.js` can break with the suite green
— the silent divergence between the two workflows that criterion 11 asks to be
guarded against.

**Reproduction.** `test-repo.sh` lines 456-466: the loop
`for wf in "$root/workflows/loop.js" "$root/workflows/agile-loop.js"` covers
modes `w1`, `w2`, `w3` only; modes `w4`, `w5`, `w6` and `w7` are invoked with
`"$root/workflows/loop.js"` alone. Append `plan.testPlan` to the implementer
prompt in `workflows/agile-loop.js` (lines 651-658), or `plan.plan` to the
test-author prompt (lines 633-641), or drop the `if (asksTheHuman(...)) break`
after the research step (line 622), and `bash test.sh` still reports every case
of that section as `ok`.

**Criterion.** "the two workflows stay guarded against silent divergence", and
criterion 1's per-role slicing, which criterion 7 extends to both workflows.

### Finding 5 — `run.steps` is never shed, so closed increments leave full step returns behind

**Claim.** Closing an increment sheds only that increment's own steps. The step
returns recorded at run level survive every close, so after an incremental run
`backlog.json` holds one full copy of the cut per closed increment on top of
the current one.

**Reproduction.** `workflows/agile-loop.js` line 722 records the `replan:<id>`
step with `recordStep('-', replanLabel)` and schema `BACKLOG`, whose return
carries the whole `increments` array — id, title, goal, criteria, note for
every increment (lines 707-726). `skills/agent-brief/assets/backlog.mjs`
`close()` (lines 160-174) sets `increment.steps = []` and touches
`backlog.run.steps` nowhere; `init()` copies `run.steps` forward untouched
(lines 110, 120), which
`skills/agent-brief/assets/backlog.test.mjs` line 116 pins as intended
behaviour. So a run of three increments ends with `run.steps` holding
`decompose` plus `replan:i1`, `replan:i2` and `replan:i3` — four full copies of
the cut — and the default `maxIncrements` of 8 makes that nine.

**Criterion.** "`backlog.json` stays small: full step returns exist only for
the increment in flight, and closing an increment — done, blocked or dropped —
sheds them to status and criteria."

### Beyond the criteria

Traced and found nothing further:

- **Callers of what was touched.** `rulebook.md` step 4-5, `README.md`, the
  `retro` skill and `.claude/rules/agents.md` all move to the new mechanism;
  no other file in the repository names `backlog.md` or a role handoff file
  outside `docs/issues/`. `plugin.json` needs no new entry: the recorder is an
  asset under an already-declared skill, and `test.sh` lists its suite.
- **The recorder's contract.** `record` prints one line and nothing of the
  file, so the reviewer's blind append holds; `init`/`record`/`close` write
  through `<path>.tmp` and rename, so a killed step leaves no half file. Both
  are covered by the recorder suite.
- **The reviewer's diff exclusion.** `agents/reviewer.md` excludes
  `backlog.json` from the diff it judges and forbids reading it, and both are
  guarded (`test-repo.sh` lines 160-170).
- **Old issue directories.** Nothing in the change reads or migrates them,
  which is what the issue's out-of-scope section asks for.

Two facts, neither a finding:

- `test.sh` and `test-repo.sh` are not executable in this checkout
  (`-rw-r--r--`), so `./test.sh` exits 126. This predates the change —
  `git show origin/main:test.sh` is the same file mode — and `test.sh` itself
  invokes every suite through `bash`, so it is a property of the checkout, not
  of the change.
- The agent pages and the shared brief that this change rewrites were not the
  ones in force during this run: the shared brief preloaded into this review
  still carries the old "Your handoff file is `reviewer.md`" wording, so the
  prose handoffs in this issue directory were written under the old rules. That
  is a stale plugin cache, not a defect in the diff.
