---
status: done
branch: claude/offenes-issue-umsetzen-lpeuk3
pr: 22
---

# The workflow spends more tool calls than the work needs

## Intent

A measured comparison of one real bug fix — the same idea, the same commit, the
same model (`claude-sonnet-5`), once with the uroboros workflow and once without —
showed where the workflow's cost actually comes from. The control run was a
single context; the uroboros run dispatched researcher, tracker, test-author,
implementer (3x), reviewer.

| | with uroboros | control |
| --- | ---: | ---: |
| LLM turns | 327 | 146 |
| tool calls | 345 | 145 |
| tokens | 37.3 M | 28.1 M |
| wall clock | 85 min | 27 min |

**96% of billed input is cache read**, at a tenth the price of a cache write.
So a long agent context is nearly free per token, and the unit of cost is the
turn: every tool call re-reads the whole context. Measured, a turn cost $0.045
in the uroboros run and $0.065 in the control run.

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

## Map

Taken at `4bed60a`, the tip of `main` at the start of this run.

- `CLAUDE.md` — the rulebook, injected verbatim into every session of every
  wired project by the SessionStart hook. Criteria 2, 3, 4, 5 and 7 land here.
- `agents/reviewer.md` — the reviewer's whole brief: `## What you check`
  (criterion 1), `## The reproduction rule` (criterion 2), and the read-only
  claim that `Bash` walks around (criterion 6).
- `agents/researcher.md` — `## Your report` is where the module map is
  produced (criterion 3).
- `agents/test-author.md` — `## How you work` step 1 is where the test
  conventions are looked for today (criterion 4).
- `agents/implementer.md` — `## How you work` step 1, the other consumer of
  the map.
- `agents/tracker/skills/issue/SKILL.md` — owns the issue file's operations,
  template and section list; the map needs a section and an operation there.
- `.claude/rules/agents.md` — path-scoped rules for `agents/`: an agent's page
  is the interface, so what a dispatch hands over has to be declared on it.
- `test.sh` → `test-repo.sh`, `test-plugin.sh`, `test-worktree.sh`,
  `npm --prefix tools/observability test` — the whole suite, one command.

## Plan

## Tasks

## Decisions

- The reviewer keeps `Bash` and the sandbox is written as a boundary on its
  page, not taken away as a tool. Source: default, unanswered — the suite and
  the static analysis are exit-code facts and need a shell, and criterion 1
  makes that one call per round.
- The module map lands in a new `## Map` section of the issue rather than in
  `## Plan`. Source: default, unanswered — `## Plan` is what the change will
  do, the map is what the code is today, and the two go stale at different
  moments.
- Criterion 4's consuming-project half is not built here. Source: the
  criterion itself — "Lands in the consuming project, not in this
  repository." What lands here is the rule that the workflow produces and
  consumes those conventions.
- The tracker subagent did not write this record; the session wrote it
  directly. Source: default, unanswered — this environment registers no
  `tracker` agent type and its harness forbids dispatching subagents unasked,
  so the rulebook's bookkeeping rule could not be followed.

## Log

- Run started from the human's instruction to implement an open issue
  directly, without tests. This change is prose only — agent pages, the
  rulebook and one skill page — so nothing a test could run; step 3 of the run
  is skipped for the reason the rulebook already names.
- Criterion 1: `agents/reviewer.md`, check 1 rewritten — both facts come from
  a single `Bash` call per round, runners chained so each keeps its own exit
  code, and a re-run to confirm what a call already said is named as waste.
- Criterion 2: `agents/reviewer.md` gains "a reproduction is a spec, not a
  file you wrote"; `agents/test-author.md` gains the dispatch that hands it a
  reviewer's spec instead of the whole intent; `CLAUDE.md` step 5 says the
  same in one clause.
- Criterion 3: `agents/researcher.md` — the briefing opens with the module map
  and the commit from `git rev-parse --short HEAD`.
  `agents/tracker/skills/issue/SKILL.md` — new *record a module map*
  operation, `## Map` in the template and in the shape table.
  `CLAUDE.md` — the map is established once and every later dispatch carries
  it. `agents/test-author.md`, `agents/implementer.md`, `agents/reviewer.md` —
  each declares that its prompt may quote the map and that it is a given.
- Criterion 4: `agents/test-author.md` gets a new step 2 — read the
  conventions from the `CLAUDE.md` next to the tests, and when there is none,
  work them out once and close the report with them. `CLAUDE.md`'s
  conventions bullet says test conventions are conventions.
- Criterion 5: `CLAUDE.md` — a new bullet, the orchestrator dispatches and
  does not read the project; the background-dispatch bullet now ends with
  waiting when nothing independent is pending.
- Criterion 6: `agents/reviewer.md` — new section "The tree you review is not
  yours to touch": no `git stash`, no `sed -i`, no `cat >`, no `rm`, and
  `git worktree add` on a temporary path when another state must actually be
  run.
- Criterion 7: `CLAUDE.md` — continuing an agent is `SendMessage` by name, and
  a schema lookup rides in the same block as the dispatch it will continue.
- `bash test.sh`, all four suites (the repository itself, the plugin, the
  worktrees, `tools/observability` at 113 cases), exit 0. No static analysis
  exists in this repository; `test.sh` is the whole of what a tool checks
  here.
- Out of scope, not fixed: `CLAUDE.md`'s bookkeeping bullet spells
  "heckpoints" for "checkpoints". Violates no criterion of this issue.

## Checkpoints

### Before implementation

- Does this match what was asked? Yes — seven criteria, all of them about
  where the workflow's turns go, all landing in the rulebook and the agent
  pages. Nothing here changes what a stage does, only how many round trips it
  takes to do it.
- What surprised me? Criterion 4 is the only one whose subject sits outside
  this repository: the conventions file lands in whatever project is being
  worked on, so what this change can carry is the rule alone.
- What am I assuming without having verified it? That every one of these
  criteria is met by prose — no code path enforces a turn count, and the
  expected savings in the issue are estimates that this change cannot
  measure. Verifying them takes another measured run like the one that filed
  the issue.

### Before the PR

- Does this match what was asked? All seven criteria are met, each in the file
  the criterion names, and the diff carries nothing else — no stage dropped,
  no criterion reinterpreted. The human asked for the issue without tests, and
  a prose-only change has nothing a test could run anyway.
- What surprised me? Criterion 6's mechanism was already practised without
  being written down: `docs/2026-08-02-workflow-token-measurement.md` records
  a reviewer that re-established the log's numbers "in a throwaway worktree it
  created and removed". The rule now says what the good run did by itself and
  the measured one did not.
- What am I assuming without having verified it? That a rule stated on a page
  changes what a dispatch does — the whole change is prose, so `bash test.sh`
  proves only that nothing else in the repository broke, never that a run is a
  quarter cheaper. And that no review round ran on this diff: this environment
  registers none of uroboros's own subagents, so the reading here is the
  implementer's own, which is exactly the check the rulebook says an
  implementer cannot do for itself.

## Retro
