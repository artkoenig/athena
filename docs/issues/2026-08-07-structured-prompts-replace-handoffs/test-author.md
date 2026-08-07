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
