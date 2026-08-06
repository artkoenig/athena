# Backlog — argus timeline UI

Issue: `docs/issues/2026-08-06-argus-timeline-ui/issue.md`
Written by the planner; rewritten in full on every planner call. Status is one
of `todo`, `done`, `blocked`, `dropped`.

## content-pipeline — Content flows from the CLI through the collector to the JSON API

**Status:** done

**Delivers:** A recording made through `argus env` carries conversation
content — user prompts, tool details, tool content, and the API
request/response bodies if the CLI can emit them — and the collector stores
those records and serves them over the JSON API like the existing signals.
After this increment, everything the timeline UI will later render is
retrievable by time and by agent from the API alone.

**Acceptance criteria:**
- `argus env` (both formats) includes the content flags by default: user
  prompts, tool details, tool content, and the flag(s) required for the CLI
  to emit `api_request_body`/`api_response_body` events. The exact flag names
  are verified against the CLI's monitoring documentation; if
  request/response body events turn out not to be emittable by the current
  CLI, that is reported as a finding and the later context view is built from
  the best content the flags do provide.
- The collector stores and serves what those events carry, so the UI can ask
  for the context belonging to a point in time; content-bearing records are
  exposed over the JSON API like the existing signals.
- Recordings made without the content flags are out of contract: no fallback
  handling, no compatibility notice, and no test pins behavior for them
  (decision: no such recordings exist). This binds every later increment as
  well; it is recorded here.

**Outcome:** Accepted after one correction round. Both open questions are
answered by measurement: the body events are emittable and now flow end to
end, and subagent attribution arrives as `query_source` (grammar
`agent:<source>:<name>`) with concurrent same-type agents distinguishable
only by span. The findings are in `researcher.md` (Increment 1) and
`reviewer.md`; the increments below are re-cut against them.

## timeline-landing — The timeline is the central session view, with one lane per agent

**Status:** todo

**Delivers:** Opening a session in the argus UI lands on a timeline view that
draws one lane for the main session and one per subagent, each lane spanning
that agent's lifetime. The previous technical views survive, reachable from
the timeline and subordinate to it. Along the way the UI stops advising a
flag that `argus env` now sets, a falsehood content-pipeline introduced.

**Acceptance criteria:**
- Opening a session in the argus UI lands on the timeline view. The previous
  technical views (event tail, traces, raw inspectors) remain reachable from
  it, subordinate to the timeline — not the other way round.
- The timeline draws one lane for the main session and one lane per subagent,
  each agent lane spanning that agent's lifetime, so "which agents are
  running at this moment" is answered by looking at any vertical slice.
- Two subagents of the same type running concurrently get two lanes, never
  one merged lane. (Content-pipeline measured that such agents share one
  `query_source` and are told apart only by span, so a lane keyed on the
  agent name alone silently merges them.)
- The UI no longer advises setting `OTEL_LOG_TOOL_DETAILS=1` (or any other
  flag `argus env` now sets by default) — that advice became false when the
  flags became the default.

**Open question this increment must answer** (a finding for the increments
after it): what marks a lane's start and end in the data the collector
serves. Content-pipeline measured a `claude_code.subagent_completed` event as
the natural end marker for a subagent, but the collector does not know that
event today; whether lane lifetimes come from it or from the records already
served is the researcher's call, reported as a finding.

## lane-density — Activity and context growth are visible on the lanes themselves

**Status:** todo

**Delivers:** Each lane carries its agent's activity over time and, behind
it, the context size over time, so where token consumption grows is visible
on the timeline without opening any detail.

**Acceptance criteria:**
- Each lane shows its activity over time (tool calls, API requests) and, as a
  curve or area behind it, the context size over time, so growth in token
  consumption is visible on the timeline itself without opening any detail.

## scrub-live — The timeline scrubs, and a live mode follows the head

**Status:** todo

**Delivers:** A time cursor the human can drag to any point of the recorded
session, and a live mode in which the timeline follows the newest data as it
arrives.

**Acceptance criteria:**
- The timeline can be scrubbed backward and forward to any point of the
  recorded session, and offers a live mode that follows the newest data as it
  arrives; scrubbing away from the head leaves live mode, and a control
  returns to it.

## context-inspector — Selecting a lane at a time shows that agent's context as a message list

**Status:** todo

**Delivers:** Selecting a lane at the chosen time opens that agent's (or the
main session's) context as of that moment, rendered as a structured,
expandable message list built from the nearest API request body at or before
that time.

**Acceptance criteria:**
- Selecting a lane at the chosen time shows that agent's (or the main
  session's) context as of that moment: the body of the nearest API request
  at or before that time, rendered as a structured message list — system
  prompt, user, assistant, tool call, tool result — each block collapsed to
  one line with its size, expandable to the exact full text.

## tool-usage — Selecting a lane at a time also shows the tools used up to that moment

**Status:** todo

**Delivers:** The same lane-at-time selection also answers "which tools, and
what for": every tool the agent has used up to that moment, with name and
call parameters. Closes the run with the full suite green.

**Acceptance criteria:**
- Selecting a lane at the chosen time also shows the tools that agent has
  used up to that moment, with tool name and the call's parameters, so
  "which tools, and what for" is answerable per agent and per time.
- `./test.sh` is green.
