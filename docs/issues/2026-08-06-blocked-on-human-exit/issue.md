# A question for the human is a regular exit of the loop

## Problem

The reviewer may name a human decision as an acceptable resolution of a
finding — in the argus-timeline-ui run (2026-08-06), Finding 2 of round 1
read "either the criteria get a dependency-free check, or the impossibility
is put to the human as a question and recorded". But the `VERDICT` schema in
`workflows/loop.js` carries only `findings`, `reason` and `summary`: the loop
cannot tell a correctable finding from one that is blocked on a decision, and
`MAX_CORRECTIONS` is 2. That run escaped by luck — the round-2 researcher
found a dependency-free extraction (`timeline.js`) that made the question
moot. Had it not, the loop would have burned its last round against a
finding no agent is allowed to resolve (the dependency decision belongs to
the human per `tools/argus-ui/CLAUDE.md`) and ended unaccepted, with the
question buried in a findings file the human is not sitting in front of.

## Acceptance criteria

- [ ] The `VERDICT` schema gains a `questions` array: decisions only the
      human can make, each self-contained enough to answer without opening a
      file, empty when none. The reviewer's page says when to raise one — a
      finding whose acceptable resolutions include a decision that is
      reserved to the human.
- [ ] The `PLAN` schema gains the same field for the researcher, for a
      correction plan that hits such a decision before the chain runs.
- [ ] When a round returns a non-empty `questions`, the loop stops the round
      loop, `log()`s the questions, and returns them in its result (e.g.
      `blockedOnHuman`) alongside the rounds so far — instead of spending
      further correction rounds on findings that cannot be corrected.
- [ ] A round that ends in questions does not count against
      `MAX_CORRECTIONS`; after the human has answered, a resumed or fresh run
      continues with the remaining budget.
- [ ] The loop's skill page tells the invoking session what to do with the
      returned questions: put them to the human (`AskUserQuestion` where
      available), record the answers in the issue file's Decisions, and
      re-run the loop.
- [ ] `./test.sh` is green.

## Out of scope

- Any agent asking the human directly from inside the workflow; agents stay
  non-interactive and the session stays the only human-facing surface.
- Pausing the workflow mid-run to wait for an answer. The exit is a return,
  not a wait.
- Changing `MAX_CORRECTIONS`.

## Decisions

Recorded from the session-log analysis of the argus-timeline-ui run,
2026-08-06:

1. **Exit, don't grind.** A finding that only the human can resolve must not
   consume correction rounds; this run's escape via extraction was luck, not
   design.
2. **Questions ride the existing structured results**, not a new file — the
   human sits in the chat, and the findings file already holds the long form.
