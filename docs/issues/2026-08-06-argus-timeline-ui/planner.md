# Planner handoff — argus timeline UI

## The cut

Six increments, against a budget of eight. Every acceptance criterion of the
issue lands in exactly one of them:

| Issue criterion | Increment |
| --- | --- |
| `argus env` includes the content flags by default | content-pipeline |
| Collector stores and serves content-bearing records over the JSON API | content-pipeline |
| Recordings without content flags are out of contract | content-pipeline (recorded there, binds the whole run) |
| Timeline is the landing view, technical views subordinate | timeline-landing |
| One lane for the main session, one per subagent, spanning lifetimes | timeline-landing |
| Activity plus context-size curve per lane | lane-density |
| Scrubbing plus live mode with return-to-live control | scrub-live |
| Lane-at-time selection shows the context as a message list | context-inspector |
| Lane-at-time selection shows tools used up to that moment | tool-usage |
| `./test.sh` is green | tool-usage (the closing increment; every increment still leaves the repo working) |

**Why this order.** The whole issue stands on two facts nobody has verified:
whether the current CLI can emit `api_request_body`/`api_response_body` at
all, and how completely subagent traffic is attributed. Both live in
content-pipeline, so it goes first — if the body events cannot be emitted,
the issue itself says the context view is built from the best content the
flags do provide, and I need that finding before the UI increments are
touched, because it may force a re-cut of context-inspector and lane-density.
The UI then builds outward: structure first (timeline-landing gives the lanes
and the navigation rework), then the data-dense rendering on those lanes
(lane-density), then the time cursor (scrub-live), then the two detail panels
that depend on "the chosen time" existing (context-inspector, tool-usage).

**Why these seams.** timeline-landing and lane-density could be one
increment, but they carry different risks: the first is a navigation and
layout change judged by where you land and what a vertical slice shows, the
second turns on a data question — what "context size over time" is computed
from — that content-pipeline's findings feed directly. Keeping the seam lets
the run learn from the first before committing the second. The two detail
panels (context-inspector, tool-usage) share a selection mechanism but not
their substance: parsing a request body into an expandable message list is
the heavy half, listing tool calls up to a time is the light half, and the
reviewer gets a readable diff for each. scrub-live sits before both because
"the chosen time" is what they select at.

**What I rejected.** A single big UI increment (everything after
content-pipeline at once) — too large to review and it wastes the chance to
re-cut after the attribution finding. A per-endpoint or per-file cut of the
collector work — that is a file list, not a deliverable; content-pipeline is
one change: content in, content served. A separate increment for the
"recordings without flags are out of contract" criterion — it is a
prohibition, not work; it is recorded in content-pipeline and binds every
increment after it.

