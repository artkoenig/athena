# Researcher handoff — the test-author must prove why a test fails

## Summary

A prose change to one file: `agents/test-author.md`. The page already demands
that every test fail "because the behaviour is missing — not an import error,
not a typo", but it asks only that the failure be quoted. It never says the
handoff must carry the *actual* output, never names the wrong-reason kinds
beyond two examples, never says who repairs a test that failed for the wrong
reason, and never says what to do with a failure the test-author cannot
explain. This change closes those four holes and keeps the page in its own
voice.

No production code, no tests. See "Test plan" for why, and for the one command
that counts.

## Module map

- `/home/user/uroboros/agents/test-author.md` — **the only file this change
  touches.** Frontmatter (`name`, `description`, `tools: Read, Write, Edit,
  Bash`, `color`), then the body: an opening paragraph, `## How you work` with
  four numbered steps (4. **Prove the failures.** is the one at issue), a
  paragraph on correction rounds, `## Boundaries` (three bullets), and
  `## Your handoff`. Lines are hard-wrapped at ~78 columns. Steps are bold
  imperative headings followed by two to five plain sentences; there is no
  checklist anywhere on the page and none is to be added.
- `/home/user/uroboros/agents/implementer.md` — read, not changed. Its step 3
  says the implementer runs the tests, "may not edit a test and may not write
  one", and puts a test it believes wrong into its handoff as a note. That
  stays true: the test-author's repair happens one role earlier, before the
  implementer ever runs.
- `/home/user/uroboros/agents/reviewer.md` — read, not changed. It makes no
  claim about who fixes a test; a red suite it caused stays its first finding.
- `/home/user/uroboros/agents/researcher.md` — read, not changed. It owns the
  test plan; nothing here touches that.
- `/home/user/uroboros/README.md`, `/home/user/uroboros/CLAUDE.md`,
  `/home/user/uroboros/.claude/rules/agents.md`,
  `/home/user/uroboros/skills/grill/SKILL.md`,
  `/home/user/uroboros/.claude/workflows/uroboros-loop.js` — every other place
  that names the test-author. Checked, all four criteria compatible: the README
  says it "turns the planned cases into failing tests" and "writes those cases
  and no others" (repairing an assertion of its own is still the same case,
  still red); the loop script only hands it the issue directory, the work order
  and the handoff path; `rules/agents.md` governs page structure and the
  `plugin.json` agent list, which this change does not alter; `grill` mentions
  it only in passing. **No other page contradicts this change, so per
  acceptance criterion 6 the change stays confined to
  `agents/test-author.md`.**

## Environment

- **Whole suite:** `./test.sh` from the repository root (`bash test.sh` works
  from anywhere; the script resolves its own root). It chains six suites:
  `test-repo.sh`, `test-plugin.sh`, `test-worktree.sh` and `npm test` in
  `tools/argus`, `tools/argus-ui`, `tools/log-parser`. Prerequisites: `node`
  and `npm` on PATH, and the `claude` CLI on PATH (`test-plugin.sh` calls
  `claude plugin validate`). No install step — the tools are
  zero-dependency. Runtime: about a minute.
- **Single file:** each suite runs on its own — `bash test-repo.sh`,
  `bash test-plugin.sh`, `bash test-worktree.sh`,
  `npm --prefix tools/argus test`. None of them is relevant to this change;
  listed so nobody has to look.
- **Linter:** there is none. No ESLint, Prettier, markdownlint, editorconfig
  or `lint` script exists anywhere in the repository.
- **Formatter:** there is none. Markdown wrapping is done by hand.
- **Already red:** nothing. I ran `./test.sh` on the current checkout
  (branch `claude/offene-issues-f39bb5`, tip `dd91cbb`) and it ended
  `PASS: all 6 suites`. Any red afterwards belongs to this change.

## Implementation plan

Edit `agents/test-author.md` in three places. Wrap at 78 columns, no trailing
whitespace, no blank-line changes elsewhere. The wording below is the intended
result; keep it unless a sentence reads badly next to its neighbours, and then
change the sentence, not the substance.

### 1. Replace step 4 under `## How you work`, and add a step 5

Current step 4 (lines 33–37) reads:

> 4. **Prove the failures.** Run your own tests with the single-file command
>    the plan names, and confirm each fails because the behaviour is missing —
>    not an import error, not a typo. Quote the failure in your handoff. The
>    suite and the linter are not yours to run; the implementer runs what the
>    plan lists once the code exists.

