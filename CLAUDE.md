# Working in this repository

This repository is the athena Claude Code plugin and the marketplace that
offers it, plus the tools under `tools/`. What is checked in here is what
every wired project loads at session start, so a change here reaches all of
them.

`AGENTS.md` is that shipped rulebook: it governs how a *run* is conducted, in
this repository and in every other. It is not the place for this
repository's own conventions — those belong in the `CLAUDE.md` of the
directory they govern, and only what holds everywhere stays in this file.

## The layout

| path                   | what it is                                                          |
| ---------------------- | ------------------------------------------------------------------- |
| `AGENTS.md`            | the rulebook, delivered verbatim into every session by the hook      |
| `agents/`              | the subagents the plugin ships — one flat `.md` per agent           |
| `skills/`              | the skills the plugin ships — one directory with a `SKILL.md` each  |
| `hooks/`               | the `SessionStart` hook: rulebook, self-check, push guard           |
| `.githooks/`           | the `pre-push` guard the hook points `core.hooksPath` at            |
| `.claude-plugin/`      | the plugin manifest and the marketplace manifest                    |
| `tools/`               | programs that stand on their own, one directory each                |
| `test*.sh`             | the suites; `test.sh` runs all of them                              |

## Rules that hold everywhere here

- **One command proves the suite.** `bash test.sh` runs every suite and exits
  0 only when all of them pass. A new suite is added to its list, or nothing
  runs it.
- **No figure in prose that a change can falsify.** How many skills, agents,
  tests or suites exist is produced by the session's self-check and by the
  suites themselves. Documentation describes what a thing is and how to reach
  it, never how many there are.
- **Everything checked in is written in English**, this file included.
- **Conventions live next to the code they govern.** A rule for one directory
  goes into that directory's `CLAUDE.md`, so it loads when a session reads
  there and not before. The one exception is `agents/`: discovery reads every
  `agents/*.md` as an agent page, so its conventions are path-scoped from
  [`.claude/rules/agents.md`](.claude/rules/agents.md) instead.
- This file is for sessions working *in* this repository. A `CLAUDE.md` at a
  plugin root is not loaded into the sessions of projects that install the
  plugin — what reaches them goes through `AGENTS.md`, a skill or an agent
  page.
