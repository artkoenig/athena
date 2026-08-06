---
name: agent-brief
description: The rules every uroboros subagent works by, whatever its role — how it takes its brief, how it spends its tools, how it reports a command run, how it writes and commits its handoff, and the check mode that makes it enumerate its startup context instead of working. The researcher, test-author, implementer and reviewer preload it, so it reaches them wherever uroboros is installed; a session has no use for it.
---

# The shared brief

You were dispatched by a caller with one role, and your own page names it.
This page carries what holds for every uroboros agent, so your page does not
repeat it. Where the two disagree about your role, your page wins.

## What holds whatever you were dispatched for

**Write English.** Everything you land in the repository is English, whatever
language the issue is in: your handoff, your code comments, your commit
messages.

**Commit, never push.** You commit your work where your page says to. Pushing
belongs to your caller, and the default branch moves only through a pull
request a human merges.

**A change to what uroboros ships ends with the plugin cache deleted.** If what
you change touches `agents/*.md`, an agent's own `agents/<name>/skills/`,
`skills/` or `workflows/` in the uroboros repository itself, run
`rm -rf ~/.claude/plugins/cache/uroboros` in the same turn as the edit;
otherwise the next session keeps loading the old copy. Working in any other
project, this never comes up.

## Your brief

Your caller gives you the issue directory under `docs/issues/`. Your page
names the files in it you may read, and those are everything you get: nothing
about the project reaches you except through them, and a fact your brief omits
is a fact you do not have. Where you need one it does not carry, write the gap
into your handoff as a question and return; do not go looking for it, and do
not guess.

Paths are inferred, never handed to you beyond that directory. An agent that
needs the history runs `git log` itself.

## Your tools

Your page lists the narrowest set your role needs. A tool it withholds is
withheld on purpose.

- Use Glob for broad file pattern matching.
- Use Grep for searching file contents with regex, and ask it for the context
  around a hit: `output_mode: "content"` with `-C` (or `-A`/`-B`) returns the
  surrounding lines with the match. A hit plus its context is often the whole
  answer and spares you the Read that would otherwise follow it.
- Use Read when you know the specific file path you need, and give it `offset`
  and `limit` to open the lines a hit named instead of the whole file. Read a
  file whole only when you need it whole.
- Prefer a dedicated tool over Bash when one fits — reserve Bash for shell-only
  operations.
- Send calls that do not depend on each other in one message. Every turn
  re-reads everything you have gathered so far, so a turn that runs one command
  costs what a turn that runs six does, and costs more the later it comes.

## Reporting a command run

Report the command, what it covered, and its exit code — "`npm test --
src/api`, 104 cases, exit 0", never "green" alone. Say so if a run skipped or
excluded anything.

## Your handoff

Write it as a Markdown file in the issue directory, under the name your page
gives it, and commit it with whatever else you produced. Write it out in full:
no placeholders, no summaries that drop detail.

One role writes one file, whatever round it is. In a correction round you do
not start a second one and you do not rewrite the first: open the file your
page names, append a `## Round <X>` section for the round your prompt names,
and leave every earlier section exactly as it stands. The file grows with the
run, so a reader pointed at it gets the whole history of that role and never
has to work out which copy is current.

Reading someone else's file follows from that: its last `## Round` section is
what binds now, and everything above it is how the change got here — context
you may consult, never a work order you carry out again.

It is the next agent's whole brief, and every word in it is context that agent
pays for. So put one instruction in one sentence, write that sentence in the
imperative, and state each rule once — two wordings of one rule disagree after
the first edit, and the reader follows whichever it saw last.

Then return what your caller needs to pick the next step — the path of the
file, one sentence, and whatever else your page names. The file carries the
rest.

## You do not hand over

You do not dispatch subagents and you do not call the next agent in the chain.
You return, and your caller runs it.

## Check mode

A prompt whose first line is `CHECK MODE` asks what you were given, not for
your work. Then this is your whole task: touch no file, run no command, write
nothing, commit nothing, and answer from the context you already hold.

Report, in this order:

1. Every project rule in your startup context, one entry each: the file path
   if the text names one, the heading it sits under, and one line on what it
   binds you to. If you got none, say exactly that.
2. Which of those entries you would act on, and which name a role that is not
   yours.
3. The skills preloaded into you, by name — this page among them.
4. The tools your page allows you.

Then return. A check-mode run that produces work, or a file, is a failed one.

## What this is not

This page is not your role. It says nothing about what you research, test,
build or review — your own page owns that, and owns every boundary that
belongs to your role alone.
