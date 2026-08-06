# The subagents

This is `agents/`'s own page, and it sits here rather than in `agents/CLAUDE.md`
because plugin discovery reads every `agents/*.md` as an agent — a `CLAUDE.md`
there would register as a nameless agent and be counted as one by the
self-check. It carries no `paths:` frontmatter, so it loads at launch and is
inherited by every subagent the session dispatches. Scope it to a path and it
would load only when a session reads a file under `agents/` — which a subagent
never inherits, because inheritance passes on what the session loaded at launch
and a path-scoped rule is by definition not that.

One agent is one flat `<name>.md` in that directory, and every one of them is
listed in `plugin.json`'s `agents` field. That list is not decoration: for a
plugin, agent discovery scans `agents/` *recursively*, and a subdirectory
becomes part of the name — `agents/review/security.md` registers as
`uroboros:review:security`. Without the list, every `.md` anywhere below loads
as an agent of its own — a skill an agent preloads, above all. Declaring the
files replaces that scan. Add an agent, add its line; the plugin suite fails
when the two disagree.

An agent may own a directory beside its page, `<name>/` next to `<name>.md`,
for what belongs to it alone — the skills it preloads, under
`<name>/skills/<skill>/SKILL.md`, declared in `plugin.json`'s `skills` field.
Anything else under `agents/` is in the tree and unreachable, which the
self-check reports as a defect.

## What every agent shares

What holds for every agent at run time — how it takes its brief, how it spends
its tools, how it reports a run, how it writes and commits its handoff, and the
check mode — lives in `skills/agent-brief/SKILL.md`, and every agent page names
it in `skills:` so it is injected at startup. Nothing an agent needs while it
works may live on this page instead: a plugin ships agents, skills and hooks,
not `.claude/rules/`, so this page reaches only sessions running inside this
repository and never an agent in a project that installed uroboros. This page
is for whoever writes the agents; the shared brief is for the agents.

So an agent page carries its role and the boundaries of that role alone, and
restates nothing the shared brief already says. A rule that stands in both
drifts.

The one exception opens every page: the line that tells the agent to report the
shared brief as missing and stop. A skill that failed to load cannot announce
its own absence, and Claude Code skips an unresolved `skills:` entry with
nothing but a line in the debug log — so without that opener an agent runs on
half its rules and nobody hears about it.

## What a page has to carry

- **Frontmatter**: `name`, `description`, `tools`, `skills`, `color`. The
  `description` is what a caller reads while deciding — say what the agent
  does, when to dispatch it, and what not to use it for. It is read far more
  often than the body. `skills` carries `agent-brief` and whatever else that
  agent alone preloads. `model` is left out, so the agent runs on the session's
  model; name a tier only for an agent whose work is mechanical enough that a
  smaller one cannot get it wrong, and say on its page why.
- **The body** is what the shared brief does not already cover: the role, how
  it works, the boundaries that belong to it alone, and the shape of its
  report. Beyond the brief it has no context — a caller's reasoning never
  reaches it.

## The page is the interface

The rulebook binds every dispatch to what this page declares: whatever the
page says the agent does *not* get is not handed over, and whatever it says
the agent may not do is not asked of it. So state both explicitly — an
implementer that may not edit the tests, a test-author that has never seen an
implementation, a reviewer that sees only the diff and the intent. An omission
here becomes a leak in every run.

Give each agent the narrowest tool list that does its job; a read-only role
gets no writing tools. Give it nothing about the project beyond the issue
directory under `docs/issues/`, and hand it no path beyond that directory: the
next agent finds what it needs there by the `status:`/`branch:` scan the issue
file describes, and a reviewer derives the intent from git instead, its diff
range already bounding what it may see.
