#!/bin/bash
set -u

# ---------------------------------------------------------------------------
# The plugin's SessionStart hook. One job: in a cloud session, warn when the
# session is not running the newest uroboros.
#
# It deliberately updates nothing. The CLI resolves a session's components
# before any hook runs, so an update from inside a session can only reach
# the next one — keeping the installation current is the job of the
# environment's setup script and of the CLI's own background auto-update,
# both of which run outside a session. What a session itself can do about
# its staleness is exactly one thing: say so.
#
# The comparison needs no claude call. The plugin pins no version, so the
# installed version is the source commit's SHA prefix, and that is the name
# of the directory CLAUDE_PLUGIN_ROOT points into. The newest version is the
# tip of the marketplace repository, asked from the marketplace clone's own
# remote — its origin, not a hard-coded URL, so a fork's plugin checks
# against the fork. No answer, no warning: with the network down there is
# nothing to compare against, and a wrong warning is worse than none.
#
# Local sessions are left alone: no network, no output. stdout carries the
# hook JSON and nothing else — a stray echo would invalidate it and the
# warning would never arrive.
# ---------------------------------------------------------------------------

[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
[ -n "${CLAUDE_PLUGIN_ROOT:-}" ] || exit 0

running="$(basename "$CLAUDE_PLUGIN_ROOT")"
marketplace="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/marketplaces/uroboros"

git -C "$marketplace" rev-parse --git-dir >/dev/null 2>&1 || exit 0
tip="$(timeout 10 git -C "$marketplace" ls-remote origin HEAD 2>/dev/null | cut -f1)"

[ -n "$tip" ] || exit 0
case "$tip" in "$running"*) exit 0 ;; esac

printf '{"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "WARNING: this session runs an outdated uroboros plugin (version %s, but the repository tip is %s). Its agents, skills and workflows are the old ones, and a running session cannot swap them — tell the human, and recommend a fresh session after claude plugin update uroboros@uroboros."}}\n' \
  "$running" "$tip"
