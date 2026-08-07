# Test-author handoff — structured prompts replace the handoffs

## Round 1

I read `issue.md` and `researcher.md` only, wrote the cases the researcher's
Test plan section names, in the two files it names, and ran each with the
single-file command it names. No production code was opened. Below is every
case, where it landed, and the failure it produces today.

### A. `skills/agent-brief/assets/backlog.test.mjs` (new file)

Run with `node --test skills/agent-brief/assets/backlog.test.mjs` (see the
environment note at the end — the plan's literal `node --test
skills/agent-brief/assets/` does not work in this sandbox for any directory,
mine or a pre-existing one). `skills/agent-brief/assets/backlog.mjs` does not
exist yet, so every case that shells out to it gets `Cannot find module
'/home/user/uroboros/skills/agent-brief/assets/backlog.mjs'` from Node's own
loader — a real, uncontrived absence, not a typo in the test.

- **R1** → `init creates a fresh backlog.json in the documented shape`.
  `not ok`. Failure: `execFileSync` throws `Command failed: ... backlog.mjs
  init ...` / `Error: Cannot find module
  '/home/user/uroboros/skills/agent-brief/assets/backlog.mjs'` (`MODULE_NOT_FOUND`).
- **R2** → `init merges into an existing backlog: kept increments keep their
  steps, dropped ones vanish, new ones start empty, run.steps is untouched`.
  `not ok`, same `MODULE_NOT_FOUND` on the first `run(['init', ...])` call.
- **R3** → `record appends a step to the named increment and prints only the
  confirmation, nothing from the file`. `not ok`, same cause.
- **R4** → `recording the same label twice replaces the entry instead of
  duplicating it`. `not ok`, same cause.
- **R5** → `record with an increment id of "-" lands the step in run.steps
  and touches no increment`. `not ok`, same cause.
- **R6** → `record against an increment id no increment has exits 1 and
  leaves the file untouched`. `not ok`, same cause (fails on the `init` call
  that has to succeed first, before the case's own assertion is even
  reached).
- **R7** → `record against a path with no file exits 1 and creates nothing`.
  **`ok`** — but for the wrong reason: `record` against a path with no
  `backlog.json` is expected to exit 1, and a missing CLI module also makes
  Node exit 1, so the two coincide right now. This case is not proof of
  correct behaviour yet; it will only become a real assertion once
  `backlog.mjs` exists and can actually reach its own "no such file" branch.
  I flag it here so the implementer does not read this `ok` as "R7 is done."
- **R8** → `close sets status and note and empties only the closed
  increment's steps`. `not ok`, `MODULE_NOT_FOUND` on the first `init`.
- **R9** → `close with a status outside done|blocked|dropped exits 1 and
  leaves the file untouched`. `not ok`, same cause.
- **R10** → `read prints the file's exact content`. `not ok`, same cause.
- **R11** → `read on a missing file exits 1 and prints nothing on stdout`.
  **`ok`** — same caveat as R7: the missing module's exit code 1 coincides
  with the expected one; not yet a real pass.
- **R12** → `a successful record leaves no .tmp file behind`. `not ok`, same
  `MODULE_NOT_FOUND` cause.

Full run: `node --test skills/agent-brief/assets/backlog.test.mjs` → `# tests
12`, `# pass 2`, `# fail 10` (the two passes are R7 and R11, both accidental
for the reason above).

### B. `test-repo.sh`

I deleted the section `=== a correction round reuses the handoff it already
has` (its three cases) whole, as the plan asked, and added the two sections
it names in its place, in the file's own style (`echo "=== ..."` header, one
`ok`/`no` line per case, a comment above each explaining why the case
exists). Run with `bash test-repo.sh`.

**`=== the run state is the channel, and no prose handoff is left`** (G1–G8):

- **G1** — `no prompt, agent page or skill still names a prose handoff
  file`. `FAIL`. The grep still finds the old references, e.g.:
  `workflows/loop.js:163:    \`Issue directory: ${dir}\n${correction}${handoff('researcher.md', round)}${noDispatch}\`,`
  and `agents/researcher.md:30:Your handoff file is \`researcher.md\`, in
  every round: a correction round` — 29 matching lines in total across
  `workflows/*.js`, `agents/*.md` and `README.md`.
