# Researcher handoff — the test-author must prove why a test fails

## What the change is

A prose change to exactly one file: `agents/test-author.md`. Two edits, both
inside text that already exists. No production code, no script, no manifest,
no frontmatter, no other agent page.

Step 4 of "How you work" ("Prove the failures") already tells the test-author
to confirm each test fails because the behaviour is missing. What it never
does is (a) demand the actual output as evidence, (b) define what a wrong
reason looks like, (c) say what to do when it finds one, or (d) say what to do
with a failure it cannot explain. The change closes those four gaps in that
step, and widens one noun in the "Your handoff" section so the two readings of
the page agree.

There is nothing here a tool can check — see **Test plan** — so this ships
without a new test. The issue's own "Assumptions taken as defaults" names that
as an acceptable outcome and asks the researcher to say so rather than invent
a test. This is that sentence.

## Module map

### The file that changes

**`/home/user/uroboros/agents/test-author.md`** — 65 lines, the only file
edited. Its structure, by line:

| Lines | What it holds |
|---|---|
| 1–7 | YAML frontmatter: `name: test-author`, `description`, `tools: Read, Write, Edit, Bash`, `model: sonnet`, `color: green` |
| 9–11 | Opening paragraph: the agent has never seen an implementation |
| 13–38 | `## How you work`, four numbered prose steps: 1 read your brief (15–20), 2 write the planned cases (21–26), 3 test behaviour not implementation (27–33), **4 prove the failures (34–38)** |
| 40–43 | The correction-round paragraph |
| 45–51 | `## Boundaries`, three bullets |
| 53–64 | `## Your handoff`, incl. the "Walk the test plan case by case" sentence (**56–58**) |

Both edits land in the bolded spans: step 4, and one sentence of the handoff
section. Nothing else in the file is touched.

Entry points into this file at runtime: the plugin registers the agent through
`.claude-plugin/plugin.json`'s `agents` list (line 25, `"./agents/test-author.md"`),
and `.claude/workflows/uroboros-loop.js` dispatches `uroboros:test-author` at
lines 143–148 (first round) and 157–162 (correction round). Neither reads the
body; both only need the file to exist and to carry valid frontmatter.

### Files checked and deliberately not changed

This list is the recorded answer to acceptance criterion 6. I searched the tree
for every page that makes a claim about how the test-author proves a failure
(`grep -rin "test-author|fail.* for the right reason|failure"` across `*.md`,
`*.js`, `*.json`, `*.sh`). These are all the hits that matter:

- **`/home/user/uroboros/agents/implementer.md`**, step 3 (lines 21–27): "Run
  them and confirm they fail for the right reason before you change anything."
  Same idea one station later, and it does not contradict the new wording — it
  is the backstop for a wrong-reason failure that slipped past the test-author.
  It does not define "right reason" either, but copying the definition there
  would put one rule on two pages, where the two wordings drift apart at the
  first edit. Out of scope, left alone.
- **`/home/user/uroboros/agents/reviewer.md`**, check 3 (lines 49–59): judges
  the tests against the intent and reads no handoff. It makes no claim about
  how a failure is proved. The issue puts the reviewer's behaviour out of scope
  explicitly.
- **`/home/user/uroboros/agents/researcher.md`**, "The test plan" (50–77): owns
  whether/what/how/what-counts-as-done/what-is-already-red. Nothing about how
  the test-author proves a failure. No contradiction.
- **`/home/user/uroboros/.claude/workflows/uroboros-loop.js`**, lines 142–148
  and 156–163: builds the test-author's prompt. It hands over the issue
  directory, points at the Test Plan section as the work order, and names the
  handoff path. Silent on failure proof, so nothing there contradicts the new
  text and nothing there needs to change.
- **`/home/user/uroboros/README.md`**, line 37 of the mermaid diagram
  ("turns the planned cases into failing tests") and lines 56–60 (whether/what/
  how is the researcher's call, the test-author writes those cases and no
  others). Both still true after the change. No edit.
- **`/home/user/uroboros/CLAUDE.md`**, line 27: names the four agents the loop
  runs. Untouched by this.
