# Researcher handoff — the test-author must prove why a test fails

## What the change is

A prose change to one file: `agents/test-author.md`. Step 4 of "How you work"
("Prove the failures") currently demands that the test-author confirm each test
fails for the right reason and "quote the failure" in the handoff. It never
defines what a wrong reason looks like, never says what to do when it finds
one, and never says what to do with a failure it cannot explain. The whole
change is to close those three gaps in that step, plus one word-level
alignment in the "Your handoff" section.

No production code, no script, no manifest, no other agent page. There is
nothing here a tool can check — see **Test plan** below — so this change ships
without a new test, which is the outcome the issue names as acceptable in its
"Assumptions taken as defaults" section.

## Module map

Files that this change touches:

- **`/home/user/uroboros/agents/test-author.md`** — the only file edited. 65
  lines. Structure: YAML frontmatter (lines 1–7: `name`, `description`,
  `tools: Read, Write, Edit, Bash`, `model: sonnet`, `color: green`), an
  opening paragraph (9–11), `## How you work` with four numbered steps (13–38),
  a paragraph on correction rounds (40–43), `## Boundaries` (45–51), and
  `## Your handoff` (53–64). The edit lands in step 4 (lines 34–38) and in one
  sentence of `## Your handoff` (lines 56–58). Frontmatter is not touched.

Files that were checked and are **not** touched, with the reason:

- **`/home/user/uroboros/agents/implementer.md`** — step 3 says "Run them and
  confirm they fail for the right reason before you change anything." This is
  the same idea one station later and it does not contradict the new wording;
  it becomes the backstop for a wrong-reason failure that slipped through. It
  does not define "right reason" either, but tightening it is not in this
  issue's scope and would spread one rule across two pages.
- **`/home/user/uroboros/agents/reviewer.md`** — check 3 judges the tests
  against the intent and reads no handoff. It makes no claim about how a
  failure is proved. The issue puts the reviewer's behaviour out of scope
  explicitly.
- **`/home/user/uroboros/agents/researcher.md`** — owns the test plan
  (whether/what/how/what counts as done/what is already red). It says nothing
  about how the test-author proves a failure.
- **`/home/user/uroboros/.claude/workflows/uroboros-loop.js`** — lines 142–147
  and 156–161 build the test-author's prompt. The prompt hands over the issue
  directory, points at the Test Plan section as the work order, and names the
  handoff path. It says nothing about failure proof, so nothing there
  contradicts the new text and nothing there needs to change.
- **`/home/user/uroboros/README.md`** — line 37 of the mermaid diagram and the
  paragraph at lines 56–59 describe the test-author as turning the planned
  cases into failing tests. Still true.
- **`/home/user/uroboros/.claude/rules/agents.md`** — path-scoped to
  `agents/**`, so it loads when this file is edited. It governs frontmatter and
  the "the page is the interface" principle. The change adds a duty to the
  page, which is exactly how that principle says a duty comes into existence.
  No edit needed.
- **`/home/user/uroboros/.claude/rules/docs.md`** — path-scoped to `docs/**`,
  so it does not formally bind `agents/test-author.md`. Its three rules (one
  instruction per sentence, imperative, state each rule once) are the house
  voice all the same and the wording below follows them.

**Conclusion for acceptance criterion 6:** no other page makes a claim this
contradicts, so the change stays confined to `agents/test-author.md`. That is
the recorded reason.

## Environment

- **Whole suite:** `bash test.sh` from the repository root
  (`/home/user/uroboros`). It runs six suites in order — `test-repo.sh`,
  `test-plugin.sh`, `test-worktree.sh`, and `npm test` in `tools/argus`,
  `tools/argus-ui`, `tools/log-parser` — and exits 0 only when all six pass.
  It takes a few minutes, mostly in `test-plugin.sh`, which shells out to the
  real `claude` CLI (`claude plugin validate`, `claude plugin marketplace add`,
  `claude plugin install`). The `claude` CLI is on the PATH in this
  environment; it is the one prerequisite the suite needs.
- **A single suite:** `bash test-repo.sh`, `bash test-plugin.sh`,
  `bash test-worktree.sh`, or `npm --prefix tools/argus test --silent`
  (likewise `tools/argus-ui`, `tools/log-parser`). The three Node packages are
  zero-dependency, so no `npm install` is needed first.
