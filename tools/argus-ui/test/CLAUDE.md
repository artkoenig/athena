# tools/argus-ui/test

`node --test` suites for the interface. The ground rules — zero dependencies, port 0 always, the collector faked with `node:http` and never imported from `tools/argus` — are owned by `../CLAUDE.md`; this page maps the suite itself.

## The files

- `config.test.mjs` — `parseArgs`/`resolveConfig` from `src/config.mjs`: defaults, env vs flags, the non-loopback-without-`--token` refusal.
- `server.test.mjs` — the real `createServer` from `src/server.mjs` against a fake collector: static serving, proxying with token injection and cookie stripping, unbuffered SSE, 401→502, the `--token` cookie handoff, plus a source-text guard that the proxy names no route under `/api/`.
- `timeline.test.mjs` — the pure functions of `public/timeline.js`: lanes, geometry, density curves, activity marks, the tool-mark merge, the live/scrub cursor, and the rendered timeline markup.
- `context.test.mjs` — the pure functions of `public/context.js`: `contextBlocks` parsing, `renderContextPanel` markup, the lane→query mapping, `fetchLaneContext`, `lanePanelInput`, the block filter, the search, and the block keys that keep an open block open as the conversation grows.
- `run.test.mjs` — the pure functions of `public/run.js`: `isClosedIncrement`/`CLOSED_STATUSES`, `incrementCounts`, `pickRunId`, `runFrame`, `shouldLoadRun`, `stepView`, `runningView`, `STEP_SHED_NOTE`, and the `renderRunList`/`renderRun`/`renderSteps`/`renderRunning`/`renderValue` markup — including the step in flight and its open prompt, an increment's goal and criteria, a step's prompt and superseded attempts, a closed increment's archived rounds, and a return laid out by shape with the raw JSON still one click away.
- `page.test.mjs` — `public/app.js`, `index.html`, `styles.css` and the `.md` pages checked as source text: imports, event wiring, the boot path and the run view's fetch-and-repaint wiring, state shape, deleted views staying deleted, `refreshRuns` delegating its re-fetch decision to `shouldLoadRun`, and a repaint leaving the reader inside the block they were reading. `app.js` touches browser globals, so it is never imported.
- `independence.test.mjs` — the project is complete, imports nothing outside itself, and the pure modules reach for no browser global.

## Helpers and fixtures

All file-local; copy the pattern rather than importing across test files. Every fixture factory takes an `over` object spread last.

- `context.test.mjs`: `requestBody(over)` — an API request body as a JSON string, modelled on a captured one; `item(over)` — the content record carrying it; `lane(over)`, `agentLane(over)`, `view(over)` — lane and view shapes; `recorder(answer)` — an injected `api` function that records its calls; `blockChunks(html)` — the rendered `<details class="ctx-block">` chunks in order.
- `run.test.mjs`: `increment(over)` — one backlog increment; `doc(over)` — the whole backlog document one run's state is; `runEntry(over)` — the one-run answer `GET /api/runs/:id` serves, `state` included; `listItem(over)` — the same entry as `GET /api/runs` lists it, `state` left off; `step(over)` — one recorded step, an increment's or the run's own; `running(over)` — the `running` entry the recorder writes for the step in flight, defined beside the cases that use it rather than at the top.
- `timeline.test.mjs`: `session(over)`, `record(over)`, `threeRecordContent()` — one main record plus three subagent records on span `sp-a`; `toolMark(over)`, `toolEvent(over)`.
- `server.test.mjs`: `startFakeCollector({ token, routes })` — `node:http` stand-in recording every upstream request; `withUi(options, run)` — boots collector and UI on port 0 and tears both down.
- `page.test.mjs`: `functionSource(source, name)`, `detailListener(source, type)`, `callArguments(source, name)` — slice one function, one delegated `#detail` listener, or one call's arguments out of `app.js`; `walk(dir)` — every file under `public/`.

## Where a new case goes

One test file per module under test. Within a file, cases sit under `// Criterion N — …` and `// Increment N — …` section comments naming the acceptance criterion or increment that produced them, in the order the work happened. Put a new case under the section whose behaviour it extends; new work appends a new section comment at the end.

## Naming

`test(…)` titles are lowercase declarative sentences stating the guaranteed behaviour, often with its reason — `'a scrubbed cursor stays on its moment while the session grows'`, `'an upstream 401 becomes a 502 that names the cause'`. No "should", no function-name prefixes. Assert messages explain why a failure matters, not just what failed; several cases first assert their own fixture is non-vacuous.

## Real vs faked

- Real and executed: `src/config.mjs`, `src/server.mjs`, and the pure `public/` modules (`timeline.js`, `context.js`, `format.js`, `run.js`), imported directly into `node --test`.
- Faked: the collector — `node:http` in `server.test.mjs`, a plain recorded `api` function in `context.test.mjs`. Never anything from `tools/argus`.
- No DOM anywhere: renderers return HTML strings, asserted with string and regex matching; `app.js` is only ever read as text.
- Pure helpers accept a Set or an array for id collections, and cases assert both spellings render byte-identical markup.

Run from the repository root: `npm --prefix tools/argus-ui test`.