Replace it with two steps:

```
4. **Prove the failures.** Run every test you wrote with the single-file
   command the plan names, and put its actual output in your handoff — the
   failure the runner printed, not a sentence saying it was red. Then name
   which kind of failure it is, because only one kind counts: the behaviour is
   missing. A test that never reached its assertion did not prove anything —
   an import that does not resolve, a typo, a missing fixture, a broken
   helper. Nor did one whose expected value is simply wrong: an actual and an
   expected that differ only in formatting — separators, locale, whitespace,
   ordering — is your assertion failing, not the feature. The suite and the
   linter are not yours to run; the implementer runs what the plan lists once
   the code exists.
5. **A wrong failure is yours, now.** Fix the test yourself, run it again, and
   record the failure it ends on. Left for the review it costs a whole
   correction round — four agents to change one assertion. If you cannot say
   why a test fails, do not pass it off as proven: it goes in the commit with
   the output you got and an open question in your handoff, for the researcher
   to pick up.
```

Rationale for the split: step 4 is the evidence and the taxonomy, step 5 is
the duty that follows from it. One step carrying both would be the longest on
the page and would bury the repair.

The formatting-mismatch sentence is criterion 2's named case and must stay
explicit, with those four examples (separators, locale, whitespace, ordering).

### 2. Qualify the boundary that says the test-author never makes a test pass

Current bullet (lines 47–48):

> - You never make a test pass. The implementer does that, and may not edit
>   what you wrote.

Without a qualifier, step 5 reads as a contradiction of it — the page would
argue with itself, which is the one thing the reviewer catches for free.
Replace with:

```
- You never make a test pass. The implementer does that, and may not edit what
  you wrote. Repairing a test of your own that failed for the wrong reason is
  not making it pass: it stays red, for the right reason.
```

### 3. Update `## Your handoff`

Current sentence (lines 56–58):

> Walk the test plan case by case: which test file and test name each case
> became, its failure output, and for anything you did not write, which case it
> was and why.

Replace "its failure output" so the handoff carries the evidence and the
verdict, not just a quote:

```
Walk the test plan case by case: which test file and test name each case
became, the output its run actually printed and which kind of failure that is,
and for anything you did not write, which case it was and why.
```

Leave the rest of that section as it stands — "Every gap and conflict you
found in the plan belongs here too" already gives the unexplained failure of
step 5 its place, and step 5 names the handoff itself.

### What not to do

- **Do not touch the frontmatter.** The `description` is accurate as it stands,
  and prose no criterion asked for is a finding.
- **Do not add a checklist, a template, a table or a required section
  heading.** Criterion 5 rules them out, and the page has none today.
- **Do not change any other file.** Criterion 6, and nothing else contradicts.
- **Do not touch `docs/issues/` beyond your own handoff file.**

## Test plan

- **Whether: no tests.** Nothing in this change is checkable by a tool. It is
  prose in one agent page; the repository's suites check manifests, file
  layout, licence claims and the JavaScript tools, and none of them reads the
  body of an agent page — deliberately, since a keyword assertion over prose
  would pin the wording rather than the rule and would go stale on the next
  edit. The issue anticipates exactly this outcome and asks me to say so rather
  than invent a test; I say so. **No test-author round is needed for this
  issue.**
- **What counts as done — the closed list, run from the repository root:**

  ```
  ./test.sh
  ```

  That is the whole list. Nothing else gets run by anyone: there is no linter
  and no formatter, and the change touches no code any other command could
  reach. Criterion 7 asks for exactly this command to be green, and it was
  green before the change.

## Acceptance criteria, mapped

1. Actual failure output plus the kind of failure, per test → step 4 and the
   `## Your handoff` sentence.
2. The kinds that do not count, with the formatting mismatch among them →
   step 4, sentences three and four.
3. The test-author fixes and re-runs its own wrong test before returning →
   step 5, plus the qualified boundary bullet.
4. An unexplained failure becomes an open question instead of being passed off
   as fine → step 5, last sentence.
5. Voice: short, plain, no machinery, no mechanical checklist → prose only,
   the existing step-and-bullet shape, no new section.
6. Confined to `agents/test-author.md` → checked every page that names the
   test-author (module map); none contradicts, so no other page changes.
7. `./test.sh` green → the only command that counts; green at `dd91cbb`.
