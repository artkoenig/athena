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

## Round 1

**Status: 3 findings, correction needed.**

### The commands that count

- `bash test-repo.sh` — **exit 0**. 42 cases, seven sections (`the licence`, `no
  repository-local rule reaches an agent`, `the run state is the channel, and no
  prose handoff is left`, `a run resumes from the state it recorded`, `the two
  workflows coexist`, `every agent page is declared`, `remote operation deploys
  the collector alone`). Nothing skipped or excluded.
- `bash test.sh` — **exit 0**. `PASS: all 6 suites`: `the repository itself`
  (test-repo.sh, 42 cases), `parallel runs: worktrees` (4 cases),
  `skills/agent-brief/assets: the backlog recorder` (15 cases, 0 fail),
  `tools/argus` (23 pass in its own TAP summary), `tools/argus-ui`,
  `tools/log-parser`. Nothing skipped or excluded.

Round 0's five findings are all repaired: the driver markers are disjoint
(`MARKER-IMPLEMENTATION-PLAN` / `MARKER-TEST-PLAN`), `agents/planner.md` names
no handoff, mode `w8` asserts the per-step record-and-push instruction on every
step's own prompt, `w4`–`w8` now run against both workflow files, and
`close` sheds the returns of the run's own steps.

### Finding 1 — a run that ended on a question for the human can never be resumed

**Claim.** The step that asked the question is recorded, so the resumed run
replays that recorded return, sees the same `questions` again, and exits at
Publish without dispatching a single agent. The human's answer in `issue.md` is
never read, and the run cannot advance no matter how often it is restarted.

**Reproduction.** State: `<issueDir>/backlog.json` with
`increments: [{ id: "i1", status: "todo", steps: [ { label: "research:i1.0",
at: "...", return: { …, questions: ["which database?"] } } ] }]` and
`run.steps: [{ label: "decompose", … }]` — exactly the state criterion 10 asks
the run to leave behind, since the researcher records its return before it
finishes and that return carries the question. Start `uroboros:loop` on that
same issue directory. `workflows/loop.js` lines 456-462 load every recorded
label into `recorded`; `step()` at lines 469-478 finds `research:i1.0` recorded,
logs `recorded already, skipping` and returns the stored object without
dispatching; line 547 `if (asksTheHuman(researchLabel, plan)) break` reads
`questions: ["which database?"]` out of that stored object and breaks the round
loop. `blockedOnHuman` is non-empty, so the close step is skipped (line 617) and
the run goes straight to Publish and returns `blockedOnHuman` again. The
researcher is never dispatched, so nothing ever reads the `## Decisions` entry
the human wrote. `workflows/agile-loop.js` is identical: lines 489-495, 502-511
and line 622.

`rulebook.md` line 54, added by this change, promises the opposite in so many
words: "record their answers under a `## Decisions` heading in `issue.md` …
and start the same workflow on the same directory again."

No driver mode covers this: `w7` proves only the *fresh*-run question exit
(`test-repo.sh` line 468), and no fixture in `contextFor` (lines 370-388) hands
the script a saved backlog whose recorded step carries a question.

**Criterion.** "An agent's question for the human lands in `backlog.json` and
ends the run as a regular exit (`blocked-on-human-exit`), so the session that
picks the run back up finds the question in the state it resumes from … and the
resuming researcher reads it there." Also criterion 6, "Resume is the workflow
started again on the same issue directory": here the restart makes no progress
at all.

### Finding 2 — no test exercises a correction round, so the findings channel to the researcher is unguarded

**Claim.** Every driver mode returns a verdict with an empty `findings` list, so
the round loop always breaks after round 0 and no assertion ever inspects a
round-1 prompt. Delete `findingsBlock(verdict, round)` from the researcher
dispatch and the whole suite stays green, though the reviewer's findings would
then reach nobody.

