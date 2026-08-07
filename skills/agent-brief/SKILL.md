---
name: agent-brief
description: The rules every uroboros subagent works by, whatever its role — how it takes its brief, how it spends its tools, how it reports a command run, how it records, commits and pushes its step return, and the check mode that makes it enumerate its startup context instead of working. Every uroboros agent preloads it, so it reaches them wherever uroboros is installed; a session has no use for it.
---

# The shared brief

You were dispatched by a caller with one role, and your own page names it.
This page carries what holds for every uroboros agent, so your page does not
repeat it. Where the two disagree about your role, your page wins.

## What holds whatever you were dispatched for

**Write English.** Everything you land in the repository is English, whatever
language the issue is in: your step return, your code comments, your commit
messages.

**Commit your step, then push it.** You commit your work where your page says
to, and you push that commit straight away — an unpushed commit dies with the
container that made it, and the run state it carries dies with it. Retry a
failed `git push` up to four times, waiting 2s, 4s, 8s and 16s; a push that
still fails is a line in your return's summary, not a stopped step. The default
branch moves only through a pull request a human merges, and opening that pull
request is your caller's, never yours.

## Your brief

Your caller gives you the issue directory under `docs/issues/`, and your prompt
carries the slice of the earlier steps' returns your role needs. That prompt
and the files your page names are everything you get: nothing about the project
reaches you except through them, and a fact your brief omits is a fact you do
not have. Where you need one it does not carry, put the gap in your return's
`questions` and return; do not go looking for it, and do not guess. A
non-empty `questions` ends the run and puts the gap to the human, so keep it
for decisions only a human can make.

Paths are inferred, never handed to you beyond that directory. An agent that
needs the history runs `git log` itself.

**A prompt may narrow the issue to one increment.** Some runs deliver an issue
in steps, and then your prompt names the increment that is yours and the
criteria it has to satisfy. Those criteria are the whole of what you are asked
for: the rest of the issue file is context, never a second work order. Work
outside them is scope you were not given, and a criterion of the issue that
your increment does not repeat is not yours to satisfy, to test, or to report
as missing — a later increment takes it. Where your prompt names no increment,
the issue is the scope, whole.

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

## A live collector

Run `node tools/argus/scripts/with-collector.mjs [--port <n>] -- <command>` where
you need a collector to talk to: it starts one on a free port, hands the command
`ARGUS_URL` and `ARGUS_PORT`, and stops it when the command exits, whatever that
command exits with. Never start a collector by hand, and never kill one with
`pkill`. That script is there in an uroboros checkout only — the plugin ships
`skills/`, `workflows/` and `agents/`, so a session in another project has no
`tools/argus/` to run it from.

## Your step return

You return one structured object, and your page names its fields. That object
is the whole channel: your caller hands the next role the slice of it that role
needs, and nothing else you produce reaches anyone. So the substance goes in
the fields, in full — no placeholders, no summaries that drop detail — and no
file of your own carries it.

Every word of it is context the next agent pays for. So put one instruction in
one sentence, write that sentence in the imperative, and state each thing once:
two wordings of one rule disagree after the first edit, and the reader follows
whichever it saw last.

**Record it before you finish.** Pipe your return into the recorder on stdin,
with a trailing `-` in place of a file:

```
node "<base>/assets/backlog.mjs" record <issueDir>/backlog.json <incrementId> <label> - <<'RETURN'
{"summary": "your return, as JSON"}
RETURN
```

Quote the heredoc delimiter as `<<'RETURN'` so the shell passes your JSON
through untouched, quotes and markup and all. Use the increment id and the
label your prompt gives you. A path to a JSON file still works in place of the
`-`. `<base>` is the base directory of the `agent-brief` skill, which your
context names on its `Base directory for this skill:` line; where no such line
is there, find the helper with `find "$HOME/.claude/plugins" -path
'*agent-brief/assets/backlog.mjs' | head -1`. That helper is the only writer of
`backlog.json`, so you never edit that file by hand.

`backlog.json` is the whole durable state of the run: a session that dies
resumes from it, a step it holds is never worked twice, and a step it does not
hold is worked again from the start. Record your step, commit it with your
work, and push the commit.

A step you work again may meet what its interrupted first run
already committed: tests that exist and fail, code that half-exists. Read the
working tree and `git log` before you start, then finish or correct what is
there instead of writing it a second time.

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
