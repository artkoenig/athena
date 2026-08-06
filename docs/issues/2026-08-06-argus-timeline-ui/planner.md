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
