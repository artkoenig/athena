# Each increment on its own branch, merged on acceptance

## Problem

The run works one branch, so "what did this increment change" is not a fact
anyone can cheaply ask of git. Two costs follow, both measured or visible in
the run of 2026-08-07 (evidence:
`docs/issues/2026-08-08-carry-the-map-across-rounds`):

1. **The reviewer re-derives its scope every round.** It checks the whole
   diff against main, and from the second increment on that diff carries the
   accepted work of every increment before it. The `baseline()` prose block
   in `workflows/agile-loop.js` tells it in words which increments are
   settled, but not which files are its own, so it tours the commit history
   to find out: 17.9 M cache-read tokens and ~21 minutes across seven
   reviewers went into finding what to review, not reviewing it.

2. **Work that was never accepted stays in the diff and the pull request.**
   A blocked increment's code sits on the issue branch forever; `baseline()`
   has to tell the reviewer to neither fix it nor re-report it, and the
   human merges a pull request that carries it.

The fix is structural: every increment branches off the issue branch, all
its rounds happen on that branch, and acceptance merges it back. Then the
increment's diff is the branch's diff against its merge-base — a git fact,
free of bookkeeping — and a blocked increment is simply never merged: the
next increment starts from a tip that holds only accepted work, and the
pull request contains nothing the review did not pass.

## Acceptance criteria

- [ ] Every increment is worked on its own branch, created from the issue
      branch's tip by the first agent dispatched for it, under a naming
      convention that carries the increment id. The branch name is recorded
      on the increment in `backlog.json`, and a resumed run fetches and
      checks out the recorded branch instead of assuming the issue branch.
- [ ] Every dispatch of an increment names the increment branch, and every
      agent of the increment commits and pushes to it. The shared brief's
      commit-and-push rule and the workflow prompts agree on this in one
      wording.
- [ ] The reviewer's brief names the diff range — the increment branch
      against its merge-base with the issue branch — and the reviewer judges
      that diff. The `baseline()` block goes: no prose list of settled
      increments is needed when the diff no longer contains them. The
      reviewer is still handed no plan, no codemap and no other agent's
      output.
- [ ] The reviewer may prove "already red before this change" by running the
      named checks in a throwaway worktree of the merge-base, and its page
      says so. The worktree is created and removed inside its own step —
      never recorded, never resumed from.
- [ ] On acceptance, the planner's replan step merges the increment branch
      into the issue branch and pushes it, before it closes the increment
      and re-cuts. On a blocked close it does not merge; the increment
      branch stays pushed, and the state's note names it.
- [ ] An increment handed back as `todo` after a re-cut starts a fresh
      branch from the issue branch's current tip; the recorded branch name
      is replaced, and the abandoned branch is left on the remote for the
      human.
- [ ] The publish step opens the pull request for the issue branch as
      today, and its body names the branch of every blocked increment, so
      unmerged work is findable without being in the diff.
- [ ] The driver in `test-repo.sh` covers the branch-per-increment flow:
      the branch exists while the increment is worked, acceptance lands the
      work on the issue branch, a blocked increment's work does not land,
      and a resume finds the recorded branch.
- [ ] `./test.sh` is green.

## Decisions

Recorded from the discussion of 2026-08-08; each answer is the human's.

1. **How does the reviewer learn its increment's scope?** From the branch:
   the increment's diff is its branch against the merge-base, so the scope
   is a git fact nobody hands over. (Rejected: a base SHA recorded per
   increment — solves the scoping but leaves blocked work in the pull
   request; a file list threaded through the implementer's return — grows
   the schema and still has the reviewer working a whole-of-run diff.)
2. **Are worktrees run state?** No. The run is sequential — one increment
   at a time — so one working directory that checks out the increment
   branch suffices, and a worktree would be local state that dies with the
   container while `backlog.json` and the remote survive. A worktree
   appears only as the reviewer's throwaway checkout of the merge-base.
3. **Who merges?** The planner, in the replan step it already owns: it
   closes the increment, so it lands the accepted work in the same call.
   Sequential branching from the tip means the merge is fast-forward-clean
   in the normal case; a conflict there is a run bug worth surfacing, not
   worth automating around.

## Out of scope

- **The recorder size ceiling** from
  `docs/issues/2026-08-08-carry-the-map-across-rounds`. It stays there;
  that issue's reviewer-file-list criterion is superseded by this one, and
  its re-cut now has three predecessors to cut against.
- **Parallel increments.** Branches would permit working increments
  concurrently; the run stays sequential, and nothing here may depend on
  two increment branches being live at once.
- **The pull request's shape.** One pull request, issue branch against the
  default branch, as today. Per-increment pull requests are a different
  design with a different review gate.
