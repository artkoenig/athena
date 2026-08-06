#!/bin/bash
set -u

# ---------------------------------------------------------------------------
# The plugin's SessionStart hook. It does two things a plugin cannot do by
# itself: it puts the rulebook text into the session's context — rulebook.md
# is not a memory filename, so nothing loads it anywhere, and a skill is
# model-invoked and therefore optional — and it points the project's git hooks
# at the push guard shipped with the plugin, unless the project already has
# hooks of its own.
#
# That the rulebook is not named CLAUDE.md is the point. A CLAUDE.md in the
# uroboros checkout would load as project memory there and be inherited by
# every subagent, which no installing project can reproduce — the same agent
# would then hold the rulebook in one project and not in the other. Delivered
# from here it reaches the session and stops there, identically everywhere,
# and what an agent needs travels in the agent-brief skill instead.
#
# Skills and agents need nothing from here: plugin discovery exposes
# skills/<name>/SKILL.md and agents/<name>.md on its own. What this script
# adds for them is the self-check status, which counts what is actually
# reachable in the plugin tree, so a session sees what it really has instead
# of trusting the rulebook's role names.
#
# stdout carries the hook JSON and nothing else.
# ---------------------------------------------------------------------------

plugin_root="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
plugin_root="$(cd "$plugin_root" 2>/dev/null && pwd || echo "$plugin_root")"
project_dir="${CLAUDE_PROJECT_DIR:-.}"

# A remote, disposable environment can sit on a plugin cache that is a
# stale snapshot from whenever the environment itself was provisioned —
# nothing re-fetches it between sessions on its own. Update first, then
# resolve the rulebook from wherever the update actually left the plugin,
# not from the CLAUDE_PLUGIN_ROOT this invocation inherited: that path was
# resolved before the update ran and may already be the orphaned version.
# Local development never takes this path: CLAUDE_CODE_REMOTE is unset, so
# no `claude` call, no network, no added dependency.
#
# Directory mtimes are not a safe way to find the current version — they
# have been observed out of order between two installed versions. `claude
# plugin list` is what actually knows, so that is what gets parsed. Any
# failure here — no update available, the call times out, the reported
# version does not exist on disk — leaves plugin_root exactly as inherited;
# the rulebook this session gets is then the same one it would have gotten
# without this block.
if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ] && command -v claude >/dev/null 2>&1; then
  timeout 15 claude plugin update uroboros@uroboros >/dev/null 2>&1
  new_version="$(claude plugin list 2>/dev/null | grep -A1 'uroboros@uroboros' | sed -n 's/^ *Version: *//p')"
  if [ -n "$new_version" ]; then
    candidate="$(dirname "$plugin_root")/${new_version}"
    [ -d "$candidate" ] && plugin_root="$candidate"
  fi
fi

rulebook="${plugin_root}/rulebook.md"
guard_dir="${plugin_root}/.githooks"

# JSON-encode stdin as the body of a JSON string: drop the control bytes that
# carry no text anyway, escape the two delimiters, the tab and the carriage
# return, then fold the newlines. A raw CR would end the JSON string's
# validity as surely as a raw newline, so it is escaped rather than dropped —
# a rulebook with CRLF line ends arrives whole. Multibyte UTF-8 passes
# through untouched.
json_body() {
  LC_ALL=C tr -d '\000-\010\013\014\016-\037\177' \
    | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\t/\\t/g' -e 's/\r/\\r/g' \
    | sed -e ':a' -e 'N' -e '$!ba' -e 's/\n/\\n/g' \
    | tr -d '\n'
}

problems=""

