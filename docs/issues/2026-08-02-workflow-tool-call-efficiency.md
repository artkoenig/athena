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
2 and 3 and would have hit auto-compaction. The restarts are correct. The turn
count is not: 191 of 327 turns were process, 136 were the implementation, and
the process turns contain concrete, removable waste.

Where the turns went, and what the transcript shows:

| stage | turns | tool calls | finding |
| --- | ---: | ---: | --- |
| implementer (3) | 136 | 135 | 23 of the first dispatch's 51 turns were warm-up before the first edit |
| reviewer | 87 | 87 | 26 turns re-running verification; 20 mutating operations |
| test-author | 47 | 46 | 20 of 28 bash calls spent locating the test harness |
| orchestrator | 35 | 28 | ~10 turns duplicating the running researcher |
| tracker (3) | 14 | 11 | — |
| researcher | 8 | 14 | cheapest stage; its briefing did not reach later dispatches |

Two findings are not about cost. The reviewer is declared read-only, but Bash is
an escape hatch around the tool allowlist: it wrote 10 throwaway test files into
`src/evaluator/` of the repository under review, ran `sed -i` on source files,
and ran `git stash push` twice on the very files it was reviewing — had a stash
not been popped, it would have judged a diff that no longer existed. And the
orchestrator scheduled a 1200s heartbeat to poll a background dispatch, which
the rulebook forbids, then cancelled it one turn later.

Acceptance criteria:

1. A review round establishes suite and static-analysis results in at most two
   tool calls. Measured today: 21 test runs and 5 static-analysis runs across
   three rounds, mostly one runner per call.

2. The reviewer produces a finding's reproduction without writing into the
   working tree it is reviewing: no file created under the repository, no
   in-place edit of a tracked file, no `git stash`. Measured today: 11 file
   writes, 3 `sed -i`, 2 `git stash push`.

3. A dispatched agent does not re-derive what an earlier agent in the same run
   already established. Measured today: 68 search calls across the run, with
   `isHidden` searched 8 times by 4 different agents and `evalTree.js` opened by
   4 stages.

4. A project's test conventions are established once and read by every agent
   that writes tests, instead of being rediscovered per dispatch. Measured
   today: the test-author spent 20 of its 28 bash calls finding out how a test
   is written in this repository. The rulebook already says conventions live
   next to the code they govern; what is missing is that the workflow produces
   and consumes them.

5. The orchestrator reads no source file and does not work a subject a running
   dispatch is working. Measured today: ~10 turns at the second-most expensive
   context, reading two issue files and the same reference document three
   times, while the researcher investigated the same question — against an
   explicit warning in the dispatch result not to duplicate the agent's work.

6. The orchestrator never schedules a poll, heartbeat or wakeup for a
   background dispatch. Measured today: one 1200s `ScheduleWakeup`, cancelled
   one turn later.

7. Continuing an agent costs no tool-discovery turn: the tool the rulebook
   requires for continuation is available when it is needed. Measured today:
   one `ToolSearch` turn before the reviewer could be continued.

8. The workflow documentation states the cost model this measurement
   established — cost scales with turns, not with context length, because
   almost all billed input is cache read — and records that a fresh dispatch is
   cheaper than a long-lived context, with the implementer measurement as the
   evidence.

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