**Where the criteria of the issue put questions on the researcher.** Two are
written into content-pipeline explicitly: the exact flag names for the body
events (verify against the CLI's monitoring documentation) and what agent
attribution actually arrives for subagent activity and request bodies. Their
answers are findings the later increments consume; if either comes back
short, the backlog gets re-cut, not silently absorbed.

## After increment 1

**Closed.** content-pipeline is `done` — the review accepted it on round 1
after one correction round (a test-coverage gap on `api_response_body`,
closed with test cases only, no production change).

**What the increment answered, and what that did to the cut.** The two
questions the whole plan hinged on came back answered by measurement, not
reading:

1. *The body events are emittable* (`OTEL_LOG_RAW_API_BODIES=1`), so the
   "if not emittable, build from the best the flags provide" hedge is dead
   everywhere downstream. context-inspector keeps its full criterion — the
   nearest request body exists and is served whole.
2. *Attribution is by `query_source`, not `agent.name`*, and two concurrent
   subagents of the same type share one `query_source`, told apart only by
   span. That retires timeline-landing's old hedge ("if attribution is
   incomplete, show what is attributable") — attribution is complete enough
   for lanes — and replaces it with a sharper criterion the measurement
   makes necessary: two concurrent same-type agents get two lanes, never one
   merged lane. Without that criterion, a lane keyed on the agent name would
   pass review and be wrong.

**One criterion added.** timeline-landing gains: the UI no longer advises
setting `OTEL_LOG_TOOL_DETAILS=1`. Content-pipeline made that advice false
(the flag is now on by default), the reviewer recorded it as blast radius and
deliberately left it for a UI increment, and timeline-landing is the first
increment that owns the UI. Leaving a known falsehood on screen through the
rest of the run would be churn later for silence now.

**One open question moved onto timeline-landing.** The issue never said what
bounds a lane's lifetime. Content-pipeline surfaced a candidate — a
`claude_code.subagent_completed` end-marker event the collector does not read
today — but whether lanes are bounded by it or by the records already served
is a code-facts question I cannot settle, so it is written into
timeline-landing for the researcher to answer and report.

**What I deliberately did not change.** The timeline-landing / lane-density
seam stays, though its original reason weakened: the data question behind
lane-density ("what is context size computed from") now has a measured answer
(per-request `body_length` over time, servable from the content metadata
index). The seam survives on size alone — timeline-landing already carries
the navigation rework plus lane derivation, likely across both packages, and
folding the density rendering in would make one increment too large to
review. scrub-live, context-inspector and tool-usage stand as cut; nothing
the increment showed touches their seams, and tool-usage got quiet good news
(tool calls arrive with `tool_input` under the now-default flags).

**What stays out.** The reviewer's remaining blast-radius notes — span-carried
tool content is unbudgeted and unstripped, `/api/events?search=` now walks
the bodies, and the 32 MB ingest cap versus the raised content limit — are
recorded, not scheduled: none violates an issue criterion and none has a
demonstrated failure. If a later increment trips over one of them, it enters
the backlog then, with that increment as its reason.

Budget: 1 of at most 8 increments spent; five remain planned, so the run fits
with room to split once more if a lane increment demands it.

## After increment 2

**Closed.** timeline-landing is `done` — the review accepted it on round 1
with zero findings, after one correction round whose whole content was test
cases (the landing behavior was correct but unpinned; no production file
changed in the correction).

**The open question it carried is answered.** The backlog asked this
increment what marks a lane's start and end. The answer, now recorded in the
increment's outcome: a lane is a span, bounded by the first and last content
record carrying that `spanId`, all read off the content index the collector
already serves in one request; the main lane is the exception and spans the
session's own `firstSeenMs`…`lastSeenMs`. The `claude_code.subagent_completed`
candidate stays deliberately unmeasured — whether it arrives as a log record
or a span event is unknown, settling it costs a live capture, and no open
criterion needs an exact lane end. If a later increment wants one, measuring
that event comes first; until then it is a note, not work.

**What I deliberately did not change.** All four open increments stand as
cut, in their order, with their criteria untouched. Nothing the increment
showed reaches their seams: lane-density's data question ("what is context
size computed from") was already answered after increment 1 (per-request
`bodyLength` on the content index); scrub-live still precedes the two detail
panels because "the chosen time" is what they select at; and the
context-inspector / tool-usage split still separates the heavy half (parsing
a body into a message list) from the light one. The increment also handed the
later ones quiet good news rather than new constraints: the lane derivation
and markup live as pure functions in a module `node --test` can import, so
the density, cursor and selection work has a tested surface to build on
instead of unpinnable page wiring — a fact for their researchers, not a
reason to re-cut.

**What stays out.** The reviewer's residual observations are recorded, not
scheduled, because none violates a criterion and none has a demonstrated
failure: the 2000-record content window truncating the oldest lanes of an
over-long session (increment 1's retention window, not a regression), the
empty-`spanId` merge (out of contract — `argus env` sets the trace flags, so
every content record carries a span), and the unpinned `case null` in the
tab-body switch (below the finding bar by the reviewer's own account). The
increment-1 blast-radius notes (span-carried tool content unbudgeted,
`search=` walking bodies, the 32 MB ingest cap) likewise stay out, unchanged.
If a later increment trips over any of these, it enters the backlog then,
with that increment as its reason.

Budget: 2 of at most 8 increments spent; four remain planned, so the run
still fits with room to split twice if the detail-panel increments demand it.
