#!/bin/bash
set -u

# ---------------------------------------------------------------------------
# The plugin's SessionStart hook. Two jobs, one piece of output.
#
# 1. It puts the rulebook into the session's context. `rulebook.md` is not a
#    memory filename, so nothing loads it anywhere on its own, and a skill is
#    model-invoked and therefore optional — a session would be free to skip it.
#    The text is delivered verbatim rather than as a pointer to the file for
#    the same reason: a session that is told where the rules are is a session
#    that may not go and read them.
#
# 2. In a cloud session it warns when that session is not running the newest
#    uroboros.
#
# That the rulebook is delivered from here and not as a `CLAUDE.md` is the
# whole point, and it is what keeps it out of every subagent. A `CLAUDE.md` at
# the plugin root or in the checkout would load as project memory and be
# inherited by every agent dispatched in that session — which no installing
# project can reproduce, so the same agent would hold the rulebook in one
# project and not in the other. `additionalContext` goes to the session that
# is starting and to nothing else: a subagent is dispatched inside a running
# session and never starts one, so this hook does not fire for it and cannot
# reach it. What an agent needs travels in the `agent-brief` skill instead,
# which every agent page preloads. `test-repo.sh` pins both halves.
#
# It deliberately updates nothing. The CLI resolves a session's components
# before any hook runs, so an update from inside a session can only reach the
# next one — keeping the installation current is the job of the environment's
# setup script and of the CLI's own background auto-update, both of which run
# outside a session. What a session itself can do about its staleness is
# exactly one thing: say so.
#
# The comparison needs no claude call. The plugin pins no version, so the
# installed version is the source commit's SHA prefix, and that is the name
# of the directory CLAUDE_PLUGIN_ROOT points into. The newest version is the
# tip of the marketplace repository, asked from the marketplace clone's own
# remote — its origin, not a hard-coded URL, so a fork's plugin checks
# against the fork. No answer, no warning: with the network down there is
# nothing to compare against, and a wrong warning is worse than none.
#
# stdout carries the hook JSON and nothing else — a stray echo would
# invalidate it and neither the rulebook nor the warning would arrive.
# ---------------------------------------------------------------------------

# CLAUDE_PLUGIN_ROOT is set when this runs as an installed plugin. Falling back
# to this script's own parent is what makes the hook work in a checkout of the
# repository itself, where the rulebook sits beside it.
plugin_root="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
plugin_root="$(cd "$plugin_root" 2>/dev/null && pwd || echo "$plugin_root")"
rulebook="${plugin_root}/rulebook.md"

# JSON-encode stdin as the body of a JSON string: drop the control bytes that
# carry no text anyway, escape the two delimiters, the tab and the carriage
# return, then fold the newlines. A raw CR would end the JSON string's validity
# as surely as a raw newline, so it is escaped rather than dropped — a rulebook
# with CRLF line ends arrives whole. Multibyte UTF-8 passes through untouched.
json_body() {
  LC_ALL=C tr -d '\000-\010\013\014\016-\037\177' \
    | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\t/\\t/g' -e 's/\r/\\r/g' \
    | sed -e ':a' -e 'N' -e '$!ba' -e 's/\n/\\n/g' \
    | tr -d '\n'
}

# The staleness check, remote sessions only: no network and no output on a
# local one. An empty warning is the normal case and costs the session nothing.
warning=""
if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ] && [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then
  running="$(basename "$CLAUDE_PLUGIN_ROOT")"
  marketplace="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/marketplaces/uroboros"

  if git -C "$marketplace" rev-parse --git-dir >/dev/null 2>&1; then
    tip="$(timeout 10 git -C "$marketplace" ls-remote origin HEAD 2>/dev/null | cut -f1)"
    if [ -n "$tip" ]; then
      case "$tip" in
        "$running"*) ;;
        *)
          warning="WARNING: this session runs an outdated uroboros plugin (version ${running}, but the repository tip is ${tip}). Its agents, skills and workflows are the old ones, and a running session cannot swap them — tell the human, and recommend a fresh session after claude plugin update uroboros@uroboros."
          ;;
      esac
    fi
  fi
fi

# A missing rulebook is worth saying out loud rather than passing over: the
# session would otherwise run with no rules at all and no sign that it is.
if [ ! -f "$rulebook" ]; then
  warning="WARNING: no rulebook.md at ${plugin_root}, so this session started without the uroboros rulebook. Tell the human.${warning:+ }${warning}"
fi

# Nothing to say, nothing written: a hook that prints an empty context is a
# hook that has to be parsed for no reason.
[ -f "$rulebook" ] || [ -n "$warning" ] || exit 0

{
  printf '{"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "'
  {
    [ -f "$rulebook" ] && cat "$rulebook"
    [ -n "$warning" ] && printf '\n%s\n' "$warning"
  } | json_body
  printf '"}}\n'
}