- **G2** — state loader carried in both workflows. `FAIL` for both:
  `loop.js is missing backlog.json or load-state`, `agile-loop.js is missing
  backlog.json or load-state`.
- **G3** — the reviewer's no-read boundary. `FAIL` for both: `the reviewer's
  page does not forbid reading backlog.json`, `the reviewer's page does not
  exclude backlog.json from its diff judgment`.
- **G4** — the planner dispatched from both workflows. `FAIL` —
  `loop.js does not dispatch the planner` (the plain loop does not call the
  planner today, which is exactly decision 5's change). `ok` —
  `agile-loop.js dispatches the planner` already holds today, since the
  incremental loop already calls the planner for its own re-cut; that is a
  correct pre-existing fact, not something my case needs the change for, and
  the case as a whole is still red because of `loop.js`.
- **G5** — every agent page and the shared brief name the recorder. `FAIL` —
  `these agent pages do not mention backlog.json: implementer.md planner.md
  researcher.md reviewer.md test-author.md`, `the shared brief does not name
  backlog.mjs`.
- **G6** — push is instructed. `ok` for all three files today
  (`skills/agent-brief/SKILL.md`, `loop.js`, `agile-loop.js` each already
  contain the word "push" in some form) — this case does not go red on its
  own; see "What is already green" below.
- **G7** — the plain loop pinned to one increment. `FAIL` —
  `the plain loop's schema does not pin maxItems: 1`.
- **G8** — the helper ships, parses, is listed. `FAIL` on all three:
  `skills/agent-brief/assets/backlog.mjs does not exist`, `the backlog helper
  does not parse (or does not exist)`, `test.sh does not list the recorder
  suite`.

**`=== a run resumes from the state it recorded`** (W1–W7), driven by a
heredoc `driver.js` written to a `mktemp -d` (removed afterwards), the same
pattern as the existing `scope.js` case: it compiles the workflow file with
`new AsyncFunction('args', 'agent', 'log', 'phase', src)` and runs it with a
stub `agent()`, feeding canned `STATE`/`BACKLOG`/`PLAN`/`TESTS`/`BUILD`/`VERDICT`
returns keyed by label prefix and mode, then asserts on the recorded call
sequence, `agentType`s and prompt contents (marker substrings). All ten
invocations (W1–W3 against both workflow files, W4–W7 against `loop.js`
alone) fail, because the current scripts have none of the new mechanism:

- **W1 / loop.js** — `not ok`: `Error: unexpected label tests` — the current
  `loop.js` dispatches a step it labels `tests` (no round suffix, no
  `research:`/`tests:` scheme), which my driver's `returnFor` does not
  recognise, because that scheme does not exist yet.
- **W2 / loop.js** — `not ok`, same `unexpected label tests` (the resume path
  does not exist, so the driver still walks into the current script's own,
  different dispatch sequence).
