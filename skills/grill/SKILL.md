---
name: grill
description: Turn a genuinely vague idea into written acceptance criteria — first gather what is already true about it, from the code, the project's documentation, the record of past issues and the documentation of what the project builds on, then interview the human one question at a time about what is left. A shelf tool — reach for it only when the idea is too unclear to write criteria directly; a clear request needs no ceremony. The output is a filed issue whose criteria the human approved.
user-invocable: true
---

# Grill

The idea is too vague to build. Close the gap the only way that works: ask
the human, one question at a time, until the intent is concrete enough that a
criterion could fail.

Ask them last, though. An interview that opens uninformed spends its
questions on what the repository would have answered for free, and the human
answers those politely while the vagueness that made grilling necessary
survives untouched.

## Ground yourself first

Ask the user to clarify the problem statement. The main session does NO research of its own in the codebase. You do not read the code or the documentation yourself to prepare for the interview. You rely entirely on the user's input to establish the acceptance criteria.

## Then ask

1. **Open with the ground.** A few sentences: what you found, and what your
   questions therefore rest on. A premise corrected here costs one turn; found
   wrong later it costs every answer built on it.
2. **One question per turn.** Ask the single question whose answer most
   constrains the design. Offer the options you see and your recommendation —
   picking is faster than drafting. Never bundle questions; bundled questions
   get half-answers.
3. **Chase the observable.** Push politely past "it should be better" until
   every answer can land as an acceptance criterion. Close the edges the sweep
   turned up as well as the centre — the empty case, the limit, the repeat: an
   edge left undecided comes back as a blocked `test-author`, one role too
   late.
4. **Stop when criteria stop changing.** When two consecutive answers refine
   wording but not substance, you are done.

## The output

Write the issue directly to a file under `docs/issues/`. Create a markdown file with the problem and the criteria, and **record a decision** — for every answer the human gave. The human's answers are not the only thing that shaped them, and a criterion whose source is gone is one nobody can revisit. 

Do NOT use git to commit this issue file. The main session does no git operations.
Once the file is created and the human has approved the criteria, hand over the issue filename to the `researcher` subagent to begin the linear workflow.

Then show the criteria to the human for approval: this is the first of their
three steering points, and the one place a run genuinely waits.

## What it is not

Not a research project: the sweep serves the questions and ends the moment the
open points have turned into preference questions. Not a substitute for the
approval — finding the answer in the code settles what *is*, never what the
human wants. And not for a clear request; that one needs no ceremony.
