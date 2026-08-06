---
name: argus
description: Measure what a Claude Code session costs — tokens, requests, tool calls, errors — in this project or any other. Reach for it when someone asks to measure token usage, to see where the cost went, to compare two runs, or to start or check the telemetry collector. Telemetry is configured at process start, so a session that is already running cannot be measured; this says what to do about that.
user-invocable: true
---

# argus

**The session you are in right now probably cannot be measured.** Claude Code
reads its telemetry configuration at process start and never again: a session
started without the `OTEL_*` block exports nothing, and no hook, no export and
no settings file added afterwards changes that. What gets measured is always
the **next** session.

So the order is: start the collector, put the environment block in place, then
start a new session. Everything below serves that order.

## Start the collector

From the directory of the project to be measured:

```bash
argus start --background
```

It returns straight away and prints four things: the endpoint, the token if
there is one, the absolute measurement directory, and the process id. The
collector keeps listening and ends by itself when this session's process does —
there is no stop command, and there is nothing to clean up.

Started twice on the same port, the second call starts nothing. It names the
directory the collector already there is writing to when it can read that
collector's configuration; that needs the collector's token, so without it the
call says the directory could not be read rather than naming one. Either way it
answers "is anything measuring right now?" — that is what it is for.

Measurements land in `<project>/.uroboros-telemetry/<timestamp>/`, one directory
per run, and that directory ignores itself in git — nothing else in the
measured project is touched.

## Point a session at it

```bash
argus env
```

prints the export block. Two ways to use it, and the choice matters:

- **For one session**: `eval "$(argus env)"` in a shell, then start Claude Code
  **from that shell**.
- **For every session in this project**: put the block into
  `.claude/settings.local.json` (`argus env --format settings` prints exactly
  that file's content). It is gitignored, which is the point — a versioned
  settings file would have every contributor exporting to a collector they do
  not run.

Either way, a **new** session has to be started afterwards. Say that out loud
when you hand this over; it is the one step that silently produces no data.

## Check that it arrives

```bash
argus check
```

Run it inside the environment the agent runs in. It walks the export path the
exporter takes — reachable, one instance, ingest accepted, record stored — and
names the step that broke. Exit 1 when anything failed, so it works in a
script.

## Read the numbers

The collector serves JSON on its own port:

| Route                   | Answers                                             |
| ----------------------- | --------------------------------------------------- |
| `GET /api/sessions`     | Every session with tokens, cost and error counts     |
| `GET /api/sessions/:id` | One session in full, traces included                 |
| `GET /api/stats`        | Totals, top models, top tools                        |
| `GET /api/events`       | The event timeline, filterable                       |
| `GET /api/config`       | Endpoint, limits and the measurement directory        |
| `GET /api/sessions/:id/agents` | The main session and every subagent that ran in it, each with its own tokens, cost, tool calls and context occupancy per model call |
| `GET /api/sessions/:id/agents/:key/content` | One agent's prompts, responses and tool calls, in order |
| `GET /api/sessions/:id/agents/:key/body/:seq` | One captured request payload, parsed when it arrived whole |

A finished measurement is read back by starting a collector on its directory:

```bash
argus start --open .uroboros-telemetry/2026-08-03T14-22-05
```

That replays it and writes nothing into it, however old it is.

## See what was in the context

By default Claude Code exports structure only — how many tokens, not which ones.
The text itself needs five switches, each set beside the `argus env` block and,
like everything else here, **before the session starts**:

```bash
export OTEL_LOG_USER_PROMPTS=1          # the prompt text of each turn
export OTEL_LOG_ASSISTANT_RESPONSES=1   # the response text
export OTEL_LOG_TOOL_DETAILS=1          # tool call arguments, and real subagent names
export OTEL_LOG_TOOL_CONTENT=1          # tool output (needs CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1)
export OTEL_LOG_RAW_API_BODIES=1        # the whole request payload of every model call
```

They are off by default because a captured request payload is the entire prompt
of that call — the system blocks, every tool definition, and the whole message
history including file contents. Set them on a throwaway measurement, not on
one you will keep or share, and remember that `--persist` writes all of it to
disk as JSONL.

The Agents tab in `argus-ui` shows what each of them fills in, per agent. When a
panel there is empty, it names the variable that would have filled it.

## An old session, or one already running

There is nothing to recover. Telemetry not exported at the time was never
produced, and no directory holds it. Say so and offer the measurable thing: a
new session doing the same work.

## What this is not

Not a profiler and not a tracer of your own code: it sees what Claude Code
exports over OpenTelemetry — model requests, tokens, cost, tool calls, errors —
and nothing else. Not a monitor either: it is started on demand, and dies with
the session that started it.
