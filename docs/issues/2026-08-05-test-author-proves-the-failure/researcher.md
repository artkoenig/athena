# Researcher handoff — the test-author must prove why a test fails

## Summary

Prose change to exactly one file: `agents/test-author.md`. Its step 4 already
says every test must fail "because the behaviour is missing — not an import
error, not a typo", but it asks only that the failure be *quoted*. Five things
are missing: the runner's **actual output** in the handoff, the test-author
**naming** which kind of failure it saw, the **wrong-expectation** case (an
expected value that differs from the actual only in formatting), **who repairs**
a test that failed for the wrong reason, and what happens to a failure the
test-author **cannot explain**. This change closes all five inside the shape the
page already has: one rewritten step, one added clause on an existing boundary
bullet, one extended sentence in the handoff section. No new step, no new
section, no checklist.

No tests are written for this issue — see "Test plan" for why, and for the one
command that judges the work.

## Module map

- **`/home/user/uroboros/agents/test-author.md` — the only file this change
  touches.** Structure at the current tip (`1a409bc`), by line:
  - 1–6: frontmatter — `name: test-author`, a long one-paragraph
    `description`, `tools: Read, Write, Edit, Bash`, `color: green`. **Not
    touched.**
  - 8–10: opening paragraph ("Turn the researcher's test plan into failing
    tests…"). **Not touched.**
  - 12–37: `## How you work`, four numbered steps. Each step is a bold
    imperative heading followed by two to five plain sentences. Step 4,
    **"Prove the failures."** (lines 33–37), is what Edit 1 rewrites.
  - 39–42: the correction-round paragraph. **Not touched.**
  - 44–50: `## Boundaries`, three bullets. The second one (lines 47–48) gets
    one added sentence in Edit 2.
  - 52–63: `## Your handoff`. The sentence at lines 55–57 and the one at 57–58
    get extended in Edit 3.
  - House style of this file: hard wrap at ~78 columns, em dashes, backticks
    around file names and commands, no tables, no checklists, no trailing
    whitespace, one blank line between blocks.
- `/home/user/uroboros/agents/implementer.md` — read, **not changed**. Its step
  3 ("Run the tests first — they are not yours") has the implementer confirm the
  tests "fail for the right reason before you change anything", forbids it to
  edit or write a test, and turns a test it believes wrong into a note for the
  reviewer. All still true: the test-author's repair happens one role earlier,
  before the implementer runs at all. No contradiction, no edit.
- `/home/user/uroboros/agents/reviewer.md` — read, **not changed**. It makes no
  claim about who fixes a broken test. It says a red run this change caused is
  its first finding, and that it never writes a test itself. The issue's "Out of
  scope" keeps that as it is.
- `/home/user/uroboros/agents/researcher.md` — read, **not changed**. It owns
  whether/what/how to test and the closed command list; nothing here touches
  that ownership.
- `/home/user/uroboros/README.md` (lines 34–66) — read, **not changed**. It says
  the test-author "turns the planned cases into failing tests" and "writes those
  cases and no others". Repairing a wrong expected value inside a case the plan
  asked for is still that case, still red, so nothing there goes stale.
- `/home/user/uroboros/.claude/rules/agents.md` — read, **not changed**. It
  governs page structure, frontmatter fields and the `plugin.json` agent list;
  none of those move. Its line 46 ("a test-author that has never seen an
  implementation") stays true — the test-author still reads no production code.
- `/home/user/uroboros/.claude/workflows/uroboros-loop.js` (lines 143–162) —
  read, **not changed**. It hands the test-author only the issue directory, the
  work order ("the Test Plan section of researcher.md") and the handoff path. No
  claim this change contradicts.
- `/home/user/uroboros/skills/grill/SKILL.md` (line 34) — read, **not
  changed**. Mentions the test-author only in passing ("an edge left undecided
  comes back as a blocked `test-author`"), which this change reinforces.
- `/home/user/uroboros/CLAUDE.md` (line 27) — read, **not changed**. Names the
  four agents the loop runs; nothing about failure reasons.
- `/home/user/uroboros/.claude/rules/checks.md` — read, **not changed**. It is
  the standing record of what this repository checks itself with, and the source
  of the "prose is not covered" fact used in the test plan.

**Criterion 6 is met by confinement, and this paragraph is the record of the
check it asks for:** I grepped the whole repository for `test-author` and read
every page that names it (the list above). None makes a claim this change
contradicts, so no second file is edited.

## Environment

- **The whole suite: `bash test.sh`**, run from the repository root.
  - The scripts are tracked **non-executable**, so `./test.sh` fails with
    "Permission denied". That is not a broken checkout, and nothing gets
    `chmod`-ed. Criterion 7 writes it as `./test.sh`; the command that actually
    runs it is `bash test.sh`.
  - It chains six suites: `test-repo.sh`, `test-plugin.sh`, `test-worktree.sh`,
    and `npm test` in `tools/argus`, `tools/argus-ui`, `tools/log-parser`. It
    prints `PASS: all 6 suites` and exits 0 when all pass.
  - Prerequisites: `node` and `npm` on PATH; the `claude` CLI on PATH, because
    `test-plugin.sh` calls `claude plugin validate`; `git`. No install step —
    the JS tools are zero-dependency, so no `npm install` first.
  - Runtime on this checkout: a few seconds.
- **There is no linter and no formatter** in this repository — no ESLint, no
  Prettier, no markdownlint, no editorconfig, no `lint` script, no type-checker.
  Do not go looking for a second tool. Markdown wrapping is done by hand at ~78
  columns; match the surrounding lines by eye.

That is every command this handoff asks anyone to run.

## Implementation plan

Three edits, all in `/home/user/uroboros/agents/test-author.md`. The wording
below is the intended result. Keep it as written unless a sentence reads badly
against its neighbours; then change the sentence, not the substance. Wrap at ~78
columns, no trailing whitespace, and leave every other line of the file exactly
as it is.

### Edit 1 — rewrite step 4 under `## How you work` (lines 33–37)

Replace this, in full:

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
   naming the kind of failure it is. Only one kind counts: the behaviour is
   missing. A test that never reached its assertion proves nothing — an import
   that does not resolve, a typo, a missing fixture, a helper that throws. Nor
   does a wrong expectation: when expected and actual differ only in formatting
   — a separator, a locale, whitespace, ordering — your assertion is failing,
   not the feature. Both are yours to repair before you return: fix the test,
   run it again, and report the failure it ends on. A failure you cannot
   explain is an open question in your handoff, with the output you got, not a
   test reported as proven. The suite and the linter are not yours to run; the
   implementer runs what the plan lists once the code exists.
```

Why one step and not a new one: the page has four steps of two to five
sentences each, and the frugality lesson recorded in commit `134eb30` is that
every added paragraph is paid in the base context of every run. Evidence,
taxonomy, repair and open question are one duty — prove it, and if it is not
proof, deal with it — so they stay in the step that already carries the first
half. **Do not add a step 5**, and do not promote any of this to a new section.

What each sentence is doing, so nothing is dropped if the wording gets polished:

- "put the runner's actual output in your handoff, naming the kind of failure
  it is" — criterion 1. Both halves matter: the output *and* the naming. "It was
  red" is not the output.
- "Only one kind counts: the behaviour is missing." — the right reason, stated
  positively, which is what makes the rest a closed set of wrong ones.
- "never reached its assertion — an import that does not resolve, a typo, a
  missing fixture, a helper that throws" — criterion 2, the setup-level wrong
  reasons.
- "when expected and actual differ only in formatting — a separator, a locale,
  whitespace, ordering — your assertion is failing, not the feature" —
  criterion 2's explicitly named case. **Keep all four examples**; the criterion
  names them.
- "Both are yours to repair before you return: fix the test, run it again, and
  report the failure it ends on." — criterion 3, including the re-run and that
  it happens before returning rather than at review time.
- "A failure you cannot explain is an open question in your handoff, with the
  output you got, not a test reported as proven." — criterion 4, including that
  the test is still committed; what is forbidden is calling it proven.
- The last sentence is unchanged from the current text and stays last.

### Edit 2 — add one clause to the second boundary bullet (lines 47–48)

Replace:

```
- You never make a test pass. The implementer does that, and may not edit what
  you wrote.
```

with:

```
- You never make a test pass. The implementer does that, and may not edit what
  you wrote. Repairing your own broken assertion is not making it pass — it
  stays red, for the right reason.
```

Without this the page argues with itself: step 4 tells the test-author to fix
its own test, and the boundary reads as a flat ban on touching a test once
written. The clause is in the same file, so criterion 6 still holds.

### Edit 3 — extend two clauses in `## Your handoff` (lines 55–58)

Replace:

```
commit it with the tests. Walk the test plan case by case: which test file and
test name each case became, its failure output, and for anything you did not
write, which case it was and why. Every gap and conflict you found in the plan
belongs here too — that is where the researcher picks them up.
```

with:

```
commit it with the tests. Walk the test plan case by case: which test file and
test name each case became, the output its run printed and which kind of
failure that is, and for anything you did not write, which case it was and why.
Every gap and conflict you found in the plan belongs here too, and every failure
you could not explain — that is where the researcher picks them up.
```

This is what makes criterion 1 binding on the artefact the implementer actually
reads, and it gives criterion 4's open question a named home.

### What not to do

- **Do not touch the frontmatter.** The `description` is still accurate, and
  prose no criterion asked for is a finding under the reviewer's check 2.
- **Do not add a checklist, a table, a template, a new heading or a step 5.**
  Criterion 5 rules out new machinery, and the page has none today.
- **Do not edit any other file** — not `implementer.md`, not `reviewer.md`, not
  the README, not the rulebook. Every page naming the test-author was checked
  (module map); none contradicts.
- **Do not touch anything under `docs/issues/`** beyond your own handoff file.
- **Do not `chmod` the test scripts.** They are tracked non-executable on
  purpose.

### Rejected alternatives

- **A fifth step, "Repair what failed wrongly".** Rejected: it adds a paragraph
  to the base context of every test-author run for a duty that belongs to the
  step that already demands the proof, and commit `134eb30` records that this
  repository pays for added paragraphs and does not get behaviour back for them.
- **A handoff template or a table of test / output / failure kind.** Rejected
  by criterion 5 — no checklist the agent fills in mechanically — and no other
  agent page in this repository uses one.
- **A test in `test-repo.sh` grepping `agents/test-author.md` for the new
  words.** Rejected; see the test plan. It would pin the phrasing rather than
  the rule and go stale on the next rewording, and `.claude/rules/checks.md`
  already settles that prose is not covered here.
- **Also amending `implementer.md` so it knows the test-author may have
  repaired a test.** Rejected: the implementer's contract ("run them, confirm
  the right reason, do not edit them") is unchanged by this, so the edit would
  be prose no criterion asked for.

## Test plan

- **Whether: no tests.** Nothing in this change can be checked by a tool. Every
  criterion, 1 through 6, is a statement about the text of an agent page, and
  `.claude/rules/checks.md` states the standing fact: "Prose is not covered. No
  suite reads the body of an agent page, a rulebook or the README. A change
  confined to prose has no test to write, and saying so is a finished answer,
  not a gap." I confirmed it against the suites themselves: `test-repo.sh`
  checks cross-file repository facts, `test-plugin.sh` checks both manifests,
  the declared agent file list, frontmatter presence, the SessionStart hook and
  the push guard, `test-worktree.sh` checks worktree copying, and the three `npm
  test` suites cover the JS tools; none of them reads a step of an agent page.
  The issue anticipates this and asks me to say so rather than invent a test.
  **No test-author round is needed for this issue.**
- **What: nothing.** Criteria 1–6 are deliberately untested, by the rule above.
  Criterion 7 is the existing suite, which is already the command below.
- **How: not applicable.** No test file, no framework, no single-file command.
- **What counts as done — the closed list, run from the repository root:**

  ```
  bash test.sh
  ```

  That is the whole list. Closed means closed: nobody downstream runs anything
  else — there is no linter and no formatter, and no other command reaches what
  this change touches. Criterion 7 is exactly this command exiting 0.
- **What is already red: nothing.** I ran `bash test.sh` on this checkout
  (branch `claude/offene-issues-f39bb5`, tip `1a409bc`) and it ended `PASS: all
  6 suites`, exit 0. Any red afterwards belongs to this change.

## Acceptance criteria, mapped

1. Actual failure output plus the kind of failure, for every test → Edit 1,
   sentence 1; Edit 3, first clause.
2. The wrong kinds named, formatting mismatch among them → Edit 1, sentences 3
   and 4 (separator, locale, whitespace, ordering).
3. The test-author fixes its own test and re-runs before returning → Edit 1,
   sentence 5; Edit 2 keeps the boundary from contradicting it.
4. An unexplained failure is an open question, not a test committed as fine →
   Edit 1, sentence 6; Edit 3, last clause.
5. Voice: short, plain, no new machinery, no mechanical checklist → prose only,
   inside the existing step and bullet shape; no new step, no new section.
6. Confined to `agents/test-author.md` → every page naming the test-author was
   read (module map), none contradicts, no other page is edited, and the record
   of that check is in this handoff.
7. `bash test.sh` green → the only command that counts; green before the change
   at `1a409bc`.
