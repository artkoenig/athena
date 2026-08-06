# Researcher handoff — the test-author must prove why a test fails

## The decision in one paragraph

This is a prose change to one agent page. `agents/test-author.md` step 4
already tells the agent to confirm each test fails "because the behaviour is
missing — not an import error, not a typo", but it demands no evidence and
says nothing about what to do when the reason is wrong. The change replaces
that step with two: one that names the right reason and the wrong ones
(formatting mismatches included), and one that puts a wrong reason on the
test-author to fix and re-run, and an unexplainable failure into the handoff as
an open question. The handoff section is extended by three words so the record
carries the actual output and the kind. Nothing else in the repository changes:
no other page contradicts this, and I checked the ones that could.

## Module map

| Path | What it holds | Entry point for this change |
| --- | --- | --- |
| `agents/test-author.md` | The test-author's whole brief: frontmatter, the four-step "How you work" list, "Boundaries", "Your handoff". | Lines 34-38 (step 4, "Prove the failures") and line 58 (the sentence in "Your handoff" that lists what each case's entry carries). |
| `agents/implementer.md` | The implementer's brief. Step 3 (lines 21-27) says it runs the tests, confirms they fail for the right reason, may not edit them, and puts a test it believes wrong in its handoff. | Read only — checked for contradiction, none found. No edit. |
| `agents/reviewer.md` | The reviewer's brief. Rejects a red suite (lines 38-44), judges tests against the intent (lines 45-59), writes no tests (lines 74-79). | Read only — the issue puts the reviewer out of scope. No edit. |
| `agents/researcher.md` | The researcher's brief, including the test plan the test-author works from. Says nothing about how failures are proved. | Read only. No edit. |
| `.claude/rules/agents.md` | Path-scoped rules for `agents/**`: one flat `<name>.md` per agent, declared in `plugin.json`; frontmatter fields; "the page is the interface". | Read only — the edit keeps the file flat and the frontmatter untouched, so the plugin suite stays green. No edit. |
| `.claude/rules/docs.md` | Rules for Markdown under `docs/`: one instruction per sentence, imperative, **state each rule once**. | Not binding on `agents/` by its own path scope, but the "state each rule once" principle drove where the handoff requirement is stated. No edit. |
| `README.md` lines 49-66 | Describes the loop and who decides testing. Says the test-author "turns the planned cases into failing tests" and "writes those cases and no others". | Read only — unaffected by this change. No edit. |
| `.claude/workflows/uroboros-loop.js` lines 143-163 | Builds the test-author's prompt: issue directory, the Test Plan section as work order, the handoff path. | Read only — the prompt carries no claim about proving failures. No edit. |
| `test.sh`, `test-repo.sh`, `test-plugin.sh`, `test-worktree.sh` | The suites. None of them reads the prose of an agent page. | Read only. No edit. |

## Why the change is confined to `agents/test-author.md`

Criterion 6 asks for this check explicitly, so here is the result, page by
page.

- **`agents/implementer.md`** — step 3 says "Run them and confirm they fail for
  the right reason before you change anything" and "A test you believe wrong
  [...] are notes in your handoff for the reviewer". That is the implementer's
  own duty over tests it may not edit, and it stays true after this change: the
  test-author now fixes wrong reasons it can see, the implementer still checks
  and still reports rather than edits. No contradiction, no edit.
- **`agents/reviewer.md`** — rejecting a red suite stays correct (issue, Out of
  scope), and nothing on that page claims the test-author's failures are the
  review's to diagnose. No contradiction, no edit.
- **`agents/researcher.md`** and **`README.md`** — both describe who decides
  the testing, not how a failure is proved. No contradiction, no edit.
- **`.claude/workflows/uroboros-loop.js`** — the test-author's prompt names the
  work order and the handoff path only. No contradiction, no edit.

The one tension is inside the page being edited: "You never make a test pass"
under **Boundaries** could be read as forbidding the test-author from touching
a test it already wrote. The fix is a sentence in the new step 5 that separates
the two — correcting an assertion leaves the test red, so it is not making it
pass — rather than weakening the boundary line, which must stay verbatim
because it is the guarantee the whole loop rests on.

