# Reviewer handoff — Zwei Modi: Issue-Workflow oder direkte Arbeit

Round 1 (first fresh-context look). Reviewed: `git diff main...HEAD`, three
commits on `claude/zwei-modi-issue-workflow-2fnxb4` (`2156ff6`, `7ea7d99`,
`dc20b0e`).

## Review Status

**Approved with findings — none blocking.**

All six acceptance criteria are met by the text in `CLAUDE.md`. Nothing in the
diff is unasked-for code. The three findings below all sit *outside* the
acceptance criteria: they are documents in the repository that this change
makes stale or leaves in conflict with the new Direct Mode. Each carries a
concrete reproduction. None of them is a defect in the criteria themselves, so
none of them blocks the change; the caller decides whether to fix them here or
file them.

## 1. Facts, by exit code

One command, both runners chained:

```
bash test.sh; echo "suite $?"
```

- **`bash test.sh` — exit 0.** Final line: `PASS: all 6 suites`. The six suites
  test.sh chains are: `test-repo.sh` (the repository itself), `test-plugin.sh`
  (manifests, session-start hook, push guard), `test-worktree.sh` (parallel
  runs), and `npm test` for `tools/argus`, `tools/argus-ui`, `tools/log-parser`.
  Nothing was skipped or excluded; test.sh runs every suite unconditionally and
  counts failures. The tail of the output I read directly showed
  `tools/argus-ui` at 14 tests / 0 fail and `tools/log-parser` at 5 tests /
  0 fail; the earlier suites scrolled past, and their aggregate verdict is the
  `PASS: all 6 suites` line plus the exit code.
- **`bash test-plugin.sh` — exit 0, `PASS: 39 cases`.** Run separately because
  this is the suite that actually touches the changed file: `test-plugin.sh`
  copies the repository's `CLAUDE.md` into a scratch plugin root and asserts
  the whole text arrives verbatim in the SessionStart hook's
  `additionalContext` JSON (`test-plugin.sh:372-373`). That is the one
  mechanical check the changed file has, and it passes with the new text —
  including its straight double quotes around `"mach das direkt"` /
  `"leg ein Issue an"`, which pass through the hook's `json_body` escaping
  intact.

**Static analysis: there is none in this repository, and that is the fact, not
a skipped step.** How I looked: no root `package.json`, `Makefile` or
`pyproject.toml` (`ls` — all absent); no `.eslintrc*`, `eslint.config*` or
`.shellcheckrc` anywhere at the root; `grep -l '"lint"' tools/*/package.json`
exits 1 — no tool declares a lint script; `command -v shellcheck` finds
nothing installed. `test.sh` is the whole of the project's automated checking,
and it is what I ran.

**What the suite does and does not say about this change.** The diff touches no
executable code — one Markdown file outside the issue directory. A green suite
here proves only that the rulebook is still delivered verbatim and that nothing
else regressed; it cannot confirm that the two modes are described correctly.
That judgment is checks 2-4 below, and they carry this review.

## 2. The whole diff against the intent

Changed files (`git diff main...HEAD --stat`):

| File | Lines | Judgment |
| --- | --- | --- |
| `CLAUDE.md` | +25 / −3 | The change under review. Judged below. |
| `docs/issues/2026-08-05-zwei-modi/issue.md` | +17 | The issue file itself. In scope, correct. |
| `docs/issues/2026-08-05-zwei-modi/dispatcher.md` | +215 | Handoff of another agent — excluded from this review by my brief. |

No production code, no test file, no configuration file, no new file outside
`docs/issues/` was touched. `GEMINI.md` is a symlink to `CLAUDE.md`, so it
picks the change up with no edit — verified with `readlink`.

### Criterion by criterion

**Criterion 1 — the rulebook describes both modes. MET.**
`CLAUDE.md:17-21` introduces both by name (**Issue Mode**, **Direct Mode**),
`CLAUDE.md:27-42` is the Issue Mode section, `CLAUDE.md:44-52` the Direct Mode
section. The criterion names `CLAUDE.md` and "`.claude/rules/` where needed";
`.claude/rules/agents.md` is path-scoped to `agents/**` and is about writing
agent pages, so it is not where a main-session rule belongs. Leaving it
untouched is right.

