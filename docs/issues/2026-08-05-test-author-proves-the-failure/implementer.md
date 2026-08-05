# Implementer handoff — the test-author must prove why a test fails

Issue: `docs/issues/2026-08-05-test-author-proves-the-failure/issue.md`
Brief: `docs/issues/2026-08-05-test-author-proves-the-failure/researcher.md`

## Summary

The Implementation Plan in `researcher.md` §6 is implemented in full and
unchanged in substance: three edits to `agents/test-author.md` and no other
production file. The whole suite (`bash test.sh`) is green, exit 0. There is no
linter and no formatter in this repository — `researcher.md` §3 states that
explicitly ("**Linter: there is none.** … **Formatter: there is none.** So when
the implementer's page tells it to run 'the project's static analysis', the
answer for this repository is: none exists — cite this sentence and move on"),
so per my own page's step 4 I cite it and did not search.

**There is no test-author handoff for this issue, and there are deliberately no
new tests.** That is not an omission: `researcher.md` §5 ("Test decision: no
new tests, deliberately") orders it, and §5 closes with "Consequence for the
implementer: there is no test-author handoff to read for this issue, and no new
failing test to make pass. Per your own page, step 3: 'A change with nothing to
run — prose, nothing a tool checks — has none; say so in your report.'" I
verified the absence rather than assuming it: the issue directory contains
exactly `issue.md`, `researcher.md` and (now) this file. See §"Test Results"
below for the full record, and §"The no-tests decision, quoted" for the
researcher's argument reproduced so the reviewer judges the reasoning rather
than an absence.

## Changes Made

All three edits are in one file, `agents/test-author.md`. Frontmatter
(`name`, `description`, `tools`, `color`) is byte-identical to before —
untouched, as §6 "What not to touch" requires.

### Edit A — step 4 of `## How you work` replaced (criterion 1)

Removed (former lines 32–34):

```
4. Run every test you wrote and confirm each fails for the right reason: the
   behaviour is missing — not an import error, not a typo. Prove it in your
   report with the failure summary.
```

Added (now lines 32–35):

```
4. Run every test you wrote, one at a time, and put its actual failure output
   in your handoff — the assertion, the message, the line — and name which
   kind of failure it is: the behaviour is missing, or something else. A red
   bar is not evidence. The output is.
```

This is the researcher's proposed text adopted verbatim. It carries criterion 1's
two demands per test — the actual failure output (named concretely: the
assertion, the message, the line) and a named kind of failure — and it removes
the loophole sentence "Prove it in your report with the failure summary". The
closing pair, "A red bar is not evidence. The output is.", is the explicit
rejection of the red bar as evidence that the issue's framing asks for.

### Edit B — new section `## The right reason, and the wrong ones` (criteria 2, 3, 4)

Inserted between the reviewer-reproduction-spec paragraph that ends
`## How you work` (now lines 37–40) and `## Boundaries` (now line 63), exactly
at the position §6 Edit B specifies. The researcher's proposed text is adopted
verbatim — I judged the wording already correct against the criteria and saw no
claim to add or remove, so adapting it would only have introduced drift. Three
paragraphs, now lines 42–61:

- **Paragraph 1 (criterion 2)** — states the single right reason ("the
  behaviour the criterion asks for does not exist yet") and then names the
  kinds that do not count: an unresolvable import, a misspelled name, a fixture
  or prerequisite that never ran, a test that errors before its assertion, and
  an expected value that is simply wrong. It then singles that last one out
  ("That last one hides best") and names the formatting-only mismatch
  explicitly, with the four examples the issue lists — a thousands separator, a
  locale, whitespace, the order of a list — plus the inference the test-author
  is to draw: "the behaviour is very likely already there and your assertion is
  what is broken. Read the two values, not the colour of the bar."
- **Paragraph 2 (criterion 3)** — the fix-it-now duty: "yours to fix, before
  you return: correct the test, run it again, and record the output of that
  run", and the reason it is not left for review ("one wrong assertion costs a
  whole correction round of four agents and changes no production code").
- **Paragraph 3 (criterion 4)** — the unexplained failure goes into the handoff
  as an open question, with the output seen and what was expected instead,
  rather than being committed as if it were fine.

Form: a named `##` section with prose paragraphs, no bullets, no bold labels, no
numbered form to fill in — the house form the researcher cites
(`agents/reviewer.md` carries `## The reproduction rule` the same way), and what
criterion 5 ("no new machinery, no checklist") requires. No defined terms and no
capitalised jargon were introduced.

### Edit C — one clause in `## Your output and handoff` (criterion 1)

Former line 53 began "The file should include Test Plan and Coverage
Requirements. **Important**: …". It now begins:

```
The file should include Test Plan, Coverage Requirements, and for every test you wrote its failure output with the kind of failure it is. **Important**: …
```

The rest of that line and section — the "**Important**: The Markdown content
must be extensively detailed…" sentence, the commit instruction, the return
value sentence, the English-handoff sentence — is untouched. This puts the
evidence into the enumeration of the handoff's own contents, where criterion 1
wants the record to live.

One deliberate deviation from the researcher's presentation, in whitespace only:
§6 Edit C shows the replacement wrapped across two lines. I kept it as a single
long line instead, because every line in that section is already unwrapped in
the source (the "You do not return your report…" line is 156 characters, the
"After writing your tests…" line is 83). Wrapping only my clause would have
produced a half-wrapped paragraph. No word of the proposed text changed; only
the line break was dropped. Verified afterwards that no line I *added* exceeds
79 characters except this one, and that the only lines in the file over 79
characters are pre-existing ones (3 — the frontmatter description, 22, 74, 75,
78).

## Files Modified

| Path | Change |
| --- | --- |
| `agents/test-author.md` | 26 insertions, 4 deletions. Step 4 of `## How you work` rewritten; new `## The right reason, and the wrong ones` section added before `## Boundaries`; one clause added to the contents enumeration in `## Your output and handoff`. File grows 59 → 82 lines (+23), which is within the "roughly 20 added lines" the researcher's §8 calls proportionate. |
| `docs/issues/2026-08-05-test-author-proves-the-failure/implementer.md` | This handoff (new). |

Nothing else. No test file, no `plugin.json`, no other agent page, no README,
no suite script, no new file or directory under `agents/`.

Verified mechanically, per §7 step 4:

```
$ git diff --name-only main
agents/test-author.md
docs/issues/2026-08-05-test-author-proves-the-failure/researcher.md

$ git diff --stat main -- . ':!docs/issues'
 agents/test-author.md | 30 ++++++++++++++++++++++++++----
 1 file changed, 26 insertions(+), 4 deletions(-)
```

(`researcher.md` is the researcher's own committed handoff, expected in the
range; this file joins it in the same commit as this change.)

## Test Results

### There were no failing tests to make pass — the record

My page's step 3 ("Tests first — but not yours") tells me to read the
test-author's handoff, run the named failing tests, and confirm they fail for
the right reason before changing anything. For this issue there is no such
handoff and no such tests, by the researcher's explicit decision. What I did
instead of guessing:

1. Listed the issue directory before editing anything:
   `ls -la docs/issues/2026-08-05-test-author-proves-the-failure/` → exactly
   `issue.md` (2936 bytes) and `researcher.md` (17397 bytes). No
   `test-author.md`, no `test-author-1.md`, no test file.
2. Confirmed against `researcher.md` §5, which orders that outcome and tells me
   to say so and cite the section. Done here.
3. Ran the whole suite *before* editing to establish the baseline, so that a
   green suite afterwards is a comparison and not just an assertion: `bash
   test.sh` → `PASS: all 6 suites`, **exit 0**, before any edit. This matters
   because with no new test there is nothing that goes red-then-green; the only
   available evidence is "green before, green after, and the diff reads right".

So: this change has no failing test to prove it, and none was written. The
evidence for criteria 1–5 is the diff, read against the criteria — reviewer
check 2 — plus the unchanged green suite for the mechanical properties.

### Whole suite — the one command behind "the suite is green"

```
$ bash /home/user/uroboros/test.sh
...
PASS: all 6 suites
EXIT=0
```

**Command:** `bash /home/user/uroboros/test.sh` (the command named in
`researcher.md` §3 as the whole suite).
**Exit code:** 0.
**Run twice:** once before any edit (baseline) and once after all three edits,
both exit 0. A third run after the whitespace-only adjustment to Edit C also
exited 0.

**What it covered** — the six chained suites, with the per-suite counts printed
by this run:

1. `test-repo.sh` — "the repository itself": the licence claims across
   `LICENSE`, `plugin.json`, `tools/argus/package.json`, `README.md`, that no
   file claims Apache, and that remote operation deploys the collector alone.
   `PASS: 6 cases`.
2. `test-plugin.sh` — manifests, install, collector reach, rulebook delivery,
   self-update, self-check, push guard. `PASS: 39 cases`. This is the suite
   that guards the file I edited: it asserts "plugin.json has the documented
   fields", "plugin.json declares exactly the agent files the tree holds",
   `claude plugin validate` on both the marketplace and the plugin manifest
   plus its components, the `--strict` warning budget ("warns about the missing
   version and the root CLAUDE.md, and nothing else"), and "the installed
   inventory equals what the tree holds, agent-owned skills included". All of
   those stayed green, which is the mechanical confirmation that the
   frontmatter of `agents/test-author.md` is still intact, that the file is
   still a single flat `agents/*.md`, that no stray file appeared under
   `agents/`, and that the `plugin.json` agent list still matches the tree.
   The `claude` CLI prerequisite named in §3 was present.
3. `test-worktree.sh` — parallel runs / worktrees. `PASS: 9 cases`.
4. `npm --prefix tools/argus test --silent` — node:test, passed.
5. `npm --prefix tools/argus-ui test --silent` — node:test, passed.
6. `npm --prefix tools/log-parser test --silent` — node:test, passed.

Aggregate line: `PASS: all 6 suites`. Total individual `ok` assertions printed
by the shell suites in the after-run: 54. No `npm install` was needed (the three
packages are zero-dependency, per §3), no build step, no service.

### Static analysis

**None exists in this repository, and none was run.** `researcher.md` §3:

> **Linter: there is none.** No `eslint`/`prettier`/`biome` config exists
> anywhere in the tree … and no `package.json` in the repo defines a `lint` or
> `format` script … **Formatter: there is none.** So when the implementer's
> page tells it to run "the project's static analysis", the answer for this
> repository is: none exists — cite this sentence and move on. Do not add one;
> no criterion asks for it.
>
> **Markdown lint: none.** Nothing checks line length or style in `*.md`.

I cited it and moved on, per my page ("When that section says there is no suite
or no linter, cite it and move on — that is the same path to `done`"). I did not
search for a linter and I did not add one.

In place of the absent markdown lint I checked the house convention by hand, as
§3 says to ("Match it by eye"): every line I added is ≤ 79 characters except
the single deliberately unwrapped line in `## Your output and handoff`
described under Edit C, and the only over-79 lines in the finished file are ones
that were already there.

### Manual read against criteria 1–5 (§7 step 3)

I read the changed page whole, once, after the edits. Against the criteria:

- **1 — actual failure output per test, in the handoff, with a named kind.**
  Present twice, and in the two right places: step 4 of `## How you work`
  (the instruction) and the contents enumeration in `## Your output and
  handoff` (the record). "A red bar is not evidence. The output is." kills the
  old loophole.
- **2 — the failure kinds that do not count, formatting-only named.** Present
  in paragraph 1 of the new section: import, misspelled name, unrun
  fixture/prerequisite, error before the assertion, wrong expected value — and
  the formatting-only mismatch named explicitly with separator, locale,
  whitespace and list order.
- **3 — fix it and re-run, now.** Paragraph 2, including "before you return"
  and "record the output of that run".
- **4 — cannot explain it → open question, not a silent commit.** Paragraph 3,
  in those terms.
- **5 — no new machinery, no checklist.** Nothing in the diff reads like a form:
  no bullets in the new section, no bold field labels, no numbered evidence
  template, no new file, no new frontmatter key, no new tool. Prose only.
- **6 — one file.** Confirmed by `git diff --name-only main` above.
- **7 — suite green.** Above, exit 0.

## Challenges and Problems

Nothing blocked, and no question is open. Four things worth the reviewer's eye:

1. **No test-author handoff existed, which is the one input my page assumes.**
   Handled by verifying the directory contents and then following
   `researcher.md` §5, which anticipates exactly this and instructs me to
   report the absence with its reasoning. I added the before-edit baseline run
   of `test.sh` on my own initiative so that "green" has a comparison point;
   without a red-to-green transition that baseline is the only thing that
   distinguishes "the suite still passes" from "the suite was never run".
2. **A possible tension the reviewer may want to weigh, which I did not
   change.** `## Boundaries` still says "You never make a test pass; the
   implementer who follows you does that, and may not edit what you wrote",
   while the new section tells the test-author to correct its own broken test
   before returning. I read these as compatible and left the bullet alone:
   correcting a test that fails for a wrong reason does not make it pass — a
   correct test still fails, now for the right reason — and the new paragraph
   says so in its own last clause ("changes no production code"). The
   researcher's §4 contradiction audit covered `implementer.md`,
   `reviewer.md`, `skills/grill/SKILL.md`, the loop script and the README, and
   §6 "What not to touch" forbids widening the diff, so rewording that bullet
   would have been scope I do not own. Noting it here rather than editing it is
   the path my page prescribes.
3. **Whitespace-only deviation in Edit C**, described in full under Edit C
   above: the researcher showed the replacement clause wrapped over two lines;
   I kept the sentence on the single long line the surrounding section already
   uses. No wording changed. Flagging it so the reviewer is not surprised that
   the diff does not look character-for-character like §6.
4. **Length.** The page went from 59 to 82 lines (+23 against the ~20 §8
   predicted). The overage is the section heading plus its two blank lines; no
   fourth paragraph and no sentence beyond criteria 1–4 was added, which is the
   constraint §8 actually sets.

Out-of-scope observations noticed while working, recorded and not acted on: the
`## Your output and handoff` sections of the agent pages are unwrapped long
lines while the rest of each page wraps at ~76–79, which is a cosmetic
inconsistency across all four pages, not this issue's business.

## The no-tests decision, quoted

So the reviewer sees the argument and not an absence, `researcher.md` §5 in
full, as §8 asks me to reproduce:

> **Tests are not needed for this change, and none should be written.** The
> issue's own default (`## Assumptions taken as defaults`) authorises this
> outcome and asks the researcher to say so rather than invent a test. …
>
> - Every acceptance criterion 1–5 is a statement about *what a page says* and
>   *how it says it*. The only mechanical check available for that is a `grep`
>   for chosen words in `agents/test-author.md`. Such a test proves nothing
>   about the change: the same agent-run that writes the sentence writes the
>   pattern that matches it, and it passes for a page that contains the word
>   "formatting" in any context whatsoever.
> - It would also actively work against criterion 5 ("no new machinery") and
>   against the repository's own habit: it freezes one wording, so every later
>   rewording of an agent page turns red for a reason that has nothing to do
>   with correctness. `test-repo.sh` deliberately checks only *cross-file
>   consistency* facts … a real fact one file cannot state alone. This change
>   creates no such fact: §4 established that no other page repeats or depends
>   on this claim.
> - The mechanical properties that *can* break — frontmatter keys, the file
>   staying a single flat `agents/*.md`, the `plugin.json` agent list matching
>   the tree, the `--strict` warning budget, the installed inventory count —
>   are already covered by `test-plugin.sh`, which runs inside `./test.sh`. …
> - What carries the review is therefore reviewer check 2 (reading the diff
>   against the criteria) plus the existing suite, exactly as
>   `agents/reviewer.md` check 3 provides for ("For a change that has no tests
>   because there is nothing to run, say so").

I say so. There is nothing a tool checks in this change beyond the frontmatter
and file-shape properties that `test-plugin.sh` already asserts, and those are
green.
