# The SessionStart hook

`hooks.json` registers one hook; `session-start.sh` is what it runs. Between
them they do the three things a plugin cannot do on its own: put the rulebook
text into the session's context, count what the plugin actually exposes, and
point the project's git hooks at the push guard.

## Conventions

- **stdout is the hook JSON and nothing else.** Every diagnostic goes to
  stderr. A stray `echo` does not merely add noise — it invalidates the JSON
  and the session starts without the rulebook.
- **Plain `bash` with `set -u`, and nothing beyond coreutils, `git`, and —
  only when `CLAUDE_CODE_REMOTE=true` — the `claude` CLI itself, to
  self-update before resolving the rulebook path.** The hook runs wherever a
  session starts, including a container with nothing installed; the `claude`
  dependency is scoped to the remote path precisely because a fresh local
  checkout cannot be assumed to have it wired up yet.
- **Report the end state, never the step that was attempted.** "push guard not
  set (project's own hooks at .husky left in place)" is the fact; "tried to set
  core.hooksPath" is not.
- **Never take over what the project owns.** A project that already points
  `core.hooksPath` somewhere manages its own hooks; overwriting it would
  silently delete all of them. Leave the value and report the missing guard.
- **Count, do not assume.** The self-check counts only what discovery can
  actually reach, and names anything that is in the tree but unreachable as a
  defect. Zero of something is not a defect.
- **Resolve the updated version through `claude plugin list`, never through
  directory mtimes.** A remote environment can reuse a plugin cache that is
  hours or days older than the session — `CLAUDE_PLUGIN_ROOT` is resolved
  before the self-update runs, so it can still point at what the update just
  orphaned. mtimes of the version directories under the cache have been
  observed out of order between two installed versions, so they cannot stand
  in for "which one is current." Only `claude plugin list`'s own report does.
  Any failure in the self-update — nothing to update, the call times out, the
  reported version is not on disk — is silent: `plugin_root` simply stays
  what it was inherited as, and the hook proceeds exactly as it would without
  this step.

`test-plugin.sh` guards all of this — the JSON shape, the verbatim rulebook,
every branch of the self-check, and the guard's behaviour against a real
scratch repository.
