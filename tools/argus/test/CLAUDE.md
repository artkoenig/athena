# tools/argus/test

`node --test` over `test/*.test.mjs` — one file per module in `src/`, no shared
helpers module, no mocking library, no fixtures directory.

## What each file covers

- `protobuf.test.mjs` — encode/decode round-trips of `src/otlp/protobuf.mjs` against `schema.mjs`: varints, BigInt timestamps, hex ids, unknown fields skipped.
- `decode.test.mjs` — `decodeExportRequest` normalizing protobuf and OTLP/JSON traces/logs/metrics into flat records; nanosecond-to-ms exactness.
- `store.test.mjs` — `TelemetryStore` in memory: token/cost rollups, temporality, spans, tool results, todos/tasks, and the ring-buffer eviction that bounds every index.
- `persist.test.mjs` — `JsonlPersistence` round-trip and rotation; then bin-level runs asserting what a start writes into the measured project (`.uroboros-telemetry`, `--persist`, `--open`, `--no-persist`).
- `server.test.mjs` — the HTTP surface of `createServer`: OTLP ingest (protobuf/JSON/gzip), read API, token gating, SSE, JSON 404s.
- `probe.test.mjs` — `probeCollector` against a real collector and against stub servers playing strangers, login gates and load balancers.
- `config.test.mjs` — `endpointFor`, `resolveConfig` layering (flags > namespaced env > PaaS env), `runDirName`, `parseDuration`; `argus env` output via the binary.
- `claude.test.mjs` — pure functions of `claude.mjs`: `sessionNameOf` (decoding, capping, the missing name) and what the `otelEnvFor` block does and does not carry.
- `background.test.mjs` — `spawnBackground`/`exitWhenGone`, then `start --background` end to end: the banner, shutdown with the session, and how a second start classifies whatever holds the port.
- `tunnel.test.mjs` — `startTunnel` driven by shell scripts standing in for cloudflared: verify-before-resolve, QUIC-to-HTTP/2 fallback, failure messages.
- `version.test.mjs` — `argus --version`/`-V` via `execFile` of the binary: manifest-sourced, answered before configuration, no port taken, nothing written.

## Helpers a new case reuses (all file-local — copy the pattern, or add to the file that has it)

- `withServer(options, run)` (server, probe) — real `TelemetryStore` + `createServer` on port 0, closed afterwards.
- `freePort()` (background, persist, version) — asks the OS via `listen(0)`; a hard-coded port is forbidden.
- `projectDir()` / `emptyDir()` / `tmpdir()` — `mkdtemp` scratch directory standing in for the measured project, `rmSync` in `finally`.
- `runBackground` / `runArgus` / `startCollector` — run `bin/argus.mjs` as a child process; the per-command timeout is the only clock allowed.
- `sacrificialProcess()` (background) — an idle node process for `--exit-with` to watch.
- `frontedCollector()` (background) — real backgrounded collector behind a proxy that overrides only `/api/config`, for deterministic abnormal answers.
- payload builders — `tracePayload`/`logsPayloadJson` (server), `attrs` (decode), `metric`/`log`/`span` (store, persist): literals shaped like the wire or like decoder output.
- `fakeBinary(name, script)` (tunnel) — executable shell script; final command is `exec sleep` so SIGTERM reaches it.

## Where a new case goes

Into the file matching the module under test; CLI behavior goes with the module that implements it (persistence flags in `persist.test.mjs`, `--version` in `version.test.mjs`). Files run unit cases first, then process-level cases, with `/* --- banner --- */` comments splitting the sections in the longer files (`background`, `persist`, `version`). Append to the matching section.

## Naming

`test(...)` titles are lowercase declarative sentences stating the guaranteed behavior, often as a contrast: `'records survive a restart'`, `'a torn trailing line is skipped instead of failing the load'`, `'--open <dir> replays it however old it is, and writes nothing into it'`. No "should", no numbering.

## Real and faked

Almost everything is real: real HTTP servers on port 0, real filesystem in `mkdtemp` directories, real child processes of `bin/argus.mjs`, real signals (SIGSTOP/SIGCONT to shape a busy collector). The only stand-ins are stub `http`/`net` servers playing non-collectors, the `/api/config`-overriding front, shell scripts replacing cloudflared, and hand-built record literals fed straight to `TelemetryStore`. Three rules from `tools/argus/CLAUDE.md` bind every case: never a hard-coded port, never a wall-clock duration assertion on a probe path, and messages asserted as absences, never as wordings.

## Running

```bash
npm --prefix tools/argus test
```
