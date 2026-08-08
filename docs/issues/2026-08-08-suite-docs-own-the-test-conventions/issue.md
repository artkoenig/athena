# The suite doc owns the test conventions, and the test-author keeps it

## Problem

The test-author is the most expensive role in a measured run — 31.4 M
cache-read tokens over six agents, 5.24 M each, more than double any other
role — and it gets the least about the code. Its whole brief is the
researcher's test plan, which names the target test file and demands its
conventions be followed, but does not carry what those conventions are. So
the author reads the file whole to find out where a case belongs and which
helper to reuse: `context.test.mjs` was opened 20 times in one run
(evidence: `docs/issues/2026-08-08-carry-the-map-across-rounds`).

Almost none of that knowledge is issue-specific. Which helpers a suite has,
how its fixtures work, how cases are named, what is faked and what is real —
that changes when the tests change, not when the issue does. It is project
knowledge, and the run has been keeping it in the wrong place: in step
returns that `close` sheds, so every agent re-derives it.

The fix: the knowledge lives in the repository, as a `CLAUDE.md` in each
test directory, loaded automatically for whoever works there — this repo has
measured that directory memory reaches a subagent on its own reads. The run
writes what it learns back into the repository instead of into state that
dies with the increment.

## Acceptance criteria

- [ ] Every test directory in this repository carries a `CLAUDE.md`:
      `skills/agent-brief/assets/`, `tools/argus/test/`,
      `tools/argus-ui/test/` and `tools/log-parser/test/`. Each states what
      the suite covers, the helpers and fixtures a new case reuses and what
      each is for, where a new case belongs, how cases are named, what is
      faked and what is real, and the command that runs just this suite.
      Each is written from reading the suite as it is, not from memory.
- [ ] The test-author's page makes the suite doc part of its step: for every
      test file it touched, it updates that directory's `CLAUDE.md` in the
      same commit as the tests, and where none exists it creates one from
      what it just read. A doc the test plan reported wrong is the
      test-author's to correct, since it is the one changing the suite.
- [ ] The researcher's test-plan contract gives the conventions up: its page
      and the `testPlan` schema description in `workflows/agile-loop.js` say
      that conventions, helpers and fixtures belong to the suite doc, and
      the test plan carries per case only the issue-specific facts — the
      criterion it proves, input, state, expected result, level, target file
      and the command. Where the suite doc is missing or wrong, the test
      plan says so instead of restating conventions.
- [ ] `test-repo.sh` checks that every directory holding a `*.test.mjs`
      carries a `CLAUDE.md`, so a new suite cannot ship undocumented and a
      bootstrapped doc cannot be deleted silently.
- [ ] `./test.sh` is green.

## Decisions

Recorded from the grilling of 2026-08-08; each answer is the human's.

1. **Where does the suite knowledge live?** In the repository, as a
   `CLAUDE.md` per test directory — the human proposed it, replacing the
   run-level suite index sketched in carry-the-map. Most of the knowledge is
   project-durable, not issue-specific; the issue-specific rest stays in the
   test plan. (Rejected: a run-level index in `backlog.json` — dies with the
   run's usefulness, needs a new state channel, helps no human.)
2. **Who maintains it?** The test-author, in the same commit as the tests it
   writes; it creates the doc where none exists. (Rejected: the researcher —
   it never touches the tests, so it would document files others change;
   nobody/retro-only — the doc rots, which is the status quo.)
3. **What happens to the test plan?** It gives the conventions up and keeps
   the issue-specific facts; gaps and errors in the suite doc are reported,
   not worked around. (Rejected: keeping both — two descriptions of one
   thing drift, against this repo's describe-once rule.)
4. **Bootstrap now or lazily?** Now, for all four suites of this repository,
   with the `test-repo.sh` existence check. (Rejected: lazily — this issue
   would deliver nothing observable, and the most expensive known read,
   `tools/argus-ui/test/`, would stay undocumented.)

Defaults taken without a question: the file is named `CLAUDE.md` (the memory
mechanism the agents actually run on; no `GEMINI.md` mirror in test
directories — the root-level mirror exists for the session, and no agent of
the loop runs on Gemini); the reviewer's brief does not change.

## Out of scope

- **The reviewer's file list and the recorder size ceiling** from
  `docs/issues/2026-08-08-carry-the-map-across-rounds`. That issue must be
  re-cut against this one as well as against
  `2026-08-08-planner-codemap-single-workflow`: its run-level map is now
  superseded twice — the what-files half by the planner's codemap, the
  suite-knowledge half by the suite docs.
- **Suite docs in host projects.** The test-author's page rule travels with
  the plugin and creates them lazily wherever it works; bootstrapping other
  repositories is their own business.
- **The implementer's reading.** It gets the module map and was the
  second-cheapest role; nothing here changes its brief.
