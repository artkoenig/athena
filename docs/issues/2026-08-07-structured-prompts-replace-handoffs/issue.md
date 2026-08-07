# Structured prompts replace the handoff files, and `backlog.json` carries the run

## Problem

The handoff files are two things at once — the channel between the agents and
the record of the run — and as a channel they are paid for many times over.
Measured on the argus-timeline-ui issue, the agile run committed 11,585
handoff lines against 2,615 for the plain loop, and every later dispatch that
opens a file pays its history again. The workflow scripts already carry
structured returns (`PLAN`, `VERDICT`, `BACKLOG` schemas) but inject only
metadata and send the next agent to read prose.

The record half has the opposite problem: it does not survive the one failure
that matters. The workflow journal is session-local, so a container reset
loses everything an agent returned, and what was not committed and pushed is
gone — `loop-resume-after-restart` asks for exactly the re-entry this makes
impossible.

The change: the chain communicates through structured returns that the
workflow injects into the next prompt, the prose handoff files disappear, and
the backlog — converted to JSON — becomes the one durable run state a fresh
session resumes from.

## Acceptance criteria

- [ ] The chain communicates through structured returns injected into
      prompts. The researcher's return carries the implementation plan,
      module map, environment and test plan; the test-author's the
      case-to-test mapping with each failure as expected-versus-got and its
      open questions; the implementer's its deviations from the plan, command
      results by exit code, and blockers; the reviewer's its findings, each
      as claim, reproduction and criterion. The workflow hands each agent
      exactly the slice its role needs — the test-author the test plan, the
      implementer plan and checks, the reviewer the checks alone.
- [ ] Neither workflow writes or reads a prose handoff file any more:
      `researcher.md`, `test-author.md`, `implementer.md`, `reviewer.md` and
      `planner.md` are not created, and no prompt, agent page or skill still
      instructs anyone to write or read one — the retro among them, which
      works from `backlog.json` and the git history instead. `issue.md`
      stays what it is.
- [ ] `backlog.md` becomes `backlog.json`: machine-readable, carrying the
      increments as today — id, title, what it delivers, its criteria, its
      status — and, new, the run state.
- [ ] The run state is step-level. After each agent step, that step's
      structured return is recorded in `backlog.json` under the increment in
      flight and committed; every agent updates the file, ending the
      planner's exclusive ownership. A fresh session can rebuild the next
      prompt from `backlog.json` alone.
- [ ] Every step's commit is pushed, so the state survives a container reset
      — `push-after-each-round`, extended from rounds to steps.
- [ ] Resume is the workflow started again on the same issue directory. The
      script itself touches no file: a cheap state-loader dispatch opens
      every run — it reads `backlog.json` and returns it structured, or
      reports that none exists — and the script continues at the first step
      not recorded. Recorded steps never re-run; the step in flight at the
      moment of death is lost and repeats, so the granularity is the last
      completed step. A repeated step tolerates work its interrupted first
      run already committed (failing tests that exist, code that
      half-exists). A backlog whose increments are all closed starts nothing
      over: the run re-asserts the publish step — idempotent, the branch
      pushed and a pull request existing — and ends as already complete.
- [ ] `backlog.json` stays small: full step returns exist only for the
      increment in flight, and closing an increment — done, blocked or
      dropped — sheds them to status and criteria. The record of a closed
      increment is the git history it produced.
- [ ] The plain loop runs the same mechanism through the same roles: the
      state loader opens the run, a planner dispatch writes `backlog.json`
      with exactly one increment spanning the whole issue — pinned to one by
      prompt and schema — and a closing planner dispatch marks it done and
      sheds its step returns once the review accepts. The loop still never
      re-cuts; one increment is its shape.
- [ ] The reviewer's independence survives the new channel: it still sees no
      other agent's output, `backlog.json` is excluded from its diff
      judgment as the handoff files are today, its findings reach the
      researcher through its return, and the human still gets the reason
      sentence in the chat. It records its own step blind: an append that
      never loads `backlog.json` into its context, because reading the file
      to edit it would hand it the plan its independence forbids.
