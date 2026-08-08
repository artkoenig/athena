# Dummy issue: a duration formatter

This issue exists to exercise the loop end to end on a small, self-contained
change. Build it exactly as written; do not widen it.

## Goal

Add a helper that turns a duration in milliseconds into a short human-readable
string, and cover it with unit tests.

## Acceptance criteria

- A new module `tools/humanize/duration.mjs` exists.
- It exports a named function `formatDuration(ms)`.
- `formatDuration` returns `"850ms"` for any input below 1000, printed as a whole number of milliseconds.
- It returns `"1.4s"` for any input from 1000 up to but not including 60000, printed with exactly one decimal place.
- It returns `"2m 5s"` for any input from 60000 up to but not including 3600000, printed as whole minutes and whole seconds.
- It returns `"1h 3m"` for any input of 3600000 or more, printed as whole hours and whole minutes.
- It rounds down to the unit it prints, so 1999 becomes `"1.9s"` and 119999 becomes `"1m 59s"`.
- It throws a `TypeError` when the input is not a number, is `NaN`, is infinite, or is negative.
- The module has no dependencies beyond the Node standard library.
- A new test file `tools/humanize/duration.test.mjs` covers one case per rule above, written for `node --test`.
- `test.sh` runs that new test file as its own named suite.
- `bash test.sh` exits 0.

## Out of scope

- No existing file changes beyond the one line that registers the new suite in `test.sh`.
- No caller of `formatDuration` anywhere else in the repository.