**Criterion 2 — the mode is settled at the start of a task; no question when
the human already named it. MET.**
`CLAUDE.md:18-21`: "The human names it — 'mach das direkt', 'leg ein Issue an'
— and then it stands. If they did not, ask once, in one line, and say which one
you would take; that is a question, not a fourth steering point, and unanswered
it falls to Issue Mode." That covers all three of the issue's recorded
defaults: asked once per task rather than per message ("ask once", together
with "the next task settles it again" at line 23-24); no question when the
human named the mode ("and then it stands"); Issue Mode when there is no
statement and no answer ("unanswered it falls to Issue Mode"). The clause "not
a fourth steering point" is a deliberate reconciliation with `CLAUDE.md:56`
("Three steering points, nothing else") — the change anticipated that conflict
instead of creating one.

**Criterion 3 — Issue Mode unchanged. MET, verified line by line.**
I diffed the block against `git show main:CLAUDE.md`. The four numbered
responsibilities (`CLAUDE.md:31-34`) and the five restriction bullets
(`CLAUDE.md:38-42`) are byte-identical to main with one exception: the trailing
space after "You do not modify production code or tests." on the *No Code
Changes* bullet was removed. That is whitespace only, no semantic change. The
two headings were renamed — `### Your Responsibilities` → `### Issue Mode`,
`### Your Restrictions` → `And what you do not do here:` — and one framing
sentence was added (`CLAUDE.md:29`, "The requirements are yours, the work is
the subagents'."). Renaming the headings is what the criterion requires, since
the restrictions must now read as Issue Mode's and not the session's. The
scoping is unambiguous: the bullets sit under the `### Issue Mode` heading and
are introduced by "And what you do not do here".

**Criterion 4 — Direct Mode. MET.**
`CLAUDE.md:46-49` grants all five of the criterion's verbs explicitly: "Read
the code, change the code and the tests, run them, commit, push." It denies the
ceremony explicitly: "No issue file, no dispatcher, no subagent is required."
`CLAUDE.md:51-52` keeps the broad-search delegation the criterion asked to
preserve: "Hand a broad search through the code to a subagent anyway; it comes
back as an answer instead of as a hundred files in your context."

**Criterion 5 — mode per task, escalation announced. MET.**
`CLAUDE.md:23-25`: "The mode belongs to the task, not to the session — the next
task settles it again. A direct task that turns out bigger than it looked moves
to Issue Mode; say so when it moves." Both halves of the criterion — per task,
and announce the switch — are there.

**Criterion 6 — short, in the rulebook's language, no new machinery. MET.**
22 lines of new prose, English like the rest of the page, the two German mode
phrases quoted because they are the human's own words (and the page already
mixes them in, `CLAUDE.md:64`). No new file, no flag, no configuration key —
the diff stat proves it: the only non-issue file touched is `CLAUDE.md`.

### Anything in the diff no criterion asked for

One sentence: `CLAUDE.md:48-49`, "Push to a branch — the default branch still
advances only through a merged pull request." No criterion asked for it. I
judge it in scope rather than a finding, because criterion 4 grants a power
("pushen") that had never applied to the main session before, and this is the
boundary of that power; it is factually correct (`.githooks/pre-push` refuses
`refs/heads/main` and `refs/heads/master`, and `test-plugin.sh` proves it with
"a push to main is refused" against a real scratch repository). It does restate
what `CLAUDE.md:60` already says as steering point 3 — see Observation O1.

## 3. The tests against the intent

**There are no tests for this change, and none of the repository's existing
suites would fail if the two-modes text were deleted.** I checked this rather
than assumed it: the only assertion any suite makes about `CLAUDE.md` is
`test-plugin.sh:372-373`, which compares the delivered `additionalContext`
against whatever `CLAUDE.md` currently says — it is a transport check, not a
content check, so it passes for any text at all. `test-repo.sh` asserts licence
consistency and the deployment shape, nothing about the rulebook's prose.

For a rulebook prose change that is defensible: there is no behaviour to run.
Check 2 therefore carries the review, and I have taken it line by line above.

Worth naming for the caller's triage, not as a demand: `test-repo.sh` already
owns exactly this *class* of check. Its licence cases exist because "three of
them said Apache 2.0 over a GPL-3 LICENSE file, each drifting on its own,
because nothing compared them" (`test-repo.sh:16-18`). Findings F1-F3 below are
the same failure mode — one rule stated in two documents that now disagree —
and `test-repo.sh` is where a case comparing them would belong if the caller
wants the drift caught mechanically rather than by the next reader.

## 4. Beyond the criteria — blast radius