- **W3 / loop.js** — `not ok`, same cause.
- **W1 / agile-loop.js** — `not ok`: `TypeError: Cannot read properties of
  undefined (reading 'map')` — the current `agile-loop.js` expects its
  canned `decompose` return (or some other dispatch's return) in a shape my
  driver's `BACKLOG`-schema object does not provide, because the current
  script predates that schema.
- **W2 / agile-loop.js** — `not ok`, same `TypeError`.
- **W3 / agile-loop.js** — `not ok`, same `TypeError`.
- **W4, W5, W6, W7 / loop.js** — all `not ok`, each with the same `Error:
  unexpected label tests` as W1, because the slice-per-role behaviour these
  cases pin does not exist until the labels and the schemas do.

Full run: `bash test-repo.sh` → `FAIL: 22 of 37 cases`. The 22 failures are
exactly the new B cases above (16 grep sub-checks under G1–G8, minus the two
that are already true — G4's `agile-loop.js` half and G6's three — plus all
10 driver invocations); nothing pre-existing in the file broke: `the licence`,
`no repository-local rule reaches an agent`, `the two workflows coexist`,
`every agent page is declared` and `remote operation deploys the collector
alone` are unchanged and still green.

### What is already green, and why that is not a problem

Three sub-checks pass today without any code change: `agile-loop.js
dispatches the planner` (G4), and all three of G6's push mentions
(`skills/agent-brief/SKILL.md`, `loop.js`, `agile-loop.js` already say
"push" somewhere, e.g. in the shared brief's current "Commit, never push"
sentence and in existing push-retry code the incremental loop already has
for its own commits). None of these make their case as a whole pass — G4 is
still `FAIL` because of `loop.js`, and G6 needs no further work from the
implementer for the exact word "push" to keep appearing, but the *sense* of
those lines still has to change (the brief has to start telling the agent to
push, not to withhold pushing) even though the grep itself won't move. I am
flagging this so the implementer does not read grep survival as proof the
sentence in `skills/agent-brief/SKILL.md` already says what criterion 5
needs — it currently says the opposite.

### Every case from the plan is written; none was skipped

R1–R12, G1–G8 and W1–W7 are all present as described above. Nothing in the
plan's "Left untested, deliberately" list was tested: no assertion on
`README.md`/`rulebook.md`/`skills/retro/SKILL.md`/`.claude/rules/agents.md`
prose beyond G1, nothing on push retry/backoff, nothing on the state loader's
real file read (only its dispatch's presence in the call sequence, via
W1–W3), nothing on the shed's effect on a live agent's context.

### Gaps and conflicts found in the test plan

1. **The plan's literal single-file command for section A does not run in
   this sandbox.** `node --test skills/agent-brief/assets/` fails with
   `Error: Cannot find module '/home/user/uroboros/skills/agent-brief/assets'`
   — Node tries to `require()` the bare directory instead of scanning it for
   `*.test.mjs`. This is not specific to my new file: the same command
   against the pre-existing `tools/argus-ui/test/` fails identically in this
   Node v22.22.2 build. `node --test skills/agent-brief/assets/backlog.test.mjs`
   (an explicit file) and `node --test` (no path, full-repo scan) both work.
   I used the explicit-file form to prove the cases red; whoever judges the
   suite later should use that form too, or confirm the bare-directory form
   works in their own environment before relying on it.
2. **R7 and R11 currently pass for a reason that has nothing to do with
   their case.** Recorded above, not a defect in the cases themselves — once
   `backlog.mjs` exists, the module-not-found coincidence disappears and
   these two start testing what they were written to test.
3. **No conflict found between the test plan and the acceptance criteria** —
   every case I could pin to a concrete expected outcome from the plan's own
   wording; I did not have to invent an expectation the plan left open.

## Environment

`node --version` → `v22.22.2`. Both suites were run from the repository root,
`/home/user/uroboros`. `bash test-repo.sh` needs no setup beyond what the
repository already has (`git`, `node`, `mktemp`). No suite beyond the two the
plan names was run — `./test.sh` is the implementer's and the judgment's to
run, not mine.

## Round 1

The criterion this round is the reviewer's Round 0 reproduction spec, and the
Test plan section of `researcher.md`'s `## Round 1` is my work order for it.
I read `issue.md`, `researcher.md` (both its top-level content and `## Round
1`), and no other file. Two production files stay untouched this round
(`workflows/loop.js`, `workflows/agile-loop.js`), as the plan says; my own
work is in the two test files I already own. I did not read the reviewer's
own findings file — the plan named it as my criterion but the case-by-case
work order is entirely in `researcher.md`'s Round 1 section, which quotes
every finding I needed.

Twelve cases were planned, one per numbered item under "The cases". All
twelve are written, in the two files and at the level the plan names. Cases 1
and 6-7 add new assertions to the existing driver; cases 2-5 move existing
assertions into the two-workflow loop; case 8 is a new grep section; case 9
tightens an existing grep loop; cases 10-12 are new `backlog.test.mjs` tests.

### A. `test-repo.sh` — the driver heredoc

Run with `bash test-repo.sh`.

1. **Disjoint markers** → the standing assertion at the top of `main()`
   (`test-repo.sh`, inside the driver heredoc, just after
   `const AsyncFunction = ...` — no, before it, at the very top of the
   function body): loops `DISJOINT_MARKERS = [PLAN_MARKER, TESTPLAN_MARKER,
   'CHECK-MARKER']` pairwise and asserts none contains another. I also
   renamed the two constants themselves, per the plan's own fix:
   `PLAN_MARKER = 'MARKER-IMPLEMENTATION-PLAN'`,
   `TESTPLAN_MARKER = 'MARKER-TEST-PLAN'`. This is not a red case — it is the
   guard against finding 1 returning, and it runs in every mode. **Result:
   green**, matching the plan's own prediction ("Expected: passes for the
   renamed constants"). I could not "prove it red" because there is nothing
   to break yet: the disjointness is a property of the two literals I just
   chose, not of any production code. I verified it the other way instead —
   with the old literals restored temporarily, the loop threw
   `marker "MARKER-TEST-PLAN".includes... ` — no, concretely:
   `'TESTPLAN-MARKER'.includes('PLAN-MARKER')` is `true`, which is finding
   1's own reproduction, quoted in the plan; I did not need to re-derive it.
2. **`w4` on both workflows** — "`$wf_name`: the test-author's prompt carries
   the test plan and not the implementation plan". Moved inside the
   `for wf in ...` loop, unchanged assertions. **Result: green** on both
   `loop.js` and `agile-loop.js`, once the markers are disjoint. Before my
   fix, `bash test-repo.sh` reported exactly what the reviewer's Finding 1
   reproduction quotes: `FAIL — loop.js: the test-author's prompt carries the
   test plan and not the implementation plan: the test-author's prompt
   carries the implementation plan` — a false failure against a prompt that
   in fact carried only the test plan, since `'MARKER-TEST-PLAN'` did not
   yet exist and the old `'TESTPLAN-MARKER'`/`'PLAN-MARKER'` pair still
   overlapped. My fix repairs that false failure; there is no further
   red/green cycle to report for this case, only the before/after already
   quoted in the researcher's plan and now confirmed here.
3. **`w5` on both workflows** — "`$wf_name`: the implementer's prompt
   carries the plan and the checks and not the test plan". Moved into the
   loop, unchanged assertions. **Result: green** on both workflows; it was
   already passing on `loop.js` before this round (the markers don't overlap
   the other direction) and is now additionally exercised on
   `agile-loop.js`, also green.
4. **`w6` on both workflows** — "`$wf_name`: the reviewer's prompt carries
   the checks alone". Moved into the loop. **Result: green** on both.
5. **`w7` on both workflows** — "`$wf_name`: a question from the researcher
   ends the run at publish". Moved into the loop. **Result: green** on both.
6. **`w8` on both workflows, new** — "`$wf_name`: every step's prompt tells
   the agent to record its return and push the commit". Added a `case 'w8':`
   arm to `contextFor` (grouped with `w4`-`w6`, same clean-plan fixture), and
   a `mode === 'w8'` branch that walks every call whose label is neither
   `load-state` nor `publish` and asserts its prompt matches
   `/backlog\.json/` and `/\brecord\b/i`, and separately `/\bpush\b/i`.
   **Result: green** on both `loop.js` and `agile-loop.js` as the scripts
   stand — six labels covered on each (`decompose`, `research:i1.0`,
   `tests:i1.0`, `implement:i1.0`, `review:i1.0`, and `close:i1` /
   `replan:i1`). I did not delete `, then push the commit` from either
   script to hand-verify the red side, since that would be editing
   production code; the plan's own claim (Finding 3's reproduction) is that
   deleting it leaves the old grep-based guard green and this new case is
   what would go red instead — I trust that reproduction rather than
   re-deriving it by touching code I may not touch.
