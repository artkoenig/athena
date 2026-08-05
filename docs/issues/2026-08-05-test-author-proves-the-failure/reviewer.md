# Review — round 0

Issue: `docs/issues/2026-08-05-test-author-proves-the-failure/issue.md`
Diff reviewed: `git diff main` on branch `claude/offene-issues-ots4ej`
(HEAD `ed74f84 Make the test-author prove why a test fails`).

## Review Status

**Rejected — 1 finding requires a correction.**

The prose change hits every acceptance criterion as written, and the suite is
green by exit code. The one finding is a contradiction the change introduces
*inside* `agents/test-author.md`: it tells the agent to correct its own wrong
assertion and re-run, explicitly for the case where "the behaviour is very
likely already there" — a case whose re-run is green — while two other
sentences on the same page (one of them also touched by this diff) require a
failure output for every test written and forbid making a test pass. No
sentence resolves which instruction wins, and the next agent's page
(`agents/implementer.md:17`) assumes the tests it receives are failing.

## Facts established by running things

One command, both runners chained, each reporting its own exit code:

```
bash test.sh 2>&1 | tail -40; echo "suite ${PIPESTATUS[0]}"
```

- `bash test.sh` — **exit 0**, final line `PASS: all 6 suites`. This is the
  command the issue names in the last criterion (`./test.sh` is green), and
  `test.sh`'s own header comment calls it "the one command behind 'the suite is
  green'".
- What it covered, as the suites reported themselves in that run:
  - `the repository itself` (`test-repo.sh`) — `PASS: 6 cases`
  - `the plugin: manifests, session-start hook, push guard` (`test-plugin.sh`)
    — `PASS: 39 cases`
  - `parallel runs: worktrees` (`test-worktree.sh`) — `PASS: 9 cases`
  - `tools/argus` (`npm --prefix tools/argus test`) — node TAP, all `ok`; my
    capture of the headline lines was truncated at `ok 42`, so I can state
    "at least 42 cases, no `not ok`" rather than an exact total.
  - `tools/argus-ui` (`npm --prefix tools/argus-ui test`) — all `ok`, no
    `not ok`; exact total likewise not captured.
  - `tools/log-parser` (`npm --prefix tools/log-parser test`) —
    `# tests 23 # pass 23 # fail 0`.
  - Nothing was skipped or excluded: `# skipped 0 # todo 0 # cancelled 0` in
    the node suites, and the aggregate line reports all 6 of the 6 suites
    `test.sh` declares.
