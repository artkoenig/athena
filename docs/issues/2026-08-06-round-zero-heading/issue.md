# The loop names the round heading in round 0

## Problem

`handoff()` in `workflows/loop.js` tells a round-0 agent only "Write your
handoff to `<file>`" — no round is named. The agent-brief tells every agent to
append "a `## Round <X>` section for the round your prompt names", so a
round-0 agent has to invent a number, and in the argus-timeline-ui run
(2026-08-06) all three build-chain agents invented `## Round 1`. When the
correction round was then instructed to "Append a `## Round 1` section", the
researcher, test-author and implementer files each ended up with two
`## Round 1` sections, and the pointer `section()` builds — "the `## Round 1`
section of researcher.md" — matched both. The run survived only because the
brief's "the last `## Round` section binds" rule happened to pick the right
one, and because the round-1 test-author read the whole file. Commit messages
("Build the argus session timeline (round 1)") also disagree with
`reviewer.md`, whose prompt names rounds from 0.

## Acceptance criteria

- [ ] `handoff()` in `workflows/loop.js` names the round in round 0 too: the
      round-0 prompt instructs the agent to open its handoff with a
      `## Round 0` section, in the same sentence that names the file.
- [ ] The correction-round wording ("Append a `## Round <X>` section …") and
      `section()` stay as they are; numbering remains 0-based throughout.
- [ ] The repository suite (`test-repo.sh`) guards the round-0 wording the
      same way it already guards the append wording, so the two cannot drift
      apart silently.
- [ ] `./test.sh` is green.

## Out of scope

- Renumbering rounds to start at 1. That would touch every prompt, label and
  the reviewer's existing convention for no behavioural gain.
- Repairing the duplicated headings in already-committed issue directories.
- Any change to the agent-brief; its rule ("the round your prompt names") is
  correct once every prompt names one.

## Decisions

Recorded from the session-log analysis of the argus-timeline-ui run,
2026-08-06:

1. **Fix the prompt, not the brief.** The agents behaved correctly given
   their inputs; the missing input was the round number in the round-0
   prompt. Chosen over teaching agents to infer a number, which is exactly
   what produced the collision.
2. **0-based numbering stays.** It matches the script's loop variable, the
   reviewer prompts and the existing `reviewer.md` files.
