# Researcher handoff — the test-author must prove why a test fails

## What this change is

One prose edit to one file: `agents/test-author.md`. Its step 4, "Prove the
failures", currently asks the test-author to *confirm* each test fails for the
right reason and to *quote* the failure. It never says what "the right reason"
excludes beyond two examples, it never says what to do when a test failed for
the wrong reason, and it never says which failures the test-author may not
simply swallow. The change closes those three holes and puts the classification
of every failure into the handoff, where the reviewer and the next researcher
can see it.

No other file changes. Nothing in the repository contradicts the new rules — I
checked every page that mentions the test-author (see *Contradiction check*
below), and the one adjacent sentence, in `agents/implementer.md`, stays
correct and stays where it is.

## Baseline

The change is written against `origin/main` = commit `4aa773b`. Two spots in
`agents/test-author.md` are touched, and nothing else in the file.

**Spot A — item 4 of "## How you work", verbatim at the baseline:**

```
4. **Prove the failures.** Run your own tests with the single-file command the
   plan names, and confirm each fails because the behaviour is missing — not an
   import error, not a typo. Quote the failure in your handoff. The suite and
   the linter are not yours to run; the implementer runs what the plan lists
   once the code exists.
```

**Spot B — the middle of "## Your handoff", verbatim at the baseline:**

```
commit it with the tests. Walk the test plan case by case: which test file and
test name each case became, its failure output, and for anything you did not
write, which case it was and why. Every gap and conflict you found in the plan
belongs here too — that is where the researcher picks them up. Write it out in
full; no placeholders, no summaries that drop detail.
```

If the working copy you are handed already carries different text at these two
spots, do not try to merge it: the target end state below is what the file must
hold when you are done.

## Implementation plan

### Change 1 — replace item 4 with two items

Item 4 keeps the run and the classification. A new item 5 carries what to do
with a failure that came out wrong. Write exactly this in place of Spot A:

```
4. **Prove the failures.** Run your own tests with the single-file command the
   plan names, and work out for each one what its failure really shows. One
   answer counts: the behaviour is missing. An import error, a syntax error, a
   typo, a missing fixture, a wrong path and a test that errors before it
   asserts do not, and neither does an expected value that differs from the
   actual one only in formatting — a separator, a locale, whitespace, the order
   of a list. That last one is the expensive one: it reads like a missing
   feature and is a broken assertion. The suite and the linter are not yours to
   run; the implementer runs what the plan lists once the code exists.
5. **Repair a failure that is yours.** A test that failed for one of those
   other reasons is yours to fix and to run again before you return, until it
   fails because the behaviour is missing; correcting your own test is not
   making it pass, and it stays red. Leaving it for the review costs the run a
   whole correction round to change one line. A failure you cannot explain is
   not yours to guess at: leave the test as it stands and put the failure in
   your handoff as an open question, instead of committing it as if it were
   fine.
```

Nothing else in the numbered list moves, and no text anywhere references these
items by number — I grepped the whole tree for `step [0-9]` and `Step [0-9]`
and there is no hit, so adding a fifth item breaks no cross-reference.

### Change 2 — the handoff section records the evidence

The requirement that the *handoff* carry the actual output and the named kind
lives here and only here, because this section is the one that describes what
the handoff contains. Write exactly this in place of Spot B:

```
commit it with the tests. Walk the test plan case by case: which test file and
test name each case became, its failure output as the run printed it, and which
kind of failure that is. Name any test you had to repair and what was wrong with
it, and for anything you did not write, which case it was and why. Every gap,
conflict and unexplained failure you found belongs here too — that is where the
researcher picks them up. Write it out in full; no placeholders, no summaries
that drop detail.
```

### Nothing else in the file changes

- The frontmatter `description` stays as it is. It is what a caller reads while
  deciding whether to dispatch this agent, and nothing in it becomes false.
  Repeating the new rule there would put the same rule on the page twice, which
  `.claude/rules/docs.md` forbids ("State each rule once").
- The `## Boundaries` bullet "You never make a test pass." stays untouched. The
  nuance it now needs — that fixing your own broken assertion is not making a
  test pass — is written once, in item 5, where the reader actually hits the
  conflict. Writing it in both places is the drift `.claude/rules/docs.md`
  warns about.
- Line width in this file is a hard-wrapped ~79 columns. Keep it. Use the same
  em dashes (—) the page already uses; do not introduce `--`.

## Why it is shaped this way

**Two items instead of one long one.** The acceptance criteria demand four
distinct things (record output, name the kind, list the kinds that do not
count, fix and re-run, escalate the unexplainable). Packed into one paragraph
they read as a wall and the last two get skimmed. Split at the natural seam —
item 4 is the diagnosis, item 5 is the treatment — each stays a short block in
the voice the page already uses. This is not new machinery: it is one more
numbered instruction in a list that already has four.

