# tools/observability

An OpenTelemetry collector and a web UI in one process, for watching agent
sessions live. `README.md` here is the user-facing page; this file is for
changing the code.

## Conventions

- **Zero runtime dependencies, deliberately.** The tool has to start in any
  sandbox with `node bin/athena-observe.mjs`, without `npm install` ever having
  run. Adding a dependency is not a coding decision — it changes what the tool
  promises, so it goes to the human first. `package-lock.json` stays empty of
  runtime packages.
- **ESM only, `.mjs`, Node ≥ 20.11.** Use what the platform ships — `node:test`,
  `node:http`, `AbortController` — rather than a helper.
- **No build step and no framework.** `public/` is served as it is written; a
  bundler would break the "clone and run" promise the same way a dependency
  would.
- **The protobuf decoder is hand-rolled** in `src/otlp/`. It decodes the OTLP
  fields this tool displays and no more; an unknown field is skipped, never a
  parse error.

## Running it

```bash
node bin/athena-observe.mjs            # collector + UI on http://127.0.0.1:4318
node scripts/demo-emit.mjs             # synthetic sessions, no real agent needed
```

## Tests

```bash
npm --prefix tools/observability test
```

`node --test` over `test/*.test.mjs`, one file per module in `src/`. The
repository's `test.sh` runs this through the package's own `test` script, so
the suite it runs stays the suite the package declares. A test binds to port 0
and asks the OS which port it got — a hard-coded port makes the suite fail
against whatever else is running.
