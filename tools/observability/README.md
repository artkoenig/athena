# athena · observe

An OpenTelemetry collector **and** a web UI in one process, for watching Claude Agent SDK
and Claude Code sessions: which tools ran, how long each model request took, how many
tokens flowed, what it cost and where something failed.

No dependencies, no build step, no database — just Node ≥ 20.11. That is deliberate: the
tool is meant to start in any sandbox container with `node bin/athena-observe.mjs`, even
without `npm install`.

Built to run yourself, on your own machine: no sign-up, no account, no third-party
service, no running costs. The telemetry stays where it is produced — see
[Self-hosting](#self-hosting).

```
┌──────────────┐  OTLP/HTTP   ┌────────────────────────────┐
│ Claude Code  │─────────────▶│  athena-observe :4318      │
│ / Agent SDK  │  protobuf    │  /v1/traces /v1/metrics    │
└──────────────┘  or json     │  /v1/logs   +  Web UI  /   │
                              └────────────────────────────┘
```

## Quick start

```bash
cd tools/observability

# 1. Start collector + UI (ingest and UI share one port)
node bin/athena-observe.mjs                # http://127.0.0.1:4318

# 2. In a second shell: point an agent at the collector
eval "$(node bin/athena-observe.mjs env)"
claude -p "What does this repo do?"

# 3. Open http://127.0.0.1:4318 in a browser
```

Without a real agent run, the UI can be filled with synthetic data:

```bash
node bin/athena-observe.mjs &
node scripts/demo-emit.mjs --sessions 3      # or --live for a continuous supply
```

## Wiring up an agent

`athena-observe env` prints exactly the block the
[Observability](https://code.claude.com/docs/en/agent-sdk/observability) documentation
page asks for:

```bash
export CLAUDE_CODE_ENABLE_TELEMETRY="1"
export OTEL_METRICS_EXPORTER="otlp"
export OTEL_LOGS_EXPORTER="otlp"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"
export OTEL_EXPORTER_OTLP_ENDPOINT="http://127.0.0.1:4318"
export CLAUDE_CODE_ENHANCED_TELEMETRY_BETA="1"   # required for spans (beta)
export OTEL_TRACES_EXPORTER="otlp"
export OTEL_METRIC_EXPORT_INTERVAL="1000"        # the 60s default is too sluggish for short runs
export OTEL_LOGS_EXPORT_INTERVAL="1000"
export OTEL_TRACES_EXPORT_INTERVAL="1000"
```

`--format json` and `--format dotenv` give the same values for `options.env`
(TypeScript/Python SDK) or a `.env` file. The setup dialog in the UI shows ready-made
snippets for both SDKs.

### Naming sessions

Claude Code exports **no** session name: `session.id` is a UUID, and the standard attribute
set holds neither a title nor a summary nor a working directory. So athena-observe brings a
SessionStart hook that names every session automatically — after repository and branch, i.e.
`athena · main`. Nothing about it is configured; the hook sits in the settings block that
[Switching it on for good](#switching-it-on-for-good) writes:

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "node /path/to/hooks/session-name.mjs" }] }
    ]
  }
}
```

Why a hook and not an environment variable: the OTel resource is read once at process
start, a hook runs after that — and as a subprocess with a copy of the environment, so its
`export`s never reach the CLI process. The name therefore cannot travel along in the
telemetry. Instead the hook sends it straight to the collector (`POST
/api/sessions/<id>/name`), with the `session_id` every hook is handed anyway. It reads
endpoint and token from `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS` —
the same variables the session exports with. With no telemetry running, it does nothing.

Because the name arrives before the first export, a session shows up in the list as soon as
it starts — not only once it has spent its first token.

Two things can be changed:

- `ATHENA_OBS_SESSION_NAME` overrides the derived name. Useful for CI jobs (build number)
  or SDK fleets that name their runs themselves.
- `OTEL_RESOURCE_ATTRIBUTES="session.name=…"` set **before** the start wins against the
  hook — that is the manual route when a session should be called something other than its
  branch. US-ASCII only, spaces percent-encoded (`nightly%20run`), several attributes
  separated by commas.

Without the hook and without the attribute, the session is still tracked by its ID. The ID
does not disappear for named sessions either — it sits under the name and remains what API
paths and search point at.

### Switching it on for good

An `export` only applies to the shell it was run in. Claude Code reads its configuration
**at process start**, so a session that is already running cannot be captured after the
fact — what gets captured is always the next one.

So that nobody has to remember it, the block belongs in the personal project settings:

```bash
node bin/athena-observe.mjs env --format settings > ../../.claude/settings.local.json
```

That writes `{"env": {…}, "hooks": {…}}` — the export block plus the SessionStart hook from
[Naming sessions](#naming-sessions) — and Claude Code applies it to every session in this
project. Deliberately `settings.local.json` and not `settings.json`: the latter is versioned
and would have every contributor exporting to a collector they do not run, once a second.
`settings.local.json` is in `.gitignore`.

> If the file already has content, `>` overwrites it. Paste the `env` block in by hand
> instead of redirecting.

Then start a **new** session — the running one no longer changes.

For cloud sessions (Claude Code on the web) the same variables belong in the environment
settings of the web interface, not in a file in the repository: that is how a token ends
up in the version history. The endpoint also has to be reachable from the session
container — see
[Self-hosting](#3-agent-in-a-cloud-session-claude-code-on-the-web-actions-containers).

Three signals, three independent switches — each works on its own:

| Signal     | Switch                                                     | What the UI builds from it                             |
| ---------- | ---------------------------------------------------------- | ------------------------------------------------------ |
| Metrics    | `OTEL_METRICS_EXPORTER=otlp`                               | Tokens, cost, lines of code, commits, active time       |
| Log events | `OTEL_LOGS_EXPORTER=otlp`                                  | Event timeline, tool results, API errors, audit trail   |
| Traces     | `OTEL_TRACES_EXPORTER=otlp` + `…ENHANCED_TELEMETRY_BETA=1` | Waterfall per interaction                               |

With metrics **and** events active, the metric wins for tokens and cost — nothing is
counted twice. The UI writes the source under every figure.

## Self-hosting

athena-observe is built for everyone to run on their own machine: no registration, no
account, no third-party service, no running costs. The telemetry never leaves your own
machine. There are four shapes, depending on where the agent runs — and, for the last
one, on how permanent it should be.

### 1. Agent and collector on the same machine

The normal case — the quick start above is all of it. The bind address stays
`127.0.0.1`, so the collector is not reachable from outside and needs no token.

### 2. Via Docker

For anyone who would rather not run Node directly: the image installs nothing, it is
just a Node runtime plus the sources.

```bash
cd tools/observability
docker compose up -d          # http://127.0.0.1:4318, data in the "telemetry" volume
```

The published port is deliberately bound to `127.0.0.1`. Persistence is preset in the
container (`ATHENA_OBS_PERSIST=/data`), so a restart loses nothing.

### 3. Agent in a cloud session (Claude Code on the web, Actions, containers)

The session runs in someone else's container. It cannot reach your `localhost`, and it
holds neither your `.claude/settings.local.json` nor your shell. So two parts have to
come together: a **collector URL reachable from outside** and the **variables in the
session's environment**.

#### One command

```bash
node bin/athena-observe.mjs --tunnel
```

That does all of it at once: start the collector, generate a token, open a Cloudflare
tunnel, wait until the public URL really answers, and print the finished block.

```
  athena-observe listening on http://127.0.0.1:4318
  UI          http://127.0.0.1:4318/?token=21c934f71106a6ffebf187510d233744

  Opening a Cloudflare quick tunnel …
  Got https://fewer-cube-selective-physiology.trycloudflare.com, waiting for it to serve …

  Public URL  https://fewer-cube-selective-physiology.trycloudflare.com
  Token       21c934f71106a6ffebf187510d233744

  Set these in the cloud session environment, then start a NEW session:

    CLAUDE_CODE_ENABLE_TELEMETRY=1
    OTEL_EXPORTER_OTLP_ENDPOINT=https://fewer-cube-selective-physiology.trycloudflare.com
    OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer 21c934f71106a6ffebf187510d233744
    …
