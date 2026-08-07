#!/bin/bash
# Runs every test suite in this repository, one after another, and exits 0
# only when all of them pass. This is the one command behind "the suite is
# green" — a new suite must be added to the list below.
set -u

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

failed=0
total=0

run() {
  total=$((total + 1))
  echo "=== $1"
  shift
  "$@" || failed=$((failed + 1))
  echo
}

# First, because every agent commits its step return: a signing
# misconfiguration costs a whole agent's work, and this is the one line of
# output that says so before the work rather than after it.
run "commit signing in this environment" \
  bash "$root/bin/check-commit-signing"

run "the commit-signing check itself" \
  bash "$root/test-signing.sh"

run "the repository itself" \
  bash "$root/test-repo.sh"

run "parallel runs: worktrees" \
  bash "$root/test-worktree.sh"

# The backlog recorder, the only writer of a run's `backlog.json`. Named as a
# file rather than as the `skills/agent-brief/assets` directory because
# `node --test <dir>` resolves the bare directory as a module in this Node
# build instead of scanning it for `*.test.mjs`.
run "skills/agent-brief/assets: the backlog recorder" \
  node --test "$root/skills/agent-brief/assets/backlog.test.mjs"

# Through the package's own `test` script rather than a `node --test` line
# repeated here, so the suite this runs stays the suite the tool declares.
# Zero-dependency, so no install step is needed first.
run "tools/argus" \
  npm --prefix "$root/tools/argus" test --silent

run "tools/argus-ui" \
  npm --prefix "$root/tools/argus-ui" test --silent

run "tools/log-parser" \
  npm --prefix "$root/tools/log-parser" test --silent


if [ "$failed" -eq 0 ]; then
  echo "PASS: all $total suites"
else
  echo "FAIL: $failed of $total suite(s)"
  exit 1
fi