**Reproduction.** `test-repo.sh` line 322 defines the only verdict fixture,
`verdictReturnClean = { findings: [], reason: '', … }`, and `returnFor` line 398
hands it to every `review:` label in every mode. With `found === 0` the loop
breaks at `workflows/loop.js` line 604 (`agile-loop.js` line 681), so
`findingsBlock` (loop.js lines 403-418, called at line 540; agile-loop.js lines
411-427, called at line 615) and `openQuestionsBlock` are never called under
test. Delete the `(round === 0 ? '' : findingsBlock(verdict, round)) +` line
from both scripts, or replace it with the empty string, and `bash test-repo.sh`
still reports 42 of 42 cases ok — nothing asserts that a correction round's
researcher prompt carries claim, reproduction and criterion. The reason
sentence the human reads in the chat sits in the same never-exercised branch
(`loop.js` line 612, `agile-loop.js` line 689).

**Criterion.** "The reviewer's independence survives the new channel: … its
findings reach the researcher through its return, and the human still gets the
reason sentence in the chat." Both clauses of that criterion are the only ones
the new channel changed for the correction round, and neither has a test that
fails when the behaviour breaks.

### Finding 3 — nothing tells a repeated step that its interrupted first run may already have committed work

**Claim.** The criterion asks a repeated step to tolerate work its interrupted
first run committed. No prompt, agent page or skill says so, and the shared
brief says the opposite in the one sentence that touches it.

**Reproduction.** A session dies after the test-author has committed and pushed
`x.test.mjs` with two of three planned cases but before it ran `record`, so
`tests:i1.0` is absent from `backlog.json`. The restart dispatches the
test-author again with the identical prompt (`workflows/loop.js` lines 556-568):
that prompt carries the test plan and the record line and nothing else, and
`agents/test-author.md` says only "Write the planned cases" while forbidding it
to open production code. `skills/agent-brief/SKILL.md` line 103 is the single
sentence in the repository about a repeated step, and it reads "a step it does
not hold is worked again from the start" — no mention of work that is already
there. `grep -rniE 'tolerat|already committed|half-exists|interrupted|crash|may
already|already there' agents/ skills/ workflows/ rulebook.md README.md` returns
nothing but a code comment inside the two workflow scripts (`loop.js` lines
466-467, `agile-loop.js` lines 499-500), which no agent ever reads. The same
holds for the implementer meeting code its interrupted run half-wrote.

**Criterion.** "A repeated step tolerates work its interrupted first run already
committed (failing tests that exist, code that half-exists)."

### Beyond the criteria

Traced, and nothing further found:

- **Callers of what was touched.** `rulebook.md` steps 4-5, `README.md` (both
  diagrams and the prose), `skills/retro/SKILL.md` and `.claude/rules/agents.md`
  all move to the structured return and `backlog.json`; no file outside
  `docs/issues/` still names `backlog.md` or a role handoff file, and no agent
  owns a private skill directory that the guard's `skills/*/SKILL.md` glob would
  miss.
- **The shed and resume together.** `close` deletes the `return` key of every
  run step but keeps `label` and `at`, so on resume `recorded.set(s.label,
  undefined)` still makes `recorded.has(label)` true and the step is skipped —
  and both scripts take the increments from `saved.increments` rather than from
  the shed `decompose` return, so nothing downstream needs the payload that was
  dropped. Both halves are pinned by the recorder suite and by driver mode `w3`,
  whose `doneBacklog` fixture now carries a shed run step.
- **The reviewer seeing `backlog.json` in its own diff.** The run state is
  committed on the branch, so `git diff origin/main...HEAD` shows it to the
  reviewer whatever its page says. That is exactly the exposure the prose
  handoff files have on `main` today, and criterion 9 asks for it to be handled
  "as the handoff files are today" — an instruction to exclude it from judgment,
  which `agents/reviewer.md` lines 49-52 and 85-90 give. Not a change in
  behaviour, so not a finding.
- **`plugin.json`.** The recorder is an asset under the already-declared
  `agent-brief` skill and its suite is listed in `test.sh`, so no new
  declaration is owed; `test-repo.sh` checks both.
- **Old issue directories.** Nothing reads or migrates them, which is what the
  out-of-scope section asks.

One fact, not a finding: `test.sh` and `test-repo.sh` are still not executable
in this checkout (`-rw-r--r--`), so `./test.sh` exits 126 while `bash test.sh`
exits 0. That predates the change and is unchanged by it.

