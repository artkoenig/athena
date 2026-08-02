#!/bin/bash
# Tests for running work in parallel: what a worktree needs from this
# repository, and what the plugin has to keep doing inside one.
#
# The worktrees below are real ones, created with git in a scratch clone of
# this repository — never in the checkout the suite runs from. Exit 0 = all
# cases pass.
set -u

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
# The scratch clone owns every worktree this suite creates, so removing the
# scratch tree removes them with it — nothing to prune in the real checkout.
trap 'rm -rf "$tmp"' EXIT

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
echo "=== what the plugin keeps doing inside a worktree"

# A scratch clone of this repository, with a bare remote to push at. The
# worktree goes where Claude Code would put it.
clone="$tmp/clone"
remote="$tmp/remote.git"
git init -q --bare -b main "$remote"
git clone -q "$root" "$clone" 2>/dev/null
git -C "$clone" config user.email test@example.com
git -C "$clone" config user.name test
git -C "$clone" remote set-url origin "$remote"
git -C "$clone" push -q --no-verify origin HEAD:main

worktree="$clone/.claude/worktrees/parallel-run"
git -C "$clone" worktree add -q "$worktree" -b worktree-parallel-run

# The plugin sets core.hooksPath on the main checkout, and a worktree shares
# the repository's config — so the guard reaches a parallel run without the
# hook ever being run there. This is the case worth pinning: the guard is
# what keeps a run off the default branch, and a worktree is where a run
# happens.
CLAUDE_PLUGIN_ROOT="$root" CLAUDE_PROJECT_DIR="$clone" \
  bash "$root/hooks/session-start.sh" >/dev/null 2>&1
[ "$(git -C "$worktree" config core.hooksPath)" = "$root/.githooks" ]
check $? "the guard set on the main checkout is in effect in the worktree"

echo change >>"$worktree/README.md"
git -C "$worktree" commit -qam "work in a parallel run"

git -C "$worktree" push -q origin HEAD:main >/dev/null 2>&1
[ $? -ne 0 ]
check $? "a push to the default branch from inside a worktree is refused"

git -C "$worktree" push -q origin HEAD:worktree-parallel-run >/dev/null 2>&1
check $? "a push to the run's own branch from inside a worktree succeeds"

# A session started with --worktree has the worktree as its project
# directory, not the main checkout. The hook has to work there too: same
# rulebook, and a guard state that reports what is actually in effect.
out="$tmp/worktree-hook.json"
CLAUDE_PLUGIN_ROOT="$root" CLAUDE_PROJECT_DIR="$worktree" \
  bash "$root/hooks/session-start.sh" >"$out" 2>/dev/null
status="$(node -e '
  const fs = require("fs");
  const ctx = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).hookSpecificOutput.additionalContext;
  process.stdout.write(ctx.split("\n").filter(l => l.startsWith("Athena self-check:")).pop() || "");
' "$out")"

node -e '
  const fs = require("fs");
  const ctx = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).hookSpecificOutput.additionalContext;
  if (!ctx.includes(fs.readFileSync(process.argv[2], "utf8").trimEnd())) process.exit(1);
' "$out" "$root/CLAUDE.md"
check $? "the rulebook reaches a session whose project directory is a worktree"

case "$status" in
  *"push guard set"*"no problems.") ok "the self-check reports the guard as set from inside a worktree" ;;
  *) no "unexpected status from inside a worktree: $status" ;;
esac

echo
if [ "$failed" -eq 0 ]; then
  echo "PASS: $passed cases"
else
  echo "FAIL: $failed of $((passed + failed)) cases"
  exit 1
fi