7. **`w3`'s fixture carries a shed run step** — `doneBacklog()`'s `decompose`
   entry now has only `label` and `at`, no `return` key; the close entry is
   unchanged. The `w3` assertion itself (`['load-state', 'publish']`) is
   untouched. **Result: green** on both workflows — a `Map` entry set to
   `undefined` still answers `has()` true, so the shed of Finding 5 does not
   break resume, confirmed against the real scripts as they stand today.

### B. `test-repo.sh` — the word guard

8. **"no prompt, agent page or skill still says handoff, in any spelling"**
   → new block right after the existing name-level guard (same file,
   `=== the run state is the channel...` section), `grep -rniE 'hand-?off'`
   over `workflows/*.js agents/*.md skills/*/SKILL.md rulebook.md README.md`,
   empty required. **Result: red**, exactly as the plan predicted:

   ```
   FAIL — these lines still say handoff:
          /home/user/uroboros/agents/planner.md:55:this run will never do. Say in your handoff which criterion went where.
   ```

   This is the one genuinely unimplemented fix left in this round — Finding
   2's defect, which lands in production text (`agents/planner.md`), not in
   a test file.

### C. `test-repo.sh` — the push-guard loop

9. **The loop keeps `SKILL.md` alone, tightened to `grep -q 'push the
   commit'`**, and drops `loop.js`/`agile-loop.js` (now covered
   behaviourally by `w8` above). **Result: green** —
   `skills/agent-brief/SKILL.md` already reads "push the commit" from the
   prior round's build.

