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
  view — the workflow state the collector serves over `/api/runs`, down to the
  step in flight, each increment's goal, criteria and recorded steps and the
  run's own, every step collapsed to a line that opens onto what the agent was
  asked, what it returned and the attempts it superseded.
- **Nothing recorded is summarised away, and nothing is dumped as JSON.** What
  the pane decides is only what is open by default: the running step's prompt,
  because that is the question a reader has while a run is going, and nothing
  else. A return is laid out as the shape it is — fields under their names, a
  list as a list, prose as prose — and the raw JSON stays behind a disclosure
  for whatever the layout could not shape.
- **A repaint is not how the ages stay current.** A run writes its state once
  per step and a step runs for minutes, so between two writes the only thing
  that moved is the clock. `retimeRunView` in `app.js` rewrites the text of the
  elements carrying a `data-at` instant and touches nothing else — repainting
  the pane would collapse every `<details>` the reader had opened, and fetching
  would ask the collector for a state that has not changed.
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