- **`/home/user/uroboros/.claude/rules/agents.md`** — path-scoped to `agents/`,
  so it loads for whoever edits this file. It governs frontmatter, the agent
  list in `plugin.json`, and the "the page is the interface" principle: what
  the page says the agent may not do is not asked of it, and a duty exists
  because the page states it. Adding a duty to the page is exactly how that
  principle says a duty comes into existence. No edit needed, and no
  `plugin.json` change either, because no file is added or removed.
- **`/home/user/uroboros/.claude/rules/docs.md`** — path-scoped to `docs/`, so
  it does not formally bind `agents/test-author.md`. Its three rules (one
  instruction per sentence, imperative, state each rule once) are the house
  voice all the same, and the wording below obeys them. "State each rule once"
  is why edit 1 deletes "Quote the failure in your handoff." — see below.

**Conclusion for criterion 6:** no other page makes a claim this change
contradicts. The change is confined to `agents/test-author.md`. That is the
reason, recorded.

## Environment

Everything anyone downstream needs to run this work. Nobody after me may
research the codebase, so this list is complete on purpose.

- **The whole suite:** `bash test.sh`, run from `/home/user/uroboros`.
  **Use `bash test.sh`, not `./test.sh`** — the file is mode `644`, not
  executable, so `./test.sh` dies with "Permission denied". The acceptance
  criterion spells it `./test.sh`; the runnable form of the same command is
  `bash test.sh`, and that is what goes in the closed list below. Do not
  `chmod +x` anything to make the literal spelling work; that is a repository
  change no criterion asked for.
  `test.sh` runs six suites in order — `test-repo.sh`, `test-plugin.sh`,
  `test-worktree.sh`, then `npm test` in `tools/argus`, `tools/argus-ui`,
  `tools/log-parser` — and prints `PASS: all 6 suites` / `FAIL: n of 6
  suite(s)`, exiting 0 only when all six pass. It takes a few minutes, almost
  all of it in `test-plugin.sh`.
- **A single suite:** `bash test-repo.sh`, `bash test-plugin.sh`,
  `bash test-worktree.sh`, or `npm --prefix tools/argus test --silent`
  (likewise `tools/argus-ui`, `tools/log-parser`).
- **Prerequisites:** `test-plugin.sh` shells out to the real `claude` CLI
  (`claude plugin validate`, `claude plugin marketplace add`, `claude plugin
  install`). It is on the PATH here (`/opt/node22/bin/claude`), as are `node`
  v22.22.2 and `npm`. The three Node packages are zero-dependency, so no
  `npm install` step is needed first.
- **Linter: there is none.** No ESLint, Prettier, EditorConfig or any other
  linter config exists anywhere in the tree, and no `package.json` declares a
  `lint` script. Do not go looking for one.
- **Formatter: there is none.** Markdown here is hand-wrapped; the width rule
  is under "Style constraints" below.
- **Git hook:** `.githooks/pre-push` refuses a push whose target is `main` or
  `master`. Irrelevant to this change, but it will fire if anyone tries to push
  the default branch. The current branch is
  `claude/issue-plan-token-comparison-qf8vs0`.
- **Single-file test command: there is none, because there are no tests.**

### What is already red

I ran `bash test.sh` on the current checkout, before any change. Result:
**`FAIL: 1 of 6 suite(s)`**, exit 1.

The failing suite is `test-worktree.sh`, at exactly one case. Re-run alone
(`bash test-worktree.sh`) to confirm:

```
=== what the plugin keeps doing inside a worktree
To /tmp/tmp.pUSloJqZjM/remote.git
 ! [remote rejected] HEAD -> main (shallow update not allowed)
error: failed to push some refs to '/tmp/tmp.pUSloJqZjM/remote.git'
  ok   — the guard set on the main checkout is in effect in the worktree
  ok   — a push to the default branch from inside a worktree is refused
  FAIL — a push to the run's own branch from inside a worktree succeeds
  ok   — the rulebook reaches a session whose project directory is a worktree
  ok   — the self-check reports the guard as set from inside a worktree

FAIL: 1 of 9 cases
```

