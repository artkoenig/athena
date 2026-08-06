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
governs, session and subagent alike, and nobody else.

That is why nothing here may carry a rule an agent needs *before* it reads
anything: a scoped page arrives only once the reader is already in these files.
Such a rule belongs in the shared brief, which ships with the plugin and is
injected at startup. The writing rules this page points at live there for
exactly that reason.
