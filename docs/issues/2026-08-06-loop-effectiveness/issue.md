# Five loop-effectiveness fixes from the argus-timeline-ui retro

## Problem

The argus-timeline-ui run of 2026-08-06 cost an afternoon, and the session-log
analysis afterwards traced the loss to five separate defects in the loop
itself: a round-0 prompt that names no round, work that stays local until the
Publish phase, a test-author question that only travels forward, a finding no
agent may resolve that still burns correction rounds, and a dead workflow that
nothing notices. Each was filed as its own issue with its own approved
acceptance criteria; the five texts stand below, unchanged.

They are worked as one backlog because they change the same two files. Split
across five runs on five branches, four of them would collide in
`workflows/loop.js` at merge time; split across five runs on one branch, every
run after the first would hand its reviewer a diff full of work that an
earlier review already accepted. One backlog gives each part its own
increment, its own review, and a diff the reviewer is told how to read.

## What holds for every part

- [ ] Every change to the chain lands in both `workflows/loop.js` and
      `workflows/agile-loop.js`. Where a part genuinely needs only one of
      them, the handoff says which and why.
- [ ] Both workflows still run end to end when the backlog is finished:
      `uroboros:loop` and `uroboros:agile-loop` each parse, declare their own
      `meta`, and carry every schema, prompt and phase they reference. A
      workflow script is evaluated on its own and cannot import its sibling,
      so a helper added to one is written out in the other.
- [ ] `test-repo.sh` guards every part where the two chains could drift apart
      silently, the way it already guards the append wording.
- [ ] `./test.sh` is green.

## Decisions

1. **One backlog, five increments.** Recorded above: the five parts change
   the same two files, so they are worked in sequence against one branch
   rather than in five runs whose diffs collide or overlap.
2. **The parts stay verbatim.** The criteria below were approved as five
   separate issues and are copied unchanged; nothing here re-opens them.
3. **Both workflows are the deliverable, not just the plain loop.** Four of
   the five parts name `workflows/loop.js` alone, because that is where each
   defect was observed. `agile-loop.js` repeats that orchestration and is
   held to the same fixes.
4. **Where session-facing guidance lands is the researcher's call.** Parts 4
   and 5 ask for instructions to the invoking session and call their target
   "the loop's skill page". No `skills/loop/` page exists today: the
   workflows carry `meta.whenToUse`, and `rulebook.md` is the page a session
   reads. The researcher settles which of those carries the new guidance,
   under one constraint — it ships with the plugin and reaches a session in a
   project that merely installed uroboros.

## Part 1 — The loop names the round heading in round 0

Filed on its own as `docs/issues/2026-08-06-round-zero-heading/`; the text below is that issue, unchanged.


### Problem

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

### Acceptance criteria

- [ ] `handoff()` in `workflows/loop.js` names the round in round 0 too: the
      round-0 prompt instructs the agent to open its handoff with a
      `## Round 0` section, in the same sentence that names the file.
- [ ] The correction-round wording ("Append a `## Round <X>` section …") and
      `section()` stay as they are; numbering remains 0-based throughout.
- [ ] The repository suite (`test-repo.sh`) guards the round-0 wording the
      same way it already guards the append wording, so the two cannot drift
      apart silently.
- [ ] `./test.sh` is green.

### Out of scope

- Renumbering rounds to start at 1. That would touch every prompt, label and
  the reviewer's existing convention for no behavioural gain.
- Repairing the duplicated headings in already-committed issue directories.
- Any change to the agent-brief; its rule ("the round your prompt names") is
  correct once every prompt names one.

### Decisions

Recorded from the session-log analysis of the argus-timeline-ui run,
2026-08-06:

1. **Fix the prompt, not the brief.** The agents behaved correctly given
   their inputs; the missing input was the round number in the round-0
   prompt. Chosen over teaching agents to infer a number, which is exactly
   what produced the collision.
2. **0-based numbering stays.** It matches the script's loop variable, the
   reviewer prompts and the existing `reviewer.md` files.

## Part 2 — The loop pushes the branch after every round

Filed on its own as `docs/issues/2026-08-06-push-after-each-round/`; the text below is that issue, unchanged.


### Problem

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

### Acceptance criteria

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

### Out of scope

- Pushing after every individual commit; per-phase durability is the goal,
  not a mirror of local history.
- Changes to the stop-hook. Once intermediate work is pushed, its complaint
  is correct whenever it fires.
- Opening the pull request earlier, or as a draft.

### Decisions

Recorded from the session-log analysis of the argus-timeline-ui run,
2026-08-06:

1. **Durability beats tidiness.** Intermediate pushes expose in-progress
   rounds on the remote branch; accepted, since the branch is the loop's
   workspace and the pull request is opened only at the end.
2. **Push failures never fail a round.** The remote being briefly
   unreachable must not cost agent work; the Publish phase is the hard gate.

## Part 3 — A test-author question stops the chain before the implementer builds

Filed on its own as `docs/issues/2026-08-06-test-author-question-backchannel/`; the text below is that issue, unchanged.


### Problem

The test-author's open questions travel only forward. In the
argus-timeline-ui run (2026-08-06) the test-author could not know which field
path `/api/events` uses to expose raw attributes — the plan did not say — so
it flagged the guess as "a question for the researcher" in its handoff and
wrote a substring assertion that turned out unsatisfiable. The implementer
read the question, knew the one-line answer, and was rightly not permitted to
touch the test; the reviewer then failed the round on it. Resolving a
one-line test fix cost a full correction round: researcher, test-author,
implementer and reviewer, about 25 minutes — while the clarification itself,
when the round-1 researcher finally made it, took under three minutes. The
question was aktenkundig before the implementer ever started; nothing in the
loop reads it at that point.

