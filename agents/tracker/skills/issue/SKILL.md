---
name: issue
description: The mechanics of the athena tracker — where an issue file lives, what shape it has, which states it moves through, and how each operation is carried out. Preloaded into the `tracker` subagent, which is the only context that runs it; nothing else needs it, because nothing else touches `docs/issues/`.
---

# Issue

One issue is one markdown file under `docs/issues/`. That file is the whole
tracker: no database, no script.

This page owns the file: its name, its frontmatter, its sections, its states.
Everything here is mechanics — the caller who asks for an operation never sees
a path, a filename, a frontmatter key or a heading, so all of it can change
without any caller changing.

The rulebook (`CLAUDE.md`) owns the run — what happens between the states, not
what they are. Three parts belong to it and are not repeated here: the three
checkpoint questions, what a retro says, and when a change gets a task list.

## The operations

| operation | what the caller hands over |
| --- | --- |
| **file an issue** | the problem and the observable behaviour it wants, plus the acceptance criteria |
| **record a decision** | what was settled, and the source it derives from — a document, a human's answer, or "default, unanswered" |
| **record an observation** | what happened in the run: a review round and its triage, a failed attempt, a surprise |
| **record a plan** | the modules the change touches, the contracts between them stated concretely, and one sentence per non-obvious choice saying why — a page at most, never a document of its own |
| **record checkpoint answers** | the rulebook's three answers, and which of the two checkpoints they belong to |
| **record a retro** | what got in the way, what should change |
| **record a task list** | the steps a change is being landed in |
| **set the state** | which state the issue is now in, and the branch or the pull request if one now exists |
| **read the intent** | nothing. Returns the running issue's problem statement and numbered acceptance criteria, word for word — nothing else in the file |
| **read the record on a subject** | a subject, in whatever words the caller has for it. Returns what past issues settled on it, what was filed and never built, and what was tried and abandoned — each with the issue it came from |
| **orient a session** | nothing. Returns which issue is running and everything the previous session knew about it — or, when none is running, the unfinished issues and how they depend on each other |

## Filing an issue

1. **Stamp the day.** `YYYY-MM-DD-slug.md` — the day it is filed, then a short
   hyphenated slug of the title. Take the date from `date +%F`, never from
   memory: what day it is is a fact like any other, and a session's idea of it
   is often months out. The stamp keeps the directory listing in filing order
   and dates every issue without a field; issues filed on the same day are
   told apart by their slugs, so an issue whose slug is taken that day needs a
   more specific one.
2. **Write the file** at that path, in the shape below — the whole template,
   already here, so filing is one `Write` and never a copy from somewhere else.

   ```markdown
   ---
   status: backlog
   branch:
   pr:
   ---

   # <title>

   ## Intent

   Acceptance criteria:

   1.

   ## Plan

   ## Tasks

   ## Decisions

   ## Log

   ## Checkpoints

   ### Before implementation

   - Does this match what was asked?
   - What surprised me?
   - What am I assuming without having verified it?

   ### Before the PR

   - Does this match what was asked?
   - What surprised me?
   - What am I assuming without having verified it?

   ## Retro
   ```

3. **Fill `## Intent` and nothing else**: the problem and the wanted
   observable behaviour, solution-free, then numbered acceptance criteria that
   can each be shown false. Everything below Intent fills in as the run
   happens, one record-operation at a time.

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
rulebook's, not this page's.

A `status:` that says `active` is not proof: check that its `pr:` is empty
before you take it for the running one. An issue whose pull request is merged
is finished whatever its status line says, and the wrong path here costs the
session its whole orientation.

## Reading the intent

For a caller that must see no more than what was asked — the test-author above
all — return only the running issue's `## Intent`, verbatim: the problem
statement and the numbered acceptance criteria. Nothing else in the file,
whatever else could technically be reached another way; the guarantee this
operation makes is what it withholds.

The running issue is the same one *orienting a session* finds, above.

## Reading the record on a subject

Scan the `## Intent` of every file under `docs/issues/` for the subject. Read
the `## Decisions`, `## Log` and `## Retro` of the ones it matches, and of no
others — the point of this operation is that the caller pays for the matches,
not for the tracker.

Return three things, each with the issue it came from: what was settled, what
was filed and never built, and what was tried and abandoned. A decision found
here carries its own source with it — pass that on rather than restating it as
your own.

Nothing outside `docs/issues/` is read, and "nothing on this subject" is a
complete answer. An empty result is a fact; an invented near-match is worse
than nothing, because the caller will build criteria on it.

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

The same holds for the filename. Two notes exist:

- Earlier setups copied a template into each project as
  `docs/issues/TEMPLATE.md`, and later ones kept it as an asset beside this
  page. Both are obsolete — the template is in this page now — and a project
  still holding a copy can delete it.
- Issues filed before the date stamp are named `NNNN-slug.md`, a running
  four-digit number. They keep those names: renaming them would break every
  reference from a branch, a pull request or another issue, and buy nothing.
  Nothing here reads the name anyway — the scan reads every file under
  `docs/issues/` and takes what it needs from the frontmatter.
