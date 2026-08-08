# One workflow, and the planner maps what the issue changes

## Problem

The plugin ships two workflows that share ~70 % of their code, and the session
has to pick between them before any agent has seen the issue. That choice
belongs to the planner: whether an issue is one change or several is exactly
the cut it exists to make, and a backlog of one increment already runs the
plain chain.

Separately, every researcher opens the codebase blind. The planner cuts the
issue without knowing which files it touches, so the cut is a guess about
scope, and the researcher starts every round with "which files are these?" —
a question the run could have answered once, up front.

The division this issue establishes: **the planner says what — the increments
and the files the issue has to change; the researcher says how — the plan,
the module detail, the testing.**

## Acceptance criteria

- [ ] `workflows/loop.js` is deleted. `workflows/agile-loop.js` is the only
      workflow the plugin ships, and no page, prompt, script or test names
      `uroboros:loop` anymore. The record under `docs/issues/` stays as it is.
- [ ] The planner decides whether and how to cut: its page and the decompose
      prompt say that a backlog of one increment is the right cut for an issue
      that is one change, and nothing outside the planner pre-decides the cut.
- [ ] The planner returns a `codemap` — every file the issue has to change,
      path and why, one line per file — on the opening cut, and updated on
      every re-cut against what the increment just worked showed.
- [ ] The planner builds the codemap by searching, not by designing: its tools
      gain Glob and Grep, and its page bounds the codemap to files and
      reasons — never functions, approaches or implementation detail. Those
      stay the researcher's.
- [ ] `backlog.json` carries the codemap as a top-level field, written through
      the recorder's `init` payload. `close` does not shed it, and an `init`
      payload without a codemap keeps the one already in the file.
      `backlog.test.mjs` covers all three behaviours.
- [ ] Every researcher dispatch carries the codemap with the instruction to
      build its research on it and to report corrections in its own return;
      the researcher never writes the codemap. The test-author, implementer
      and reviewer prompts do not carry it.
- [ ] A run resumed from `backlog.json` hands the saved codemap to the next
      researcher it dispatches. The driver in `test-repo.sh` covers the resume
      path and the per-role slicing.
- [ ] `rulebook.md`, `GEMINI.md` and `README.md` describe the single workflow
      and the planner's codemap, and the claim that the planner never reads
      the codebase is replaced by the search-not-design boundary.
- [ ] `./test.sh` is green.

## Decisions

Recorded from the grilling of 2026-08-08; each answer is the human's.

1. **How deep may the planner go into the codebase?** Search, not read: Glob
   and Grep to name paths and why each file changes — no designing, no
   functions or approaches in the codemap. (Alternatives rejected: full read
   access — blurs the role boundary and makes the cheapest role expensive;
   guessing from the issue alone — wrong on every non-trivial issue.)
2. **Who keeps the codemap current during a run?** The planner owns it. The
   researcher consumes it and reports deviations in its own return; the
   planner folds them in on every re-cut. One writer. (Rejected: a living
   document the researcher amends directly — two writers, more channel.)
3. **Where does the codemap survive?** As its own top-level field in
   `backlog.json`, written via the `init` payload; `close` leaves it standing.
   (Rejected: only in the planner's step return — `close` sheds returns, so a
   resume mid-increment could lose the map.)
4. **What happens to `docs/issues/2026-08-08-carry-the-map-across-rounds`?**
   It stays. This change covers only part of it and with a different owner;
   see Out of scope.

## Out of scope

- **`docs/issues/2026-08-08-carry-the-map-across-rounds`.** It attacks the
  same waste at three points this issue does not touch: the suite index for
  the test-author (the most expensive role of the measured run), the file
  list for the reviewer, and the size ceiling in the recorder. It must be
  re-cut after this lands — its mechanism (a researcher-maintained map) and
  its `workflows/loop.js` criterion are superseded by the decisions above.
- **The deep code facts.** The codemap names files and reasons. What each
  file holds, its entry points and its conventions stay per-round researcher
  work; carrying those across rounds is carry-the-map's subject.
