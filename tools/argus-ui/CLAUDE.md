# tools/argus-ui

The web interface for an argus collector: `public/` served as written, and
everything the page asks for forwarded to a collector over HTTP. `README.md`
here is the user-facing page; this file is for changing the code.

## Conventions

- **This project never imports from `tools/argus` and never reads its files.**
  It knows the collector only through the HTTP API, so it can be moved out of
  athena unchanged. That rule is what `test/independence.test.mjs` guards, and
  it is the reason this is a project of its own rather than a second directory
  sharing a library.
- **Zero runtime dependencies**, like its sibling: it has to start from a
  checkout with `node bin/argus-ui.mjs`, without `npm install` ever having run.
  Adding a dependency is not a coding decision — it goes to the human first.
- **ESM only, `.mjs`, Node ≥ 20.11.** Use what the platform ships — `node:http`,
  `node:test` — rather than a helper.
- **No build step and no framework.** `public/` is served as it is written.
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

`node --test` over `test/*.test.mjs`. One test file per `src/` module, plus
`independence.test.mjs` for the project-wide rule that nothing here imports
outside itself. Every server binds port 0 and asks the OS which port it got — a
hard-coded port makes the suite fail against whatever else is running. The
collector is faked with `node:http` in the test file, never imported from its
project.
