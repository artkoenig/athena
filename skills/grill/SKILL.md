---
name: grill
description: Turn a genuinely vague idea into written acceptance criteria by interviewing the human, one question at a time, grounded in facts from the codebase. A shelf tool — reach for it only when the idea is too unclear to write criteria directly; a clear request needs no ceremony. The output is a filed issue whose criteria the human approved.
user-invocable: true
---

# Grill

The idea is too vague to build. Close the gap the only way that works: ask
the human, one question at a time, until the intent is concrete enough that a
criterion could fail.

## How to run it

1. **Ground yourself first.** Dispatch the `researcher` for the facts the
   idea touches: what exists today, what the change would collide with.
2. **One question per turn.** Ask the single question whose answer most
   constrains the design. Offer the options you see and your recommendation —
   picking is faster than drafting. Never bundle questions; bundled questions
   get half-answers.
3. **Chase the observable.** Push politely past "it should be better" until
   every answer can land as an acceptance criterion.
4. **Stop when criteria stop changing.** When two consecutive answers refine
   wording but not substance, you are done.

## The output

Two operations of the `issue` skill: **file an issue** with the problem and
the criteria, and **record a decision** for each answer the human gave. The
skill knows where they go and what form a criterion takes — do not write into
the tracker yourself. Then show the criteria to the human for approval: this
is the first of their three steering points, and the one place a run
genuinely waits.
