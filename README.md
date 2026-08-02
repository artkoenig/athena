# athena

> An AI agent workflow built on judgment, not rules — a few invariants,
> self-correction in the loop, and a human only where it matters. Successor to
> [metis](https://github.com/artkoenig/metis).

**Athena** is the Greek goddess of wisdom and craft: skill that comes from
practice, not from instruction. That is the principle, not just the name.

## What it's for

athena bets on the judgment of a modern Anthropic agent — it assumes at
least Opus 5 — and builds on that trust rather than around its absence.
Most agent workflows compensate for a model they don't quite trust with
process: approval gates, checklists, a human re-checking work the agent
could have checked itself. athena instead gives the agent the run and asks
it to decide how much planning a change needs, how to slice it, which
tools to reach for — and keeps process only for the handful of things a
model can't reliably judge about its own work, like grading its own tests
or reviewing a diff it just wrote.

That trust is what makes unattended work possible: a run is meant to go
from idea to pull request with no human at the keyboard, stepping in only
where a human actually has to — intent that's genuinely unclear, anything
irreversible, the merge itself. Everything a run decides or discovers along
the way is written to an issue as it happens, so a session that picks the
work back up — hours later, or a different session entirely — resumes from
that record instead of from a conversation that's gone.

**It also improves itself.** After every run, the agent records what got in
its way; a rule that keeps misfiring becomes a proposed change to the
rulebook itself, reviewed like any other pull request. Because every wired
project loads athena fresh at session start, an accepted fix reaches all of
them with their next session — the workflow gets better at being followed
without a human rewriting it by hand.

The rules themselves are one page, [`CLAUDE.md`](CLAUDE.md) — short enough
to read end to end if you want the specifics; this page won't repeat it.

## Installing it

athena is a Claude Code plugin, installed from its own marketplace:

```bash
claude plugin marketplace add artkoenig/athena
claude plugin install athena@athena
```

A session with the plugin active gets the rulebook of the current `main` in
its context, the subagents in [`agents/`](agents/) and the skills in
[`skills/`](skills/), a self-check saying what of that is actually reachable,
and a `pre-push` guard that refuses a direct push to the default branch. A
project that manages its own git hooks — husky, lefthook, pre-commit — keeps
them: athena then leaves `core.hooksPath` alone and reports the missing guard
instead of overwriting it silently.

Updates come with the next session, not with a re-installation. The rulebook
reads its roles off the self-check rather than assuming a page exists, so a
subagent or a skill that is added or dropped changes what a session does
without anything else having to be told.

To have the retros land in *your* rulebook, fork this repository and point
`marketplace add` at the fork.

## Working in parallel

Runs that overlap in time each get their own worktree — the rulebook says
why, and this is what makes it work:

```bash
claude --worktree feature-auth   # its own checkout under .claude/worktrees/
git worktree list                # what is already in flight
```

`worktree.baseRef` is pinned to `"fresh"` project-wide, so a new worktree
branches from the default branch rather than from unpushed work. The push
guard holds inside a worktree too, because `core.hooksPath` lives in the
shared `.git` config. Gitignored files a run needs are listed in
[`.worktreeinclude`](.worktreeinclude) and copied into every new worktree.

Clearing a worktree away is Claude Code's job, not athena's: leaving an
interactive session it removes a clean one and asks before dropping anything
that still holds work. A `-p` run has no exit prompt, so its worktree stays
until `git worktree remove`.

## tools/

| Tool                                    | Purpose                                                                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| [`observability`](tools/observability/) | OpenTelemetry collector + web UI for watching agent sessions live: traces, tokens, cost, tool calls, errors.        |

```bash
cd tools/observability && node bin/athena-observe.mjs   # http://127.0.0.1:4318
```

Runs on your own machine — no account, no third-party service, no running
costs. Alternatively `docker compose up -d` in the same directory.

## Tests

```bash
bash test.sh
```

## Licence

GPL-3.0-or-later — see [LICENSE](LICENSE).