```

Put those lines into the environment settings of Claude Code on the web. That is where
the token belongs too — **not** in a file in the repository, or it ends up in the
version history. Same thing for GitHub Actions, via `env:` and a repository secret.

`cloudflared` is a prerequisite; if it is missing, the command says how to install it.
Without `--token` one is generated, because the URL is reachable from the internet from
that moment on. The tunnel stands as long as the command runs; `Ctrl-C` closes both.

By default `cloudflared` reaches Cloudflare over **QUIC**, that is UDP on port 7844. Many
routers, corporate networks and containers do not let UDP out, and `cloudflared` does not
fall back on its own — it keeps retrying QUIC forever. So this switches to **HTTP/2**
(TCP, same port) automatically as soon as QUIC does not get through:

```
  Got https://…trycloudflare.com, waiting for it to serve …
  QUIC (UDP 7844) did not get through — retrying over HTTP/2 (TCP 7844) …
```

If both fail, the network is blocking the port itself — visible as two `FAIL` lines in
the diagnostics:

```
    |  UDP Connectivity  region2.v2.argotunnel.com  FAIL    QUIC connection failed
    |  TCP Connectivity  region2.v2.argotunnel.com  FAIL    HTTP/2 connection is blocked
```

That is a firewall rule, not a hiccup: `cloudflared` gets through in no form here, and
another attempt changes nothing. The command then names the ways out itself — the table
below, or [point 4](#4-permanently-on-a-platform-render-fly-railway) directly: a deployed
collector needs no tunnel at all, because then your own machine does not have to be
reachable.

`--tunnel-protocol quic|http2` pins a transport when you know which one works.

> A quick tunnel's URL is **ephemeral** — every restart hands out a new one, and then the
> variables have to be updated. Anyone who needs this often takes a tunnel with a fixed
> address and passes it through with `--public-url`:
>
> | Tunnel                                            | Cost            | URL        | Account   | Goes out via |
> | ------------------------------------------------- | --------------- | ---------- | --------- | ------------ |
> | `--tunnel` (Cloudflare Quick)                     | free            | changing   | none      | **7844**     |
> | `ssh -R 80:localhost:4318 nokey@localhost.run`    | free            | changing   | none      | 22           |
> | `tailscale funnel 4318`                           | free (Personal) | **stable** | Tailscale | 443          |
> | `ngrok http 4318 --domain <yours>.ngrok-free.app` | free (1 domain) | **stable** | ngrok     | 443          |
> | your own server / NAS with `--host 0.0.0.0`       | already paid    | stable     | –         | –            |
>
> The last column is the point when `--tunnel` fails at the firewall: only Cloudflare
> needs 7844, all the others go over ports a network practically always leaves open.
> `localhost.run` does not even need an installation.

#### Checking that it arrives

When nothing arrives, the exporter stays silent. So check **inside the cloud session**:

```bash
node tools/observability/bin/athena-observe.mjs check
```

Without arguments, `check` takes what is actually configured in this environment
(`OTEL_EXPORTER_OTLP_ENDPOINT` including the token from `OTEL_EXPORTER_OTLP_HEADERS`),
sends a real OTLP span and reads it back:

```
  ✓ reachable  https://obs.example.ts.net is an athena-observe collector
  ✓ single     one collector process answers this URL
  ✓ ingest     OTLP span accepted
  ✓ stored     probe session athena-check-16f7537d is in the store