## Implementation plan

Two edits, both in `agents/test-author.md`. No other file changes.

### Edit 1 — replace step 4 with two steps

Replace lines 34-38 verbatim:

```
4. **Prove the failures.** Run your own tests with the single-file command the
   plan names, and confirm each fails because the behaviour is missing — not an
   import error, not a typo. Quote the failure in your handoff. The suite and
   the linter are not yours to run; the implementer runs what the plan lists
   once the code exists.
```

with:

```
4. **Prove why each test fails.** Run your tests with the single-file command
   the plan names and read every failure. The behaviour being missing is the
   only right reason: an import or syntax error, a missing fixture, a typo in a
   name, and an expected value that differs from the actual only in formatting
   — a separator, a locale, whitespace, the order of a list — are all the wrong
   one, however red they look.
5. **Fix a wrong reason yourself.** Correct your own test and run it again
   before you return, instead of leaving it for the review, which spends a
   whole correction round on one assertion. Correcting an assertion is not
   making a test pass: the test stays red, now for the right reason. A failure
   you cannot explain is an open question in your handoff, named as that test
   and that output, not a test committed as if it were fine. The suite and the
   linter are not yours to run; the implementer runs what the plan lists once
   the code exists.
```

Notes for whoever types this:

- The wording above is a draft in the page's voice, not a fixed string. Change
  a word if it reads better, but keep every clause: each one carries a
  criterion (see the map below), and dropping one loses that criterion.
- "Quote the failure in your handoff" is deliberately gone from the step. The
  record of the failure now stands once, in "Your handoff" (Edit 2), because
  `.claude/rules/docs.md` says a rule stated twice drifts, and this rule is
  about the shape of the report.
