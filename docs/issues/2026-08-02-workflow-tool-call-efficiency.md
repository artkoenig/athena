---
status: backlog
branch:
pr:
---

# The workflow spends more tool calls than the work needs

## Intent

A measured comparison of one real bug fix — the same idea, the same commit, the
same model (`claude-sonnet-5`), once with the athena workflow and once without —
showed where the workflow's cost actually comes from. The control run was a
single context; the athena run dispatched researcher, tracker, test-author,
implementer (3x), reviewer.

| | with athena | control |
| --- | ---: | ---: |
| LLM turns | 327 | 146 |
| tool calls | 345 | 145 |
| tokens | 37.3 M | 28.1 M |
| wall clock | 85 min | 27 min |

**96% of billed input is cache read**, at a tenth the price of a cache write.
So a long agent context is nearly free per token, and the unit of cost is the
turn: every tool call re-reads the whole context. Measured, a turn cost $0.045
in the athena run and $0.065 in the control run.

That changes what is worth optimising. Restarting an agent is cheap and
shortening a context is expensive — the three implementer dispatches each reset
from ~14k tokens, which halved the per-turn cost (170k -> 78k avg); keeping one
implementer alive across all three rounds would have cost 2.4-4x more for rounds
2 and 3 and would have hit auto-compaction. **The restarts are correct and stay
as they are.** The turn count is not: 191 of 327 turns were process, 136 were
the implementation, and the process turns contain concrete, removable waste.

Where the turns went, and what the transcript shows:

| stage | turns | tool calls | finding |
| --- | ---: | ---: | --- |
| implementer (3) | 136 | 135 | 23 of the first dispatch's 51 turns were warm-up before the first edit |
| reviewer | 87 | 87 | 26 turns re-running verification; 20 mutating operations |
| test-author | 47 | 46 | 20 of 28 bash calls spent locating the test harness |
| orchestrator | 35 | 28 | ~10 turns duplicating the running researcher |
| tracker (3) | 14 | 11 | — |
| researcher | 8 | 14 | cheapest stage; its briefing did not reach later dispatches |

Wanted: the same seven stages doing the same work, with roughly a quarter fewer
turns, and without the reviewer being able to write into the tree it reviews.

Acceptance criteria, in the order they are worth doing:

1. **The reviewer establishes suite and static-analysis results in one command
   per round.** Today it runs each runner in its own call — 21 test runs and 5
   static-analysis runs across three rounds. Expected: -23 turns, ~-$1.00. No
   risk: the exit codes are the same, only fewer round trips.

2. **The reviewer produces a finding's reproduction without writing into the
   tree it reviews.** Today it hand-builds throwaway test files there: 11 `cat >`
   into `src/evaluator/`, 3 `sed -i` on source, 4 `rm`. The reproduction spec
   goes back to the test-author instead. Expected: -20 turns, ~-$0.90. Risk: a
   finding may need one more round to get its reproduction.

3. **The researcher's briefing becomes a module map in the issue, quoted into
   every later dispatch prompt.** Today every agent rediscovers the code: 68
   searches across the run, `isHidden` searched 8 times by 4 agents,
   `evalTree.js` opened by 4 stages, while the researcher — the cheapest stage
   at $0.37 — had already established it. Expected: -25 turns, ~-$1.10. Risk: a
   stale map, so it says which commit it was taken at.

4. **A project's test conventions live next to the code they govern.** Today the
   test-author spends 20 of its 28 bash calls finding out how a test is written
   in this repository, and pays that again on every dispatch. The rulebook
   already says conventions live next to the code; what is missing is that the
   workflow produces and consumes them. Expected: -10 turns, ~-$0.50. Risk:
   upkeep. Lands in the consuming project, not in this repository.

5. **The orchestrator reads no source file, and waits when nothing independent
   is pending.** Today it spends ~10 turns at the second-most expensive context
   reading two issue files and the same reference document three times, while
   the researcher investigates the same question — against an explicit warning
   in the dispatch result not to duplicate the agent's work. Expected: -10
   turns, ~-$0.40. No risk.

6. **The reviewer gets a sandbox instead of `git stash` and `sed -i`.** It is
   declared read-only, but Bash goes around the tool allowlist: it ran `git
   stash push` twice on the very files under review, so an unpopped stash would
   have left it judging a diff that no longer existed. No token saving — this
   one is correctness.

7. **Continuing an agent costs no tool-discovery turn.** Today the rulebook
   requires continuing the reviewer, but the tool for it has to be found first:
   one `ToolSearch` turn. Expected: -1 turn, ~-$0.05. No risk.

Together ~90 of 327 turns, about a quarter of the run's cost, without dropping
a single workflow stage. The run does not reach control-run cost, and should
not: the control run fixed only half the cause.

## Plan

## Tasks

## Decisions

## Log

## Checkpoints

### Before implementation

- Does this match what was asked?
- What surprised me?
- What am I assuming without having verified it?

### Before the PR

- Does this match what was asked?
- What surprised me?
- What am I assuming without having verified it?

## Retro
