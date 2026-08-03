---
status: backlog
branch:
pr:
---

# Measurement label can introduce parsing ambiguity in argus banner

## Intent

The `Measurement` label in the argus probe banner can now introduce a parenthetical that is not a measurement. While it reads fine for humans, anything that machine-parses this banner has three shapes to handle rather than two.

Acceptance criteria:

1. The banner's `Measurement` label format is clarified or refactored so that parentheticals have a consistent, machine-parseable meaning.

## Map

## Plan

## Tasks

## Decisions

## Log

- Filed from issue 2026-08-03-split-observer-into-argus.md, review round 5, during implementer stage. The `describePersistence` function can generate "not known — its configuration could not be read; it may well be recording" as the persistence state, which introduces a parenthetical that is informational rather than metadata.
- Violates no acceptance criterion from the parent issue; recorded for its own run.

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
