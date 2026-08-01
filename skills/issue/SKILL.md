---
name: issue
description: The athena tracker. Every read of and every write to an issue goes through this skill — file an issue, record a decision, an observation, a plan, checkpoint answers, a retro or a task list, set the state, or orient a session on the running issue. Hand it the content and name the operation; it knows where that content lands. Not a shelf tool. Trigger on "file an issue", "open an issue", "new issue", "put this in the backlog", "record this in the issue", "where did we leave off", or whenever you are about to read or write anything in the tracker.
user-invocable: true
---

# Issue

One issue is one markdown file under `docs/issues/`. That file is the whole
tracker: no database, no script.

This skill owns the file: its name, its frontmatter, its sections, its states.
Four parts are handed to other owners (listed below); everything else is
described here and nowhere else — two descriptions of one thing drift apart.

A caller hands this skill **content** and names an **operation** — never a
path, a filename, a frontmatter key or a heading. That way the file can
change without any caller changing.

Subagents follow the same rule: a subagent that needs the tracker gets the
`Skill` tool and orients here, instead of being handed a path.

The rulebook (`AGENTS.md`) owns the run — what happens between the states, not
what they are.

## The operations

| operation | what the caller hands it |
| --- | --- |
| **file an issue** | the problem and the observable behaviour it wants, plus the acceptance criteria |
| **record a decision** | what was settled, and the source it derives from — a document, a human's answer, or "default, unanswered" |
| **record an observation** | what happened in the run: a review round and its triage, a failed attempt, a surprise |
| **record a plan** | the modules the change touches, the contracts between them stated concretely, and one sentence per non-obvious choice saying why — a page at most, never a document of its own |
| **record checkpoint answers** | the rulebook's three answers, and which of the two checkpoints they belong to |
| **record a retro** | what got in the way, what should change |
| **record a task list** | the steps a change is being landed in — the rulebook says when one is due |
| **set the state** | which state the issue is now in, and the branch or the pull request if one now exists |
| **orient a session** | nothing. Returns which issue is running and everything the previous session knew about it — or, when none is running, the unfinished issues and how they depend on each other |

Three parts are owned by the rulebook, because each is a rule of the run, and
this page does not repeat what it says: the three checkpoint questions, what a
retro says, and when a change gets a task list.

Everything below this line is behind the interface — the directory, the
filenames, the template, the sections. It can change without anything outside
`skills/issue/` changing.

## Filing an issue

1. **Pick the number.** `NNNN-slug.md` — four digits, zero-padded, the next
   number after the highest under `docs/issues/`, never reused. The padding
   keeps the directory listing in filing order.
2. **Copy `assets/TEMPLATE.md`** to that path. Do not retype it, do not
   reorder or rename its sections.
3. **Delete the comment block** under the title — it is a filing instruction,
   not part of an issue.
4. **Write the `## Intent`** and nothing else: the problem and the wanted
   observable behaviour, solution-free, then numbered acceptance criteria
   that can each be shown false. Everything below Intent fills in as the run
   happens.

## Orienting a session

Scan the `status:` lines of every file under `docs/issues/`. That scan decides
which of two paths you are on.

**An issue is running** — one is `active`, or one carries the `branch:` checked
out. Open that file and read it whole: the filled sections are the progress,
and Decisions, Log and Checkpoints hold everything the previous session knew.
Read nothing else to get oriented.

**Nothing is running.** Read the `## Intent` of every issue whose status is not
`done` — that section only, no other, and no file outside `docs/issues/`. Then
work out which of those issues depend on each other: one whose intent another's
criteria presuppose comes before the issue that presupposes it. Return the
unfinished issues with that dependency in view. What the session does with it —
proposing one to the human, and what happens when no answer comes — is the
rulebook's, not this skill's.

A `status:` that says `active` is not proof: check that its `pr:` is empty
before you take it for the running one. An issue whose pull request is merged
is finished whatever its status line says, and the wrong path here costs the
session its whole orientation.

## The shape

| part | what belongs in it |
| --- | --- |
| frontmatter | three lines, no more. `status` — one of the four states below. `branch` — the branch carrying this issue, set as soon as one exists. `pr` — its pull request, set when the PR is opened. |
| `# <title>` | one H1, the issue in a phrase |
| `## Intent` | the problem and the wanted observable behaviour, solution-free, then the numbered acceptance criteria — observable and falsifiable, "when X, then Y" |
| `## Plan` | optional content: the *record a plan* operation above says what belongs in it, and the rulebook says when a change warrants one |
| `## Tasks` | optional content, and the rulebook says when a change gets one |
| `## Decisions` | what was settled and why, each with its source; questions to the human and their answers. Nothing else — a mid-run reader must find the decisions without wading through process |
| `## Log` | the run as it happened, oldest first: observations, review rounds and their triage, failed attempts. Keeping this out of Decisions keeps Decisions readable |
| `## Checkpoints` | `### Before implementation` and `### Before the PR`, the rulebook's three questions answered under each |
| `## Retro` | written after the pull request; the rulebook says what goes in one |

**Every heading is always present, even when empty.** An empty `## Plan` says
no plan was needed; a missing one says nothing.

The sections fill in run order, so the filled sections show the progress:
Intent only = not started; Checkpoint 1 answered = implementing; Checkpoint 2
answered = in review; Retro written = finished.

## The four states

`status` tracks the work, not the last section written.

- **`backlog`** — filed, nobody has started it.
- **`active`** — someone is on it now. At most one issue at a time.
- **`waiting`** — parked on a question, and nothing else. Not "waiting for a
  merge", not "waiting for CI".
- **`done`** — set when the pull request is opened, together with the `pr`
  field. The merge is the human's and changes nothing in the file. The retro
  is written afterwards, into an issue that is already `done`.

## Why there is no version field

An issue file is prose read by a language model, not a record parsed by a
schema. A missing section simply shows the file is older than that section —
no migration machinery needed. If a section ever keeps its name but changes
its meaning, the migration note belongs here, in prose.

One such note exists: earlier setups copied a template into each project as
`docs/issues/TEMPLATE.md`. That copy is obsolete — this skill carries the
template now — and a project still holding one can delete it.
