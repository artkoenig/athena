# Researcher handoff — the test-author must prove why a test fails

Issue: `docs/issues/2026-08-05-test-author-proves-the-failure/issue.md`

## 1. What this change is

A prose change to one agent page. `agents/test-author.md` currently ends its
"How you work" list with:

```
4. Run every test you wrote and confirm each fails for the right reason: the
   behaviour is missing — not an import error, not a typo. Prove it in your
   report with the failure summary.
```

That demands the right outcome and accepts the wrong evidence: a "failure
summary" is satisfied by a red bar, and a red bar cannot tell a missing feature
from a broken assertion. The change replaces the evidence requirement with the
actual failure output, names the failure kinds that do not count — the
formatting-only mismatch above all — and states what the test-author does when
a test fails for a wrong reason (fix it and re-run, now) and when it cannot
explain the failure (open question in the handoff, not a silent commit).

No behaviour of any other agent changes. No new file, no new machinery, no
checklist.

## 2. Module map

The repository is a Claude Code plugin whose product *is* prose: agent pages,
skills, and a rulebook. The relevant files:

| Path | What it holds | Relevance |
| --- | --- | --- |
| `agents/test-author.md` | The test-author's whole brief: frontmatter (`name`, `description`, `tools: Read, Write, Edit, Bash`, `color: green`), `## How you work` (4 numbered steps + the reviewer-reproduction-spec paragraph), `## Boundaries`, `## Your output and handoff`. 59 lines. | **The only file to edit.** |
| `agents/implementer.md` | The implementer's brief. Step 3 says it runs the test-author's tests, confirms they fail for the right reason, and may **not** edit them: "a test you believe wrong is a note in your handoff file for the reviewer, not an editing target." | Checked for contradiction — none. See §4. |
| `agents/reviewer.md` | The reviewer's brief. Check 1 makes a red suite the first finding; check 3 judges the tests against the intent. | Out of scope per the issue; checked — none. See §4. |
| `agents/researcher.md` | This agent's brief. | Untouched. |
| `.claude/rules/agents.md` | The rules for `agents/` (path-scoped, loads when a session reads a file under `agents/`): one flat `<name>.md` per agent, every one listed in `plugin.json`'s `agents` field, required frontmatter keys, "the page is the interface". | Constrains the *form* of the edit: frontmatter keys stay, no new file, no new directory. Not edited. |
| `.claude-plugin/plugin.json` | Declares `agents` explicitly as the four flat files, replacing the recursive scan. | Must **not** change — no agent file is added or renamed. |
| `.claude/workflows/uroboros-loop.js` | The loop: researcher → test-author → implementer → reviewer, at most two correction rounds. Line 118 dispatches the test-author with `Write your handoff to <dir>/test-author.md`; line 131 uses `test-author-<round>.md` in a correction round. | Says nothing about failure evidence. Untouched. |
| `README.md` line 37/50 | Mermaid diagram node "test-author / turns the criteria / into failing tests" and a link to the page. | A one-line role label, no claim about evidence. Untouched. |
| `skills/grill/SKILL.md` line 34 | "an edge left undecided comes back as a blocked `test-author`, one role too late". | Consistent with the new "open question" sentence — a blocked test-author already reports instead of guessing. Untouched. |
| `test-repo.sh`, `test-plugin.sh`, `test-worktree.sh`, `test.sh` | The suites. See §3 and §5. | Untouched (see the test decision in §5). |

Entry point for the reader of the changed page: the agent page is loaded whole
by the plugin at dispatch time; there is no code path to trace. The only
consumers are the test-author agent itself (at runtime) and the reviewer
(reading the diff).

## 3. Environment

Everything below was run and verified in this checkout on 2026-08-05.

- **Whole suite (the one command behind "the suite is green"):**
  `bash /home/user/uroboros/test.sh` — run from anywhere; the script resolves
  its own root. It chains six suites and exits 0 only if all pass.
  Verified now: `PASS: all 6 suites`, **exit 0**, wall clock ~1m37s.
