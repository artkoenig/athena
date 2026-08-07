# Five optimizations for the agile loop from the argus-timeline-ui run

## Problem

The agile-loop run that delivered `docs/issues/2026-08-06-argus-timeline-ui`
(2026-08-06/07: 7 increments, 127 agents, ~6.6M subagent tokens, ~5.3 hours)
ended with every criterion of the issue delivered — and a session log showing
five places where the workflow spent rounds, tokens or trust it did not have
to. The five retro issues filed from the earlier run of the plain loop (#56)
cover none of them, except that one extends an idea already filed there.

1. **Nine review rejections, eight of them the same finding type.** The
   reviewer rejects a round when a criterion has no test that goes red when
   the behaviour breaks — it verifies this by mutation, and it applied that
   standard consistently. Only one rejection in the whole run was an actual
   defect (a stale-fetch race in increment 3); the other eight were coverage
   the researcher's test plan had not planned. One increment
   (context-inspector) was refused outright on three such findings after both
   correction rounds, and a successor increment (context-pinning) existed
   solely to add the missing pins. The researcher decides the testing for
   every increment, but nothing tells it the standard the reviewer will
   apply, so the bar is rediscovered per increment, at review time, at the
   price of a full research–tests–implement–review cycle each time. Once the
   bar was explicit — context-pinning's criteria were the findings phrased as
   go-red conditions — the same work passed in one round with zero findings.

2. **The run is silent while it works.** Between two planner calls — up to
   three chain rounds, an hour and more — the human sees nothing. Mid-run
   the human asked for a short status before every round; it was patched
   into the running copy (backlog counts plus the planner's own summary,
   `log()`ed before each round) and answered the question for the rest of
   the run. It lives nowhere.

3. **Work stays local until Publish.** The same exposure the filed
   push-after-each-round issue records for `loop.js`: every commit before
   the Publish phase exists only in a reclaimable container, and the
   stop-hook duly complained about unpushed commits mid-run. The agile loop
   was patched live with a minimal push step after every agent that commits;
   the patch, like the status one, lives only in that run's copy.

4. **The shipped workflows cannot be launched verbatim.** Both `meta`
   blocks build their strings with `+`. The platform's workflow runtime
   rejects any computed `meta` — `meta must be a pure literal: non-literal
   node type in meta: BinaryExpression` — so the run started only after a
   hand-flattened copy of the script was made. Nothing in the repository
   suite catches this.

5. **The run's last word is a false alarm.** The final result reported
   `accepted: false` because context-inspector ended `blocked` — although
   its single criterion had moved to context-pinning and was delivered
   there, which the planner's note records but the result cannot express.
   A human reading the result is told the run failed; a human reading the
   backlog learns it succeeded. The status vocabulary has no word for an
   increment another increment superseded.

## Acceptance criteria

- [ ] The researcher's brief states the reviewer's verification standard as
      the standard of the test plan: for every acceptance criterion, the
      plan names at least one planned test that fails when that criterion's
      behaviour is broken or removed. A criterion the researcher cannot pin
      that way is a named gap in the plan, not a silence. Both workflows and
      `agents/researcher.md` say it once, in one wording, wherever the page
      and the prompts divide that responsibility today.
- [ ] The reviewer's mutation standard is written where every role can read
      it (the agent-brief or the reviewer's page, referenced from the
      researcher's), so planner-side and review-side judge by one text.
- [ ] Before every round, the agile loop `log()`s a short status: increments
      done and open, which increment and round starts, and the planner's
      latest summary. `loop.js` logs its analogue (round number and the last
      verdict's reason) before each round.
- [ ] The agile loop pushes the current branch after every step that commits
      (research, tests, implementation, review, replan). A failed push
      retries with backoff, is `log()`ged and never aborts the run; the
      Publish phase remains the only place a pull request is opened. This
      extends the filed push-after-each-round issue (scoped to `loop.js`,
      per round) to the agile loop's step granularity.
- [ ] The `meta` objects of `workflows/loop.js` and
      `workflows/agile-loop.js` are pure literals — no concatenation, no
      computed values — and `test-repo.sh` guards that so it cannot regress
      silently.
- [ ] A blocked increment whose criteria were all carried into a later
      `done` increment is reported as superseded — the planner records it
      with a status of its own or an equivalent the schema carries — and the
      run result's `accepted` reflects whether the issue's criteria were
      delivered, not whether any increment ever blocked on the way.
- [ ] `./test.sh` is green.

## Out of scope

- The five issues filed from the earlier retro (round-zero heading,
  test-author question backchannel, blocked-on-human exit, loop resume
  after restart, push-after-each-round for `loop.js`) and the test-author
  failure-proof issue. Each stays its own change; this issue only extends
  the push idea to the agile loop.
- The loop's backstops (`MAX_CORRECTIONS`, `MAX_INCREMENTS`, `MAX_ATTEMPTS`,
  `MAX_BLOCKED`). They did their job.
- The reviewer's behaviour. Applying the mutation standard was correct every
  time; the change is telling the planning side about it, not softening it.
- Cost measurement and retro tooling; argus already owns those.

## Evidence

Recorded from the agile-loop run of 2026-08-06/07 (session
`claude/argus-timeline-ui-agile-loop-m5di9q`, PR #57):

- 7 increments worked (6 cut, 1 re-cut), 9 review rejections, 8 correction
  rounds, 127 agents, ~6.6M subagent tokens, ~5.3 hours.
- Rejection causes: eight times missing go-red coverage (increments 1, 2, 4
  and 7 once each; increment 3 once; increment 5 three times across its
  rounds), once a real defect (increment 3 round 0: tool marks written into
  shared state after an `await` without re-checking the selected session).
- Increment 5 was blocked after 2 correction rounds with three verifiability
  findings; increment 6 (context-pinning), whose criteria were those
  findings phrased as go-red conditions, was accepted in round 0 with zero
  findings.
- The status log and the per-step push were patched into the running copy
  mid-run at the human's request and ran from increment 2 on; the shipped
  scripts do not have them.
- The launch of the unmodified script failed with `meta must be a pure
  literal: non-literal node type in meta: BinaryExpression`.
- The final result reported `accepted: false`, `delivered: 6`, `open: 0`,
  with every criterion of the issue delivered and `test.sh` green.
