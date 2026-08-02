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

Find out what is already true about the topic. Dispatch the `researcher` —
one dispatch per question you actually have, never one "tell me about X",
which comes back a tour instead of an answer; the ones that do not depend on
each other go out together.

Hand over the idea in the human's own words, never your summary of it. There
is no issue yet, so that wording is the whole intent — retold, the sweep is
grounded on what you already assume.

Four places, each as far as the topic reaches into it:

- **The code** the idea touches: what it does today, who calls it, what the
  change would collide with.
- **The project's documentation**: the README, the `CLAUDE.md` of every
  directory involved, whatever is under `docs/`. A convention written there
  binds the criteria — it is a constraint, not background reading.
- **The record**, through the `tracker`'s *read the record on a subject*:
  what past issues settled on it, what was filed and never built, what was
  tried and abandoned. Re-deciding what the record already settled is the
  cheapest mistake available here.
- **The documentation of what this is built on**, where the topic is not the
  project's own invention — the library, the tool, the protocol. What it
  actually supports bounds what can be asked for at all, and no answer from
  the human moves that bound.

You are grounded when every open point left is a question of what the human
*wants* rather than of what *is*. Those are the questions worth a turn of
theirs; the rest you now answer yourself. A gap the sweep could not close is
not a question for them either — it is a fact labelled "not verified", and it
stays labelled.

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

Two operations of the `tracker`: **file an issue** with the problem and the
criteria, and **record a decision** — for every answer the human gave, and
for every fact from the sweep a criterion now rests on, each with the source
it came from. The human's answers are not the only thing that shaped them, and
a criterion whose source is gone is one nobody can revisit. Dispatch the
`tracker` for both — continuing it if this run already has one running — it
knows where they go and what form a criterion takes; do not write into
`docs/issues/` yourself.

Then show the criteria to the human for approval: this is the first of their
three steering points, and the one place a run genuinely waits.

## What it is not

Not a research project: the sweep serves the questions and ends the moment the
open points have turned into preference questions. Not a substitute for the
approval — finding the answer in the code settles what *is*, never what the
human wants. And not for a clear request; that one needs no ceremony.