```

Every step fails on its own: `reachable` points at network policy or a wrong URL,
`single` at several instances behind one address (see
[Serverless](#not-on-serverless--and-why-measured)), `ingest` at a missing or wrong
token, `stored` at a collector that accepts but does not store. Exit code 1 when anything
fails — which makes it usable in a script.

Then start a **new** session; the running one does not re-read its configuration.

> As soon as the collector is reachable beyond `127.0.0.1`, it needs a token in front of
> it — otherwise anyone who knows the address can pour telemetry in and read yours.
> Exempt are `/api/health`, which answers without a token so that health checks work (it
> only reveals that the process is running), and the three static files of the interface —
> they are the same for everyone and contain nothing.

### The token in a browser

An agent sends `Authorization: Bearer …`. A browser cannot — it sets no headers on the
files it loads itself. So **one** visit with the token in the address is enough:

```
http://127.0.0.1:4318/?token=<your-token>
```

The collector exchanges it for a cookie and sends you back to the same page without the
parameter. After that the bare address is enough — for 30 days, per browser. The cookie
is `HttpOnly` (no script can reach it) and `SameSite=Strict`, so no foreign page can pour
in or delete data with your rights.

Open the address without a token and you get an input field instead of an empty page.
That sets the cookie as well, and then it is quiet.

> Whether the session container is allowed out at all is decided by the environment's
> network policy. `check` tells you in its first line.

### 4. Permanently on a platform (Render, Fly, Railway)

A tunnel is good for a sitting, not for permanent operation: it hangs off your running
machine and the URL changes on every start. For a fixed address, put the collector
somewhere a process simply keeps running.

Only one thing matters: **a platform for processes, not one for functions.** The store
lives in the memory of a single, long-lived process, and the SSE stream works because
ingest and UI share that process. Serverless breaks both: there, every instance counts a
part of the cost, and the UI reads from one that knows nothing — what that looks like and
how to measure it is below. For the same reason the service must **not scale to several
instances**; on Render an attached disk enforces that anyway.

For Render there is a ready-made blueprint at the repository root (`render.yaml`) — there
and only there does Render read it; `rootDir` inside it still keeps the build scoped to
this tool. There is nothing to copy:

```
render.com → New → Blueprint → pick this repository → Apply
```

The blueprint sets the port and bind address, attaches a disk at `/data` (persistence in
the image is already preset to it), generates a token and registers `/api/health` as the
health check — which deliberately answers without a token. The token is then in the
dashboard under *Environment*.

Then check from the environment the agent runs in:

```bash
node bin/athena-observe.mjs check \
  --public-url https://athena-observe.onrender.com --token <token>

  ✓ reachable  … is an athena-observe collector
  ✓ single     one collector process answers this URL
  ✓ ingest     OTLP span accepted
  ✓ stored     probe session athena-check-… is in the store
