# tools/argus-ui/test

`node --test` suites for the interface. The ground rules — zero dependencies, port 0 always, the collector faked with `node:http` and never imported from `tools/argus` — are owned by `../CLAUDE.md`; this page maps the suite itself.

## The files

- `config.test.mjs` — `parseArgs`/`resolveConfig` from `src/config.mjs`: defaults, env vs flags, the non-loopback-without-`--token` refusal.
- `server.test.mjs` — the real `createServer` from `src/server.mjs` against a fake collector: static serving, proxying with token injection and cookie stripping, unbuffered SSE, 401→502, the `--token` cookie handoff, plus a source-text guard that the proxy names no route under `/api/`.
- `independence.test.mjs` — the project is complete, imports nothing outside itself, and the pure modules reach for no browser global.

There is no suite over `public/`. `app.js` is the whole page in one file and it touches browser globals at import time, so nothing here imports it; what the page renders is currently covered only through the source-text guards in `independence.test.mjs`. A change that pulls pure functions out of `app.js` into modules of their own gets a test file per module, named after it, and this list grows a line.

## Helpers and fixtures

All file-local; copy the pattern rather than importing across test files. Every fixture factory takes an `over` object spread last.

- `server.test.mjs`: `startFakeCollector({ token, routes })` — `node:http` stand-in recording every upstream request; `withUi(options, run)` — boots collector and UI on port 0 and tears both down.
- `independence.test.mjs`: `walk(dir)` — every file under the project, `node_modules` and `.git` aside.

## Where a new case goes

One test file per module under test. Within a file, cases sit under `// Criterion N — …` and `// Increment N — …` section comments naming the acceptance criterion or increment that produced them, in the order the work happened. Put a new case under the section whose behaviour it extends; new work appends a new section comment at the end.

## Naming

`test(…)` titles are lowercase declarative sentences stating the guaranteed behaviour, often with its reason — `'on loopback the browser never handles a token'`, `'an upstream 401 becomes a 502 that names the cause'`. No "should", no function-name prefixes. Assert messages explain why a failure matters, not just what failed; several cases first assert their own fixture is non-vacuous.

## Real vs faked

- Real and executed: `src/config.mjs` and `src/server.mjs`, imported directly into `node --test`.
- Faked: the collector — `node:http` in `server.test.mjs`. Never anything from `tools/argus`.
- No DOM anywhere: `public/` is only ever read as text. A renderer added later returns an HTML string, asserted with string and regex matching, rather than being driven through a DOM.

Run from the repository root: `npm --prefix tools/argus-ui test`.
