---
paths: agents/**
---
# The subagents

This is `agents/`'s own page, and it sits here rather than in `agents/CLAUDE.md`
because plugin discovery reads every `agents/*.md` as an agent — a `CLAUDE.md`
there would register as a nameless agent and be counted as one by the
self-check. Its `paths:` frontmatter is what keeps it out of a startup context:
an unscoped rule loads at launch and is inherited by every subagent the session
dispatches, and this page exists only in this checkout, so an agent would hold
it here and nowhere else. Scoped, nobody is handed it uninvited — inheritance
passes on what the session loaded at launch, and a path-scoped rule is by
definition not that.

It still reaches whoever actually works here. A reader that opens a file under
`agents/` loads this page for itself, and a subagent does so on its own reads,
not only the session — measured with a probe agent that read
`agents/test-author.md` and held this page afterwards. So scoping costs an agent
nothing it needs; it only stops the page from arriving where it is irrelevant.
What an agent needs before it reads anything is a different matter, and that
belongs in the shared brief.

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

What holds for every agent at run time — what always binds it, how it takes its
brief, how it spends its tools, how it reports a run, how it writes and commits
its handoff, and the check mode — lives in `skills/agent-brief/SKILL.md`, and
every agent page names it in `skills:` so it is injected at startup. That skill
ships with the plugin, so it is the only channel that reaches an agent in every
project alike. This page is for whoever writes the agents; the shared brief is
for the agents.

An agent holds exactly three things: its own page, the shared brief, and
whatever memory the host project itself provides. Nothing uroboros owns may
reach it by any other route, or the same agent behaves differently here than in
a project that installed the plugin. That is why the rulebook is `rulebook.md`
rather than a `CLAUDE.md` — a `CLAUDE.md` here would load as project memory and
be inherited, which no installing project can reproduce — and why every page in
`.claude/rules/` carries `paths:`. The suite checks both.

So a page here may only carry what someone developing uroboros needs, and this
one — about writing the agents — is that. It may never be the only home of a
rule that binds a run: `docs/` had such a page, and its writing rules moved into
the shared brief, where every project gets them. Scoping keeps a rule from the
wrong reader; it cannot make one exist where this directory does not.

Three rules bind the session and the agents alike: English, the default branch
moving only through a merged pull request, and the cache deletion after a change
to uroboros' own agents or skills. They stand in the rulebook and in the shared
brief, because the two audiences have no channel in common. Edit one, edit the
other.

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