- The last sentence of the old step 4 ("The suite and the linter are not yours
  to run...") is preserved word for word at the end of the new step 5. It must
  not be lost.
- Keep the list of wrong reasons as running prose with commas and an em dash,
  as drafted. Do not turn it into a bullet list or a checkbox list: criterion 5
  rules out "checklists the agent has to fill in mechanically", and no other
  step on any agent page uses a nested list.
- Numbering: the "How you work" list becomes five steps. Nothing anywhere in
  the repository refers to these steps by number — I grepped for it — so the
  renumbering breaks nothing.

### Edit 2 — the handoff section records the output and the kind

In the "Your handoff" section, line 58, replace:

```
commit it with the tests. Walk the test plan case by case: which test file and
test name each case became, its failure output, and for anything you did not
write, which case it was and why.
```

with:

```
commit it with the tests. Walk the test plan case by case: which test file and
test name each case became, its actual failure output and which kind of
failure that is, and for anything you did not write, which case it was and
why.
```

That single sentence is what makes criterion 1 checkable in the handoff, and it
is the only place the recording duty is stated.

### Formatting constraints

- Wrap the body at 80 columns or less. The current body's longest lines are 80
  and 81 characters; stay at or under 80 for new text.
- Do not touch the frontmatter. `name`, `description`, `tools`, `model` and
  `color` stay exactly as they are: no criterion asks for a description change,
  and the reviewer treats prose no criterion asked for as a finding. The page
  stays a flat `agents/test-author.md`, already declared in
  `.claude-plugin/plugin.json`, so the plugin suite's manifest-versus-tree
  check is unaffected.
- Leave the **Boundaries** section untouched, in particular "You never make a
  test pass." The reconciliation lives in step 5, as explained above.
- Leave the correction-round paragraph (lines 40-43) untouched.

### Criterion-to-sentence map

| Criterion | Where it lands |
| --- | --- |
| 1 — handoff records the actual failure output and names the kind | Edit 2, the "Your handoff" sentence; the two kinds themselves are named in the new step 4. |
| 2 — names the wrong kinds, formatting mismatch among them | New step 4: "an import or syntax error, a missing fixture, a typo in a name, and an expected value that differs from the actual only in formatting — a separator, a locale, whitespace, the order of a list". |
| 3 — the test-author fixes its own test and re-runs before returning | New step 5, first two sentences. |
| 4 — an unexplainable failure is an open question, not a silent commit | New step 5, third sentence. |
| 5 — the existing voice, no machinery, no mechanical checklist | Prose only, imperative, no new section, no bullet list, no template to fill in. |
| 6 — confined to `agents/test-author.md` | See "Why the change is confined" above; no other page contradicts, so no other page is edited. |
| 7 — `./test.sh` green | Nothing structural changes, and no suite reads this prose; the implementer still runs it (see Environment). |

## Rejected alternatives

- **A new "Diagnosing a failure" section on the page.** Rejected: criterion 5
  rules out new machinery, and the page's four-step list is the natural home
  for a rule about running the tests.
- **A table or checklist of failure kinds the agent ticks off.** Rejected by
  criterion 5 explicitly, and by the fact that no agent page in this repository
  uses one.
- **Weakening the boundary "You never make a test pass" to allow the fix.**
  Rejected: that line is the loop's guarantee that tests are not bent to the
  implementation. A sentence in step 5 that says a corrected test stays red
  resolves the tension without touching the guarantee.
- **A grep-based case in `test-repo.sh` asserting the page contains certain
  words.** Rejected: it tests wording, not behaviour, and it would go red the
  first time someone rephrases a sentence that still says the same thing. The
  issue's default (issue.md, last section) allows saying so instead of
  inventing a test, and that is what this plan does.
- **Also editing `agents/implementer.md`** so it stops saying it confirms the
  failure reason. Rejected: that duty is the implementer's own second check on
  tests it may not edit, it does not contradict anything here, and criterion 6
  forbids widening the change without a contradiction.

## Environment

Everything below is runnable from the repository root. Node 22.22.2 and npm
10.9.7 are on the PATH, and the `claude` CLI is installed at
`/opt/node22/bin/claude`.

- **The whole suite:** `bash ./test.sh` — runs `test-repo.sh`,
  `test-plugin.sh`, `test-worktree.sh` and the three Node packages under
  `tools/`, and exits non-zero if any of them fails.
- **A single suite:** `bash ./test-repo.sh`, `bash ./test-plugin.sh`,
  `bash ./test-worktree.sh`, or `npm --prefix tools/argus test --silent` (same
  form for `tools/argus-ui` and `tools/log-parser`).
- **Prerequisites:** `test-plugin.sh` shells out to the `claude` CLI
  (`claude plugin validate`, `claude plugin marketplace add`,
  `claude plugin install`) and needs it on the PATH; it is. The `tools/*`
  packages are zero-dependency, so no `npm install` step is needed before their
  tests run.
- **Linter:** there is none. There is no root `package.json`, no ESLint and no
  Prettier configuration anywhere in the repository.
- **Formatter:** there is none. Line wrapping in the Markdown files is done by
  hand; match the surrounding file.
- **Git hooks:** `core.hooksPath` points at the plugin cache's `.githooks`,
  which holds only a `pre-push` that refuses pushes to `main`/`master`. No
  pre-commit hook runs anything.

## Test plan

**Whether: no tests.** This change is prose in `agents/test-author.md`. No
suite in this repository reads the prose of an agent page — `test-repo.sh`
checks licence claims and the deployment shape, `test-plugin.sh` checks
manifests, frontmatter-bearing components, installation and the session-start
hook, `test-worktree.sh` checks parallel-run plumbing, and the `tools/*`
packages test their own code. The only test one could write against this change
would grep the page for phrases, which pins the wording rather than the
behaviour and goes red on any rephrasing. The issue anticipates exactly this
and accepts it (issue.md, "Assumptions taken as defaults"). So: no test file is
written, no case is added, and criterion 7 is what the existing suite covers.

**What counts as done — the closed list, run from the repository root:**

```
bash ./test.sh
```

That single command is the whole list, because criterion 7 names it. Nobody
downstream runs anything else — no linter (there is none), no individual suite,
no `claude plugin validate` on its own (`test-plugin.sh` already runs it).

**What is already red:** I did not run the list, and I have no evidence that
anything in it is currently red. Report the exit code you actually get; a
failure in `tools/` or in the plugin suite would be untouched by this change
and belongs in the handoff as pre-existing, with its output.
