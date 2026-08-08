# A helper that formats a duration for humans

This issue is a smoke test for the agile loop. It is deliberately small, and it
touches nothing that already exists apart from adding one function and its
tests.

Durations are carried around as a number of milliseconds. Add one helper that
turns such a number into a short string a human reads without counting digits.

## Scope

Add the helper to the module where this project already keeps its shared
utilities. Add its tests to the suite that already covers that module. Change
no other production code.

## Acceptance criteria

- A function named `formatDuration` takes a duration in milliseconds and
  returns a string.
- It is exported from the project's shared utility module.
- For a value below 1000 it returns whole milliseconds, as in `820ms`.
- For a value from 1000 up to below 60000 it returns seconds with one decimal
  place, as in `1.4s`.
- For a value from 60000 up to below 3600000 it returns whole minutes and whole
  seconds, as in `2m 5s`.
- For a value of 3600000 or above it returns whole hours and whole minutes, as
  in `1h 3m`.
- It rounds down to the unit it prints, so no band ever reports the next band's
  value.
- For an input that is negative, or not a finite number, it throws a
  `RangeError`.
- A unit test covers each of the four bands, each band boundary, and the
  `RangeError`.
- The project's existing test suite still passes.

## Out of scope

- Localisation of the unit letters.
- Formatting durations below one millisecond.
- Any change to a caller — nothing has to use the helper yet.
