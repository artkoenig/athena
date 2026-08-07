# argus-ui

The web interface for an [argus](../argus/) collector: sessions, tokens, cost,
traces, events and metrics, updating live over Server-Sent Events.

Two processes, deliberately. The collector receives OpenTelemetry, aggregates
and persists it, and serves JSON — that is the half that gets deployed and
reaches other projects. This half is a page and a proxy in front of it, run on
the machine you are sitting at.

No dependencies, no build step — just Node ≥ 20.11.

```
┌─────────┐   HTTP    ┌──────────────┐   HTTP    ┌──────────────┐
│ browser │──────────▶│ argus-ui     │──────────▶│ argus :4318  │
│         │◀── SSE ───│ :4319        │◀── SSE ───│  (collector) │
└─────────┘           └──────────────┘           └──────────────┘
```

## Quick start

```bash
# 1. A collector is running somewhere (see ../argus/README.md)
argus start --background

# 2. The interface, from this checkout
node tools/argus-ui/bin/argus-ui.mjs      # http://127.0.0.1:4319
```

Open <http://127.0.0.1:4319>. Against a collector that was started with a
token, pass it here — the interface supplies it upstream on every request, so
on loopback the browser never handles a token at all:

```bash
node bin/argus-ui.mjs --collector-token "$UROBOROS_OBS_TOKEN"
```

A collector somewhere else is the same command with an address:

```bash
node bin/argus-ui.mjs --collector https://obs.example.com --collector-token <secret>
```

## Options

| Flag                     | Env                  | Default                 | Meaning                                    |
| ------------------------ | -------------------- | ----------------------- | ------------------------------------------ |
| `-c, --collector <url>`  | `UROBOROS_OBS_URL`     | `http://127.0.0.1:4318` | The collector to read                      |
| `--collector-token <s>`  | `UROBOROS_OBS_TOKEN`   | –                       | Token that collector was started with      |
| `-p, --port <n>`         | `UROBOROS_OBS_UI_PORT` | `4319`                  | Port to serve the page on                  |
| `-h, --host <addr>`      | `UROBOROS_OBS_UI_HOST` | `127.0.0.1`             | Bind address                               |
| `-t, --token <secret>`   | `UROBOROS_OBS_UI_TOKEN`| –                       | Require this token for the data            |

A bind address other than loopback is refused without `--token`: reachable from
another machine, this process would hand the collector's token to anyone who
found the port. With a token, one visit to `http://…/?token=<secret>` trades it
for an `HttpOnly; SameSite=Strict` cookie and drops it from the address bar.

## What it shows

- **Timeline** — one lane for the main session and one per subagent instance,
  each spanning that agent's lifetime. It is what opening a session shows; the
  views below open under it, one at a time, and none is open to begin with. It
  carries a chosen time that can be scrubbed to any point of the session and
  follows the newest data until it is scrubbed, with a Live control that
  returns it to the head. A lane can be selected, and the selection lists that
  agent's tool calls up to the chosen time with each call's parameters.
- **Sessions** — every session by last activity, with cost, tokens and errors.
- **Overview** — cost, tokens by type including cache hit rate, interactions,
  requests, tool calls, lines of code, commits, active time; tables per model
  and per tool.
- **Tasks** — reconstructed `TodoWrite` / `TaskCreate` state.
- **Traces** — waterfall per interaction, clicking a bar shows its attributes.
- **Events** — filterable timeline, every row expandable.
- **Metrics** — buffered data points by metric and attribute combination.
- **Attributes** — resource and standard attributes of a session.

## How it reaches the collector

`/api/*` and `/v1/*` are forwarded to the collector; everything else is a file
out of `public/`. The collector's token is added here, server-side, and the
browser's own cookie is stripped before the request leaves.

That is a proxy rather than a browser talking to the collector directly because
`EventSource` cannot set an `Authorization` header: a cross-origin page would
have to carry the collector's token in the query string of every request, which
is the secret in the address bar and in every copied link.

An upstream 401 comes back as a 502 naming the cause — the credential in
question is this process's, not the reader's, so asking them for one would be
the wrong thing to do.

## Tests

```bash
npm --prefix tools/argus-ui test
```

## Limits

- **The collector has to be running.** An old measurement is looked at by
  starting a collector on its directory (`argus start --open <dir>`) and
  pointing this at it. Reading the files here would mean a second
  implementation of the token aggregation that lives in the collector's store,
  and two implementations of one calculation drift apart.
- **Local only.** No `PATH` entry, no plugin skill, never deployed.
