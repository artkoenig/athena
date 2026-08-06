# Implementer handoff — argus timeline UI

## Increment 1

Implemented the plan's five-file change: the content flags in the env block, the
content vocabulary in `claude.mjs`, a bounded content index with two queries in
`store.mjs`, two routes plus a body-stripped event tail in `server.mjs`, and the
four README edits. Nothing outside `tools/argus` was touched. No test file was
opened for editing.

### Baseline: the planned tests were red for the right reason

Ran `npm --prefix tools/argus test` before changing anything: 118 tests, 106
pass, 12 fail, exit 1. The failures were exactly the ones `test-author.md`
records — `undefined !== '1'` on the env flags, `404` on the two content routes,
`the event tail must not ship the body`, the missing `describeEvent` size, and
`store.test.mjs` failing to load with
`SyntaxError: … does not provide an export named 'agentOf'`. The suite total is
118 rather than 154 in the baseline precisely because that load failure keeps
`store.test.mjs`'s own cases from being counted at all.

### What changed, file by file

**`tools/argus/src/claude.mjs`**

- `otelEnvFor()` sets `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_TOOL_DETAILS`,
  `OTEL_LOG_TOOL_CONTENT`, `OTEL_LOG_RAW_API_BODIES` to `'1'` and
  `CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH` to `'2000000'`, in the unconditional
  object, above the `if (traces)` branch. One comment covers the group and says
  that `OTEL_LOG_TOOL_CONTENT` rides on span events and is inert with
  `--traces false`. No opt-out option was added.
- New exports: `CONTENT_EVENTS` (the two body event names), `agentOf(attrs)`,
  `isSubagentSource(attrs)`, `contentMetaOf(log)`.
- `agentOf` returns `null` unless `query_source` starts with `agent:`; otherwise
  the segment after the second colon, falling back to the source segment when
  the name is redacted (`agent:custom` → `'custom'`), and a name containing a
  colon keeps everything after the second one.
- `contentMetaOf` returns exactly the field list the plan named. `bodyLength`
  goes through `num()` and `truncated` through `bool()` because both arrive as
  strings; `bodyChars` is `attrs.body.length`, `0` when the body is absent.
- `describeEvent` gained a case per body event, naming model, direction,
  `body_length`, a `(truncated)` marker and `query_source` — never the body.

**`tools/argus/src/store.mjs`**

- `DEFAULTS.maxContentChars = 128 * 1024 * 1024`.
- New state `this.contentLogs` (references to the same records in `this.logs`,
  ingest order) and `this.contentChars`, both reset in `clear()`.
- `#applyLog` indexes a `CONTENT_EVENTS` record into `contentLogs`, adds its
  chars, and bumps the new per-session `counts.contentRecords`. The record stays
  in `this.logs` as well.
- Eviction is consistent on all three paths: `#trim('logs', …)` now calls a new
  `#unindexContent(removed)`; `#dropSession(id)` subtracts and filters that
  session's content records; a new `#trimContent()`, called from `#evict()`,
  shifts oldest-first while over budget **and** `contentLogs.length > 1`, then
  removes the collected records from `this.logs` in one `filter` pass. Records
  are evicted whole; `attrs.body` is never gutted in place.
- New `listContent({sessionId, agent, mainOnly, spanId, eventName, limit})` —
  newest-first walk, reversed to ascending, `contentMetaOf` per record, no body.
- New `contentAt({sessionId, agent, mainOnly, spanId, eventName, atMs})` — the
  newest match with `timeMs <= atMs`, returned with `body`, else `null`.
- Two module-level helpers: `bodyCharsOf(log)` (the single definition of what a
  record costs, used by every index and eviction path) and `matchesContent(log,
  filters)` (the ANDed filter shared by both queries).

**`tools/argus/src/server.mjs`**

- `GET /api/content` → `{ items }` from `listContent`, params `session`,
  `agent`, `main=1`, `span`, `event`, `limit` (default 200, max 2000).
- `GET /api/content/at` → `{ item }`, `400 {error:'session required'}` without
  `session`, otherwise always 200 with `item` possibly `null`. `event` defaults
  to `EVENT.apiRequestBody`, `at` to `Date.now()`.
- `/api/events` replaces `attrs` with a **copy** minus `body` and adds
  `content: contentMetaOf(event)` for `CONTENT_EVENTS` records only. The stored
  record is not mutated.
- `/api/config` reports `limits.contentChars`. The SSE frame was not touched.

**`tools/argus/README.md`** — the four planned edits: the five new lines in the
sample env block; "Sensitive data" rewritten to say `argus env` now sets these
by default, why, and what it means for memory and the `--persist` directory
(the `user.email`/`user.account_uuid`/`organization.id` sentence kept); the two
new routes in the HTTP API table; the task-id "Limits" bullet reworded to say
the id rides in a span event the store does not read, so the limit no longer
rests on the flag being off.

### Commands run

- `npm --prefix tools/argus test` (baseline, before any edit) — 118 tests, 106
  pass, 12 fail, exit 1. Red exactly as `test-author.md` recorded.
- `node --test tools/argus/test/{store,claude,server,config}.test.mjs`
  (mid-work check over the four files the plan names) — 79 tests, 79 pass,
  exit 0.
- `npm --prefix tools/argus test` (final) — **154 tests, 154 pass, 0 fail, 0
  skipped, 0 todo, exit 0.** Nothing excluded.

That one command is the whole "what counts as done" list in `researcher.md`.
`./test.sh` and the `argus-ui` suite were deliberately not run: the plan
reserves them for the closing increment, and nothing outside `tools/argus`
changed. There is no linter and no formatter in this repository.

### Nothing left red

No failure remains, so there is nothing to attribute to untouched code.

### Notes for the reviewer

Neither of these is a blocking question; both are things I noticed and did not
act on, because they are outside this increment.

1. **`intParam` refuses a negative `at`.** `GET /api/content/at?at=-1` falls
   back to `Date.now()` rather than answering with a `null` item, because
   `intParam` treats `value < 0` as absent. Epoch-ms timestamps are never
   negative in practice and the plan explicitly routes `at` through `intParam`,
   so I left it. Case 16 passes because it scrubs to a positive time before the
   first record.
2. **`contentAt` walks `contentLogs` in ingest order, not sorted by time.** The
   plan's data model is "references in ingest order", and every measured export
   arrives in time order per session, so newest-first equals latest-time-first.
   A record arriving out of order (a late flush from a different pipeline) could
   in principle be selected over a nearer one. Sorting on every call would cost
   O(n log n) per scrub; the plan chose the walk, and a later increment that
   sees out-of-order content in practice is the right place to revisit it.
3. **`counts.contentRecords` is never decremented on eviction**, matching the
   existing behaviour of every other key in `counts` (they are cumulative for
   the life of the session entry, by the module's stated contract). So it
   answers "did this recording ever carry content", not "how many bodies are
   still in memory".