# 1. What the plugin actually exposes. Count, do not assume: a skill
#    directory without its SKILL.md and an agent that is not a flat .md file
#    are invisible to plugin discovery, so neither may be counted, and each
#    is a defect — something is in the tree that the session cannot reach.
#    A count of zero is not: uroboros ships the rulebook first and its agents
#    and skills after, and the rulebook tells the session to read these
#    counts rather than assume a role has a page behind it.
#    Two places hold skills: the plugin's own skills/, and the directory of
#    an agent that preloads one of its own. Both reach a session — the second
#    through plugin.json's skills paths — so both are counted here.
skills=0
for dir in "${plugin_root}/skills"/*/ "${plugin_root}/agents"/*/skills/*/; do
  [ -d "$dir" ] || continue
  name=$(basename "$dir")
  if [ -f "${dir}SKILL.md" ]; then
    skills=$((skills + 1))
  else
    problems="${problems} skill without SKILL.md: ${name};"
  fi
done
# plugin.json lists the agent files, which replaces the recursive scan of
# agents/ — without that list every .md below the directory would load as an
# agent named after its path. So what is reachable is agents/<name>.md, and
# anything else under agents/ is in the tree and unreachable. The one
# exception is an agent's own directory, <name>/ beside <name>.md, which
# holds what belongs to that agent alone: the skills only it preloads. Those
# reach the session through plugin.json's skills paths, so the directory is
# not a lost agent.
agents=0
for entry in "${plugin_root}/agents"/*; do
  [ -e "$entry" ] || continue
  name=$(basename "$entry")
  if [ -f "$entry" ] && [ "${name%.md}" != "$name" ]; then
    agents=$((agents + 1))
  elif [ -d "$entry" ] && [ -f "${entry}.md" ]; then
    continue
  else
    problems="${problems} agent not reachable: ${name%.md};"
  fi
done

# 2. The rulebook itself, verbatim — a pointer to the file would leave the
#    session free to skip it.
if [ -f "$rulebook" ]; then
  rulebook_state="rulebook delivered"
else
  rulebook_state="rulebook missing (no rulebook.md at the plugin root)"
  problems="${problems} ${rulebook_state};"
fi

# 3. The push guard: point the project's git hooks at the plugin's, so
#    pre-push refuses a direct push to the default branch. A project that is
#    no git repository cannot be pushed from, so an absent guard there is a
#    note; anywhere else it means an unguarded push is possible, and that is
#    a failure. A project that already points core.hooksPath somewhere else
#    manages its own hooks — husky, lefthook, pre-commit — and taking that
#    over would silently delete all of them, so the value is left alone and
#    the missing guard is reported instead. Report the end state, not the
#    step that was attempted.
existing_hooks_path=""
if ! git -C "$project_dir" rev-parse --git-dir >/dev/null 2>&1; then
  guard_state="push guard n/a (project is not a git repository)"
elif [ ! -d "$guard_dir" ]; then
  guard_state="push guard not set (no .githooks at the plugin root)"
  problems="${problems} ${guard_state};"
else
  existing_hooks_path="$(git -C "$project_dir" config core.hooksPath 2>/dev/null || true)"
  if [ -n "$existing_hooks_path" ] && [ "$existing_hooks_path" != "$guard_dir" ]; then
    guard_state="push guard not set (project's own hooks at ${existing_hooks_path} left in place)"
    problems="${problems} ${guard_state};"
  else
    git -C "$project_dir" config core.hooksPath "$guard_dir" >/dev/null 2>&1
    if [ "$(git -C "$project_dir" config core.hooksPath 2>/dev/null)" = "$guard_dir" ]; then
      guard_state="push guard set"
    else
      guard_state="push guard not set (could not write core.hooksPath)"
      problems="${problems} ${guard_state};"
    fi
  fi
fi

status="Uroboros self-check: ${skills} skills and ${agents} agents reachable; ${rulebook_state}; ${guard_state};"
if [ -z "$problems" ]; then
  status="${status} no problems."
else
  status="${status} FAILED:${problems} the plugin at ${plugin_root} is incomplete."
fi

# 4. Hand the rulebook and the status to the session, in that order.
{
  printf '{"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "'
  {
    [ -f "$rulebook" ] && cat "$rulebook"
    printf '\n%s\n' "$status"
  } | json_body
  printf '"}}\n'
}