```

The second line is the one that fails on a platform for functions.

After the deploy the finished variables are in the first lines of the log, with the
public address already filled in:

```
  athena-observe listening on https://athena-observe.onrender.com  (bound to 0.0.0.0:10000)
  UI          https://athena-observe.onrender.com/?token=…

  Point an agent at it:

    export OTEL_EXPORTER_OTLP_ENDPOINT="https://athena-observe.onrender.com"
    export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer …"
```

That works because Render passes `PORT` and `RENDER_EXTERNAL_URL` into the process and
both are read. `PORT` is the convention on all of these platforms, so Fly and Railway
work the same way — there with `--public-url` or `ATHENA_OBS_PUBLIC_URL` for the address.

#### Not on serverless — and why, measured

The store lives in the memory of a process. On a function platform there is no such
thing: there, a changing number of short-lived instances answers the same URL. That is
not a slower collector here, it is a broken one. Twelve **concurrent** requests against
such a deployment, each `/api/health` (the process's uptime) and `/api/sessions` (what
this process sees):

```
uptime=264242  sessions=0     uptime=736594  sessions=0
uptime=264168  sessions=0     uptime=736583  sessions=0
uptime=264195  sessions=0     uptime=736607  sessions=0
uptime=264211  sessions=1     uptime=736552  sessions=1
uptime=264277  sessions=1     uptime=736564  sessions=0
uptime=264152  sessions=0     uptime=264609  sessions=0
```

Two clearly separated uptimes, so at least two processes — and within the same group the
answer is sometimes `1`, sometimes `0`, so more than two. Each has its own memory. An
agent's telemetry sits in exactly one of them; which one answers is decided per request.
In the browser it looks like this: **the session appears in the list and is gone again on
reload.** The SSE stream does not help, it hangs off one instance and hears nothing of
the POSTs to the others.

Consecutive requests over one connection usually hit the same instance — which is why a
single call looks healthy, and why `check` fires its requests in parallel:

```
✗ single     4 instances answer this URL, each with its own memory —
             telemetry will appear and vanish
