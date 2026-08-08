# Every agent writes its return twice, and the two copies can disagree

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

- **The workflow script cannot write files.** It runs in a harness with no
  filesystem and no Node API, so "let the script record the return" is not
  available.
- **A dedicated recorder agent does not help by itself.** Whatever writes the
  file has to emit its content as output; moving the emission to another
  agent moves the cost rather than removing it.
- **Handoff files were already tried and rejected.** `ce82369` (#60,
  "Structured prompts replace the handoff files, and backlog.json carries the
  run") removed exactly that mechanism. A fix that reintroduces per-role prose
  files reopens what that change closed, so any file-based direction has to
  say how it differs.

## Acceptance criteria

- [ ] No agent of a run emits the same content twice. For each role, the
      content of its step return is generated once, and the measurement that
      shows it — the payload written versus the structured return, per role —
      is reported.
- [ ] What `backlog.json` holds for a step and what the workflow hands the
      next role are the same content, and that cannot silently drift: either
      one is derived from the other, or a check fails the step when they
      differ. Prose asking the agent to copy carefully does not satisfy this.
- [ ] A run resumed from `backlog.json` alone reaches the same next dispatch
      as the live run would have — the resume path keeps working, whatever
      replaces the double emission.
- [ ] The recording rule reads the same way in all the places that state it:
      `skills/agent-brief/SKILL.md`, the dispatch prompts in
      `workflows/agile-loop.js`, and every page under `agents/` that repeats
      it. No page is left describing the two-emission flow.
- [ ] `backlog.mjs` keeps its guarantees whatever the calling convention
      becomes: it stays the only writer of `backlog.json`, a repeated step
      replaces its own earlier entry, closing an increment sheds its step
      returns, and `record` still prints one confirmation line and no part of
      the file, so an agent forbidden to read the state can write into it.
- [ ] `test-repo.sh` covers the new flow: that a step's recorded state and the
      next dispatch carry the same content, and that a resume still finds it.
      The existing driver cases for the state channel keep passing.
- [ ] `./test.sh` is green.

## Out of scope

- **The size of what the roles return.** The researcher's 25 KB plan may well
  be too much, but shrinking it is a separate judgment about what a plan
  should contain. This issue is about emitting it once, whatever its size.
- **Which fields each role's schema carries.** The schemas stay as they are
  except where a field exists only to serve the double emission.
- **The planner's payload envelope.** `init` takes `issue`/`workflow` where
  the return has `questions`/`summary`; that asymmetry is part of the calling
  convention this issue may change, but normalizing the envelope is not a goal
  of its own.
- **Retrofitting past runs.** Nothing has to be recovered or re-recorded from
  `backlog.json` files written before this change.

## Notes on provenance

These criteria were derived from the transcripts of run `wf_00d4cd24-684`, not
from a grilling interview — no human has approved them yet. The numbers above
are reproducible from the agent transcripts in that run's directory, comparing
each agent's `Write` payload against its `StructuredOutput` input.
