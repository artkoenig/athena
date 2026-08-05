---
paths:
  - "agents/**"
---

# The subagents

This is `agents/`'s own page, and it sits here rather than in `agents/CLAUDE.md`
because plugin discovery reads every `agents/*.md` as an agent — a `CLAUDE.md`
there would register as a nameless agent and be counted as one by the
self-check. Path-scoped like this, it loads when a session reads a file under
`agents/`, which is what a per-directory `CLAUDE.md` would have done.

One agent is one flat `<name>.md` in that directory, and every one of them is
listed in `plugin.json`'s `agents` field. That list is not decoration: for a
plugin, agent discovery scans `agents/` *recursively*, and a subdirectory
becomes part of the name — `agents/review/security.md` registers as
`athena:review:security`. Without the list, every `.md` anywhere below loads
as an agent of its own — a skill an agent preloads, above all. Declaring the
files replaces that scan. Add an agent, add its line; the plugin suite fails
when the two disagree.

An agent may own a directory beside its page, `<name>/` next to `<name>.md`,
for what belongs to it alone — the skills it preloads, under
`<name>/skills/<skill>/SKILL.md`, declared in `plugin.json`'s `skills` field.
Anything else under `agents/` is in the tree and unreachable, which the
self-check reports as a defect.

## What a page has to carry

- **Frontmatter**: `name`, `description`, `tools`, `color`. The `description`
  is what a caller reads while deciding — say what the agent does, when to
  dispatch it, and what not to use it for. It is read far more often than the
  body. `model` is left out, so the agent runs on the session's model; name a
  tier only for an agent whose work is mechanical enough that a smaller one
  cannot get it wrong, and say on its page why.
- **The body** is the agent's whole brief: how it works, its boundaries, and
  the shape of its report. It has no other context — a caller's reasoning
  never reaches it.

## The page is the interface

The rulebook binds every dispatch to what this page declares: whatever the
page says the agent does *not* get is not handed over, and whatever it says
the agent may not do is not asked of it. So state both explicitly — an
implementer that may not edit the tests, a test-author that has never seen an
implementation, a reviewer that sees only the diff and the intent. An omission
here becomes a leak in every run.

Give each agent the narrowest tool list that does its job; a read-only role
gets no writing tools. Only its handoff is written to the issue file;
give it nothing about the project beyond `docs/issues/`. An agent that needs
the history runs `git log` itself.
- **Paths are inferred, never passed:** The next agent — reviewer, or
implementer — finds it itself under `docs/issues/`, by the `status:`/
`branch:` scan the issue file describes, never through a handed
path — except a reviewer, whose diff range already bounds what it may see,
and which derives the intent from git instead.