- **Linter:** there is none. No ESLint, Prettier, or EditorConfig file exists
  anywhere in the tree, and no package declares a `lint` script.
- **Formatter:** there is none. Markdown is hand-wrapped; see the style note
  below.
- **Git hook:** `.githooks/pre-push` refuses a push whose target is `main` or
  `master`. It is irrelevant to this change but will fire if anyone tries to
  push the default branch.

### What is already red

I ran `bash test.sh` twice on the current checkout, before any change. Result
both times: **exit 1 — "FAIL: 1 of 6 suite(s)"**. The failing suite is
`test-worktree.sh`, at one case:

```
=== what the plugin keeps doing inside a worktree
To /tmp/tmp.w6GGM2wBvM/remote.git
 ! [remote rejected] HEAD -> main (shallow update not allowed)
error: failed to push some refs to '/tmp/tmp.w6GGM2wBvM/remote.git'
  ok   — the guard set on the main checkout is in effect in the worktree
  ok   — a push to the default branch from inside a worktree is refused
  FAIL — a push to the run's own branch from inside a worktree succeeds
  ok   — the rulebook reaches a session whose project directory is a worktree
  ok   — the self-check reports the guard as set from inside a worktree

FAIL: 1 of 9 cases
```

The cause is the environment, not the repository: this checkout is a shallow
clone (`.git/shallow` exists, `git rev-parse --is-shallow-repository` prints
`true`), and git refuses to push from a shallow clone into the scratch remote
the test builds — "shallow update not allowed". The other five suites pass:
`test-repo.sh` 6 cases, `test-plugin.sh` 39 cases, and 23 + the two other Node
suites green.

**This failure is pre-existing and nobody's job in this run.** A prose edit to
an agent page cannot touch it. Acceptance criterion 7 ("`./test.sh` is green")
is therefore met by "the suite is exactly as green as it was before the
change, with the one shallow-clone failure recorded here" — report it with its
exit code, name it as pre-existing, and move on. Do not attempt to fix
`test-worktree.sh`, and do not unshallow the clone.

## Implementation plan

### Style constraints the wording must satisfy

- Body lines wrap at 80 columns. The longest existing body line in the file is
  81 characters; the file otherwise sits at 78–80. Match that.
- Imperative, second person, short sentences. No bullet list inside step 4 —
  the four numbered steps are prose paragraphs and a nested list would read as
  the mechanical checklist criterion 5 forbids.
- No new heading, no new section, no template, no table. The change is two
  edits inside text that already exists.
- The body is currently 527 words. The change adds roughly 90. That is
  proportionate; if a draft runs much past that, cut it rather than keeping
  two sentences that say the same thing.

### Edit 1 — step 4, "Prove the failures" (lines 34–38)

Replace the whole step. Current text:

```
4. **Prove the failures.** Run your own tests with the single-file command the
   plan names, and confirm each fails because the behaviour is missing — not an
   import error, not a typo. Quote the failure in your handoff. The suite and
   the linter are not yours to run; the implementer runs what the plan lists
   once the code exists.
```

Proposed replacement:

```
4. **Prove the failures.** Run your own tests with the single-file command the
   plan names, and confirm each fails because the behaviour is missing. Quote
   every test's actual failure output in your handoff and name which kind of
   failure it is: the behaviour is missing, or something else. Something else
   is an import error, a typo, a fixture that never loaded, a test that dies
   before it reaches its assertion, or an expected value that differs from the
   actual one only in formatting — a separator, a locale, whitespace, an
   ordering. That failure is your own bug: fix your test and run it again
   before you return, rather than leaving it for the review. The corrected
   test is still red, so this is not making a test pass. A failure you cannot
   explain goes into your handoff as an open question instead of into the
   commit as if it were fine. The suite and the linter are not yours to run;
   the implementer runs what the plan lists once the code exists.
```

This is a draft, not a dictation. The implementer owns the final rhythm and may
re-cut the sentences, but every one of these has to survive in some form:

- **"Quote every test's actual failure output … and name which kind of failure
  it is: the behaviour is missing, or something else."** — criterion 1. The two
  halves matter: the real output, and the classification. A red bar with no
  output does not satisfy it.
- **The list of what counts as "something else", ending in the formatting
  mismatch** — criterion 2. The formatting case must name its examples
  (separator, locale, whitespace, ordering), because that is the exact failure
  the issue was filed over: a test comparing an unformatted number against
  formatted output. Keep the four examples.
