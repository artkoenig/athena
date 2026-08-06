# Implementation plan (written by the main session, for comparison)

Issue: `docs/issues/2026-08-05-test-author-proves-the-failure/issue.md`

## Implementation plan

The change is prose in one file, `agents/test-author.md`. Two places move:
step 4 of "How you work", which today demands the right check but no evidence,
and the "Your handoff" paragraph, which today asks only for "its failure
output".

### 1. Rewrite step 4, "Prove the failures"

Current text (lines 34–38):

> 4. **Prove the failures.** Run your own tests with the single-file command the
>    plan names, and confirm each fails because the behaviour is missing — not an
>    import error, not a typo. Quote the failure in your handoff. The suite and
>    the linter are not yours to run; the implementer runs what the plan lists
>    once the code exists.

Proposed replacement:

> 4. **Prove the failures.** Run your own tests with the single-file command the
>    plan names. For every test you wrote, quote the actual failure output in
>    your handoff and name which kind of failure it is: the behaviour is
>    missing, or something else. Something else is a broken test, not a proof —
>    an import that does not resolve, a typo, a fixture that never ran, a suite
>    that never reached your case, and an expected value that differs from the
>    actual one only in formatting: a separator, a locale, whitespace, an
>    ordering. That last one is the expensive one, because it looks like the
>    behaviour is missing. Fix your own test and run it again before you return;
>    a wrong assertion left standing costs a full round of four agents to
>    change. A failure you cannot explain is an open question in your handoff,
>    not something you commit as if it were fine. The suite and the linter are
>    not yours to run; the implementer runs what the plan lists once the code
>    exists.

Why this shape:

- The kinds that do not count are named as a list inside the sentence rather
  than as a checklist, because every other page here states its boundaries in
  prose (criterion: "no new machinery, no checklists").
- The formatting mismatch is called out separately and given its reason,
  because it is the failure mode the issue was filed for and the only one that
  a red bar cannot distinguish from a missing behaviour.
- "Fix your own test and run it again before you return" is the whole of
  criterion 3; no new step, no new section.

### 2. Extend the handoff paragraph

Current text (lines 57–58): "Walk the test plan case by case: which test file
and test name each case became, its failure output, and for anything you did
not write, which case it was and why."

Replacement: "… which test file and test name each case became, its actual
failure output and which kind of failure that is, and for anything you did not
write, which case it was and why."

This is what makes criterion 1 checkable against the artefact the loop
actually reads, instead of only against the agent's behaviour.

### 3. Boundary that must not be contradicted

`agents/test-author.md` line 48 says "You never make a test pass." Fixing a
wrong assertion is not making a test pass, but a reader can take it that way.
Rather than editing the boundary, the new step 4 says "fix your own test" in a
sentence whose subject is a test that is failing for the wrong reason — the
test still fails after the fix, and it now fails for the right one. If the
implementer of this issue judges that too thin, the boundary line becomes
"You never make a test pass by weakening it; the implementer makes it pass."
That is a fallback, not the first choice: the criterion asks for no new
machinery.

### Rejected alternatives

- **A separate "## Evidence" section on the page.** Rejected: it is the
  checklist the criterion forbids, and it duplicates the handoff section.
- **A machine-checkable handoff format** (a table of test name / failure kind).
  Rejected for the same reason, and because nothing in the repository parses
  handoff files.
- **Touching `agents/reviewer.md`** so the reviewer checks the failure kinds.
  Rejected: out of scope by the issue's own words, and the reviewer never
  reads the test-author's handoff.

## Module map

| Path | What it holds | Entry point |
| --- | --- | --- |
| `agents/test-author.md` | The test-author agent's whole brief: frontmatter (`name`, `description`, `tools`, `model`, `color`), "How you work" 1–4, "Boundaries", "Your handoff". | Step 4 at lines 34–38 and the handoff paragraph at lines 55–60. Only these change. |
| `agents/researcher.md` | Owns the test plan the test-author executes; its "What is already red" section explicitly leaves the first run downstream. | Read only, to confirm no contradiction. None found: it never claims a red bar is sufficient. |
| `agents/reviewer.md` | Reviews the finished change; treats a red run as a fact and a finding when the change caused it. | Read only. No contradiction — it is about the suite after implementation, not about the test-author's own pre-implementation run. |
| `agents/implementer.md` | Owes "the planned tests passing and nothing newly broken". | Read only. No contradiction. |
| `.claude/rules/agents.md` | The rules an agent page has to satisfy: frontmatter fields, one flat file per agent, the page is the interface. | The change keeps frontmatter untouched, so nothing here is affected. |
| `.claude-plugin/plugin.json` | Declares the agent files. | Unchanged — no file is added or renamed. |

## Environment

- `./test.sh` — the full suite, from the repository root. Runs six suites:
  `test-repo.sh`, `test-plugin.sh`, `test-worktree.sh`, and `npm test` in
  `tools/argus`, `tools/argus-ui`, `tools/log-parser`. Zero-dependency; no
  install step is needed first.
- There is no linter in this repository.
- No prerequisites beyond `bash` and `node`/`npm`, both already present.

## Test plan

**Whether: no new tests.**

`test-plugin.sh` and `test-repo.sh` check agent pages structurally — that
every `agents/*.md` is declared in `plugin.json`, that nothing is nested, that
the frontmatter is present. Neither greps the body prose, and adding a grep
for a phrase this change introduces would pin the wording rather than the
rule, and would break on the next honest rewording. The issue's own default
covers this case: "if nothing in the repository can check it beyond the
existing plugin suite, that is an acceptable outcome and the researcher says
so rather than inventing a test."

**What counts as done** — the closed list, verbatim, from the repository root:

```
./test.sh
```

Nothing else runs. It has to stay green because the change keeps the file's
frontmatter, name and location exactly as they are; a red here would mean the
edit broke the file's structure, which is the only thing the suite can see.

**What is already red:** nothing known. `./test.sh` was not run as a baseline.
