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

**Status:** done

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

**Outcome:** Accepted on round 1 after one correction round (a test-coverage
gap on the landing behavior, closed with test cases only, no production
change). The open question this increment carried — what marks a lane's
start and end — is answered: a lane is a span, bounded by the first and last
content record carrying that `spanId`, read off the content index the
collector already serves; the main lane spans the session's own
`firstSeenMs`…`lastSeenMs`. The `claude_code.subagent_completed` end-marker
was later measured as a by-product of increment 3: it arrives as a plain log
record carrying the subagent's lane `spanId`. It stays unused and
unscheduled — no open criterion needs an exact lane end. Details in
`researcher.md` (Increments 2 and 3) and `reviewer.md`.

## lane-density — Activity and context growth are visible on the lanes themselves

**Status:** done

**Delivers:** Each lane carries its agent's activity over time and, behind
it, the context size over time, so where token consumption grows is visible
on the timeline without opening any detail.

**Acceptance criteria:**
- Each lane shows its activity over time (tool calls, API requests) and, as a
  curve or area behind it, the context size over time, so growth in token
  consumption is visible on the timeline itself without opening any detail.

**Outcome:** Accepted on round 2 after two correction rounds, each closing
one finding: first a wiring race in `loadTimeline` (a stale response could
paint another session's tool calls and permanently jam the fetch watermark —
fixed with a selection re-check and `mergeToolMarks`), then a test gap (the
marks' time-to-position mapping was unpinned; closed with test cases only,
no production change). The increment's live capture settled tool-call
attribution by measurement: `claude_code.tool_result` carries no name
attribution at all, but its `spanId` is exactly the owning lane's span, so a
tool call belongs to the lane whose span it carries and to the main lane
otherwise. Page state keeps only `{seq, timeMs, spanId}` per tool event,
fetched incrementally by `sinceSeq`; the tool payloads (name, parameters)
stay server-side, retrievable on demand. Details in `researcher.md`
(Increment 3) and `reviewer.md`.

## scrub-live — The timeline scrubs, and a live mode follows the head

**Status:** done

**Delivers:** A time cursor the human can drag to any point of the recorded
session, and a live mode in which the timeline follows the newest data as it
arrives.

**Acceptance criteria:**
- The timeline can be scrubbed backward and forward to any point of the
  recorded session, and offers a live mode that follows the newest data as it
  arrives; scrubbing away from the head leaves live mode, and a control
  returns to it.

**Outcome:** Accepted on round 1 after one correction round (a test-coverage
gap: the slider's input routing and the drag registration were unpinned —
deleting either wire left the suite green; closed with test cases only, no
production change). "The chosen time" now exists as page state: the cursor
is `state.cursor` (`{live, timeMs}`), a live cursor resolves to the window's
current head on every render, a scrubbed one pins an absolute moment
clamped into the session window, any scrub leaves live mode (head included),
and the Live control is the only way back. `resolveCursor` is a pure
function in `timeline.js`, importable by tests, and one resolution per
render keeps thumb, cursor line and readout in agreement. The cursor
overlay carries `pointer-events: none`, so it cannot swallow the lane
clicks the next increments add. Reviewer observations recorded, not
scheduled: a `refresh()` already in flight when a drag starts can still
replace the slider mid-drag (the scrubbed value survives), and arrow-key
scrubbing moves 1 ms per press. Details in `researcher.md` (Increment 4)
and `reviewer.md`.

## context-inspector — Selecting a lane at a time shows that agent's context as a message list

**Status:** blocked

**Delivers:** Selecting a lane at the chosen time opens that agent's (or the
main session's) context as of that moment, rendered as a structured,
expandable message list built from the nearest API request body at or before
that time. This is the increment that builds the lane-at-time selection
mechanism; tool-usage rides it.

**Acceptance criteria:**
- Selecting a lane at the chosen time shows that agent's (or the main
  session's) context as of that moment: the body of the nearest API request
  at or before that time, rendered as a structured message list — system
  prompt, user, assistant, tool call, tool result — each block collapsed to
  one line with its size, expandable to the exact full text.

**Outcome:** Blocked — the review refused it on round 2 with three findings
open, after both correction rounds were spent. In all three rounds the
reviewer's line-by-line reading found the production code meeting the
criterion; what stayed unverifiable was the wiring chain from the click to
the markup, and each round's mutation probes walked that chain one hop
further than the round before could see. Open at the end (all measured, each
leaving the suite at 175 pass, exit 0): the selected lane never has to reach
the panel (an empty panel for every lane, or a subagent lane headed as the
main session, fails nothing), the click's own fetch never has to repaint the
panel (a session with no further ingest stays on "Reading the context…"
forever), and the size on a collapsed line is never read (every block can
report 0). The criterion moved to context-pinning, which carried those three
gaps as explicit criteria and closed all of them. Details in `reviewer.md`
(Increment 5, rounds 0–2) and `researcher.md` (Increment 5).

