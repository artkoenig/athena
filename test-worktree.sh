#!/bin/bash
# Tests for running work in parallel: what a worktree needs from this
# repository. Nothing here creates a worktree — every case reads the
# repository's own configuration, so the checkout the suite runs from is left
# exactly as it was. Exit 0 = all cases pass.
set -u

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

passed=0
failed=0

ok() { passed=$((passed + 1)); echo "  ok   — $1"; }
no() { failed=$((failed + 1)); echo "  FAIL — $1"; }
check() { if [ "$1" = "0" ]; then ok "$2"; else no "$2"; fi; }

echo "=== what a parallel run needs from this repository"

# `claude --worktree` puts its checkout under .claude/worktrees/. Unignored,
# every parallel run turns the main checkout's status into noise and can be
# committed by accident.
git -C "$root" check-ignore -q .claude/worktrees/some-run
check $? ".gitignore covers .claude/worktrees/"

# The rulebook branches every issue from the current default branch and never
# from an unmerged predecessor. `worktree.baseRef` decides that for worktrees,
# and "head" would branch from whatever is checked out instead. The default is
# already "fresh"; setting it in the project's own settings is what stops a
# user-scope "head" from quietly overriding it.
node -e '
  const s = require(process.argv[1]);
  if (!s.worktree || s.worktree.baseRef !== "fresh") process.exit(1);
' "$root/.claude/settings.json"
check $? "project settings pin worktree.baseRef to fresh"

# A worktree is a fresh checkout, so gitignored files are absent from it.
# .worktreeinclude names the ones a run needs — but Claude Code copies a file
# only when it is gitignored too, so a pattern git does not ignore is a
# silent no-op, and the file it names would still be missing in every
# worktree.
if [ -f "$root/.worktreeinclude" ]; then
  ok ".worktreeinclude exists"
  strays=""
  while IFS= read -r pattern; do
    case "$pattern" in ''|'#'*) continue ;; esac
    git -C "$root" check-ignore -q "$pattern" || strays="${strays} ${pattern}"
  done <"$root/.worktreeinclude"
  if [ -z "$strays" ]; then
    ok "every pattern in .worktreeinclude is one .gitignore covers"
  else
    no "these .worktreeinclude patterns are not gitignored, so nothing is copied:${strays}"
  fi
else
  no ".worktreeinclude is missing"
  no "(skipped: every pattern in .worktreeinclude is one .gitignore covers)"
fi

echo
if [ "$failed" -eq 0 ]; then
  echo "PASS: $passed cases"
else
  echo "FAIL: $failed of $((passed + failed)) cases"
  exit 1
fi
