# The skills

One skill is one directory holding a `SKILL.md`. Discovery finds it by that
file alone: a directory here without one is in the tree and unreachable from a
session, and nothing announces it — the session simply never sees the skill.

A skill only one subagent ever runs does not live here. It belongs to that
agent, under `agents/<agent>/skills/<skill>/SKILL.md`, and reaches it through
the agent's `skills:` frontmatter, which injects the whole page at startup
instead of costing a `Skill` call mid-run. Both locations are listed in
`plugin.json`'s `skills` field — for this marketplace entry a declared path
replaces the default scan, so `./skills/` has to stay listed alongside.
This directory is for the skills a session itself reaches, and for the shared
brief every agent preloads — that one belongs to no single agent, so it cannot
sit under any of them.

## What a page has to carry

- **Frontmatter**: `name`, `description`, and `user-invocable` where the human
  may call it directly. The `description` decides whether the skill is ever
  loaded, so it leads with the words a request would actually contain and
  names the triggers; the body is only read once it has won.
- **The body** is the procedure, not an essay: how to run it, what it produces,
  and a closing "what it is not" that fences it off from the neighbouring
  skill it will otherwise be confused with.

## Interface and inside

A skill page is a contract. What a caller hands it — content and the name of
an operation — is the interface; where that content lands is behind it. Say
which is which on the page, and keep paths, filenames and headings on the
inside, so they can change without a caller changing.

Describe each thing once. Where another page owns a rule, point at the owner
instead of restating it — two descriptions of one rule drift apart.

## Where a rule belongs

A rule that binds more than one skill or more than one agent has one home:
`agent-brief`, the shared brief every uroboros agent preloads. Write it there,
and let every other page point at it rather than say it again — the section
above is why.

Nothing else reaches every agent. The rulebook the session reads is the
session's alone: a subagent starts no session and inherits none of it, so a
cross-cutting rule written anywhere but the brief binds only the page it sits
on, and the agents it was meant for never see it.

What decides is who the rule binds, not what it is about. An instruction only
one skill can carry out stays on that skill's page even when it reads like
policy; an instruction every agent has to follow belongs in the brief even
when it reads like a detail.

## Assets

Commands and templates live in `assets/`, next to the page that owns them, and
are referenced relative to the page. A skill runs from a plugin cache, from
`~/.claude/skills` or from a checkout, so nothing in it may hard-code a path
inside this repository. An executable in `assets/` ships the suite that guards
it beside it, and that suite is listed in `test.sh`.