The cause is the environment, not the repository: this checkout is a shallow
clone (`git rev-parse --is-shallow-repository` prints `true`), and git refuses
to push from a shallow clone into the scratch remote that test builds —
"shallow update not allowed". The other five suites pass; `test-repo.sh` was
re-run alone and reports `PASS: 6 cases`.

**This failure is pre-existing and nobody's job in this run.** A prose edit to
an agent page cannot cause it and cannot fix it. Acceptance criterion 7 is
therefore met by "the suite is exactly as red as it was before the change, and
that one failure is the shallow-clone case recorded here": report the command,
the exit code and that case, name it pre-existing, and move on. Do not try to
fix `test-worktree.sh`, and do not unshallow the clone. Any *other* red in that
run belongs to this change and must be fixed before returning.

## Implementation plan

### Style constraints the wording must satisfy

- **Wrap the body at 80 columns.** The longest body line in the file today is
  81 characters; the file otherwise sits at 78–80. Match that. Continuation
  lines of a numbered step are indented three spaces, as they are now.
- **Imperative, second person, short sentences.** Prose paragraphs, not
  bullets: the four numbered steps are paragraphs, and a nested list inside
  step 4 would read as exactly the mechanical checklist criterion 5 forbids.
- **No new heading, no new section, no template, no table, no new term of
  art.** Two edits inside existing text, nothing more.
- **Budget.** The body is 527 words today. The change adds roughly 80. If a
  draft runs much past that, cut it rather than keep two sentences that say the
  same thing.

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
   plan names, and decide for each one which kind of failure it is: the
   behaviour is missing, or something else. Something else is an import error,
   a typo, a fixture that never loaded, or an expected value that differs from
   the actual one only in formatting — a separator, a locale, whitespace, an
   ordering. Any of those is your own bug, not the missing behaviour: fix your
   test and run it again before you return. It stays red, so correcting it is
   not making it pass. A failure you cannot explain goes into your handoff as
   an open question instead of into the commit as if it were fine. The suite
   and the linter are not yours to run; the implementer runs what the plan
   lists once the code exists.
