# Make backlog.json the single source of truth for a run

## Problem

Every agent of a run ends its step by producing the same object twice.

The workflow dispatches each role with `agent(prompt, { schema })`, which
forces the agent to hand its return back through the `StructuredOutput` tool —
that return is what `workflows/agile-loop.js` slices into the next role's
prompt. The same dispatch prompt also ends with the recording instruction:

> Record this step: write your whole return to a JSON file outside the
> repository, then run the `record` subcommand of the backlog helper your
> shared brief names.

`skills/agent-brief/assets/backlog.mjs` is the only writer of `backlog.json`
and takes a **file** as its payload, so the agent has to serialize the return
a second time, into that file, with a `Write` call. Nothing compares the two
copies.

### What it costs

Measured on the run of 2026-08-08 (workflow run `wf_00d4cd24-684`, issue
`docs/issues/2026-08-08-argus-timeline-ui-rerun`), stopped after the
test-author. One increment, no correction round, three agents:

| Agent | Payload file | Structured return | Identical | Duplicated |
| --- | --- | --- | --- | --- |
| planner | 8 699 chars | 12 218 chars | `codemap` + `increments` only | ~3 050 tokens |
| researcher | 25 509 chars | 25 817 chars | all eight fields | ~6 450 tokens |
| test-author | 10 970 chars | 10 398 chars | **no field but `questions`** | ~2 600 tokens |

Roughly 12 100 output tokens for one increment of one run. The researcher's
step is the clearest case: its `plan` (13 068 chars) and `testPlan` (8 440
chars) are byte-for-byte identical in both copies. Its three largest single
responses of the whole 17-minute step — 9 898, 7 216 and 6 633 output tokens —
are those two emissions of the plan. Output tokens are the step's wall clock,
so the second copy is roughly two of those seventeen minutes.

### What it breaks

The cost is the smaller half. The test-author's two copies **are not the same
object**: `cases` 8 621 vs 8 674 chars, `summary` 488 vs 622 chars,
`openQuestions` 1 014 vs 1 042 chars. It re-composed its report rather than
copying it, and nothing noticed.

That splits the run in two. `backlog.json` is documented as the whole durable
state of a run — "a session that dies mid-run resumes from it and from nothing
else" — while the structured return is what the live session actually hands to
the next role. When they diverge, a resumed run continues from a different
brief than the one the crashed run was working, and no reviewer, test or log
can see the difference.

### What constrains the fix

