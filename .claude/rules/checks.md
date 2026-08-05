# What this repository checks itself with

These facts do not change from issue to issue. They are written here so no
agent has to rediscover them, and rediscovering them is the expensive way to
learn what one paragraph already says.

- **The suite is `bash test.sh`.** The scripts are tracked non-executable, so
  `./test.sh` fails with "Permission denied" — that is not a broken checkout.
  It runs every suite below and exits 0 only when all of them pass.
- **There is no linter and no formatter.** No ESLint, no Prettier, no
  type-checker over the repository. "Static analysis is clean" means the suite
  is green and nothing else. Do not go looking for a second tool.
- **The suites**, each runnable on its own the same way:
  - `test-repo.sh` — facts about the repository itself: cross-file claims,
    naming, the things no other suite owns.
  - `test-plugin.sh` — the plugin this repository packages: both manifests,
    the SessionStart hook that delivers the rulebook, the push guard. Shell
    level, against scratch directories; no model is called.
  - `test-worktree.sh` — what running work in a parallel worktree needs.
- **Prose is not covered.** No suite reads the body of an agent page, a
  rulebook or the README. A change confined to prose has no test to write, and
  saying so is a finished answer, not a gap.
- **A new suite is added to the list in `test.sh`**, or it never runs.
