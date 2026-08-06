# An interrupted loop run is noticed and resumed, not waited on

## Problem

A workflow dies with its session's container and nothing notices. In the
argus-timeline-ui run (2026-08-06) a container restart killed the round-0
reviewer three minutes into its review; the loop then sat dead for 2.5 hours
until the human happened to ask for a status, at which point a manual
`resumeFromRunId` resume recovered everything — the three completed agents
replayed from cache and only the reviewer re-ran. The recovery mechanism is
cheap and works; what is missing is anything that triggers it. The journal
already contains the evidence (a `started` entry without a matching
`result`), and the run id and script path are in the session transcript, so
detection needs no new state — only somebody who looks.

## Acceptance criteria

- [ ] The loop's skill page instructs the invoking session, at launch, to arm
      a periodic self check-in (`send_later` or the platform's wakeup
      mechanism, where available) that fires while the workflow runs and
      re-arms itself until the workflow has returned.
- [ ] The same page says what a check-in does: verify the task is still
      alive; if it is gone, read the run's `journal.jsonl`, and when it shows
      a `started` agent without a `result`, resume with `resumeFromRunId` and
      the persisted script path — silently, with no message to the human
      unless the resume itself fails.
- [ ] The page tells the session to cancel the check-in once the workflow
      returns, so a finished run leaves nothing armed.
- [ ] `./test.sh` is green.

## Out of scope

- Making the workflow runtime itself restart-proof; that is the platform's
  layer, and the journal-plus-resume mechanism it already provides is what
  this issue wires up.
- Recovery when the container is reclaimed entirely (local commits lost);
  that risk is the push-after-each-round issue's to remove.
- Any periodic message to the human. A healthy check-in is silent.

## Decisions

Recorded from the session-log analysis of the argus-timeline-ui run,
2026-08-06:

1. **Detection over prevention.** The restart cost three minutes of reviewer
   time; the 2.5-hour stall cost the afternoon. The fix targets the stall.
2. **The session babysits, the human does not.** The check-in loop is the
   session's job, armed at launch and silent while healthy — the human's
   "und?" must never be the recovery mechanism again.
