# athena

> An AI agent workflow built on judgment, not rules — a few invariants,
> self-correction in the loop, and a human only where it matters. Successor to
> [metis](https://github.com/artkoenig/metis).

**Athena** is the Greek goddess of wisdom and craft: skill that comes from
practice, not from instruction. That is the principle, not just the name.

## How it works

The rulebook is one page: [`AGENTS.md`](AGENTS.md). Its core is **judgment for
process, mechanics for facts** — everything procedural is the agent's call,
every time; rules remain only where self-assessment fails. "The tests pass"
comes from an exit code, never from the agent's impression.

These invariants hold for every change:

1. The intent — acceptance criteria — is written down before any code.
2. The tests for it are written first, blind, from the intent alone, and seen
   to fail; a change with nothing to run says exactly that.
3. A fresh context checks the diff against the written intent, with a concrete
   reproduction per finding.
4. The suite and static analysis prove themselves by exit code; where nothing
   exists to run, that absence is the reported fact.
5. Decisions, surprises and checkpoint answers go into the issue as they
   happen — the record outlives the session.

The human steers where it matters and nowhere else: approving the criteria
when the idea is genuinely unclear, deciding anything irreversible or
outward-facing, and merging the pull request.

**The workflow corrects itself through the retro.** After every PR the agent
records what got in the way. A rule that misfired becomes a proposal: a pull
request against this repository, decided like any other. And because every
wired project loads athena fresh at session start, an accepted rule change
reaches all of them with their next session.

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

One run, one worktree. Two sessions running at the same time never share a
working directory:

```bash
claude --worktree feature-auth   # its own checkout under .claude/worktrees/
git worktree list                # what is already in flight
```

Every worktree branches from the default branch, not from unpushed work —
`worktree.baseRef` is pinned to `"fresh"` project-wide for that. The push
guard holds inside a worktree too, because `core.hooksPath` lives in the
shared `.git` config; a push to `main` from a parallel run is refused just the
same. Gitignored files a run needs are listed in
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

One command, every suite, exit 0 only when all of them are green.

## Licence

GPL-3.0-or-later — see [LICENSE](LICENSE).
