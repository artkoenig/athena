# A test-author question stops the chain before the implementer builds

## Problem

The test-author's open questions travel only forward. In the
argus-timeline-ui run (2026-08-06) the test-author could not know which field
path `/api/events` uses to expose raw attributes — the plan did not say — so
it flagged the guess as "a question for the researcher" in its handoff and
wrote a substring assertion that turned out unsatisfiable. The implementer
read the question, knew the one-line answer, and was rightly not permitted to
touch the test; the reviewer then failed the round on it. Resolving a
one-line test fix cost a full correction round: researcher, test-author,
implementer and reviewer, about 25 minutes — while the clarification itself,
when the round-1 researcher finally made it, took under three minutes. The
question was aktenkundig before the implementer ever started; nothing in the
loop reads it at that point.

## Acceptance criteria

- [ ] The test-author call in `workflows/loop.js` gets a structured result
      schema with an `openQuestions` array: questions only the researcher can
      answer, each one sentence, empty when the plan left nothing open. The
      test-author's page tells it when to raise one instead of guessing.
- [ ] When `openQuestions` is non-empty, the loop runs a researcher
      clarification pass before the implementer starts: the researcher
      appends the answers to its handoff, and the test-author is called once
      more to apply them to the affected cases only.
- [ ] When `openQuestions` is empty, the loop runs exactly as it does today —
      no extra agent, no extra prompt text for the implementer.
- [ ] The researcher's page requires a test plan that asserts on an API
      response to name the exact field paths the assertions use, so the
      known cause of this run's guess cannot recur silently.
- [ ] `./test.sh` is green.

## Out of scope

- A general message bus between agents. One backchannel, one direction,
  one moment in the chain.
- Letting the implementer edit tests, with or without a justification. The
  role boundary prevented a contrived fix in this run and stays.
- Questions from the implementer or reviewer; their findings already have a
  path (the handoff and the verdict).

## Decisions

Recorded from the session-log analysis of the argus-timeline-ui run,
2026-08-06:

1. **Clarify before building, not after failing.** The full correction round
   this run paid is the cost baseline; a researcher pass plus a scoped
   test-author re-run is strictly cheaper than researcher, test-author,
   implementer and reviewer.
2. **The researcher answers, the test-author applies.** Chosen over letting
   the researcher edit the tests directly — writing tests stays one role's
   job.
3. **Prevention belongs in the plan.** The schema change catches guesses; the
   researcher-page rule removes the reason to guess for the case that
   actually happened.
