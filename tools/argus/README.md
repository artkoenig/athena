# argus

An OpenTelemetry collector for Claude Agent SDK and Claude Code sessions: which tools ran,
how long each model request took, how many tokens flowed, what it cost and where something
failed. It receives, aggregates, persists and serves JSON. The page that displays all that
is a second process, [`argus-ui`](../argus-ui/), which reads this one over its HTTP API.

No dependencies, no build step, no database — just Node ≥ 20.11. That is deliberate: the
tool is meant to start in any sandbox container with `node bin/argus.mjs`, even without
`npm install`.

Built to run yourself, on your own machine: no sign-up, no account, no third-party
service, no running costs. The telemetry stays where it is produced — see
[Self-hosting](#self-hosting).

```
┌──────────────┐  OTLP/HTTP   ┌────────────────────────────┐   HTTP   ┌──────────┐
│ Claude Code  │─────────────▶│  argus :4318               │◀─────────│ argus-ui │
│ / Agent SDK  │  protobuf    │  /v1/traces /v1/metrics    │   JSON   │  :4319   │
└──────────────┘  or json     │  /v1/logs   +  /api/…      │   + SSE  └──────────┘
                              └────────────────────────────┘
```

## Quick start

```bash
# 1. Start the collector in the project you want to measure
argus start --background          # returns to the shell, keeps listening

# 2. Point an agent at it — and start a NEW session, not this one
eval "$(argus env)"
claude -p "What does this repo do?"

# 3. Look at it: the interface is its own process, from an uroboros checkout
node tools/argus-ui/bin/argus-ui.mjs        # http://127.0.0.1:4319
```

`argus` is on the `PATH` of any session with the uroboros plugin enabled, in any
project — the plugin's `bin/` is what puts it there. From a checkout the same
thing is `node tools/argus/bin/argus.mjs`.

`--background` prints the endpoint, the token if there is one, the measurement
directory and the process id, then returns. The collector shuts itself down when
the session it was started from ends (`--exit-with <pid>`, defaulting to
`$CLAUDE_PID`), so there is no stop command and nothing to clean up. A second
`start --background` on a port that already holds a collector starts nothing. It
names the directory that one is writing to when it can read that collector's
configuration; reading it needs that collector's token, so a call without it —
a session that has not run `eval "$(argus env)"`, say — is told the directory
could not be read instead of being told a wrong one.

**Telemetry is read at process start.** A session already running cannot be
measured after the fact, whatever is exported into it — what gets measured is
always the next one. The `argus` skill carries that procedure for a session to
follow.

Without a real agent run, the store can be filled with synthetic data:

```bash
cd tools/argus
node bin/argus.mjs &
node scripts/demo-emit.mjs --sessions 3      # or --live for a continuous supply
```

## Wiring up an agent

`argus env` prints exactly the block the
[Observability](https://code.claude.com/docs/en/agent-sdk/observability) documentation
page asks for:

```bash
export CLAUDE_CODE_ENABLE_TELEMETRY="1"
export OTEL_METRICS_EXPORTER="otlp"
export OTEL_LOGS_EXPORTER="otlp"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"
export OTEL_EXPORTER_OTLP_ENDPOINT="http://127.0.0.1:4318"
export OTEL_LOG_USER_PROMPTS="1"                 # content, on by default — see "Sensitive data"
export OTEL_LOG_ASSISTANT_RESPONSES="1"
export OTEL_LOG_TOOL_DETAILS="1"
export OTEL_LOG_RAW_API_BODIES="1"               # the whole context of every API call
export CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH="1000000"  # the 61440 default truncates a real body mid-JSON
export CLAUDE_CODE_ENHANCED_TELEMETRY_BETA="1"   # required for spans (beta)
export OTEL_TRACES_EXPORTER="otlp"
export OTEL_LOG_TOOL_CONTENT="1"                 # tool output; rides on span events, so traces only
export OTEL_METRIC_EXPORT_INTERVAL="1000"        # the 60s default is too sluggish for short runs
export OTEL_LOGS_EXPORT_INTERVAL="1000"
export OTEL_TRACES_EXPORT_INTERVAL="1000"
export UROBOROS_OBS_URL="http://127.0.0.1:4318"    # the same address under this tool's own name
```

`--format json` and `--format dotenv` give the same values for `options.env`
(TypeScript/Python SDK) or a `.env` file. The setup dialog in `argus-ui` shows ready-made
snippets for both SDKs.

### Naming sessions

Claude Code exports **no** session name of its own: `session.id` is a UUID, and the standard
attribute set holds neither a title nor a summary nor a working directory. What it does
forward is `OTEL_RESOURCE_ATTRIBUTES`, so a session started with

```bash
export OTEL_RESOURCE_ATTRIBUTES="session.name=nightly%20run"
```

carries that label on every record it exports, and the interface shows it where the ID would be.
US-ASCII only, spaces and umlauts percent-encoded, several attributes separated by commas.

It has to be set **before** the session starts. The OTel resource is built once at process
start, so nothing running inside an already-started session can add the attribute — not a
hook either. There is `CLAUDE_ENV_FILE`, which a SessionStart hook may write `export` lines
into, but the documentation is explicit about who that reaches: "available in all subsequent
Bash commands that Claude Code executes during the session". Later subprocesses, that is,
not the running CLI process and certainly not its already-initialised exporter. Measured: a
session whose SessionStart hook writes `OTEL_RESOURCE_ATTRIBUTES` into `CLAUDE_ENV_FILE`
still exports without `session.name` — the **next** session started from that shell has it.

Without the attribute a session is still tracked, by its ID. The ID does not disappear for
named sessions either — it sits under the name and remains what API paths and search point
at.

### Switching it on for good

An `export` only applies to the shell it was run in. Claude Code reads its configuration
**at process start**, so a session that is already running cannot be captured after the
fact — what gets captured is always the next one.

So that nobody has to remember it, the block belongs in the personal project settings:

```bash
node bin/argus.mjs env --format settings > ../../.claude/settings.local.json
```

That writes `{"env": {…}}` — the export block and nothing else — and Claude Code applies it
to every session in this project. Deliberately `settings.local.json` and not `settings.json`:
the latter is versioned and would have every contributor exporting to a collector they do
not run, once a second. `settings.local.json` is in `.gitignore`.

> If the file already has content, `>` overwrites it. Paste the `env` block in by hand
> instead of redirecting.

Then start a **new** session — the running one no longer changes.

For cloud sessions (Claude Code on the web) the same variables belong in the environment
settings of the web interface, not in a file in the repository: that is how a token ends
up in the version history. The endpoint also has to be reachable from the session
container — see
[Self-hosting](#3-agent-in-a-cloud-session-claude-code-on-the-web-actions-containers).

Three signals, three independent switches — each works on its own:

| Signal     | Switch                                                     | What is built from it                                  |
| ---------- | ---------------------------------------------------------- | ------------------------------------------------------ |
| Metrics    | `OTEL_METRICS_EXPORTER=otlp`                               | Tokens, cost, lines of code, commits, active time       |
| Log events | `OTEL_LOGS_EXPORTER=otlp`                                  | Event timeline, tool results, API errors, audit trail   |
| Traces     | `OTEL_TRACES_EXPORTER=otlp` + `…ENHANCED_TELEMETRY_BETA=1` | Waterfall per interaction                               |

With metrics **and** events active, the metric wins for tokens and cost — nothing is
counted twice. The interface writes the source under every figure.

## Self-hosting

argus is built for everyone to run on their own machine: no registration, no
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
cd tools/argus
docker compose up -d          # http://127.0.0.1:4318, data in the "telemetry" volume
```

The published port is deliberately bound to `127.0.0.1`. The persistence directory is
preset in the container (`UROBOROS_OBS_PERSIST=/data`), so every record is on the volume
rather than only in the process. A restart starts a fresh measurement in the same
directory — what is already on the volume is read back by starting a collector on it with
`--open /data`, not by restarting.

### 3. Agent in a cloud session (Claude Code on the web, Actions, containers)

The session runs in someone else's container. It cannot reach your `localhost`, and it
holds neither your `.claude/settings.local.json` nor your shell. So two parts have to
come together: a **collector URL reachable from outside** and the **variables in the
session's environment**.

#### One command

```bash
node bin/argus.mjs --tunnel
```

That does all of it at once: start the collector, generate a token, open a Cloudflare
tunnel, wait until the public URL really answers, and print the finished block.

```
  argus listening on http://127.0.0.1:4318
  OTLP ingest http://127.0.0.1:4318/v1/{traces,metrics,logs}

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
node tools/argus/bin/argus.mjs check
```

Without arguments, `check` takes what is actually configured in this environment
(`OTEL_EXPORTER_OTLP_ENDPOINT` including the token from `OTEL_EXPORTER_OTLP_HEADERS`),
sends a real OTLP span and reads it back:

```
  ✓ reachable  https://obs.example.ts.net is an argus collector
  ✓ single     one collector process answers this URL
  ✓ ingest     OTLP span accepted
  ✓ stored     probe session uroboros-check-16f7537d is in the store
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
> only reveals that the process is running). Everything else on this port needs the token.

### The token and the browser

No browser ever talks to this port: the collector accepts `Authorization: Bearer …` (what
an OTLP exporter sends) and `?token=…` (what `check` uses), and issues no cookie. The
interface is a separate process that holds the token itself and adds it to every request
it forwards, so a deployed collector's token never has to reach a browser at all:

```bash
node tools/argus-ui/bin/argus-ui.mjs --collector https://obs.example.com --collector-token <secret>
```

> Whether the session container is allowed out at all is decided by the environment's
> network policy. `check` tells you in its first line.

### 4. Permanently on a platform (Render, Fly, Railway)

A tunnel is good for a sitting, not for permanent operation: it hangs off your running
machine and the URL changes on every start. For a fixed address, put the collector
somewhere a process simply keeps running.

Only one thing matters: **a platform for processes, not one for functions.** The store
lives in the memory of a single, long-lived process, and the SSE stream hangs off that
process. Serverless breaks both: there, every instance counts a part of the cost, and a
reader is answered by one that knows nothing — what that looks like and how to measure it
is below. For the same reason the service must **not scale to several
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
node bin/argus.mjs check \
  --public-url https://argus.onrender.com --token <token>

  ✓ reachable  … is an argus collector
  ✓ single     one collector process answers this URL
  ✓ ingest     OTLP span accepted
  ✓ stored     probe session uroboros-check-… is in the store
```

The second line is the one that fails on a platform for functions.

After the deploy the finished variables are in the first lines of the log, with the
public address already filled in:

```
  argus listening on https://argus.onrender.com  (bound to 0.0.0.0:10000)

  Point an agent at it:

    export OTEL_EXPORTER_OTLP_ENDPOINT="https://argus.onrender.com"
    export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer …"
```

That works because Render passes `PORT` and `RENDER_EXTERNAL_URL` into the process and
both are read. `PORT` is the convention on all of these platforms, so Fly and Railway
work the same way — there with `--public-url` or `UROBOROS_OBS_PUBLIC_URL` for the address.

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
  minutes of quiet, and an agent that exports into a cold start loses its telemetry
  silently — exactly the case `check` exists for. That is why the blueprint is on
  `starter`. The disk does not bring a restarted collector's history back either:
  `--persist` only ever writes, so the service comes up on a fresh measurement while the
  earlier records stay on the volume, unread — reading one back needs `--open` on a
  process that has that disk. Without a disk they are gone instead.
- **The data then lives there.** The printed block turns content on, so prompts, answers
  and whole API bodies flow through the collector as well. On your own machine that has no
  consequences; on someone else's infrastructure it is a decision. See
  [Sensitive data](#sensitive-data).

## What comes out of it

The JSON API below is the whole surface: sessions with their aggregates, traces, events,
metric points, totals and facets, plus a Server-Sent Events stream that fires on ingest
(bursts coalesced into 250 ms). What that looks like as a page — sessions, overview,
tasks, traces, events, metrics, attributes — is [`argus-ui`](../argus-ui/), which reads
exactly these routes and nothing else.

## Options

| Flag                    | Env                          | Default        | Meaning                                          |
| ----------------------- | ---------------------------- | -------------- | ------------------------------------------------ |
| `-p, --port`            | `UROBOROS_OBS_PORT`            | `4318`         | Port for OTLP ingest **and** the JSON API        |
| `-h, --host`            | `UROBOROS_OBS_HOST`            | `127.0.0.1`    | Bind address (see below on a platform)           |
| `-t, --token`           | `UROBOROS_OBS_TOKEN`           | –              | Require `Authorization: Bearer …`                |
| `--background`          | –                            | –              | Start and return to the caller                   |
| `--exit-with <pid>`     | `CLAUDE_PID`                 | the session    | Shut down when that process is gone              |
| `--tunnel [binary]`     | –                            | –              | Open a Cloudflare tunnel, generate a token, print the block |
| `--tunnel-protocol <p>` | –                            | both           | Pin the transport: `quic` or `http2`             |
| `--public-url <url>`    | `UROBOROS_OBS_PUBLIC_URL`      | –              | Announced URL behind a tunnel/proxy              |
| `--persist <dir>`       | `UROBOROS_OBS_PERSIST`         | –              | Write into exactly this directory instead of the default one |
| `--no-persist`          | –                            | –              | Keep nothing on disk                             |
| `--open <dir>`          | –                            | –              | Replay an existing measurement, write nothing    |
| `--retention <duration>`| `UROBOROS_OBS_RETENTION`       | `24h`          | Age at which raw data is discarded               |
| `--max-spans <n>`       | `UROBOROS_OBS_MAX_SPANS`       | `50000`        | Span buffer                                      |
| `--max-logs <n>`        | `UROBOROS_OBS_MAX_LOGS`        | `50000`        | Event buffer                                     |
| `--max-metrics <n>`     | `UROBOROS_OBS_MAX_METRICS`     | `50000`        | Metric buffer                                    |
| `--max-sessions <n>`    | `UROBOROS_OBS_MAX_SESSIONS`    | `500`          | Sessions in memory                               |
| `-V, --version`         | –                            | –              | Print the version and exit                       |

Durations accept `ms`, `s`, `m`, `h`, `d` (e.g. `--retention 90m`).

Two more variables that platforms set themselves are read: `PORT` (Render, Fly, Railway,
Heroku) as the port and `RENDER_EXTERNAL_URL` as the public address. Both rank below the
`UROBOROS_OBS_*` variants, so a deliberately set value wins.

A set `PORT` also moves the bind address to `0.0.0.0`. The platform routes to the
container's public interface, so a loopback bind there is the deploy that fails while
looking healthy — the log says the collector is listening, and the port scan finds
nothing:

```
==> No open ports detected on 0.0.0.0, continuing to scan...
==> Port scan timeout reached, no open ports detected on 0.0.0.0.
    Detected open ports on localhost -- did you mean to bind one of these to 0.0.0.0?
```

On a machine someone is sitting at the default stays `127.0.0.1`: a collector without a
token accepts telemetry from anyone who can reach it, so it does not go onto the LAN
unless that was asked for. `--host` and `UROBOROS_OBS_HOST` decide it outright either way.

## How data is kept

Two lifetimes, deliberately separated:

- **Raw data** (spans, events, metric points) sits in bounded windows and is discarded by
  age and by count. That keeps memory use flat.
- **Session aggregates** (tokens, cost, counters per model and tool) are cumulative and
  stay correct even once the raw data has long rolled out.

**Persistence is on by default.** A `start` creates
`<cwd>/.uroboros-telemetry/<YYYY-MM-DDTHH-MM-SS>/` in the project being measured and appends
every normalized record there as JSONL; two starts get two directories, so runs can be
compared instead of one overwriting the other. Creating that root also writes a
`.gitignore` holding `*` inside it, so the measured project's `git status` stays clean and
no file outside the directory is touched. The files rotate at 64 MB (`<signal>.jsonl` →
`<signal>.1.jsonl`).

`--persist <dir>` puts the measurement in exactly that directory, with no timestamp
nesting, and `--no-persist` keeps nothing at all. Both only ever write.

**Reading one back is `--open <dir>`.** It replays that directory into a collector, turns
retention off so a measurement from last week survives its own replay, and opens nothing
for writing — a reopened measurement cannot be changed by what happens while you look at
it. `--persist` and `--open` together are refused.

```bash
argus start --open .uroboros-telemetry/2026-08-03T14-22-05
```

`DELETE /api/data` empties the store at runtime.

## Sensitive data

By default Claude Code exports structure only: durations, model names, tool names, token
counts. `argus env` **does** switch the content on, in every format it prints:
`OTEL_LOG_USER_PROMPTS=1`, `OTEL_LOG_ASSISTANT_RESPONSES=1`, `OTEL_LOG_TOOL_DETAILS=1`,
`OTEL_LOG_RAW_API_BODIES=1` and `OTEL_LOG_TOOL_CONTENT=1` (that last one only alongside
traces, because it writes onto span events), plus
`CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH=1000000` so a whole context arrives instead of a body
cut mid-JSON.

So know what that means before pasting the block: prompts, assistant responses, tool
arguments, tool output and the **complete request and response bodies** — the entire
conversation as the model saw it, including file contents it read — then live in the
collector's memory and, with `--persist`, in the measurement directory on disk. There is no
flag that turns it off, because a recording without it cannot answer what an agent was
working from. Point a measured session at a collector you control, and treat the
measurement directory as you would the transcript itself.

`argus` never puts that text on a list: `/api/events` and `/api/sessions/:id/content`
report a body's model, length and truncation flag, and only
`/api/sessions/:id/context` — one lane, one point in time — hands the text out.

`user.email`, `user.account_uuid` and `organization.id` are standard attributes and appear
in the interface under "Attributes".

## Architecture

```
bin/argus.mjs            CLI: arguments, start, env output, shutdown
src/config.mjs           defaults < environment < flags
src/otlp/protobuf.mjs    schema-driven protobuf reader/writer (wire format)
src/otlp/schema.mjs      field descriptors for opentelemetry-proto v1
src/otlp/decode.mjs      OTLP (protobuf & JSON) → flat records
src/claude.mjs           Claude Code domain knowledge: metric, event and span names
src/store.mjs            in-memory store, session aggregation, trace tree, queries
src/persist.mjs          JSONL append, replay, one directory per measurement
src/background.mjs       start in the background, end with the session
src/server.mjs           OTLP ingest, JSON API, SSE
scripts/demo-emit.mjs    synthetic sessions as real OTLP protobuf
```

The protobuf decoder skips unknown fields, so it stays tolerant of newer OTLP revisions
and new Claude Code attributes.

### HTTP API

| Route                    | Purpose                                                    |
| ------------------------ | ---------------------------------------------------------- |
| `POST /v1/{traces,metrics,logs}` | OTLP ingest (`http/protobuf`, `http/json`, gzip)   |
| `GET /api/sessions`      | Session list (`search`, `limit`, `offset`)                 |
| `GET /api/sessions/:id`  | Session aggregates including traces and `agents` (the lanes) |
| `GET /api/sessions/:id/content` | Request/response body records, described, never quoted (`agent`, `since`, `until`, `limit`) |
| `GET /api/sessions/:id/context` | The request body one lane was working from at `at=<ms>` (`agent`), body text included |
| `GET /api/traces/:id`    | Spans of a trace, flat with `depth` in render order        |
| `GET /api/events`        | Events (`session`, `event`, `trace`, `agent`, `since`, `until`, `search`, `errors`) |
| `GET /api/metrics`       | Metric points (`session`, `name`)                          |
| `GET /api/stats`         | Totals, top models, top tools, buffer sizes                |
| `GET /api/facets`        | Event and metric names that occur, with frequency          |
| `GET /api/config`        | Endpoint, limits, measurement directory, `OTEL_*` block     |
| `GET /api/stream`        | Server-Sent Events on ingest                               |
| `DELETE /api/data`       | Empty the store                                            |

## Tests

```bash
npm test          # wire format, decoder, store, persistence, config, probe, tunnel, HTTP
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
- **A measurement with bodies is orders of magnitude larger.** Content is on by default, and
  a single request body runs to hundreds of kilobytes, so `logs.jsonl` grows by megabytes
  per minute of real work — plan for gigabytes where the same run without content wrote
  megabytes. In memory a separate budget bounds every content-bearing text the env block
  turns on — user prompts, assistant responses, tool details, the tool content carried on
  span events and the raw bodies: past `maxContentBytes` (256 MB) the oldest **text** is
  dropped, whichever signal carries it, while the record, its timing, its lane, the
  reported body length and a span event's own name and time stay, so the timeline is
  unchanged and only the content of a long-past moment is gone. On disk the file rotates
  at 512 MB with one previous generation kept.
- **Attribution to a subagent needs traces.** `agent.name` does not arrive on body events
  (checked: 2.1.226); the lane is resolved from the record's span, up the tree to the
  `claude_code.tool.execution` span of the `Agent` call that dispatched it. Without traces
  the fallback is the `query_source` attribute, which names the agent *type* — so two
  concurrent subagents of the same type then share one lane. Each lane reports the evidence
  it rests on in its `source` field.
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
node tools/argus/bin/argus.mjs check
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

A name reaches the collector only as a resource attribute the session itself exports (see
[Naming sessions](#naming-sessions)), so it can be missing while everything else is there.
In order:

1. **Was `OTEL_RESOURCE_ATTRIBUTES="session.name=…"` in the environment?** Nothing else
   names a session. Check it in the session itself, not in the shell you set it from.
2. **Was it set before the session started?** The OTel resource is built once at process
   start. A running session does not get a name retroactively — the next one does.
3. **Is the value encoded?** The value is restricted to US-ASCII and comma-separated, so a
   space, a comma or an umlaut has to be percent-encoded (`nightly%20run`). An unencoded
   one truncates the attribute or drops it.
4. **Does the session's own record carry it?** Open the session in the interface, tab
   "Attributes": if `session.name` is not among the resource attributes, it never left the
   agent.
