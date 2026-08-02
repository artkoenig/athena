# athena

> An AI agent workflow built on judgment, not rules — a few invariants,
> self-correction in the loop, and a human only where it matters. Successor to
> [metis](https://github.com/artkoenig/metis).

**Athena** is the Greek goddess of wisdom and craft: skill that comes from
practice, not from instruction. That is the principle, not just the name.

## What it's for

Most agent workflows land on one of two failure modes: no process, so
quality depends on how careful the agent happened to feel that day, or so
much process that a one-line fix pays the same ceremony as a rewrite.
athena's bet is that an agent can be trusted to run the work — how much to
plan, how to slice it, which tools to reach for — while a few checks catch
exactly what an agent can't reliably catch in itself: grading its own
tests, reviewing a diff it just wrote.

That leaves a human only where a human actually has to be: saying yes to
intent that's genuinely unclear, deciding anything irreversible, merging.
Everything else the agent decides and writes down, so a rule that turns out
wrong becomes a pull request instead of a lesson each session re-learns —
and because every wired project loads athena fresh at session start, an
accepted fix reaches all of them with their next session.

The rules themselves are one page, [`AGENTS.md`](AGENTS.md) — short enough
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