- **The workflow script cannot write or read files.** This is a documented
  property of the Claude Code workflow runtime, not a choice this project made:
  "No direct filesystem or shell access from the workflow itself — Agents read,
  write, and run commands. The script coordinates the agents."
  (https://code.claude.com/docs/en/workflows). The script can compose strings
  and dispatch agents, and nothing else. Everything that touches the repository
  goes through an agent.
- **The runtime's own resume is too short-lived to serve as the state.** The
  runtime caches each agent's result and replays it on resume, but only "within
  the same Claude Code session"; a session that exits starts the workflow
  fresh. `backlog.json` exists to cover exactly that gap.
- **Handoff files were already tried and rejected.** `ce82369` (#60,
  "Structured prompts replace the handoff files, and backlog.json carries the
  run") removed per-role prose files. This issue moves content back into a file
  and has to stay clearly on the other side of that line: there is one
  structured state file, it is the run state that already exists, only the
  shipped helper writes it, every entry is addressed by its step label, and no
  role gets a prose file of its own.

## Decisions

Taken with the human on 2026-08-08, before the criteria below were written.

- **`backlog.json` is the single source of truth.** A role writes its return
  once, into the file. The next role reads it from the file. The content does
  not travel through the workflow script.
- **A dispatch prompt carries pointers, not content.** It names the steps the
  agent has to read; it does not paste them in.
- **The reviewer stays blind.** It never reads the run state, because the state
  holds the plan it is the check on. Its whole brief keeps arriving in its
  prompt.
- **Nothing in the file is ever deleted.** The human wants every recorded step
  and every dispatch prompt kept for later analysis of a run.
- **Reads are addressed, not wholesale.** Growth is handled by each reader
  naming what it needs, not by trimming the file.

## Acceptance criteria

- [ ] Each role generates the content of its step return once. It writes that
      content into `backlog.json` and does not also emit it as its structured
      return. Report, per role, the size of what was written against the size
      of what was returned, measured on a real run.
      *Built and enforced by the schemas; the measurement is still owed — see
      Status.*
- [x] A role's structured return carries only what the workflow script needs in
      order to steer: which increment and branch the step worked, whether the
      step succeeded, the questions that block it, and the closed list of
      commands the reviewer must run. State per role what its schema keeps and
      what moved into the file.
- [x] A role's structured return is a projection of what it wrote into
      `backlog.json`, and every field of it is recoverable from the file by an
      addressed read. A step that wrote its entry and then died still hands the
      resumed run everything the script needs to dispatch the next role. Those
      few steering fields are the one content the file and the return share,
      and that is accepted.
- [x] A role writes its entry into `backlog.json` before it returns, so a step
      that ends between the two leaves the file authoritative rather than
      stale.
- [x] A dispatch prompt names the step labels the agent must read out of
      `backlog.json` and carries none of their content. The reviewer's prompt
      is the single exception, and it stays a full brief.
- [x] The reviewer neither reads `backlog.json` nor receives any other agent's
      output. It records its findings into the state it cannot read.
- [x] Every read of `backlog.json` names what it needs, and the helper returns
      only that. No agent in a run reads the whole file.
- [x] No agent emits the content of `backlog.json` as its return. The step that
      opens a run returns an index — the issue branch of the run, which step
      labels are recorded, which increments exist, which branch each is on, and
      which steps ended in questions — and not the file.
- [x] What the planner reads before closing an increment is bounded by that one
      increment. Its size does not grow with the number of increments already
      closed.
- [x] `backlog.json` keeps everything ever written to it. Closing an increment
      no longer sheds its step returns.
- [x] A step written a second time keeps its earlier entry as history, and the
      readers get the current one. Resume and the correction rounds keep
      working on the current entry.
- [x] Every dispatch prompt is recorded into `backlog.json` verbatim, beside
      the step it dispatched, including the reviewer's. The two dispatches that
      are not steps of the run are the exceptions: the one that opens a run,
      because it runs before the file exists, and the one that publishes,
      because it must leave the working tree exactly as it found it.
- [x] A run whose session died resumes from `backlog.json` alone and reaches
      the same next dispatch the live run would have reached. The existing
      driver cases for resume keep passing.
- [x] The recording and reading rules read the same way in all the places that
      state them: `skills/agent-brief/SKILL.md`, the dispatch prompts in
      `workflows/agile-loop.js`, and every page under `agents/`. No page is
      left describing the two-emission flow or the shedding close.
- [x] `backlog.mjs` stays the only writer of `backlog.json`, and `record` still
      prints one confirmation line and no part of the file, so an agent
      forbidden to read the state can still write into it.
- [x] `test-repo.sh` covers the new flow: that a dispatch prompt carries no
      step content, that a role's brief reaches it through an addressed read,
      that a closed increment keeps its returns, and that a resume still finds
      what it needs.
- [x] `./test.sh` is green.

## Out of scope

- **The size of what the roles return.** The researcher's 25 KB plan may well
  be too much, but shrinking it is a separate judgment about what a plan should
  contain. This issue is about emitting it once, whatever its size.
- **The growth of the committed file.** `backlog.json` now grows for the whole
  life of an issue and is committed on every step. That is intended, and no
  rotation, compaction or archiving scheme is part of this issue.
- **Retrofitting past runs.** Nothing has to be recovered or re-recorded from
  `backlog.json` files written before this change.
- **The planner's payload envelope.** `init` takes `issue`/`workflow` where the
  return has `questions`/`summary`; normalizing that asymmetry is not a goal of
  its own, though the calling convention this issue changes may touch it.

## Status

Worked directly on 2026-08-08, at the human's instruction, rather than through
the loop. `./test.sh` is green: 50 cases in `test-repo.sh` including all sixteen
driver modes, and 40 in the recorder suite.

Two things the criteria ask for that the work does not yet have:

- **The measurement is owed.** Every content field moved out of the return
  schemas, so the second emission is gone by construction — the researcher's
  return went from eight fields to four, and `plan`, `moduleMap`, `environment`
  and `testPlan` now exist only in the file. But the numbers in "What it costs"
  came from a real run, and the matching numbers for the new flow can only come
  from another one. Take them from the next run this repository does.
- **Write-before-return is prose, not a mechanism.** The order lives in the
  dispatch prompt and in the shared brief. Nothing in the harness can enforce
  it: the agent chooses when it calls the recorder and when it returns, and no
  code of ours sits between the two.

One thing the work added that the criteria did not name: `steps --fields`. The
old flow kept a role's independence by slicing content into its prompt — the
test-author got the `testPlan` and never the `plan` beside it. Moving the brief
into a read would have handed it the whole step, so the field selector moves
that same slicing into the helper. It is what `test-repo.sh` w4 and w5 now
assert, and the guard runs in every driver mode: no dispatch prompt but the
closing planner's may read a step without naming its fields.

## Notes on provenance

The measurements come from the transcripts of run `wf_00d4cd24-684` and are
reproducible from that run's directory, comparing each agent's `Write` payload
against its `StructuredOutput` input. The decisions and criteria come from the
grilling interview of 2026-08-08.
