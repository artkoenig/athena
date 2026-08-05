---
paths:
  - "docs/**"
---

# Markdown under `docs/`

These files are the whole brief an agent works from, and every word in them is
context that agent pays for.

- Put one instruction in one sentence.
- Write that sentence in the imperative.
- State each rule once, and never in a second wording.

A rule that stands twice is a rule that drifts: the two wordings disagree after
the first edit, and the agent follows whichever one it read last. When a
sentence would repeat one that already stands in the file, delete it — or
delete the other one, if this wording is the better of the two.
