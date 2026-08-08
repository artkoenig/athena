# tools/humanize/

One module, `duration.mjs`, exporting `formatDuration(ms)`: turns a
millisecond count into a short human-readable string. Zero dependencies.

## What the suite covers

`duration.test.mjs` — flat, top-level `test(...)` calls, grouped under `// AC:`
comments in the order the four printed forms appear in the issue: the export
shape; milliseconds below 1000; seconds from 1000 up to 60000 with exactly one
decimal place; minutes and seconds from 60000 up to 3600000; hours and minutes
from 3600000 up; the floor-not-round behaviour at each boundary; the
`TypeError` rejection for non-numbers, `NaN`, infinities and negatives (and the
`-0` counterpart that is accepted); and a source-text check that the module has
no `import` and no `require(`.

The `TypeError` message text is never asserted — no criterion pins it.

## Where a new case belongs

Add it under the `// AC:` section for the rule it proves, in the order above.
A new rejection kind goes with the other `throws` cases; a new printed form
gets its own new section at the end.

## Real vs. faked

Nothing is mocked. `duration.mjs` is imported and called directly with real
values; the dependency check reads the module's own source file from disk.

## Running

From the repository root: `node --test tools/humanize/duration.test.mjs`