I traced every document in the repository that speaks about the main session,
about git, or about who reviews whose work:
`grep -rn "Main Session\|main session\|Hauptsession"` over all `*.md`, `*.sh`
and `*.json` outside `.git` and `docs/issues/` returns exactly four places —
`CLAUDE.md` itself, `agents/dispatcher.md:3,28`, and `skills/grill/SKILL.md:20,43`.
I read all of them, plus `README.md`, `hooks/CLAUDE.md`, `.claude/rules/agents.md`,
`skills/retro/SKILL.md`, `skills/CLAUDE.md`, `.githooks/pre-push` and
`hooks/session-start.sh`.

Clean, checked, nothing found:

- `agents/dispatcher.md:28` — "hand back to the main session to complete the
  task". Unaffected: the dispatcher only exists on the Issue Mode path, which
  is unchanged.
- `README.md:37-38` — "The rules themselves are one page, `CLAUDE.md` — short
  enough to read end to end if you want the specifics; this page won't repeat
  it." The README deliberately does not restate the main session's rules, so
  the mode split does not make that part stale. (One other README passage does
  — F3.)
- `hooks/session-start.sh` / `hooks/CLAUDE.md` — the hook ships whatever
  `CLAUDE.md` holds; +22 lines change nothing about its behaviour, and
  `test-plugin.sh` proves the new text survives the JSON encoding.
- `.claude/rules/agents.md` — scoped to `agents/**`, about how agent pages are
  written. Nothing in it depends on which mode a task runs in.
- `.githooks/pre-push` — the new Direct Mode push permission does not weaken
  the guard; the guard is what makes `CLAUDE.md:48-49` true.
- `docs/agents/issue-tracker.md` — describes a `tracker.py` state machine that
  does not exist in this repository. Stale, but stale on `main` too; this
  change neither touches it nor worsens it. Not a finding.
- `skills/grill/SKILL.md:44` — hands over to a `researcher` subagent that does
  not exist (`agents/` holds dispatcher, implementer, reviewer, test-author).
  Also pre-existing on `main`, also not this change's doing. Not a finding.

Three things this change *does* leave in conflict:

---

### F1 — Direct Mode leaves the retro with no place to land (medium; violates no acceptance criterion)