- **The six suites, individually (this is the "single test file" command):**
  - `bash /home/user/uroboros/test-repo.sh` — facts about the repository itself
    (licence claims across files, deployment shape). Prints `PASS: <n> cases`.
  - `bash /home/user/uroboros/test-plugin.sh` — manifests, `claude plugin
    validate` on both targets, `--strict` warning budget (exactly 2 expected
    warnings), a scratch install with `HOME`/`CLAUDE_CONFIG_DIR` redirected,
    the session-start hook, the push guard. **Prerequisite: the `claude` CLI
    must be on `PATH`** — it is, in this environment, and the suite passed.
    This is the suite that would catch a broken frontmatter or a stray file
    under `agents/`.
  - `bash /home/user/uroboros/test-worktree.sh` — parallel runs / worktrees.
  - `npm --prefix /home/user/uroboros/tools/argus test --silent`
  - `npm --prefix /home/user/uroboros/tools/argus-ui test --silent`
  - `npm --prefix /home/user/uroboros/tools/log-parser test --silent`
  All three npm packages are zero-dependency (`node --test`), so **no
  `npm install` step is needed** before running them.
- **A single Node test file**, if one is ever needed:
  `node --test /home/user/uroboros/tools/<pkg>/test/<name>.test.mjs`
  (Node >= 20.11 per `tools/argus/package.json` `engines`).
- **Linter: there is none.** No `eslint`/`prettier`/`biome` config exists
  anywhere in the tree (searched `.eslintrc*`, `eslint.config*`,
  `.prettierrc*`), and no `package.json` in the repo defines a `lint` or
  `format` script (grep over all non-`node_modules` `package.json` files
  returned nothing). **Formatter: there is none.** So when the implementer's
  page tells it to run "the project's static analysis", the answer for this
  repository is: none exists — cite this sentence and move on. Do not add one;
  no criterion asks for it.
- **Markdown lint: none.** Nothing checks line length or style in `*.md`. The
  house convention, followed by every agent page, is prose wrapped at roughly
  76–79 columns. Match it by eye.
- **Git:** current branch `claude/offene-issues-ots4ej` (not `main`), working
  tree clean apart from this handoff. `core.hooksPath` points at the plugin
  cache's `.githooks`; the only hook is `pre-push`, which refuses pushes to
  `main`/`master`. Committing on this branch is unimpeded; the loop pushes at
  the end.
- **No build step, no install step, no service to start.**

## 4. Contradiction audit (acceptance criterion 6)

Criterion 6 confines the change to `agents/test-author.md` unless another page
makes a claim this contradicts. I searched the whole tree (excluding
`docs/issues/`, `.git`, `node_modules`) for every phrasing that could carry
such a claim: `right reason`, `failure summary`, `fails for`, `red suite`,
`open question`, and every mention of `test-author`/`test author` in
`*.md`, `*.js`, `*.json`.

Result: **nothing contradicts, and no other page needs a change.** The three
places that came close, and why each is fine:

1. `agents/implementer.md` line 17–19 — "Run them and confirm they fail for the
   right reason before you change anything; you may not edit them — a test you
   believe wrong is a note in your handoff file for the reviewer, not an
   editing target." This is *reinforced*, not contradicted: the test-author
   fixing its own test happens before the implementer is dispatched, and the
   implementer's ban on editing tests is untouched. Leave this page alone.
2. `agents/reviewer.md` check 1 and check 3 — a red suite is still the
   reviewer's first finding, and it still judges the tests against the intent.
   The issue puts the reviewer explicitly out of scope. Leave it alone.
3. `skills/grill/SKILL.md` line 34 — "a blocked `test-author`" already assumes a
   test-author that reports instead of guessing, which is exactly what the new
   "open question" sentence formalises. Leave it alone.

