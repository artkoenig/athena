# The SessionStart hook

`hooks.json` registers one hook; `session-start.sh` is what it runs. Between
them they do the three things a plugin cannot do on its own: put the rulebook
text into the session's context, count what the plugin actually exposes, and
point the project's git hooks at the push guard.

## Conventions

- **stdout is the hook JSON and nothing else.** Every diagnostic goes to
  stderr. A stray `echo` does not merely add noise — it invalidates the JSON
  and the session starts without the rulebook.
- **Plain `bash` with `set -u`, and nothing beyond coreutils and `git`.** The
  hook runs wherever a session starts, including a container with nothing
  installed.
- **Report the end state, never the step that was attempted.** "push guard not
  set (project's own hooks at .husky left in place)" is the fact; "tried to set
  core.hooksPath" is not.
- **Never take over what the project owns.** A project that already points
  `core.hooksPath` somewhere manages its own hooks; overwriting it would
  silently delete all of them. Leave the value and report the missing guard.
- **Count, do not assume.** The self-check counts only what discovery can
  actually reach, and names anything that is in the tree but unreachable as a
  defect. Zero of something is not a defect.

`test-plugin.sh` guards all of this — the JSON shape, the verbatim rulebook,
every branch of the self-check, and the guard's behaviour against a real
scratch repository.