- **"fix your test and run it again before you return, rather than leaving it
  for the review"** — criterion 3. "Before you return" is the load-bearing
  part; without it the duty is satisfiable by a note.
- **"The corrected test is still red, so this is not making a test pass."** —
  this sentence exists to settle the apparent conflict with the Boundaries
  block below, which says "You never make a test pass. The implementer does
  that." Without it, a careful agent reads the boundary as forbidding the fix
  criterion 3 requires, and the page contradicts itself. Do not drop it, and do
  not solve the conflict by editing the Boundaries block instead — the boundary
  is correct as it stands and is quoted by `.claude/rules/agents.md`'s "the
  page is the interface" principle.
- **"A failure you cannot explain goes into your handoff as an open question
  instead of into the commit as if it were fine."** — criterion 4.
- **The closing sentence about the suite and the linter** — unchanged from the
  current text. It is a separate rule that happens to live in this step; keep
  it.

Dropped from the current text: "— not an import error, not a typo". Those two
examples move into the fuller list of wrong reasons, so nothing is lost and the
rule is stated once.

### Edit 2 — the handoff section (lines 56–58)

Current sentence:

```
Walk the test plan case by case: which test file and test name each case
became, its failure output, and for anything you did not write, which case it
was and why.
```

Change `its failure output` to `its failure output and the kind that failure
is`. Nothing else in that sentence or that section changes.

Reason: the handoff section is the contents list of the file, and after edit 1
it would list only half of what step 4 demands the file contain. Aligning the
noun keeps the two readings of the page from disagreeing. This is deliberately
a four-word change and not a second statement of the rule — the definitions,
the fix duty and the open-question duty all live in step 4 and only there, per
"state each rule once".

### Explicitly not done, and why

- **The frontmatter `description` is not touched.** It already says the agent
  writes failing tests and commits its handoff. No criterion asks for it, and
  a change there is prose no criterion asked for, which the reviewer treats as
  a finding.
- **`model: sonnet` stays.** `.claude/rules/agents.md` asks that a pinned model
  tier be justified on the page; this one is not justified in the body. That is
  a pre-existing gap from commit `5c853af`, unrelated to this issue, and
  fixing it here would be scope nobody asked for. Left alone deliberately.
- **The Boundaries block stays exactly as it is.** See the reasoning under
  edit 1.
- **`agents/implementer.md` stays as it is.** Its "confirm they fail for the
  right reason" is consistent with the new text, and duplicating the
  definition of a wrong reason there would put one rule on two pages, where
  the two wordings drift apart at the first edit.

## Test plan

**Whether: no tests.** This change is prose in an agent page and nothing else.
There is nothing a tool can check about it that is worth checking.

The reasoning, so the omission reads as a decision and not as a gap: the
repository's suites check structure, not wording. `test-plugin.sh` verifies
that `plugin.json`'s `agents` list matches the files in `agents/` exactly, that
`claude plugin validate` accepts every agent page, and that `--strict` emits
exactly two known warnings — all of which turn on the frontmatter and the file
list, neither of which this change touches. `test-repo.sh` checks licence
consistency and the deployment surface. Nothing anywhere reads the body of an
agent page.

A test could only be written by grepping `agents/test-author.md` for chosen
words — "formatting", "open question", "still red". That test would pin the
exact wording of a paragraph whose whole value is that a future editor can
rephrase it, it would pass for a page that contains the words in a sentence
that means the opposite, and it is precisely the "new machinery" criterion 5
rules out. The issue's own default says this outcome is acceptable and asks the
researcher to say so rather than invent a test. So: none.

Criteria 1 through 6 are verified by reading the diff. Criterion 7 is verified
by the command below.

**What counts as done — the closed list:**

```
bash test.sh
```

That is the whole list. Run it from `/home/user/uroboros`. Expect **exit 1**
with `FAIL: 1 of 6 suite(s)`, the single failing case being
`test-worktree.sh`'s "a push to the run's own branch from inside a worktree
succeeds", for the shallow-clone reason recorded above. That is the pre-change
baseline, it is not this change's defect, and it does not block `done`. Any
*other* red in that run belongs to this change and must be fixed before
returning.

It is in the list only because acceptance criterion 7 names it. Nothing else
gets run: there is no linter and no formatter to run, and no single-file
command, because there are no tests.