The loop script (`.claude/workflows/uroboros-loop.js`) makes no claim about
what the test-author proves; it only names the handoff file. `README.md` only
labels the role. So: **the diff must touch exactly one file,
`agents/test-author.md`.** Any other changed file (other than this issue
directory's handoffs) is a defect.

## 5. Test decision: no new tests, deliberately

**Tests are not needed for this change, and none should be written.** The
issue's own default (`## Assumptions taken as defaults`) authorises this
outcome and asks the researcher to say so rather than invent a test. Here is
the reasoning in full, so the reviewer can judge it:

- Every acceptance criterion 1–5 is a statement about *what a page says* and
  *how it says it*. The only mechanical check available for that is a `grep`
  for chosen words in `agents/test-author.md`. Such a test proves nothing about
  the change: the same agent-run that writes the sentence writes the pattern
  that matches it, and it passes for a page that contains the word "formatting"
  in any context whatsoever.
- It would also actively work against criterion 5 ("no new machinery") and
  against the repository's own habit: it freezes one wording, so every later
  rewording of an agent page turns red for a reason that has nothing to do with
  correctness. `test-repo.sh` deliberately checks only *cross-file consistency*
  facts (three files claiming a licence that `LICENSE` does not carry) — a
  real fact one file cannot state alone. This change creates no such fact:
  §4 established that no other page repeats or depends on this claim.
- The mechanical properties that *can* break — frontmatter keys, the file
  staying a single flat `agents/*.md`, the `plugin.json` agent list matching the
  tree, the `--strict` warning budget, the installed inventory count — are
  already covered by `test-plugin.sh`, which runs inside `./test.sh`. An edit
  that mangles the page's frontmatter turns that suite red. No new test would
  add coverage there.
- What carries the review is therefore reviewer check 2 (reading the diff
  against the criteria) plus the existing suite, exactly as `agents/reviewer.md`
  check 3 provides for ("For a change that has no tests because there is
  nothing to run, say so").

**Consequence for the implementer:** there is no test-author handoff to read
for this issue, and no new failing test to make pass. Per your own page, step 3:
"A change with nothing to run — prose, nothing a tool checks — has none; say so
in your report." Do that, and cite this section. Then run `bash test.sh`, report
the exact command, what it covered and the exit code, and note that the
environment section above states there is no linter and no formatter.

## 6. Implementation plan

One file: `agents/test-author.md`. Two edits, in this order.

### Edit A — replace step 4 of `## How you work`

Replace exactly these three lines (current lines 32–34):

```
4. Run every test you wrote and confirm each fails for the right reason: the
   behaviour is missing — not an import error, not a typo. Prove it in your
   report with the failure summary.
```

with:

```
4. Run every test you wrote, one at a time, and put its actual failure output
   in your handoff — the assertion, the message, the line — and name which
   kind of failure it is: the behaviour is missing, or something else. A red
   bar is not evidence. The output is.
```

Why: criterion 1 wants two things per test — the actual output, and a named
kind. "One at a time" is what makes a per-test output possible; the closing
pair of short sentences replaces "Prove it in your report with the failure
summary", which is the loophole the issue describes.

### Edit B — add one short section after `## How you work`

Insert a new `##` section **between** the reviewer-reproduction-spec paragraph
that ends `## How you work` (current lines 36–39, "A dispatch may hand you a
reviewer's reproduction spec… The reviewer does not write tests; you do.") and
`## Boundaries` (current line 41). A named short section is the house form —
`agents/reviewer.md` carries "## The reproduction rule" the same way.

Proposed text (adopt it, or adapt the wording while keeping every claim; the
claims are the criteria, the words are yours):

```
## The right reason, and the wrong ones

The right reason is one thing: the behaviour the criterion asks for does not
exist yet. Every other red is your own defect — an import that does not
resolve, a misspelled name, a fixture or prerequisite that never ran, a test
that errors before it reaches its assertion, an expected value that is simply
wrong. That last one hides best. When the expected and the actual value differ
only in how they are written — a thousands separator, a locale, whitespace, the
order of a list — the behaviour is very likely already there and your assertion
is what is broken. Read the two values, not the colour of the bar.

A test that fails for one of those reasons is yours to fix, before you return:
correct the test, run it again, and record the output of that run. You do not
leave it red for the implementer to trip over or for the review to catch — one
wrong assertion costs a whole correction round of four agents and changes no
production code.

A failure you cannot explain is not committed as if it were fine. It goes into
your handoff as an open question, with the output you saw and what you expected
instead.
```

Each paragraph carries one criterion: the first, criterion 2 (the kinds that do
not count, formatting-only mismatch named among them, with the four examples
the issue lists — separators, locale, whitespace, ordering); the second,
criterion 3 (fix your own test and re-run before returning, not at review
time); the third, criterion 4 (unexplained failure → open question, not a
silent commit).

### Edit C — recommended, one clause in `## Your output and handoff`

Current line 53 begins: "The file should include Test Plan and Coverage
Requirements." Extend that enumeration so the file's own contents list names
the evidence, e.g.:

```
The file should include Test Plan, Coverage Requirements, and for every test
you wrote its failure output with the kind of failure it is.
```

Why: criterion 1 puts the record in *the handoff*, and this section is where
the handoff's contents are enumerated. One clause, no new machinery. Keep the
rest of that section — including the "**Important**: extensively detailed"
sentence and the commit instruction — untouched.

### What not to touch

- **Frontmatter stays byte-identical.** `name`, `description`, `tools`,
  `color` are all still correct; the description already says the agent writes
  failing tests and writes its own handoff. Changing it risks the
  `test-plugin.sh` manifest and `--strict` checks for no gain, and it widens the
  diff for no criterion.
- **No other file.** Not `implementer.md`, not `reviewer.md`, not
  `plugin.json`, not `README.md`, not any suite. §4 is the recorded reason.
- **No checklist, no template, no numbered evidence form** the agent fills in
  mechanically (criterion 5). Prose sentences only.
- **No change to the reviewer's rejection of a red suite** and no change to the
  number of correction rounds (issue `## Out of scope`).

### Style constraints

- Wrap at ~76–79 columns, like the rest of the page.
- Second person, imperative, present tense; em dashes for asides; short
  sentences. No bold labels inside the new section, no bullet list — the
  existing page uses bullets only under `## Boundaries` and `## Your output and
  handoff`.
- Do not introduce defined terms or capitalised jargon.

## 7. Verification the implementer runs

1. `bash /home/user/uroboros/test.sh` — must print `PASS: all 6 suites`, exit
   0. This is the whole of criterion 7. Report the command, the six suites it
   covered, and the exit code.
2. No static analysis to run: the environment section above states there is no
   linter and no formatter in this repository. Cite that, do not search.
3. Read the changed page once, whole, against criteria 1–5 — that the four
   claims are present, that the formatting-only mismatch is explicitly named
   among the wrong reasons, and that nothing reads like a form to fill in.
4. `git diff --stat` against `main` must show `agents/test-author.md` and the
   files under `docs/issues/2026-08-05-test-author-proves-the-failure/` and
   nothing else.

## 8. Risks and how they are handled

- **Length creep.** The page is 59 lines; the two edits add roughly 20. That is
  proportionate to what it buys, but a fourth paragraph would not be. If a
  sentence does not carry one of criteria 1–4, drop it.
- **Duplication between step 4 and the new section.** Step 4 says *do it and
  put it in the handoff*; the section says *what counts, what to do when it
  does not, and what to do when you cannot tell*. Keep that split; do not
  restate the kinds in step 4.
- **A reviewer asking for a test anyway.** §5 is the recorded argument, backed
  by the issue's own default assumption and by `agents/reviewer.md` check 3.
  The implementer should quote §5 in its handoff so the reviewer sees the
  reasoning rather than an absence.
