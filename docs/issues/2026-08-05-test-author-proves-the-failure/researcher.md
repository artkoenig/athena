# Researcher handoff — the test-author must prove why a test fails

## Summary

This is a prose change to exactly one file: `agents/test-author.md`. Its step 4
already demands that every test fail "because the behaviour is missing — not an
import error, not a typo", but it only asks for the failure to be *quoted*. It
never says the handoff must carry the runner's **actual output**, never asks the
test-author to **name** which kind of failure it saw, never names the
wrong-value case (an assertion that differs from the actual only in
formatting), never says **who repairs** a test that failed for the wrong reason,
and never says what to do with a failure the test-author **cannot explain**.
This change closes those five holes inside the page's existing shape: one
rewritten step, one qualified boundary bullet, one extended sentence in the
handoff section. No new section, no checklist, no new step number.

No production code and no tests are written for this issue. See "Test plan" for
why, and for the single command that judges the work.

## Module map

- **`/home/user/uroboros/agents/test-author.md` — the only file this change
  touches.** Structure as it stands (line numbers are from the current tip):
  - lines 1–6: frontmatter — `name: test-author`, a long `description`,
    `tools: Read, Write, Edit, Bash`, `color: green`. **Not touched.**
  - lines 8–10: the opening paragraph ("Turn the researcher's test plan into
    failing tests…"). **Not touched.**
  - lines 12–37: `## How you work`, four numbered steps. Each step is a bold
    imperative heading followed by two to five plain sentences. Step 4,
    **"Prove the failures."** (lines 33–37), is the one this change rewrites.
  - lines 39–42: the correction-round paragraph. **Not touched.**
  - lines 44–50: `## Boundaries`, three bullets. The second one — "You never
    make a test pass." (lines 47–48) — gets one added clause.
  - lines 52–63: `## Your handoff`. One sentence in it (lines 57–59) gets
    extended.
  - House style of the file: hard wrap at ~78 columns, em dashes, no trailing
    whitespace, no checklists or tables anywhere, backticks around file names
    and commands.
- `/home/user/uroboros/agents/implementer.md` — read, **not changed**. Its step
  3 ("Run the tests first — they are not yours") says the implementer confirms
  the tests "fail for the right reason before you change anything", "may not
  edit a test and may not write one", and puts a test it believes wrong into
  its handoff as a note for the reviewer. All of that stays true: the
  test-author's repair happens one role earlier, before the implementer ever
  runs. No contradiction, so no edit.
- `/home/user/uroboros/agents/reviewer.md` — read, **not changed**. It makes no
  claim about who fixes a broken test; it only says a red run this change
  caused is its first finding, and that it never writes a test itself. The
  issue's "Out of scope" confirms this stays as it is.
- `/home/user/uroboros/agents/researcher.md` — read, **not changed**. It owns
  whether/what/how to test and the closed command list. Nothing here touches
  that ownership.
- `/home/user/uroboros/README.md` (lines 34–62) — read, **not changed**. It
  says the test-author "turns the planned cases into failing tests" and "writes
  those cases and no others". Repairing a wrong expected value in a case the
  plan asked for is still that same case, still red, so nothing there becomes
  false.
- `/home/user/uroboros/.claude/rules/agents.md` — read, **not changed**. It
  governs page structure, frontmatter and the `plugin.json` agent list; this
  change alters none of those. Its line 46 ("a test-author that has never seen
  an implementation") stays true — the test-author still reads no production
  code.
- `/home/user/uroboros/.claude/workflows/uroboros-loop.js` (lines 143–162) —
  read, **not changed**. It hands the test-author only the issue directory, the
  work order (`the Test Plan section of researcher.md`) and the handoff path. It
  makes no claim this change contradicts.
- `/home/user/uroboros/skills/grill/SKILL.md` (line 34) — read, **not
  changed**. It mentions the test-author only in passing ("an edge left
  undecided comes back as a blocked `test-author`"), which this change
  reinforces rather than contradicts.
- `/home/user/uroboros/.claude/rules/checks.md` — read, **not changed**. It is
  the page that already records what this repository checks itself with, and it
  is the source of the "prose is not covered" fact used in the test plan below.

**Criterion 6 is therefore satisfied by confinement:** every page that names the
test-author was read, none of them makes a claim this change contradicts, so no
second file is edited. That check and its result are recorded here, which is
what the criterion asks for.

## Environment

- **The whole suite:** `bash test.sh`, from the repository root.
  - The scripts are tracked **non-executable**, so `./test.sh` fails with
    "Permission denied". That is not a broken checkout — use `bash test.sh`,
    and do not `chmod` anything. (Criterion 7 writes it as `./test.sh`; the
    command that actually runs it is `bash test.sh`.)
  - It chains six suites: `test-repo.sh`, `test-plugin.sh`, `test-worktree.sh`,
    and `npm test` in `tools/argus`, `tools/argus-ui`, `tools/log-parser`.
  - Prerequisites: `node` and `npm` on PATH; the `claude` CLI on PATH, because
    `test-plugin.sh` calls `claude plugin validate`; `git`. No install step —
    the JS tools are zero-dependency, so no `npm install` is needed first.
  - Runtime on this checkout: well under a minute.
- **A single suite on its own:** `bash test-repo.sh`, `bash test-plugin.sh`,
  `bash test-worktree.sh`, `npm --prefix tools/argus test`,
  `npm --prefix tools/argus-ui test`, `npm --prefix tools/log-parser test`.
  Listed so nobody has to go looking; **none of them is relevant to this
  change**, and none of them is part of the closed list below.
- **Linter: there is none.** No ESLint, no markdownlint, no editorconfig, no
  `lint` script anywhere in the repository. Do not go looking for one.
- **Formatter: there is none.** Markdown wrapping in this repository is done by
  hand, at ~78 columns. Match the surrounding lines by eye.
- **What is already red: nothing.** I ran `bash test.sh` on the current
  checkout (branch `claude/offene-issues-f39bb5`, tip `01b501d`) and it ended
  `PASS: all 6 suites`. Any red afterwards belongs to this change.

## Implementation plan

Three edits, all in `/home/user/uroboros/agents/test-author.md`. The wording
below is the intended result. Keep it as written unless a sentence reads badly
against its neighbours; then change the sentence, not the substance. Wrap at ~78
columns, no trailing whitespace, and leave every other line of the file exactly
as it is.

### Edit 1 — rewrite step 4 under `## How you work` (lines 33–37)

Replace this, verbatim, in full:

```
4. **Prove the failures.** Run your own tests with the single-file command the
   plan names, and confirm each fails because the behaviour is missing — not an
   import error, not a typo. Quote the failure in your handoff. The suite and
   the linter are not yours to run; the implementer runs what the plan lists
   once the code exists.
```

with this:

```
4. **Prove the failures.** Run every test you wrote with the single-file
   command the plan names, and put the runner's actual output in your handoff,
   with the kind of failure it is. Only one kind counts: the behaviour is
   missing. A test that never reached its assertion proves nothing — an import
   that does not resolve, a typo, a missing fixture, a helper that throws — and
   neither does a wrong expectation: an actual and an expected that differ only
   in formatting, separators, locale, whitespace, ordering, is your assertion
   failing, not the feature. Those are yours to repair, now: fix the test, run
   it again, and report the failure it ends on. A failure you cannot explain is
   an open question in your handoff — committed with the output you got, not
   passed off as proven. The suite and the linter are not yours to run; the
   implementer runs what the plan lists once the code exists.
```

Why one step and not two: the page has four steps of two to five sentences
each, and the frugality lesson recorded in commit `134eb30` is that every added
paragraph is paid in the base context of every run. The evidence, the taxonomy,
the repair and the open question are one duty — "prove it, and if it is not
proof, deal with it" — so they stay in the step that already carries the first
half of it. Do **not** add a step 5.

Requirements this sentence-by-sentence covers, so nothing is dropped when the
wording is polished:

- "put the runner's actual output in your handoff, with the kind of failure it
  is" — criterion 1. Both halves matter: the output *and* the naming. "It was
  red" is not the output.
- "Only one kind counts: the behaviour is missing." — the right reason, stated
  positively.
- "never reached its assertion … import … typo … missing fixture … helper that
  throws" — criterion 2, the setup-level wrong reasons.
- "an actual and an expected that differ only in formatting, separators,
  locale, whitespace, ordering, is your assertion failing, not the feature" —
  criterion 2's explicitly named case. **Keep all four examples**; they are
  what the criterion names.
- "Those are yours to repair, now: fix the test, run it again, and report the
  failure it ends on." — criterion 3, including the re-run and that it happens
  before returning, not at review time.
- "A failure you cannot explain is an open question in your handoff — committed
  with the output you got, not passed off as proven." — criterion 4, including
  that the test is still committed; what is forbidden is calling it proven.

### Edit 2 — qualify the boundary bullet (lines 47–48)

Replace:

```
- You never make a test pass. The implementer does that, and may not edit what
  you wrote.
```

with:

```
- You never make a test pass. The implementer does that, and may not edit what
  you wrote. Repairing your own wrong assertion is not making it pass — it
  stays red, for the right reason.
```

Without this clause the page argues with itself: step 4 tells the test-author
to fix its own test, and the boundary reads as a flat ban on touching it once
written. The clause is inside the same file, so criterion 6 still holds.

### Edit 3 — extend two clauses in `## Your handoff` (lines 57–59)

Replace:

```
Walk the test plan case by case: which test file and test name each case
became, its failure output, and for anything you did not write, which case it
was and why. Every gap and conflict you found in the plan belongs here too —
that is where the researcher picks them up.
```

with:

```
Walk the test plan case by case: which test file and test name each case
became, the output its run printed and which kind of failure that is, and for
anything you did not write, which case it was and why. Every gap and conflict
you found in the plan belongs here too, and every failure you could not explain
— that is where the researcher picks them up.
```

This is what makes criterion 1 binding on the artefact the implementer actually
reads, and it gives criterion 4's open question a named home.

### What not to do

- **Do not touch the frontmatter.** The `description` is still accurate; prose
  no criterion asked for is a finding.
- **Do not add a checklist, a table, a template or a new section heading**, and
  do not add a step 5. Criterion 5 rules out new machinery, and the page has
  none today.
- **Do not edit any other file** — not `implementer.md`, not `reviewer.md`, not
  the README, not the rulebook. Every one of them was checked (module map);
  none contradicts.
- **Do not touch anything under `docs/issues/`** beyond your own handoff file.
- **Do not `chmod` the test scripts.** They are tracked non-executable on
  purpose.

## Test plan

- **Whether: no tests.** Nothing in this change can be checked by a tool.
  `.claude/rules/checks.md` states it as a standing fact of this repository:
  "Prose is not covered. No suite reads the body of an agent page, a rulebook
  or the README. A change confined to prose has no test to write, and saying so
  is a finished answer, not a gap." I confirmed it against the suites
  themselves: `test-repo.sh` checks licence claims and the deployment files,
  `test-plugin.sh` checks both manifests, the agent file list, frontmatter
  presence, the SessionStart hook and the push guard, `test-worktree.sh` checks
  worktree copying, and the three `npm test` suites cover the JS tools. None of
  them reads a step of an agent page, and a keyword assertion over this wording
  would pin the phrasing instead of the rule and go stale on the next edit. The
  issue anticipates exactly this and asks me to say so rather than invent a
  test; I say so. **No test-author round is needed for this issue.**
- **What: nothing.** Every acceptance criterion, 1 through 6, is a statement
  about the text of `agents/test-author.md`; criterion 7 is the suite, which
  exists already. Deliberately untested, in full, and by the rule above.
- **How: not applicable.** No test file, no framework, no single-file command.
- **What counts as done — the closed list, run from the repository root:**

  ```
  bash test.sh
  ```

  That is the whole list. Closed means closed: nobody downstream runs anything
  else — there is no linter and no formatter, and no other command reaches what
  this change touches. Criterion 7 is exactly this command being green.
- **What is already red: nothing.** `bash test.sh` at tip `01b501d` on branch
  `claude/offene-issues-f39bb5` ended `PASS: all 6 suites`. So a red run after
  the change belongs to the change.

## Acceptance criteria, mapped

1. Actual failure output plus the kind of failure, for every test → Edit 1,
   sentence 1; Edit 3, first clause.
2. The kinds that do not count, with the formatting mismatch named → Edit 1,
   sentences 3 and 4 (separators, locale, whitespace, ordering).
3. The test-author fixes its own test and re-runs before returning → Edit 1,
   sentence 5; Edit 2 keeps the boundary from contradicting it.
4. An unexplained failure is an open question, not a test committed as fine →
   Edit 1, sentence 6; Edit 3, last clause.
5. Voice: short, plain, no new machinery, no mechanical checklist → prose only,
   inside the existing step and bullet shape, no new step and no new section.
6. Confined to `agents/test-author.md` → every page naming the test-author was
   read (module map); none contradicts; no other page is edited, and this
   paragraph is the record of that check.
7. `bash test.sh` green → the only command that counts; green before the
   change at `01b501d`.