**No checklist, no template.** The criteria explicitly rule out a form the
agent fills in mechanically, so the requirement is phrased as what the handoff
walks through, in the same sentence shape the section already had ("Walk the
test plan case by case: …"). No table, no headings to fill, no per-test
scaffold.

**The formatting mismatch is named as the expensive case, not just listed.**
The issue's whole cost story is that a separator mismatch looks exactly like a
missing feature. The sentence "That last one is the expensive one: it reads
like a missing feature and is a broken assertion" is what makes the agent stop
on it instead of scanning past it in a list.

**Rejected: adding the rule to `agents/implementer.md` too.** The implementer's
item 3 already says "Run them and confirm they fail for the right reason before
you change anything." That stays. It is a different agent doing a different
check at a different time (a second pair of eyes after the tests are committed),
and neither page is context for the other — an agent reads only its own page.
Duplicating the list of wrong-reason failures onto that page would be the same
rule in two wordings, which is exactly what the docs rule forbids, and it would
widen the diff past criterion 6 for nothing.

**Rejected: touching `README.md`.** Its description of the loop ("the
test-author writes those cases and no others") is untouched by this change.

## Contradiction check (acceptance criterion 6)

I grepped the whole tree for `test-author` and for the phrases `right reason`,
`failure summary`, `fails because`, `red bar`. Every hit, and its verdict:

| File | What it says about the test-author | Contradicts? |
| --- | --- | --- |
| `agents/implementer.md` line 23 | The implementer runs the tests and confirms they fail for the right reason before changing anything. | No. A second, independent check; the test-author doing it first does not make it wrong. Out of scope anyway — the issue's "Out of scope" keeps the review side unchanged, and this is the same kind of downstream check. |
| `agents/researcher.md` | Decides whether/what/how to test; the test-author writes what it names. | No. |
| `agents/reviewer.md` | Reads no handoff; rejects a red suite. | No. The issue keeps this correct on purpose. |
| `README.md` lines 37, 50, 56-60 | Names the role and the "researcher decides the testing" rule. | No. |
| `.claude/workflows/uroboros-loop.js` lines 142-163 | Dispatches the test-author with the Test Plan as its work order; writes `test-author.md` / `test-author-<round>.md`. | No. |
| `.claude/rules/agents.md` | The page is the interface; frontmatter fields; one flat `.md` per agent. | No — and the change adds no file, so the `plugin.json` agent list stays correct. |
| `CLAUDE.md` | Names the loop's agents. | No. |
| `skills/grill/SKILL.md` line 34 | An undecided edge comes back as a blocked test-author. | No. |
| `.claude-plugin/plugin.json` | Declares `./agents/test-author.md`. | No — the file keeps its path and its name. |
| `tools/log-parser/test/**` | Fixture transcripts that happen to contain the string. | No — test data, not a claim. |

So the change stays confined to `agents/test-author.md`. Record in your handoff
that the check was done and found nothing to correct.

## Module map

| Path | What it holds | Entry point / relevance |
| --- | --- | --- |
| `agents/test-author.md` | **The only file this change edits.** Frontmatter (`name`, `description`, `tools: Read, Write, Edit, Bash`, `color`), then the body: intro, `## How you work` (a numbered list, items 1-4 at the baseline), a paragraph on correction rounds, `## Boundaries`, `## Your handoff`. | Spot A is item 4; Spot B is inside `## Your handoff`. |
| `agents/implementer.md` | The implementer's brief; item 3 runs the tests and confirms the failure reason. | Read-only context for the contradiction check. Do not edit. |
| `agents/reviewer.md` | The reviewer's brief; the reproduction rule and "you never write a test". | Read-only context. Do not edit. |
| `agents/researcher.md` | The researcher's brief; owns the Test Plan. | Read-only context. Do not edit. |
| `.claude/rules/docs.md` | The style law for markdown under `docs/`: one instruction per sentence, imperative, each rule once. It is path-scoped to `docs/`, but its "state each rule once" reasoning is why this plan refuses to repeat the rule on other pages. | Constraint on wording. |
| `.claude/rules/agents.md` | The law for `agents/`: one flat `<name>.md`, every one declared in `plugin.json`, frontmatter fields, the page is the whole brief. | Constraint: no new file, no frontmatter field dropped. |
| `.claude-plugin/plugin.json` | Declares the exact agent file list. | Must keep matching the tree — it does, since no file is added or renamed. `test-plugin.sh` asserts this. |
| `test.sh` | Runs all six suites; the one command behind "the suite is green". | The check for this change. |
| `test-repo.sh`, `test-plugin.sh`, `test-worktree.sh` | The three shell suites. `test-plugin.sh` is the one that reads agent files at all — it counts them and validates the manifests; it asserts nothing about the prose in them. | Nothing to update. |

## Environment

- **Run the whole suite:** `bash test.sh` — from the repository root
  (`/home/user/uroboros`). Takes roughly a minute.
- **`./test.sh` does not work in this checkout.** The `*.sh` files are mode
  `100644` in git and not executable on disk, so `./test.sh` exits with
  "Permission denied". Always invoke them through `bash`. The acceptance
  criterion says "`./test.sh` is green"; `bash test.sh` is that same command,
  and it is the form to use everywhere.
- **Run a single suite:** `bash test-repo.sh`, `bash test-plugin.sh`,
  `bash test-worktree.sh`. The three Node suites run through their packages:
  `npm --prefix tools/argus test --silent`, and the same for `tools/argus-ui`
  and `tools/log-parser`.
- **Linter:** there is none. No root `package.json`, no ESLint, Prettier or
  markdownlint configuration anywhere in the tree.
- **Formatter:** there is none. Markdown here is hand-wrapped at about 79
  columns; match the surrounding text by hand.
- **CI:** there is none. No `.github/` directory exists.
- **Prerequisites:** Node 20+ and `git` must be on the PATH (they are), and
  `test-plugin.sh` needs the `claude` CLI (it is present and passing). No
  install step is needed — the Node packages are zero-dependency.

## Test plan

### Whether

**No tests.** This change adds no behaviour a tool can check. The whole change
is prose inside one agent page, and the only mechanical assertion available
would be a grep for the words the diff itself introduces — a test that passes
because the words are there and says nothing about whether the instruction is
clear, well-placed or in the page's voice. The issue anticipates this outcome
and asks me to say so instead of inventing a test; I am saying so.

There is a precedent for asserting prose — `test-plugin.sh` checks that
`skills/argus/SKILL.md` contains `process start`. I considered extending that
pattern to this page and rejected it. That check guards a fact that a rewrite
could silently drop from a user-facing skill whose body nobody re-reads; here
the page *is* the deliverable, the diff is small enough to be read whole by the
reviewer, and pinning the words would freeze wording that criterion 5 wants to
stay free and plain. It would also push the change outside
`agents/test-author.md`, which criterion 6 wants confined.

So no test file is written and no test-author round is needed for this issue.
Criteria 1-6 are verified by reading the diff — the reviewer's check 2 carries
this review, which its own page provides for. Criterion 7 is verified by the
command below.

### What / How

Not applicable: no cases. Nothing is deliberately left untested beyond what the
paragraph above states, because there is nothing testable to leave out.

### What counts as done

The closed list, verbatim, runnable from the repository root:

- `bash test.sh`

Nothing else. No linter exists, and no single-file runner is relevant when no
test file changes.

### What is already red

I ran `bash test.sh` on the current checkout. Result: **5 of 6 suites pass, 1
fails, and that failure is pre-existing and environmental.**

- `test-repo.sh` — PASS: 6 cases
- `test-plugin.sh` — PASS: 39 cases
- `test-worktree.sh` — **FAIL: 1 of 9 cases**, the case
  `a push to the run's own branch from inside a worktree succeeds`
- `tools/argus`, `tools/argus-ui`, `tools/log-parser` — all pass

**Why that case is red, and why it is nobody's job here.** This checkout is a
shallow clone (`git rev-parse --is-shallow-repository` → `true`,
`.git/shallow` exists). `test-worktree.sh` clones the checkout into a scratch
directory and pushes to a scratch bare remote; the clone inherits the
shallowness and git refuses every push into the bare remote with
`! [remote rejected] HEAD -> worktree-parallel-run (shallow update not
allowed)`. I reproduced it by hand outside the suite and got exactly that
message. It has nothing to do with `agents/test-author.md`, which this suite
never reads.

Consequence for the implementer and the reviewer: `bash test.sh` will exit
non-zero in this environment before and after the change. Report it with its
exit code, name it as this pre-existing shallow-clone failure, and do not chase
it — the implementer's page and the reviewer's page both provide for exactly
that. Confirm the other five suites are green and that
`test-worktree.sh`'s failure count is still exactly this one case. In a full
clone, `bash test.sh` is green, and that is what acceptance criterion 7 means.

## Acceptance criteria, mapped

| Criterion | Where it is met |
| --- | --- |
| 1. Handoff records actual failure output and names the kind, per test | `## Your handoff`, Change 2: "its failure output as the run printed it, and which kind of failure that is"; item 4 supplies the two kinds. |
| 2. Names the kinds that do not count, formatting mismatch among them | Item 4, Change 1: import error, syntax error, typo, missing fixture, wrong path, errors before it asserts, and the formatting mismatch — separator, locale, whitespace, order. |
| 3. Wrong reason → fix your own test and re-run before returning | Item 5, first sentence, plus "Leaving it for the review costs the run a whole correction round". |
| 4. Unexplainable failure → open question, not committed as fine | Item 5, last sentence, reinforced by "Every gap, conflict and unexplained failure you found belongs here too" in the handoff section. |
| 5. Voice: short, plain, no machinery, no mechanical checklist | Two numbered items in an existing numbered list, imperative sentences, no table, no template, no new section. |
| 6. Confined to `agents/test-author.md` | Only that file is edited; the contradiction check above found no other page to correct, and that fact is what the implementer records in its handoff. |
| 7. `bash test.sh` green | The single command in "What counts as done", with the pre-existing shallow-clone failure recorded above. |

## What the implementer records in its handoff

- The two spots it replaced, and that no other file was touched.
- That the contradiction check was already done by the researcher and found
  nothing to correct — restate the conclusion, do not redo the search.
- The `bash test.sh` run: the exit code, the five green suites, and the one
  pre-existing `test-worktree.sh` failure with its shallow-clone cause.
