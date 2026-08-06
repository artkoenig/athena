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

run "the repository itself" \
  bash "$root/test-repo.sh"

run "parallel runs: worktrees" \
  bash "$root/test-worktree.sh"

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

