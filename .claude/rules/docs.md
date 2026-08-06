---
paths: docs/**
---
# Markdown under `docs/`

Every file here is the whole brief some agent works from, and every word in it
is context that agent pays for. The rules for writing one live in
`skills/agent-brief/SKILL.md`, under "Your handoff", and they hold for
everything under `docs/`, the issue file included.

This page is scoped to a path on purpose, and so is every other page in
`.claude/rules/`. A rule that loads at launch is inherited by every subagent the
session dispatches, and these pages exist only in this checkout — an agent would
hold such a rule here and not in a project that installed uroboros, and behave
differently in the two. Scoped, a page reaches whoever opens the files it
governs and nobody else. So nothing in `.claude/rules/` may carry a rule an
agent needs while it works: that belongs in the shared brief, which ships with
the plugin.