### D. `skills/agent-brief/assets/backlog.test.mjs`

Run with `node --test skills/agent-brief/assets/backlog.test.mjs`. Added
after the existing close cases, before "close with a status outside
done|blocked|dropped exits 1 and leaves the file untouched".

10. **"close sheds the returns of the run's own steps and keeps their
    labels"** → `init` with `i1`/`i2`, `record - decompose` with a payload
    carrying `summary: 'MARKER-RUN-STEP-RETURN'`, `record i1 research:i1.0`,
    `close i1 done`. **Result: red**:

    ```
    not ok 9 - close sheds the returns of the run's own steps and keeps their labels
    error: |-
      the shed run step carries no return key at all
      true !== false
    code: 'ERR_ASSERTION'
    expected: false
    actual: true
    ```

    `close()` today never touches `run.steps`, so the `return` key survives
    — exactly Finding 5's claim. The `length`, `label` and `at` assertions
    ahead of it in the test all pass first (nothing shrinks `run.steps` yet
    because only `decompose` was ever recorded at run level in this fixture),
    so the failure lands precisely on the missing-key assertion, the one the
    plan named.
11. **"closing a second increment leaves the already-shed run steps shed"**
    → same setup, `close i1 done`, `record i2 research:i2.0`,
    `close i2 done`. **Result: red**, same cause:

    ```
    not ok 10 - closing a second increment leaves the already-shed run steps shed
    error: |-
      the run step shed by the first close stays shed after the second
      true !== false
    ```
12. **"close on a backlog that carries no run key exits 0 and writes the
    status"** → a hand-written `backlog.json` with no `run` key, then
    `close i1 done`. **Result: green**, as the plan predicted ("the old
    `close` never looks at `run`"): exit 0, stdout `closed i1 as done`,
    `increments[0].status === 'done'`. This case guards the fix's own crash
    risk rather than proving anything unimplemented; it is reported here
    green on arrival, not as a proof.

Full run: `node --test skills/agent-brief/assets/backlog.test.mjs` →
`# tests 15`, `# pass 13`, `# fail 2` — the two failures are cases 10 and 11
above, exactly as the researcher's "What is already red" predicted.

Full run: `bash test-repo.sh` → `FAIL: 1 of 42 cases` — the one failure is
case 8 above (`agents/planner.md:55`). Every other case, old and new, is
green: 41 of 42. This matches the researcher's own sanity figure ("around 42
cases") exactly.

### Every case from the plan is written; none was skipped

Cases 1-12 are all present, in the two files and the two commands the plan
names. Nothing in `workflows/loop.js` or `workflows/agile-loop.js` was
opened or edited — the plan said this round changes neither, and my own
cases 1-9 prove that boundary indirectly: they run the two scripts unchanged
and still turn green wherever the plan predicted green.

### Gaps and conflicts found in the test plan

None. Every case in the Round 1 plan pinned a concrete file, a concrete
assertion and a concrete expected result, and every one of my observed
results (red or green) matched what the plan predicted in its "What proves
each finding" and "What is already red" sections — I found no vague case to
push into `openQuestions` and no case that contradicted the criterion it
claimed to cover.

### Environment

`node --version` → `v22.22.2`. Both commands were run from the repository
root. `bash test-repo.sh` needs no setup beyond `git`, `node` and `mktemp`,
all present. `node --test
skills/agent-brief/assets/backlog.test.mjs` needs no setup either. Neither
`./test.sh` nor the bare-directory `node --test skills/agent-brief/assets/`
form was run — the plan's "What counts as done" for this round names `bash
test-repo.sh` and `bash test.sh` as the implementer's and the judgment's
commands, not mine; `node --test
skills/agent-brief/assets/backlog.test.mjs` is named only as the command to
write cases 10-12 against, which is what I used it for.
