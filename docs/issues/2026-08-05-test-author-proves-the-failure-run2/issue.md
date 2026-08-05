# The test-author must prove why a test fails, not just that it fails

## Problem
A test that fails for the wrong reason costs a whole correction round, and the
loop cannot tell the difference until the reviewer rejects the run.

The failure mode: the test-author writes a test whose expected value is wrong —
an unformatted number compared against formatted output, an assertion off by a
separator. The test is red, and red is what the test-author expects to see at
this point, so it commits and returns. The implementer then cannot make it pass
by building the right thing, the reviewer rejects the run because the suite is
red, and a correction round runs researcher, test-author, implementer and
reviewer again to change one assertion. Measured on a real run: 27 of 60
minutes, four agents, and no production change at the end of it.

`agents/test-author.md` already demands the right thing — run every test you
wrote and confirm each fails for the right reason, the behaviour is missing,
not an import error, not a typo. What it does not demand is evidence. "Prove it
in your report with the failure summary" is satisfied by pasting a red bar, and
a red bar cannot distinguish a missing feature from a broken assertion.

## Acceptance criteria
- [ ] `agents/test-author.md` requires, for every test written, that the handoff record the actual failure output and name which kind of failure it is: the behaviour is missing, or something else.
- [ ] The page names the failure kinds that do NOT count as the right reason, and a mismatch between an expected and an actual value that differ only in formatting — separators, locale, whitespace, ordering — is one of them.
- [ ] The page states what happens when a test fails for the wrong reason: the test-author fixes its own test and re-runs it before returning, rather than leaving it for the review.
- [ ] The page states that a test whose failure the test-author cannot explain is reported as an open question in the handoff instead of being committed as if it were fine.
- [ ] The wording stays in the voice of the existing agent pages: short, plain, no new machinery, no checklists the agent has to fill in mechanically.
- [ ] The change is confined to `agents/test-author.md` unless another page makes a claim that this contradicts; if it does, that page is corrected too and the reason is recorded in the handoff.
- [ ] `./test.sh` is green.

## Out of scope
- The reviewer's behaviour. Rejecting a red suite was correct and stays correct.
- Any change to how many correction rounds the loop runs.
- Making the test-author read production code. It still works from the intent and the researcher's plan.

## Assumptions taken as defaults (no answer from the human)
- This is a prose change to an agent page; if nothing in the repository can check it beyond the existing plugin suite, that is an acceptable outcome and the researcher says so rather than inventing a test.
