# uroboros

> An AI agent workflow built on judgment, not rules — a few invariants,
> self-correction in the loop, and a human only where it matters. Successor to
> [metis](https://github.com/artkoenig/metis).

**Uroboros** is the snake that eats its own tail: the loop that closes on
itself and starts again. That is the principle, not just the name — a run
reviews and corrects its own work, and what a run learns about the workflow
is written back into the workflow.

## What it's for

uroboros bets on the judgment of a modern Anthropic agent — it assumes at
least Opus 5 — and builds on that trust rather than around its absence.
Most agent workflows compensate for a model they don't quite trust with
process: approval gates, checklists, a human re-checking work the agent
could have checked itself. uroboros instead gives the agent the run and asks
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
project loads uroboros fresh at session start, an accepted fix reaches all of
them with their next session — the workflow gets better at being followed
without a human rewriting it by hand.

The rules themselves are one page, [`CLAUDE.md`](CLAUDE.md) — short enough
to read end to end if you want the specifics; this page won't repeat it.

## How a run goes

Every task runs in one of two modes, and the human names which.

**Direct Mode** — the session does the work itself: read the code, change it,
run the tests, commit, push. No issue file, no subagent, no ceremony.

**Issue Mode** — the session owns the requirements, the subagents own the
work. It writes the acceptance criteria to
`docs/issues/<timestamp>-<slug>/issue.md`, has them confirmed, and hands the
directory to the `uroboros-loop` workflow
([`.claude/workflows/uroboros-loop.js`](.claude/workflows/uroboros-loop.js)),
which runs the chain:

| Step      | Agent                                  | What it does                                                                    |
| --------- | -------------------------------------- | ------------------------------------------------------------------------------- |
| Research  | [`researcher`](agents/researcher.md)   | Researches the codebase, decides the solution, writes the implementation plan    |
| Tests     | [`test-author`](agents/test-author.md) | Turns the criteria into failing tests, having never seen an implementation       |
| Implement | [`implementer`](agents/implementer.md) | Builds from the plan until the tests pass and the suite is green                 |
| Review    | [`reviewer`](agents/reviewer.md)       | Checks the whole diff against `main` — it sees the diff and the issue, no handoffs |

Every agent writes its handoff into the issue directory and commits it, so the
record is the issue rather than anyone's context. Findings from the review
open a correction round; after two the loop stops and hands back to the human.
The orchestration is a script and not an agent because a subagent cannot start
another one.

Three skills sit on the shelf for when they are needed:
[`grill`](skills/grill/) turns an idea too vague to build into approved
criteria, one question at a time; [`retro`](skills/retro/) writes the session
retrospective from the log into the issue; [`argus`](skills/argus/) measures
what a session cost.

## Installing it

uroboros is a Claude Code plugin, installed from its own marketplace:

```bash
claude plugin marketplace add artkoenig/uroboros
claude plugin install uroboros@uroboros
```

A session with the plugin active gets the rulebook of the current `main` in
its context, the subagents in [`agents/`](agents/) and the skills in
[`skills/`](skills/) — plus, for a subagent that owns one, a skill preloaded
from beside its page — a self-check saying what of that is actually reachable,
and a `pre-push` guard that refuses a direct push to the default branch. A
project that manages its own git hooks — husky, lefthook, pre-commit — keeps
them: uroboros then leaves `core.hooksPath` alone and reports the missing guard
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

Clearing a worktree away is Claude Code's job, not uroboros': leaving an
interactive session it removes a clean one and asks before dropping anything
that still holds work. A `-p` run has no exit prompt, so its worktree stays
until `git worktree remove`.

## tools/

| Tool                              | Purpose                                                                                                                |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| [`argus`](tools/argus/)           | OpenTelemetry collector for agent sessions: traces, tokens, cost, tool calls, errors. Ingests, aggregates, serves JSON. |
| [`argus-ui`](tools/argus-ui/)     | The page that shows what a collector holds. Local only — started from a checkout, never deployed.                      |
| [`log-parser`](tools/log-parser/) | Reads a Claude Code or Gemini/Antigravity session log into markdown and metrics. What the `retro` skill runs.          |

```bash
argus start --background                     # collector, http://127.0.0.1:4318
node tools/argus-ui/bin/argus-ui.mjs         # interface, http://127.0.0.1:4319
bin/parse-agent-log --latest auto            # the last session as markdown
```

`argus` is on the `PATH` of every session with the plugin enabled, so a project
that is not this one can measure itself; the `argus` skill carries the
procedure. The interface is not distributed — it is started from a checkout.
What a measured run persists lands in `<project>/.uroboros-telemetry/`.

Runs on your own machine — no account, no third-party service, no running
costs. Alternatively `docker compose up -d` in `tools/argus` for the collector.

## Tests

```bash
bash test.sh
```

Six suites, one command: the repository's own rules, the plugin manifests and
the session-start hook, parallel runs in worktrees, and the three tools.

## Licence

GPL-3.0-or-later — see [LICENSE](LICENSE).