### Acceptance criteria

- [ ] The test-author call in `workflows/loop.js` gets a structured result
      schema with an `openQuestions` array: questions only the researcher can
      answer, each one sentence, empty when the plan left nothing open. The
      test-author's page tells it when to raise one instead of guessing.
- [ ] When `openQuestions` is non-empty, the loop runs a researcher
      clarification pass before the implementer starts: the researcher
      appends the answers to its handoff, and the test-author is called once
      more to apply them to the affected cases only.
- [ ] When `openQuestions` is empty, the loop runs exactly as it does today —
      no extra agent, no extra prompt text for the implementer.
- [ ] The researcher's page requires a test plan that asserts on an API
      response to name the exact field paths the assertions use, so the
      known cause of this run's guess cannot recur silently.
- [ ] `./test.sh` is green.

### Out of scope

- A general message bus between agents. One backchannel, one direction,
  one moment in the chain.
- Letting the implementer edit tests, with or without a justification. The
  role boundary prevented a contrived fix in this run and stays.
- Questions from the implementer or reviewer; their findings already have a
  path (the handoff and the verdict).

### Decisions

Recorded from the session-log analysis of the argus-timeline-ui run,
2026-08-06:

1. **Clarify before building, not after failing.** The full correction round
   this run paid is the cost baseline; a researcher pass plus a scoped
   test-author re-run is strictly cheaper than researcher, test-author,
   implementer and reviewer.
2. **The researcher answers, the test-author applies.** Chosen over letting
   the researcher edit the tests directly — writing tests stays one role's
   job.
3. **Prevention belongs in the plan.** The schema change catches guesses; the
   researcher-page rule removes the reason to guess for the case that
   actually happened.

## Part 4 — A question for the human is a regular exit of the loop

Filed on its own as `docs/issues/2026-08-06-blocked-on-human-exit/`; the text below is that issue, unchanged.


### Problem

The reviewer may name a human decision as an acceptable resolution of a
finding — in the argus-timeline-ui run (2026-08-06), Finding 2 of round 1
read "either the criteria get a dependency-free check, or the impossibility
is put to the human as a question and recorded". But the `VERDICT` schema in
`workflows/loop.js` carries only `findings`, `reason` and `summary`: the loop
cannot tell a correctable finding from one that is blocked on a decision, and
`MAX_CORRECTIONS` is 2. That run escaped by luck — the round-2 researcher
found a dependency-free extraction (`timeline.js`) that made the question
moot. Had it not, the loop would have burned its last round against a
finding no agent is allowed to resolve (the dependency decision belongs to
the human per `tools/argus-ui/CLAUDE.md`) and ended unaccepted, with the
question buried in a findings file the human is not sitting in front of.

### Acceptance criteria

- [ ] The `VERDICT` schema gains a `questions` array: decisions only the
      human can make, each self-contained enough to answer without opening a
      file, empty when none. The reviewer's page says when to raise one — a
      finding whose acceptable resolutions include a decision that is
      reserved to the human.
- [ ] The `PLAN` schema gains the same field for the researcher, for a
      correction plan that hits such a decision before the chain runs.
- [ ] When a round returns a non-empty `questions`, the loop stops the round
      loop, `log()`s the questions, and returns them in its result (e.g.
      `blockedOnHuman`) alongside the rounds so far — instead of spending
      further correction rounds on findings that cannot be corrected.
- [ ] A round that ends in questions does not count against
      `MAX_CORRECTIONS`; after the human has answered, a resumed or fresh run
      continues with the remaining budget.
- [ ] The loop's skill page tells the invoking session what to do with the
      returned questions: put them to the human (`AskUserQuestion` where
      available), record the answers in the issue file's Decisions, and
      re-run the loop.
- [ ] `./test.sh` is green.

### Out of scope

- Any agent asking the human directly from inside the workflow; agents stay
  non-interactive and the session stays the only human-facing surface.
- Pausing the workflow mid-run to wait for an answer. The exit is a return,
  not a wait.
- Changing `MAX_CORRECTIONS`.

### Decisions

Recorded from the session-log analysis of the argus-timeline-ui run,
2026-08-06:

1. **Exit, don't grind.** A finding that only the human can resolve must not
   consume correction rounds; this run's escape via extraction was luck, not
   design.
2. **Questions ride the existing structured results**, not a new file — the
   human sits in the chat, and the findings file already holds the long form.

## Part 5 — An interrupted loop run is noticed and resumed, not waited on

Filed on its own as `docs/issues/2026-08-06-loop-resume-after-restart/`; the text below is that issue, unchanged.


### Problem

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

### Acceptance criteria

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

### Out of scope

- Making the workflow runtime itself restart-proof; that is the platform's
  layer, and the journal-plus-resume mechanism it already provides is what
  this issue wires up.
- Recovery when the container is reclaimed entirely (local commits lost);
  that risk is the push-after-each-round issue's to remove.
- Any periodic message to the human. A healthy check-in is silent.

### Decisions

Recorded from the session-log analysis of the argus-timeline-ui run,
2026-08-06:

1. **Detection over prevention.** The restart cost three minutes of reviewer
   time; the 2.5-hour stall cost the afternoon. The fix targets the stall.
2. **The session babysits, the human does not.** The check-in loop is the
   session's job, armed at launch and silent while healthy — the human's
   "und?" must never be the recovery mechanism again.