```

This is a draft, not a dictation — the implementer owns the final rhythm and
may re-cut the sentences. Every one of these has to survive in some form, and
here is what each is for:

- **"decide for each one which kind of failure it is: the behaviour is
  missing, or something else"** — the classification half of criterion 1. The
  evidence half (the actual output) lives in edit 2, so that the rule is
  stated once; see the note under that edit.
- **The list of what "something else" is, ending in the formatting mismatch**
  — criterion 2. Keep the four formatting examples (separator, locale,
  whitespace, ordering): the exact failure the issue was filed over is a test
  comparing an unformatted number against formatted output, and a bare phrase
  like "a wrong expectation" would not have caught it.
- **"fix your test and run it again before you return"** — criterion 3.
  "Before you return" is the load-bearing part; without it the duty is
  satisfiable by writing a note and leaving the red test for the review.
- **"It stays red, so correcting it is not making it pass."** — this settles
  the apparent conflict with the Boundaries bullet below, which says "You never
  make a test pass. The implementer does that". Without this sentence a careful
  agent reads that boundary as forbidding the fix criterion 3 demands, and the
  page contradicts itself. Do not drop it, and do not solve the conflict by
  editing the Boundaries block instead: the boundary is correct as it stands
  and is the kind of prohibition `.claude/rules/agents.md` requires a page to
  state explicitly.
- **"A failure you cannot explain goes into your handoff as an open question
  instead of into the commit as if it were fine."** — criterion 4, both halves
  of it: the open question, and the refusal to commit it as fine.
- **The closing sentence about the suite and the linter** — unchanged from the
  current text. It is a separate rule that happens to live in this step. Keep
  it verbatim.

Deliberately dropped from the current text:

- "— not an import error, not a typo": those two examples move into the fuller
  list of wrong reasons. Nothing is lost, and the rule is stated once.
- "Quote the failure in your handoff.": the duty to record the output moves to
  the handoff section, which is where the contents of the handoff file are
  specified. See edit 2.

### Edit 2 — the handoff section (lines 56–58)

Current sentence:

```
Walk the test plan case by case: which test file and test name each case
became, its failure output, and for anything you did not write, which case it
was and why.
```

Replacement:

```
Walk the test plan case by case: which test file and test name each case
became, its actual failure output and which kind of failure that is, and for
anything you did not write, which case it was and why.
```

Reason: this sentence is the contents list of the handoff file, so it is the
right place for "the handoff records the actual failure output and names the
kind" — the whole of criterion 1's evidence demand. Putting it here and taking
"Quote the failure in your handoff." out of step 4 keeps the rule in one place
instead of two half-statements that drift apart at the next edit. "actual" is
doing work: it is what rules out pasting a red bar or a paraphrase.

Re-wrap the paragraph to 80 columns after the change; the sentence grows by
about six words.

### Explicitly not done, and why

- **The frontmatter is not touched.** The `description` already says the agent
  writes failing tests and commits its handoff, and no criterion asks for a
  change there. Prose no criterion asked for is a reviewer finding.
- **`model: sonnet` stays.** `.claude/rules/agents.md` asks that a pinned model
  tier be justified on the page, and this one is not justified in the body.
  That is a pre-existing gap from commit `5c853af`, unrelated to this issue.
  Left alone deliberately.
- **The Boundaries block stays exactly as it is.** Reasoning under edit 1.
- **`agents/implementer.md` stays as it is.** Reasoning in the module map.
- **`.claude-plugin/plugin.json` stays as it is.** No file is added or removed,
  so the declared `agents` list still matches the tree and `test-plugin.sh`'s
  check on it still passes.
- **Nothing is made executable.** `test.sh` keeps mode 644; the runnable
  spelling is `bash test.sh`.

## Test plan

### Whether: no tests

This change is prose in an agent page and nothing else. Nothing a tool can
check about it is worth checking. **The test-author is not needed for this
issue.**

The reasoning, so the omission reads as a decision and not as a gap: the
repository's suites check structure, never wording. `test-plugin.sh` verifies
that `plugin.json`'s `agents` list matches the files in `agents/` exactly, that
`claude plugin validate` accepts every agent page, and that the self-check
counts the reachable agents — all of which turn on the file list and the
frontmatter, neither of which this change touches. `test-repo.sh` checks
licence consistency and the deployment surface. `test-worktree.sh` checks
worktree behaviour. Nothing anywhere reads the body of an agent page.

A test could only be written by grepping `agents/test-author.md` for chosen
words — "formatting", "open question", "still red". Such a test would pin the
exact wording of a paragraph whose whole value is that a future editor can
rephrase it, it would pass for a page that contained those words in a sentence
meaning the opposite, and it is precisely the "new machinery" criterion 5 rules
out. The issue's own default says this outcome is acceptable and asks me to say
so instead of inventing a test. So: none.

Criteria 1 through 6 are verified by reading the diff. Criterion 7 is verified
by the one command below.

### What: nothing

No cases, no files, no framework, no levels. Left untested on purpose: the
wording of the new sentences, and the fact that the diff touches one file —
both of them a reading, done by the reviewer against the criteria.

### How: not applicable

There are no cases, so there is no level, no test file, no framework, no
convention to follow and no single-file command.

### What counts as done — the closed list

```
bash test.sh
```

That is the whole list. Run it from `/home/user/uroboros`. Nothing else gets
run: there is no linter and no formatter, and there is no single-file test
command because there are no tests.

Expect **exit 1** with `FAIL: 1 of 6 suite(s)`, the single failing case being
`test-worktree.sh`'s "a push to the run's own branch from inside a worktree
succeeds", for the shallow-clone reason recorded under "What is already red".
That is the pre-change baseline, it is not this change's defect, and it does
not block `done`. Report the command, what it covered and the exit code — never
"green". Any other red in that run belongs to this change.

This command is in the list only because acceptance criterion 7 names it.