- [ ] An agent's question for the human lands in `backlog.json` and ends the
      run as a regular exit (`blocked-on-human-exit`), so the session that
      picks the run back up finds the question in the state it resumes from.
      The answer has a machine-findable landing place: it is recorded as a
      decision in `issue.md` before the workflow is started again, and the
      resuming researcher reads it there.
- [ ] The shared brief and the agent pages describe the structured returns
      instead of the handoff files, and `test-repo.sh`'s guards move with
      them: the append-a-section guards fall, guards on the new mechanism
      replace them, and the two workflows stay guarded against silent
      divergence.
- [ ] `./test.sh` and `./test-repo.sh` are green.

## Out of scope

- `issue.md`, the grilling and the human approval points: unchanged.
- Old issue directories: existing prose handoffs stay as history; nothing
  reads or migrates them, and no test pins behavior for them.
- Measuring the effect: the argus baseline exists, but the measurement run is
  its own undertaking, not a criterion here.

## Decisions

Recorded from the grilling interview, 2026-08-07:

1. **The resume anchor is the backlog, converted to JSON.** The human's
   words: "backlog auf json umstellen und dafür nutzen". Chosen over an
   agent-step state file beside it and over issue-level re-entry; one file is
   channel payload store and run state at once.
2. **Step-level granularity inside an increment.** `backlog.json` records
   the last finished step's structured return and every agent writes it
   forward. The human chose this over increment-level re-entry, accepting
   both costs named in the interview: the planner's exclusive backlog
   ownership ends, and every step commits.
3. **No prose record remains.** All four handoff files go; `backlog.json`
   plus the git history is the whole record, and the retro reads those.
   Chosen over keeping `reviewer.md` as the one surviving prose file and
   over a distilled per-increment journal, accepting the named loss: the
   long-form reviewer observations that fed past retros.
4. **The plain loop gets the same mechanism**, as a one-increment backlog.
   Chosen over leaving the loop on prose (two mechanics for good) and over
   merging the loop into agile-loop. Its no-planner half is superseded by
   decision 5.
5. **The planner opens and closes both workflows.** From the follow-up on
   2026-08-07 ("planner auch beim normalen loop nutzen"): the plain loop
   dispatches the planner too — once to write the one-increment backlog,
   once to close it and shed — so the two workflows share one opening, one
   shed-owner and one state shape. The human accepted the two extra
   dispatches per plain run; the loop still never re-cuts.
6. **The dry-run findings stand as criteria, not as interview memory.** The
   simulation of 2026-08-07 surfaced the gaps now folded in above: the
   script touches no file (state loader opens every run, agents write all
   state), the reviewer's read-to-edit conflict (blind append), the lost
   step in flight (last-completed-step granularity), the human's answer
   needing a machine-findable landing place (`issue.md`), the close of the
   plain loop needing an owner (the planner), and the already-complete run
   still re-asserting publish.

## Assumptions taken as defaults (no explicit answer needed)

- **Shed on close.** Follows from the cost goal: a `backlog.json` that keeps
  every step return of every increment rebuilds the handoff problem in JSON.
- **Push per step.** Without it, step-level granularity is theater: a
  container reset takes the unpushed state with it.
- **The brevity lives in the schemas.** The return schemas' field
  descriptions carry the discipline the prose rules carried — one line per
  case, expected-versus-got, findings as claim/repro/criterion — so
  shortness is enforced at validation, not requested in prose.
- **Container reset is the design case, not the edge.** Resume is specified
  from `backlog.json` alone — no journal, no context window, no memory of
  the session that died.
- **The blind append ships as an asset.** The reviewer's no-read write needs
  a helper that exists in every installing project: a plugin asset on node,
  which uroboros already requires, not per-project shell quoting.
