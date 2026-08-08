# tools/argus-ui

The web interface for an argus collector: `public/` served as written, and
everything the page asks for forwarded to a collector over HTTP. `README.md`
here is the user-facing page; this file is for changing the code.

## Conventions

- **This project never imports from `tools/argus` and never reads its files.**
  It knows the collector only through the HTTP API, so it can be moved out of
  uroboros unchanged. That rule is what `test/independence.test.mjs` guards, and
  it is the reason this is a project of its own rather than a second directory
  sharing a library.
- **Zero runtime dependencies**, like its sibling: it has to start from a
  checkout with `node bin/argus-ui.mjs`, without `npm install` ever having run.
  Adding a dependency is not a coding decision — it goes to the human first.
- **ESM only, `.mjs`, Node ≥ 20.11.** Use what the platform ships — `node:http`,
  `node:test` — rather than a helper.
- **No build step and no framework.** `public/` is served as it is written.
  `app.js` boots the page and owns every browser global; `format.js`,
  `timeline.js`, `context.js` and `run.js` beside it are pure modules returning
  strings, which is what makes them testable without a DOM. `run.js` is the run
  view — the workflow state the collector serves over `/api/runs`, shown as the
  `backlog.json` document it is.
- **The run pane shows the document, not a description of it.** `renderNode` is
  the one renderer every level is built from: a key is printed as the recorder
  wrote it, a list keeps its order and is keyed by index, every record and every
  list is a `<details>` that folds, and nothing is renamed, reordered,
  summarised or dropped on the way. An earlier version laid each part out under
  a heading of its own and a run of any size arrived as one page of prose with
  no way to fold a part of it away. What the pane decides is only what is open
  when it arrives: the top level, the increment being worked, and the running
  step's prompt, because that is the question a reader has while a run is going.
- **A repaint must leave the reader where they were.** The session pane is
  rebuilt whole on every ingest, and a live session ingests constantly. So an
  open context block is remembered by a key naming what the block is —
  `kind:tool_result#2`, `field:tools#0`, built in `contextBlocks` — and never by
  the seq of the record it came from, which changes on every API call the agent
  makes. `readBlockScroll`/`applyBlockScroll` in `app.js` carry the scroll
  offset inside each open block across the same repaint.
- **A repaint is not how the ages stay current.** A run writes its state once
  per step and a step runs for minutes, so between two writes the only thing
  that moved is the clock. `retimeRunView` in `app.js` rewrites the text of the
  elements carrying a `data-at` instant and touches nothing else — repainting
  the pane would collapse every `<details>` the reader had opened, and fetching
  would ask the collector for a state that has not changed.
- **The run pane's repaint leaves the reader where they were too, by path.**
  `renderRunView` restores every disclosure by its `data-panel` key, then the
  scroll position — in that order, because the pane's height depends on what is
  open — then focus, without scrolling to it. Markup identical to what is on screen is not written at all;
  `innerHTML` would drop the reader's text selection for no change. A key is a
  value's path in the document, and a list of records is keyed by each record's
  own `id` or `label` rather than by its index: the planner re-cuts the backlog
  between increments, and a position key would hand the reader's open row to
  whatever landed in that slot. Where a list has no distinct identity to key by,
  `listRefs` falls back to the index — two rows sharing a key would restore each
  other's state.
- **Local only.** No entry on the `PATH`, no skill, no mention in the plugin
  manifest, never deployed. The collector is the half that travels.

## Running it

```bash
node bin/argus-ui.mjs                              # http://127.0.0.1:4319
node bin/argus-ui.mjs --collector https://obs.example.com --collector-token …
```

## Tests

```bash
npm --prefix tools/argus-ui test
```

`node --test` over `test/*.test.mjs`. One test file per module that carries a
suite — `src/config.mjs`, `src/server.mjs`, `public/timeline.js`,
`public/context.js` and `public/run.js`, that last one covered by
`test/run.test.mjs` — plus `page.test.mjs` reading `app.js` as source text and
`independence.test.mjs` for the project-wide rule that nothing here imports
outside itself. `public/format.js` carries no file of its own: the suites import
its formatters to build their expectations. Every server binds port 0 and asks the OS which port it got — a
hard-coded port makes the suite fail against whatever else is running. The
collector is faked with `node:http` in the test file, never imported from its
project.
