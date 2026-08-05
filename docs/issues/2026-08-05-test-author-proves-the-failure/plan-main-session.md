# Implementation plan — main session

Written by the main session for the token-comparison experiment. The
researcher's own plan for the same issue is in `researcher.md`; neither
supersedes the other.

## What the code says today

- `agents/test-author.md` is the only page that owns this behaviour. Step 4
  ("Prove the failures", lines 34–38) demands the right thing and asks for no
  evidence: "confirm each fails because the behaviour is missing — not an
  import error, not a typo. Quote the failure in your handoff."
- The handoff section (lines 53–62) already asks for "its failure output" per
  case. That sentence is where the evidence requirement belongs; step 4 must
  not repeat it, because `.claude/rules/docs.md` states each rule once.
- No suite checks the prose of an agent page. `test-repo.sh` checks the licence
  claims and the deployment; `test-plugin.sh` checks manifests, the file list
  and the hooks — it counts `agents/*.md`, it never reads them. So the change is
  unverifiable by a test, and the issue's own default says to say that rather
  than invent one.

## The change

One file: `agents/test-author.md`. Two edits.

### Edit 1 — replace step 4

Replace lines 34–38 with:

> 4. **Prove the failures.** Run every test you wrote with the single-file
>    command the plan names. Decide for each one which kind of failure you are
>    looking at: the behaviour is missing, or something else. Only the first
>    kind counts. An import error, a syntax error, a missing fixture, a
>    misspelled test name, and an expected value that differs from the actual
>    one only in formatting — separators, locale, whitespace, ordering — are all
>    something else, and each of them is your own mistake. Fix your own test and
>    run it again until it fails because the behaviour is missing. A failure you
>    cannot explain is an open question in your handoff, and you do not commit
>    that test as if it were fine. The suite and the linter are not yours to
>    run; the implementer runs what the plan lists once the code exists.

Why each sentence is there: criterion 1 (classify), criterion 2 (the kinds that
do not count, formatting mismatch named among them), criterion 3 (fix and
re-run before returning), criterion 4 (unexplained failure becomes an open
question).

### Edit 2 — the handoff section

In line 57, replace "its failure output" with "the actual failure output and
which kind of failure it is". That carries the evidence half of criterion 1,
and it is the only place that asks for it.

Delete "Quote the failure in your handoff." from step 4 — Edit 1 already drops
it. Without that deletion the rule stands twice and the two wordings drift.

## What is not changed, and why

Criterion 6 asks whether another page contradicts this. Checked, none does:

- `agents/implementer.md:23` tells the implementer to run the tests and confirm
  they fail for the right reason. That is a second gate on the same fact, not a
  contradiction — it stays.
- `agents/reviewer.md:37` keeps rejecting a red suite. Out of scope, and still
  correct.
- `agents/researcher.md:73` covers what was red *before* the change. Different
  subject.

Record that check in the implementer's handoff, as criterion 6 requires.

## Tests

None can be written. No suite reads agent prose, and adding a grep for a
sentence would test the wording rather than the behaviour, and would break on
the next honest edit. The existing `./test.sh` must stay green — it will, since
the page's structure, frontmatter and file count are untouched.

## Done when

`./test.sh` exits 0 and the diff touches `agents/test-author.md` only.

## Risks

- **Length.** Step 4 grows from four sentences to eight. That is the page's
  most-violated instruction, so it earns the words. If it reads as a checklist
  after the edit, cut the list of failure kinds to the two most common ones —
  import error and formatting mismatch — and keep the rest as "or anything else
  you caused".
- **Voice.** Criterion 5 asks for no new machinery. The edit adds no field, no
  template and nothing to fill in; it names two outcomes and what to do about
  each.