## context-pinning — The lane-at-time context panel is verified end to end

**Status:** done

**Delivers:** Closes the criterion context-inspector left blocked. The
panel's production behavior already meets it by the reviewer's reading;
this increment makes the three still-unverifiable hops of the
click-to-markup chain fail a test when broken — restructuring where that is
what pinning takes — so the criterion is demonstrated instead of read off
the source. The three gaps are named exactly, with measured reproductions,
in `reviewer.md` under "Increment 5 — Round 2" (findings 1–3).

**Acceptance criteria:**
- Selecting a lane at the chosen time shows that agent's (or the main
  session's) context as of that moment: the body of the nearest API request
  at or before that time, rendered as a structured message list — system
  prompt, user, assistant, tool call, tool result — each block collapsed to
  one line with its size, expandable to the exact full text. (Carried
  unchanged from context-inspector; this increment now owns it.)
- The suite goes red when the panel is not drawn from the lane the reader
  selected: a panel that paints empty for every lane, and a subagent lane
  presented under the main session's heading, each fail a test (reviewer's
  finding 1, mutations M-A and M-C).
- The suite goes red when selecting a lane never repaints the panel after
  the fetch that click started has resolved — including on a session that
  receives no further ingest (reviewer's finding 2, mutation M-B).
- The suite goes red when a collapsed line's size is not that block's own
  measured size, when the head's total is not the body's own length, or when
  the collapsed one-line preview never reaches the markup (reviewer's
  finding 3, mutations M-D and M-E).

**Outcome:** Accepted on the first review with zero findings — the run's
first round-zero acceptance. All five mutations increment 5 left alive
(M-A…M-E) now fail a case, measured one at a time in a sandbox worktree,
along with seven of eight further variants the reviewer probed along the
same chain; the suite stands at 181 pass, exit 0
(`npm --prefix tools/argus-ui test`). The restructure the criteria permitted
is 37 production lines: the panel's whole input became the pure
`lanePanelInput` in `context.js`, importable by tests and pinned by value,
with `renderLanePanel` reduced to one flat call a source assertion can read;
no rendered byte changed. The repaint hop (M-B) and the page-side call are
pinned by sharpened source assertions — the measured honest ceiling for
DOM-only hops in a suite with no DOM and no dependencies. One hop of the
chain stays unread by the reviewer's own measurement (M-K': a correct render
whose markup never reaches the container leaves the suite green), recorded
as an observation, not a finding — the reviewer notes the pin is a one-line
addition for whoever touches that path next. Details in `researcher.md`
(Increment 6) and `reviewer.md` (Increment 6).

## tool-usage — Selecting a lane at a time also shows the tools used up to that moment

**Status:** done

**Delivers:** The same lane-at-time selection also answers "which tools, and
what for": every tool the agent has used up to that moment, with name and
call parameters. Rides the selection mechanism context-inspector built and
context-pinning verified end to end. Closes the run with the full suite
green.

**Acceptance criteria:**
- Selecting a lane at the chosen time also shows the tools that agent has
  used up to that moment, with tool name and the call's parameters, so
  "which tools, and what for" is answerable per agent and per time.
- `./test.sh` is green.

**Outcome:** Accepted on round 1 with zero findings, after one correction
round (round 0 found the increment-6 pin on the context panel's lane wiring
disarmed by the new single-assignment repaint; the correction re-armed it,
and the reviewer re-ran that mutation plus three more in a sandbox — all
four caught). Selecting a lane paints, under that lane's context, the tools
it had called by the cursor's moment, newest first, each row with name,
one-line preview, character count, and the parameters expandable
(pretty-printed, capped at a declared 2000 characters with the full size on
the row). Attribution follows increment 3's measured rule: a call belongs to
the lane whose `spanId` it carries, span-less calls to main, computed from
the same `spanLaneKeys` map the density badge uses. Verification: 45 page
cases pass, and `bash test.sh` reports `PASS: all 5 suites`, exit 0 —
nothing skipped. With this the run closes: every issue criterion is
delivered and demonstrated. Details in `researcher.md` (Increment 7) and
`reviewer.md` (Increment 7, rounds 0–1).
