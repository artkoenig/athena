# A session timeline as the argus UI's central view

## Problem

The argus UI is technical: it shows many numbers and raw records, and the
overview gets lost in them. What the human actually wants to see is how a
session develops over time — which agents are running at a given moment, what
the context of the main session and of each agent looks like at that moment
(the exact content, as text), and which tools each agent has used up to that
point and with what parameters. The purpose is to optimize the workflow as a
whole and to reduce token consumption: the view has to make visible *where*
context grows and *what* fills it.

The control the human asked for is a timeline: scrub the session backward and
forward, or let it follow live.

Today the data for this only partially arrives. The OTLP export carries
metrics, events and spans with timestamps and agent attribution
(`agent.name`, `skill.name` on spans), but all content is behind opt-in flags
that `argus env` does not set: prompt text needs `OTEL_LOG_USER_PROMPTS`,
tool parameters need `OTEL_LOG_TOOL_DETAILS`, tool result content needs
`OTEL_LOG_TOOL_CONTENT`, and the full request/response bodies — the event
names `claude_code.api_request_body` / `claude_code.api_response_body` are
already known to `tools/argus/src/claude.mjs` — need whatever flag the CLI
requires for them. An API request body *is* the context at the time of that
request, which makes OTLP alone a sufficient source once the flags are on.

## Acceptance criteria

- [ ] `argus env` (both formats) includes the content flags by default:
      user prompts, tool details, tool content, and the flag(s) required for
      the CLI to emit `api_request_body`/`api_response_body` events. The
      researcher verifies the exact flag names against the CLI's monitoring
      documentation; if request/response body events turn out not to be
      emittable by the current CLI, that is reported as a finding and the
      context view is built from the best content the flags do provide.
- [ ] The collector stores and serves what those events carry, so the UI can
      ask for the context belonging to a point in time; content-bearing
      records are exposed over the JSON API like the existing signals.
- [ ] Opening a session in the argus UI lands on the timeline view. The
      previous technical views (event tail, traces, raw inspectors) remain
      reachable from it, subordinate to the timeline — not the other way
      round.
- [ ] The timeline draws one lane for the main session and one lane per
      subagent, each agent lane spanning that agent's lifetime, so "which
      agents are running at this moment" is answered by looking at any
      vertical slice.
- [ ] Each lane shows its activity over time (tool calls, API requests) and,
      as a curve or area behind it, the context size over time, so growth in
      token consumption is visible on the timeline itself without opening
      any detail.
- [ ] The timeline can be scrubbed backward and forward to any point of the
      recorded session, and offers a live mode that follows the newest data
      as it arrives; scrubbing away from the head leaves live mode, and a
      control returns to it.
- [ ] Selecting a lane at the chosen time shows that agent's (or the main
      session's) context as of that moment: the body of the nearest API
      request at or before that time, rendered as a structured message list —
      system prompt, user, assistant, tool call, tool result — each block
      collapsed to one line with its size, expandable to the exact full
      text.
- [ ] Selecting a lane at the chosen time also shows the tools that agent
      has used up to that moment, with tool name and the call's parameters,
      so "which tools, and what for" is answerable per agent and per time.
- [ ] Recordings made without the content flags are out of contract: no
      fallback rendering, no compatibility notice is required, and no test
      pins behavior for them (decision: no such recordings exist).
- [ ] `./test.sh` is green.

## Out of scope

- Reading session transcripts (JSONL) as a second data source. OTLP with the
  content flags is the single source.
- Backward compatibility with telemetry directories recorded before this
  change.
- Cross-session comparison on one timeline; the view shows one session.
- Any change to how the collector is started or discovered.

## Decisions

Recorded from the grilling interview, 2026-08-06:

1. **Data source: OTLP only, content flags on by default in `argus env`.**
   The human asked for the OTLP contents to be checked rather than assumed;
   the check (in `tools/argus/src/claude.mjs`, `store.mjs`) showed OTLP
   carries everything needed once the opt-in content flags are set, so the
   human chose to make them the default over an `--content` opt-in or a
   split default. Consequence: the whole conversation content lands in the
   gitignored telemetry directory; accepted, since argus is a local
   measurement tool and measuring is the point.
2. **The timeline is the central session view**, not an additional tab and
   not a full replacement that deletes the technical views: those remain
   reachable but subordinate. Chosen because the complaint is precisely that
   the overview drowns among technical views.
3. **Context is rendered as a structured, expandable message list** rather
   than as raw full text (or a toggle between both). One line + size per
   block collapsed, exact full text on expand — chosen so what fills the
   context is visible at a glance while every character stays reachable.
4. **The timeline itself draws lanes with activity blocks and a context-size
   curve per lane** — not bare activity lanes, not a single marker strip.
   Chosen because seeing where consumption explodes without clicking is the
   missing overview.
5. **No handling for recordings without content flags.** The human states no
   old recordings exist; the degradation question was dropped rather than
   decided, so nothing may test or promise behavior for that case.

## Assumptions taken as defaults (no explicit answer needed)

- "Real time" means the live mode above: the timeline follows the newest
  data, and scrubbing pauses the following. No playback-speed machinery is
  asked for.
- Subagent lanes depend on the telemetry attributing records to agents
  (`agent.name` and related attributes on spans/events). The researcher
  verifies what attribution actually arrives for subagent activity and
  request bodies; if the CLI attributes subagent traffic incompletely, the
  lanes show what is attributable and the gap is reported as a finding, not
  silently papered over.
- The UI work happens in `tools/argus-ui`, the collector/API work in
  `tools/argus`, matching the existing split (the collector stays headless).