## Round 2

**Status: 2 findings, correction needed.**

### The commands that count

- `bash test-repo.sh` — **exit 0**. 47 cases, seven sections (`the licence`, `no
  repository-local rule reaches an agent`, `the run state is the channel, and no
  prose handoff is left`, `a run resumes from the state it recorded`, `the two
  workflows coexist`, `every agent page is declared`, `remote operation deploys
  the collector alone`). Nothing skipped or excluded.
- `bash test.sh` — **exit 0**. `PASS: all 6 suites`: `the repository itself`
  (test-repo.sh, 47 cases), `parallel runs: worktrees` (4 cases),
  `skills/agent-brief/assets: the backlog recorder` (15 cases, 0 fail),
  `tools/argus`, `tools/argus-ui`, `tools/log-parser` (23 pass, 0 fail in the
  TAP summary). Nothing skipped or excluded.

Both are green, so no red run is this change's to answer for.

Round 1's three findings are all repaired: a recorded step whose return carried
a question is worked again instead of replayed (`carriedQuestions` /
`answeredBlock` in both scripts, pinned by driver mode `w9` on both), driver
mode `w10` exercises a correction round end to end, and
`skills/agent-brief/SKILL.md` now tells a repeated step what its interrupted
first run may already have committed.

The review was taken against `origin/main` (eb13462), which is the default
branch tip; the local `main` ref in this checkout is stale at 57e5fd4, and
diffing against it additionally shows six issue directories that are already on
`origin/main`. That is a checkout fact, not part of this change. The real diff
is 20 files.

### Finding 1 — the plain loop throws away a question the closing planner asks

**Claim.** `workflows/loop.js` dispatches the planner for the Close step and
discards its return without ever looking at `questions`. A question asked there
never reaches the human, never lands in `blockedOnHuman`, and can never be
re-asked on a restart — while `workflows/agile-loop.js` handles the identical
role in the identical position correctly.

**Reproduction.** State: a plain-loop run reaching Close, where the planner's
`close:i1` return is
`{ questions: ["Should the increment count as done when one check was skipped?"], summary: "closed" }`.
`workflows/loop.js` line 656 is `await step(closeLabel, 'Close', () => agent(...))`
— the value is neither assigned nor passed to `asksTheHuman`, and lines 674-678
go straight on to `task.status = ...`. Result: `blockedOnHuman` stays `[]`, so
the `${blockedOnHuman.length} question(s) for the human ended this run` log at
lines 680-685 never prints, the run returns `blockedOnHuman: []` at line 720,
and the session — which the rulebook (line 609) tells to surface exactly that
field — reports the run as finished. The question is written into
`backlog.json` by the planner's own `record` call and then read by nobody: on a
restart `close:i1` is put into `carriedQuestions` (lines 477-488), but the
increment is already closed in the file, so `increments.find(t => t.status ===
'todo')` at line 550 yields `null`, the guard `if (task && verdict && ...)` at
line 653 is false, and the Close step is never dispatched again.

The script promises the opposite in its own schema: `CLOSED.questions` at
`workflows/loop.js` lines 311-317 is described as "Decisions only the human can
make … A non-empty list ends the run." `workflows/agile-loop.js` line 772 does
call `asksTheHuman(replanLabel, recut)` for the same planner in the same
closing position, so the two workflows differ here in behaviour.

No driver mode covers it: `returnFor` at `test-repo.sh` line 473 hands every
`close:`/`replan:` label `{ summary: 'closed' }`, and `w7` — the only
human-question mode — puts the question on the researcher.

**Criterion.** "An agent's question for the human lands in `backlog.json` and
ends the run as a regular exit (`blocked-on-human-exit`), so the session that
picks the run back up finds the question in the state it resumes from." Also
"the two workflows stay guarded against silent divergence": this is a
divergence, and nothing in the suite would catch it.

### Finding 2 — an increment handed back is now never worked a second time