- **Static analysis: there is none in this project.** How I looked: there is no
  root `package.json` (`ls /home/user/uroboros/package.json` → "No such file or
  directory"); the three package manifests under `tools/*/package.json` declare
  only `start`, `dev`, `test` and `demo` scripts — no `lint`, no `eslint`, no
  `prettier` (`grep -n '"scripts"' -A6 tools/*/package.json`); and `test.sh`
  runs no analyser. So the suite above is the whole of the automated evidence,
  and `agents/researcher.md:26` ("There is no linter") is the documented shape
  of that answer in this repository.
- **No test accompanies this change, and none could be expected to.** The diff
  touches one Markdown agent page and no test file
  (`git diff main --stat`: `agents/test-author.md`, plus the two handoff files
  in the issue directory, which are out of scope for this review). The issue
  itself takes that as an accepted default: *"if nothing in the repository can
  check it beyond the existing plugin suite, that is an acceptable outcome"*
  (`issue.md:37`). There is also no `test-author.md` handoff in the issue
  directory, which is the loop behaving as written — `.claude/workflows/
  uroboros-loop.js:117-121` dispatches the test-author only when the
  researcher returns `needsTests: true`. I record that as a fact, not a
  finding: no criterion asks for a test, and check 2 below therefore carries
  this review.

## Criterion-by-criterion

Line numbers refer to `agents/test-author.md` at HEAD `ed74f84`.

1. **"requires, for every test written, that the handoff record the actual
   failure output and name which kind of failure it is: the behaviour is
   missing, or something else."** — **Met.** Step 4 (lines 32-35): *"Run every
   test you wrote, one at a time, and put its actual failure output in your
   handoff — the assertion, the message, the line — and name which kind of
   failure it is: the behaviour is missing, or something else. A red bar is not
   evidence. The output is."* The handoff section repeats the obligation in the
   file's own required contents (line 75), so the requirement exists both where
   the work is described and where the deliverable is specified. The weak
   sentence the issue named as the root cause ("Prove it in your report with
   the failure summary") is gone.
2. **"names the failure kinds that do NOT count as the right reason, and a
   formatting-only expected/actual mismatch — separators, locale, whitespace,
   ordering — is one of them."** — **Met.** Lines 44-51 name: an import that
   does not resolve, a misspelled name, a fixture or prerequisite that never
   ran, a test that errors before its assertion, and an expected value that is
   simply wrong; then the formatting case explicitly, with all four examples
   the criterion lists — *"a thousands separator, a locale, whitespace, the
   order of a list"*. Every example the criterion asked for is present.
3. **"states what happens when a test fails for the wrong reason: the
   test-author fixes its own test and re-runs it before returning, rather than
   leaving it for the review."** — **Met as written.** Lines 53-57: *"A test
   that fails for one of those reasons is yours to fix, before you return:
   correct the test, run it again, and record the output of that run. You do
   not leave it red for the implementer to trip over or for the review to
   catch."* (The finding below is about a state this instruction can reach, not
   about the instruction being absent.)
4. **"a test whose failure the test-author cannot explain is reported as an
   open question in the handoff instead of being committed as if it were
   fine."** — **Met.** Lines 59-61, near-verbatim, and it goes one step further
   by requiring the observed output and the expectation alongside the question.
5. **"the wording stays in the voice of the existing agent pages: short, plain,
   no new machinery, no checklists the agent has to fill in mechanically."** —
   **Met.** Three short paragraphs under one `##` heading, second person,
   declarative, no template, no numbered form to fill in, no new artefact or
   file. The heading style ("## The right reason, and the wrong ones") matches
   the sibling pages (`agents/reviewer.md` has "## The reproduction rule",
   "## Production code is not yours to touch"). Added lines wrap at 76-81
   columns, the same width as the untouched lines around them (pre-existing
   lines 14 and 22 are already 81-82 columns), so no formatting convention is
   broken.
6. **"confined to `agents/test-author.md` unless another page makes a claim
   this contradicts."** — **Met on the letter, with one caveat carried into the
   finding.** The only non-handoff file in the diff is
   `agents/test-author.md`. I checked every place in the repository that speaks
   about the test-author (`grep -rn "test-author"` outside `docs/issues/`):
   `agents/reviewer.md:44,67,71`, `agents/implementer.md:3,14,17`,
   `agents/researcher.md:12,24,31-40`, `.claude/rules/agents.md:46`,
   `skills/grill/SKILL.md:34`, `README.md:37,50`, `CLAUDE.md:27`,
   `GEMINI.md:27`, `.claude-plugin/plugin.json:25`,
   `.claude/workflows/uroboros-loop.js:7,118,131`. None of them asserts
   anything the new text denies: the reviewer still says the tests were written
   blind from the intent; the researcher still supplies "the command that runs
   a single test file" (`agents/researcher.md:24`), which is exactly what the
   new "one at a time" needs; the README diagram still describes the
   test-author as turning criteria into failing tests. The caveat is
   `agents/implementer.md:17`, which presumes the tests it is handed are red —
   see the finding.
7. **"`./test.sh` is green."** — **Met**, exit 0, evidenced above.

## Anything in the diff no criterion asked for?

- `"one at a time"` in step 4 is new and no criterion says it. I do not raise
  it as a finding: per-test failure output (criterion 1) is not obtainable from
  a single aggregate run, so the phrase serves a criterion directly, and
  `agents/researcher.md:24` already guarantees the single-file command the
  instruction depends on.
- The handoff-contents sentence (line 75) grew by one clause. That clause is
  criterion 1's requirement landing in the deliverable spec; asked for.
- Nothing else. No code, no configuration, no dependency, no other page.

## Findings

### Finding 1 — a corrected test that turns green has no instruction, and three sentences on the page then disagree

**Where:** `agents/test-author.md`, the interaction of lines 48-51 and 53-57
(both added by this diff) with line 75 (also changed by this diff) and line 67
(unchanged).

**Violates which criterion:** none directly. Criteria 1-4 are each satisfied by
the text as written; this is a coherence defect the new text introduces, of the
exact class the issue was filed to remove (an ambiguity that costs a
correction round). Criterion 6 is the nearest relative, because the same gap
reaches `agents/implementer.md:17`.

**Reproduction (a spec, in words — no file was written):**

- *State:* a criterion says "the report prints the total with thousands
  separators". The test-author, working blind from the intent as its page
  requires, writes `assert.equal(render(total), "1234567")` — the expected
  value missing the separators. The production code already formats with
  separators, so the run produces `expected "1234567", actual "1,234,567"`.
- *The page's own reading of that:* lines 48-51 say precisely this case is the
  test-author's defect and that *"the behaviour is very likely already there
  and your assertion is what is broken"*.
- *The instructed action:* lines 53-57 — *"correct the test, run it again, and
  record the output of that run."* The corrected assertion is
  `"1,234,567"`, and the re-run **passes**.
- *The wrong result — three instructions the agent now cannot satisfy
  together:*
  1. Line 75 requires the handoff to carry *"for every test you wrote its
     failure output with the kind of failure it is"*. The corrected test has no
     failure output. The agent must either paste the stale pre-fix failure
     (which now misrepresents the state of the suite to the implementer and
     the reviewer) or silently omit the test from the very record this change
     exists to guarantee.
  2. Step 4 (lines 32-35) has the same shape: it demands the actual failure
     output for *every* test it wrote.
  3. Line 67 (unchanged): *"You never make a test pass."* Fixing the assertion
     did exactly that. A reader can charitably scope that sentence to
     "you do not write production code" — but nothing on the page says so, and
     the diff is what created the collision.
- *Blast radius, same reproduction:* the implementer is briefed by
  `agents/implementer.md:17` to *"find the failing tests. Run them and confirm
  they fail for the right reason before you change anything"*. Handed a green
  test recorded with a stale red output, it cannot confirm anything, and its
  page gives it no path other than a note for the reviewer — which is the
  correction round the issue set out to save. Criterion 4's escape hatch does
  not cover this: a passing test is not "a failure you cannot explain".
- *Expected result:* the page resolves the green case in one sentence, in its
  own voice — e.g. that a corrected test which now passes means the behaviour
  already exists, that the agent does not doctor it back to red, and that it
  says so in the handoff (the criterion may already be met) instead of
  reporting a failure it no longer has. If that resolution makes
  `agents/implementer.md:17` stale, criterion 6 already authorises correcting
  that page too, with the reason recorded in the handoff.

## Beyond the criteria — what else could this change break?

Traced, and stated even where the answer is nothing:

- **Callers of the changed page.** The page is dispatched by
  `.claude/workflows/uroboros-loop.js:117-121` and `:127-133`. Both hand it
  only the issue directory (and, in a correction round, "the reviewer's
  reproduction spec is your criterion"). The new text adds no input the
  dispatch does not already provide: it needs a single-test command, which
  `agents/researcher.md:24` puts in the researcher's handoff, and the page
  already told the agent to report a missing environment fact rather than go
  looking (lines 22-25). No breakage found.
- **The declared-agents self-check.** `test-plugin.sh:139-155` and the
  `plugin.json` `agents` list care about which files exist under `agents/`, not
  their contents. No file was added or removed, and `test-plugin.sh` passed
  (39 cases). No breakage.
- **Documents this makes stale.** `README.md:37,50`, `CLAUDE.md:27`,
  `GEMINI.md:27`, `.claude/rules/agents.md:46` and `skills/grill/SKILL.md:34`
  all describe the test-author at a level the change does not touch (it writes
  failing tests, it has never seen the implementation, it is one step in the
  chain). None became false. The one page that leans on an assumption the
  change can now break is `agents/implementer.md:17`, folded into Finding 1
  rather than raised twice.
- **The agent's own frontmatter** (`agents/test-author.md:3`) still describes
  the role accurately — it writes failing tests before implementation and
  commits tests plus handoff. It does not mention the new evidence duty, but
  `.claude/rules/agents.md` asks the description to say what the agent does,
  when to dispatch it and what not to use it for; the evidence duty changes
  none of those three. Not a finding.
- **Runtime cost.** "One at a time" makes the test-author run N single-file
  commands instead of one suite run. That is a token and wall-clock cost, not a
  breakage, and it is the price criterion 1 asks for. Not a finding.

## What I did not do

I wrote no test and no production change. Nothing outside this file was
modified; the working tree was clean before and after, and every other state I
needed I read with `git diff` / `git show`.