```

Anyone who wants serverless anyway has to move the store outside (Postgres, Redis) — a
rebuild, not a switch, and with `OTEL_*_EXPORT_INTERVAL=1000` every agent writes once a
second. A platform with one process and one disk is the shorter road.


#### Knowing beforehand

Two things hold for all of these variants:

- **It costs.** Render's free tier has no disk and puts the service to sleep after ~15
  minutes of quiet. Both erase the history, and an agent that exports into a cold start
  loses its telemetry silently — exactly the case `check` exists for. That is why the
  blueprint is on `starter`.
- **The data then lives there.** With `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA` switched on,
  prompts and answers flow through the collector as well. On your own machine that has no
  consequences; on someone else's infrastructure it is a decision. See
  [Sensitive data](#sensitive-data).

## What the UI shows

- **Sessions** — list of all sessions, sorted by last activity, with cost, tokens and error
  count; live sessions are marked. With the hook installed the name leads and the ID sits
  below it, otherwise the ID leads (see [Naming sessions](#naming-sessions)).
- **Overview** — grid of figures (cost, tokens by type including cache hit rate,
  interactions, LLM requests, tool calls, lines of code, commits/PRs, active time) plus
  tables per model (requests, latency, TTFT, errors) and per tool (calls, failures,
  rejects, duration).
- **Tasks** — current state of `TodoWrite` (the full list per call) as well as
  `TaskCreate`/`TaskUpdate` (tasks by ID, plus separately those newly created tasks whose
  ID the telemetry does not carry — see [Limits](#limits)). Needs
  `OTEL_LOG_TOOL_DETAILS=1`, otherwise content and status stay empty. The tab deliberately
  has no counter in its label: completed and deleted tasks stay in the reconstructed state
  (see [Limits](#limits)), so a number would only grow and say nothing about the current
  state.
- **Traces** — waterfall per interaction: `interaction` → `llm_request` / `tool` →
  `tool.blocked_on_user` + `tool.execution`, coloured by span type, clicking a bar shows
  all attributes and span events. Subagent spans hang under the parent agent's `tool`
  span, so the delegation chain is one trace.
- **Events** — filterable event timeline (name, full text across all attributes, "errors
  only"), every row expandable to the complete attribute set.
- **Metrics** — all buffered data points, grouped by metric and attribute combination.
- **Attributes** — resource and standard attributes of the session.

The UI updates over Server-Sent Events; bursts are coalesced into 250 ms.

## Options

| Flag                    | Env                          | Default        | Meaning                                          |
| ----------------------- | ---------------------------- | -------------- | ------------------------------------------------ |
| `-p, --port`            | `ATHENA_OBS_PORT`            | `4318`         | Port for OTLP ingest **and** UI                  |
| `-h, --host`            | `ATHENA_OBS_HOST`            | `127.0.0.1`    | Bind address                                     |
| `-t, --token`           | `ATHENA_OBS_TOKEN`           | –              | Require `Authorization: Bearer …`                |
| `--tunnel [binary]`     | –                            | –              | Open a Cloudflare tunnel, generate a token, print the block |
| `--tunnel-protocol <p>` | –                            | both           | Pin the transport: `quic` or `http2`             |
| `--public-url <url>`    | `ATHENA_OBS_PUBLIC_URL`      | –              | Announced URL behind a tunnel/proxy              |
| `--persist [dir]`       | `ATHENA_OBS_PERSIST`         | –              | JSONL on disk, replay at start                   |
| `--retention <duration>`| `ATHENA_OBS_RETENTION`       | `24h`          | Age at which raw data is discarded               |
| `--max-spans <n>`       | `ATHENA_OBS_MAX_SPANS`       | `50000`        | Span buffer                                      |
| `--max-logs <n>`        | `ATHENA_OBS_MAX_LOGS`        | `50000`        | Event buffer                                     |
| `--max-metrics <n>`     | `ATHENA_OBS_MAX_METRICS`     | `50000`        | Metric buffer                                    |
| `--max-sessions <n>`    | `ATHENA_OBS_MAX_SESSIONS`    | `500`          | Sessions in memory                               |

Durations accept `ms`, `s`, `m`, `h`, `d` (e.g. `--retention 90m`).

Two more variables that platforms set themselves are read: `PORT` (Render, Fly, Railway,
Heroku) as the port and `RENDER_EXTERNAL_URL` as the public address. Both rank below the
`ATHENA_OBS_*` variants, so a deliberately set value wins.

## How data is kept

Two lifetimes, deliberately separated:

- **Raw data** (spans, events, metric points) sits in bounded windows and is discarded by
  age and by count. That keeps memory use flat.
- **Session aggregates** (tokens, cost, counters per model and tool) are cumulative and
  stay correct even once the raw data has long rolled out.

With `--persist <dir>` every normalized record is appended as JSONL and replayed at the
next start — useful in containers that get restarted. The files rotate at 64 MB
(`<signal>.jsonl` → `<signal>.1.jsonl`).

`DELETE /api/data` empties the store at runtime.

## Sensitive data

By default Claude Code exports structure only: durations, model names, tool names, token
counts. Prompts, tool arguments and API bodies arrive only with
`OTEL_LOG_USER_PROMPTS=1`, `OTEL_LOG_TOOL_DETAILS=1`, `OTEL_LOG_TOOL_CONTENT=1` and
`OTEL_LOG_RAW_API_BODIES`. `athena-observe env` deliberately does **not** set these. Anyone
who switches them on should know that prompt and file contents then live in the
collector's memory and — with `--persist` — on disk.

`user.email`, `user.account_uuid` and `organization.id` are standard attributes and appear
in the UI under "Attributes".

## Architecture

```
bin/athena-observe.mjs   CLI: arguments, start, env output, shutdown
src/config.mjs           defaults < environment < flags
src/otlp/protobuf.mjs    schema-driven protobuf reader/writer (wire format)
src/otlp/schema.mjs      field descriptors for opentelemetry-proto v1
src/otlp/decode.mjs      OTLP (protobuf & JSON) → flat records
src/claude.mjs           Claude Code domain knowledge: metric, event and span names
src/store.mjs            in-memory store, session aggregation, trace tree, queries
src/persist.mjs          optional JSONL append + replay
src/server.mjs           OTLP ingest, JSON API, SSE, static serving
hooks/session-name.mjs   SessionStart hook: names the session in the collector
public/                  UI (vanilla JS, no build)
scripts/demo-emit.mjs    synthetic sessions as real OTLP protobuf
```

The protobuf decoder skips unknown fields, so it stays tolerant of newer OTLP revisions
and new Claude Code attributes.

### HTTP API

| Route                    | Purpose                                                    |
| ------------------------ | ---------------------------------------------------------- |
| `POST /v1/{traces,metrics,logs}` | OTLP ingest (`http/protobuf`, `http/json`, gzip)   |
| `GET /api/sessions`      | Session list (`search`, `limit`, `offset`)                 |
| `GET /api/sessions/:id`  | Session aggregates including traces                        |
| `GET /api/traces/:id`    | Spans of a trace, flat with `depth` in render order        |
| `GET /api/events`        | Events (`session`, `event`, `trace`, `search`, `errors`)   |
| `GET /api/metrics`       | Metric points (`session`, `name`)                          |
| `GET /api/stats`         | Totals, top models, top tools, buffer sizes                |
| `GET /api/facets`        | Event and metric names that occur, with frequency          |
| `POST /api/sessions/:id/name` | Name a session (`{"name": "…"}`), from the SessionStart hook |
| `GET /api/config`        | Endpoint, limits, ready-made `OTEL_*` block, hook block     |
| `GET /api/stream`        | Server-Sent Events on ingest                               |
| `DELETE /api/data`       | Empty the store                                            |

## Tests

```bash
npm test          # wire format, decoder, store, persistence, config, probe, tunnel, HTTP, hook
npm run demo      # emit a synthetic session
```

## Limits

- **OTLP over HTTP only.** gRPC (port 4317) is not spoken —
  `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf` (or `http/json`) is required.
- **No Prometheus scrape endpoint.** `OTEL_METRICS_EXPORTER=prometheus` does not export
  here.
- **Not usable as a `console` exporter.** With the Agent SDK, stdout is the message
  channel; `console` would destroy it. So always `otlp`.
- Histograms are stored and listed, but not drawn as a distribution.
- **"Result tokens" is almost always an estimate with current CLI versions (checked:
  2.1.220).** The documented `result_tokens` attribute on `claude_code.tool` spans is not
  sent by the CLI at the moment. When it is missing, the store extrapolates it from
  `tool_result_size_bytes` on the matching `claude_code.tool_result` event (~4 bytes per
  token, a rule of thumb for English text) and marks the value in the tools table with a
  tilde (`~`). As soon as the CLI delivers the attribute itself, that value is preferred
  and the tilde disappears.
- **Newly created tasks cannot always be matched to their ID.** The CLI assigns the task
  ID on `TaskCreate` and names it only in the tool result — which only
  `OTEL_LOG_TOOL_CONTENT=1` exports (undocumented format, considerably more sensitive, see
  [Sensitive data](#sensitive-data)). The Tasks tab therefore shows such tasks separately
  under "Created (id not yet known)" instead of guessing.
- **The Tasks tab shows what was ever seen, not what exists right now.** A deleted or
  completed task does not disappear from the table, it only gets the status
  `deleted`/`completed`. There is deliberately no aggregate counter here (unlike traces,
  events and metrics), because it could only grow monotonically.
- The store lives in the process. For long-term retention or alerting, the telemetry
  belongs in a real backend (Honeycomb, Grafana, Datadog, Langfuse) — both work in
  parallel, `OTEL_EXPORTER_OTLP_*` variables can point each signal at a different
  endpoint.

## Troubleshooting

When nothing arrives, the CLI exports silently into the void. The first move is always to
check, from the agent's own environment, whether the path stands at all:

```bash
node tools/observability/bin/athena-observe.mjs check
```

`CLAUDE_CODE_OTEL_DIAG_STDERR=1` additionally turns on exporter diagnostics on stderr
(Claude Code ≥ 2.1.179); with the SDK they land in the `stderr` callback. Then check in
order:

1. `curl -s http://127.0.0.1:4318/api/health` — is the collector running?
2. Does `OTEL_EXPORTER_OTLP_ENDPOINT` point at the host **without** a `/v1/…` path?
3. Is `CLAUDE_CODE_ENABLE_TELEMETRY=1` set (without it nothing happens at all)?
4. Only spans missing? Then `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1` is missing.
5. Short run with no data? Lower the export intervals (see above) — at process exit there
   is only a narrow flush window.

### Sessions arrive, but without a name

The name is the one thing that does not travel with the telemetry (see
[Naming sessions](#naming-sessions)), so it can be missing while everything else is
there. In order:

1. **Is the hook installed?** `.claude/settings.local.json` (or the cloud session's
   environment settings) needs a `hooks.SessionStart` block next to `env`. A file written
   before this feature has only `env` — print `env --format settings` again and install it.
2. **Does the collector know the route?** `athena-observe check` has a step of its own for
   this: `✗ naming … predates session naming` means the collector runs an older build.
   Redeploy or restart it — with `autoDeploy: false` on Render that does not happen by
   itself.
3. **Was a new session started?** The hook fires at startup. Running sessions do not get a
   name retroactively.
4. **What does the hook itself say?** Run it by hand, with the same environment as the
   session:

   ```bash
   echo "{\"session_id\":\"probe\",\"cwd\":\"$PWD\"}" | node tools/observability/hooks/session-name.mjs
   ```

   No output means it named the session (check `/api/sessions?search=probe`). Otherwise it
   writes the reason to stderr — no endpoint in the environment, the collector's HTTP
   status, a timeout. As a hook the same lines show up under `claude --debug`.