**Claim.** `workflows/agile-loop.js` keys its step labels on the increment id,
and the in-session `recorded` map caches every dispatched step. So the second
attempt at an increment the planner handed back re-uses the labels of the
first, finds all of them cached, dispatches nobody, and re-reads the stale
verdict and the stale re-cut — turning `MAX_ATTEMPTS` from "worked twice" into
"worked once, then a no-op iteration". On `origin/main` the same path re-worked
the increment.

**Reproduction.** State: `increments = [i1]`; the planner's `replan:i1` return
lists `i1` with `status: "todo"` again (the case the `MAX_ATTEMPTS` comment at
`workflows/agile-loop.js` lines 48-51 exists for). Iteration `n = 1` works `i1`
through `research:i1.0`, `tests:i1.0`, `implement:i1.0`, `review:i1.0`,
`replan:i1`; `step()` at lines 531-540 writes each into `recorded`. Line 768
then replaces `increments` with the re-cut, so `n = 2` picks `i1` again with
`attempt = 2` (lines 624-631, within `MAX_ATTEMPTS`). Every label it builds at
lines 640, 661, 680 and 698 is byte-identical to iteration 1's, so
`recorded.has(label)` is true for all of them: each logs `recorded already,
skipping` and returns iteration 1's payload. `verdict` is iteration 1's
verdict, `replan:i1` at line 744 is skipped too, so `recut` is iteration 1's
re-cut and `i1` is still `todo`; `n = 3` gives `attempt = 3 > MAX_ATTEMPTS` and
the run stops with `"…" was worked 2 times and the planner handed it back again
without re-cutting it` — a message that is now false, since it was worked once.

`git show origin/main:workflows/agile-loop.js` line 280 builds the label as
`research:${n}.${round}`, keyed on the iteration ordinal, so on `origin/main`
iteration 2 used fresh labels and really did dispatch the chain a second time.
This change moved the key to the increment id (lines 527-530's comment states
that as deliberate) without giving the second attempt a distinct label, and no
driver mode exercises a re-cut that hands an increment back as `todo`.

**Criterion.** None — no criterion asks for the re-attempt behaviour either
way. It is the blast radius of the resume mechanism: criterion 6's "Recorded
steps never re-run" is satisfied, and agile-loop's second-chance backstop is
what pays for it.

### Beyond the criteria

Traced, and nothing further found:

- **Callers of what was touched.** `rulebook.md` steps 4-5, `README.md` (both
  diagrams and the prose), `skills/retro/SKILL.md` and `.claude/rules/agents.md`
  all move to the structured return and `backlog.json`. `grep -rn 'backlog\.md'`
  outside `docs/issues/` returns nothing, and the only surviving occurrences of
  "handoff" outside `docs/issues/` are `test-repo.sh`'s own guard comments and
  an unrelated local variable in `tools/argus-ui/test/server.test.mjs`. No agent
  owns a private `agents/<name>/skills/` directory, so the guard's
  `skills/*/SKILL.md` glob misses nothing.
- **The question triage and the shed together.** `close` drops each run step's
  `return` and keeps `label` and `at`; `load()` (loop.js lines 478-483,
  agile-loop lines 511-516) reads `s.return.questions` defensively, so a shed
  step yields `asked = []` and lands in `recorded` with an `undefined` payload —
  the resume still skips it. Driver mode `w3`'s `doneBacklog` fixture carries
  exactly that shape.
- **The reviewer's page.** It forbids reading `backlog.json`, excludes it from
  the diff it judges, and the recorder prints one confirmation line and nothing
  of the file, so the blind append holds. Its "nothing you run may change the
  checkout" sentence sits beside an instruction to record and commit
  `backlog.json`, but the same tension existed word for word on `origin/main`
  (where it committed `reviewer.md`), so it is not this change's defect.
- **`plugin.json`.** The recorder is an asset under the already-declared
  `agent-brief` skill and its suite is listed in `test.sh`; `test-repo.sh`
  checks both, and the agent-page declaration case passes.
- **Old issue directories.** Nothing reads or migrates them, which is what the
  out-of-scope section asks.

One fact, not a finding: `test.sh` and `test-repo.sh` are still not executable
in this checkout (`-rw-r--r--`), so `./test.sh` exits 126 while `bash test.sh`
exits 0. That predates the change and is unchanged by it.
