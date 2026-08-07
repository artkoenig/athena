# The loop pushes the branch after every round

## Problem

The loop pushes only in the Publish phase, after the verdict. Everything
before that exists solely in an ephemeral container: in the
argus-timeline-ui run (2026-08-06) the session's container restart killed
the round-0 reviewer, and for the 2.5 hours until a human happened to poke
the session, three commits holding about 40 minutes of agent work —
research plan, 26 tests, the whole implementation — sat unpushed on a
machine that is reclaimed on inactivity. A reclaim in that window would have
erased the run. The same gap makes the stop-hook complain about unpushed
commits every time the session ends its turn mid-loop, which it did twice in
that run — noise a human reads as something being wrong.

## Acceptance criteria

- [ ] `workflows/loop.js` pushes the current branch to `origin` after every
      round's review returns, and once after the initial round-0 chain
      (research, tests, implementation) before the first review — so no
      completed agent's commits ever wait on a later phase to be durable.
- [ ] A failed push retries with backoff and, if it still fails, is
      `log()`ged and does not abort the run; the round's work is committed
      either way and the Publish phase remains the last push of record.
- [ ] The Publish phase remains the only place a pull request is opened or
      updated.
- [ ] `./test.sh` is green.

## Out of scope

- Pushing after every individual commit; per-phase durability is the goal,
  not a mirror of local history.
- Changes to the stop-hook. Once intermediate work is pushed, its complaint
  is correct whenever it fires.
- Opening the pull request earlier, or as a draft.

## Decisions

Recorded from the session-log analysis of the argus-timeline-ui run,
2026-08-06:

1. **Durability beats tidiness.** Intermediate pushes expose in-progress
   rounds on the remote branch; accepted, since the branch is the loop's
   workspace and the pull request is opened only at the end.
2. **Push failures never fail a round.** The remote being briefly
   unreachable must not cost agent work; the Publish phase is the hard gate.