**Where.** `CLAUDE.md:44-49` (Direct Mode: "No issue file, no dispatcher, no
subagent is required") against `skills/retro/SKILL.md:3` and
`skills/retro/SKILL.md:46-47`, and against `CLAUDE.md:4`.

**Reproduction.** Human says "mach das direkt" and asks for a small fix. The
session works in Direct Mode, and during the task a rule on `CLAUDE.md` and its
own judgment conflict. `CLAUDE.md:4` requires: "When the two conflict, this
page wins — say so in the retro." The retro skill's only defined output target
is the active issue document: its own description says it appends "to the
active issue document (`docs/issues/<timestamp>-<slug>/issue.md`)", and step 4
says "Append the formatted Retrospective section directly under the `## Retro`
heading in the active issue document". A Direct Mode task has no issue
document, by criterion 4's own design.

**Expected vs actual.** Expected: the session has one defined place to record
the conflict. Actual: no target exists, and the session must pick between two
rules it cannot both keep — create an issue directory anyway (contradicting
`CLAUDE.md:47`, "No issue file", and criterion 4) or drop the retro
(contradicting `CLAUDE.md:4`). This is the mechanism the README calls the
project's self-improvement loop (`README.md:30-35`), so silently dropping it
for every Direct Mode task is a real loss, not a formality.

**Not a criterion violation.** No acceptance criterion mentions the retro. This
is blast radius: the change creates a task shape the retro skill was never
written for. Resolutions the caller might pick from — one sentence in Direct
Mode naming where a retro goes without an issue (or that a direct task has
none), or a line in `skills/retro/SKILL.md` for the no-issue case. I am not
prescribing which.

---

### F2 — `skills/grill/SKILL.md` states the old restrictions as unconditional facts about the main session (low-medium; violates no acceptance criterion)

**Where.** `skills/grill/SKILL.md:20` — "The main session does NO research of
its own in the codebase. You do not read the code or the documentation
yourself" — and `skills/grill/SKILL.md:43` — "Do NOT use git to commit this
issue file. The main session does no git operations." Against `CLAUDE.md:46-48`,
which grants the main session exactly those two powers in Direct Mode.

**Reproduction.** One session, two tasks — which the change explicitly allows,
`CLAUDE.md:23` ("The mode belongs to the task, not to the session"). Task 1: a
vague idea, Issue Mode, the session invokes the `grill` skill; the skill page
is now in the session's context in full, including the sentence "The main
session does no git operations." Task 2, same session: the human says "mach das
direkt". `CLAUDE.md:46-47` now requires the session to read the code and to
commit and push. The loaded skill text says, without any condition attached,
that the main session does neither.

**Expected vs actual.** Expected: a session holding both texts reads one
consistent rule. Actual: it holds a direct contradiction. It is resolvable —
`CLAUDE.md:4` says the rulebook wins — but resolvable-by-precedence is exactly
the drift `skills/CLAUDE.md` forbids for skill pages: "Describe each thing
once. Where another page owns a rule, point at the owner instead of restating
it — two descriptions of one rule drift apart." The grill page restated a rule
`CLAUDE.md` owns, and this change is the moment they drifted.

**Why it is not a criterion violation.** Criterion 1 names `CLAUDE.md` and
`.claude/rules/`; `skills/` is outside what it asked for. Note also that the
statements remain *true in effect* wherever grill actually runs — grill's
output is a filed issue, so grilling implies Issue Mode. The defect is the
unconditional wording carried into a session that later switches mode, not a
wrong instruction inside grill's own procedure. That is why I rate it below F1.

---

### F3 — `README.md` still says uroboros keeps process for precisely what Direct Mode now drops (low-medium; violates no acceptance criterion)

**Where.** `README.md:15-20` against `CLAUDE.md:46-49`.

**Reproduction.** A reader (or an agent) evaluating what uroboros guarantees
reads `README.md:16-20`: uroboros "gives the agent the run and asks it to decide
how much planning a change needs, how to slice it, which tools to reach for —
and keeps process only for the handful of things a model can't reliably judge
about its own work, **like grading its own tests or reviewing a diff it just
wrote**." Then a Direct Mode task runs: `CLAUDE.md:46-48` lets one session
write the implementation, write the tests, run them, and push, with "no
subagent is required" — that is one agent grading its own tests and shipping a
diff nobody else reviewed, which is the exact pair of examples the README names
as the two things process is kept for.

**Expected vs actual.** Expected: the README's claim about where process is
kept holds for every task shape the rulebook allows. Actual: it holds only for
Issue Mode tasks, and the README says so nowhere. The README is the project's
outward-facing description, so this is the statement most likely to be read by
someone who never opens `CLAUDE.md`.

**Not a criterion violation.** Criterion 4 grants tests and no-subagents
deliberately, and criterion 6 forbids new machinery — so *narrowing* Direct
Mode is not obviously the right fix. The honest options are a qualifier in the
README ("except a direct task, which the human sized as small") or an explicit
bound in Direct Mode. `CLAUDE.md:46` already carries an implicit bound — "Small
or obvious work" — but the README's claim is unconditional and was not updated.
Caller's call.

---

## Observations (checked, deliberately not findings)

- **O1 — one restated rule in the new text.** `CLAUDE.md:48-49` ("the default
  branch still advances only through a merged pull request") says the same
  thing as `CLAUDE.md:60` ("They merge the pull request") and as
  `.githooks/pre-push`. Three statements of one rule is the drift pattern F2 is
  about. I do not raise it as a finding because the sentence is the boundary of
  a power criterion 4 newly grants and is worth stating where that power is
  granted — but if the caller is trimming, this is the sentence with the least
  new information in the diff.
- **O2 — "ask once" is momentarily ambiguous.** Read alone, `CLAUDE.md:20`
  ("ask once") could mean once per session. Lines 23-24 ("the next task settles
  it again") resolve it to once per task, which is what criterion 2 wants. I
  can construct no reading where a session gets the timing wrong after reading
  both, so this is not a finding.
- **O3 — no reviewer for a Direct Mode task, by design.** Criterion 4 says so
  outright. I note it only so the record shows I considered it and did not
  treat it as an unasked-for gap; F3 is the part of it that is actually
  actionable, because a document contradicts it.

## Commands run, in full

```
git log --oneline main..HEAD                   # 3 commits
git status --short                             # clean
git diff main...HEAD --stat                    # 3 files, +257/-3
git diff main...HEAD -- CLAUDE.md              # the change, read in full
git show main:CLAUDE.md                        # the before-state, line-by-line comparison
bash test.sh                                   # exit 0 — PASS: all 6 suites
bash test-plugin.sh                            # exit 0 — PASS: 39 cases
grep -rn "Main Session\|main session\|Hauptsession" ...   # blast radius
grep -l '"lint"' tools/*/package.json          # exit 1 — no lint script anywhere
command -v shellcheck                          # not installed
```

Nothing I ran wrote to the checkout. The only file I created is this handoff.
