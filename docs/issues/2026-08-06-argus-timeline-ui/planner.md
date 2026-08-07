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

## After increment 3

**Closed.** lane-density is `done` — the review accepted it on round 2, after
two correction rounds each closing one finding. Round-zero's finding was a
real wiring defect (a stale response could paint another session's tool calls
onto the lanes and permanently jam the incremental fetch watermark), fixed in
production code and pinned. Round 1's finding was a test gap only — nothing
tied an activity mark's position to the moment its activity happened, so a
constant position would have passed — closed with test cases, no production
line changed.

**What the increment measured, and what that does to the cut.** The
researcher ran a live capture, and three facts came back that the remaining
increments consume:

1. *Tool-call attribution is settled.* `claude_code.tool_result` carries no
   `query_source` and no `agent.name` — but its `spanId` is exactly the
   owning lane's span. So "which tools has this agent used" has an exact
   rule with no name matching: the tool events carrying that lane's span,
   with everything else falling to main. tool-usage inherits a measured
   answer where it might have carried an open question. That is a fact for
   its researcher, not a criterion change, so the criterion stands as
   written.
2. *The tool payloads are server-side on purpose.* The page keeps only
   `{seq, timeMs, spanId}` per tool event (the full `tool_input` would hold
   megabytes in page state); the names and parameters tool-usage must show
   remain on `/api/events`, fetchable on demand for one lane at one moment.
   Again a fact for the researcher, not a re-cut.
3. *One recorded unknown fell as a by-product:* `claude_code.subagent_completed`
   arrives as a plain log record carrying the subagent's lane `spanId` —
   increment 2 had left this deliberately unmeasured. I corrected the
   sentence in timeline-landing's outcome so the backlog stops asserting an
   unknown that is now known. It stays unused and unscheduled: no open
   criterion needs an exact lane end. Quietly measured alongside it: real
   token counts exist on `claude_code.api_request` (input and cache tokens,
   with attribution) — available if a later need arises, needed by no open
   criterion, recorded and not scheduled.

**What I deliberately did not change.** All three open increments stand as
cut, in their order, with their criteria untouched. scrub-live still precedes
the two detail panels because "the chosen time" is what they select at. The
context-inspector / tool-usage seam holds, and the increment confirmed it
rather than disturbing it: the two panels now visibly ride different data
paths (the inspector reads the stored request body the content index points
at; tool-usage reads the tool events on demand), so each remains a reviewable
diff of its own. The pure-function surface in `timeline.js` grew again
(density, marks, merge — all importable by `node --test`), so the cursor and
selection work keeps a tested base to build on; good news for their
researchers, not a reason to re-cut.

**What stays out.** The reviewer's observations stay recorded, not
scheduled, because none violates a criterion and none has a demonstrated
failure: the 2000-record ceilings (the content index's window from increment
1, and now the first tool-event fetch of a session taking only the newest
2000) truncate the oldest history of an over-long session — degradation at
scale within a fixed retention window, not a wrong drawing of what is
retained. The reviewer's in-checkout doubt about subagent tool attribution
(same `spanId` on a subagent's bodies and its tool results) is answered by
the researcher's capture, which measured exactly that identity; it needs no
scheduling. The earlier blast-radius notes (span-carried tool content
unbudgeted, `search=` walking bodies, the 32 MB ingest cap) stand unchanged.
If a later increment trips over any of these, it enters the backlog then,
with that increment as its reason.

Budget: 3 of at most 8 increments spent; three remain planned, so the run
still fits with room to split twice if a detail panel demands it.

## After increment 4

**Closed.** scrub-live is `done` — the review accepted it on round 1 after
one correction round whose whole content was test cases (the slider's input
routing and the drag registration were correct but unpinned: the reviewer
demonstrated in a sandbox that deleting either wire left the suite green;
no production file changed in the correction).

**What the increment delivered to the two panels.** "The chosen time" —
the precondition both remaining increments select at — now exists as page
state: `state.cursor` (`{live, timeMs}`), resolved through a pure
`resolveCursor` in `timeline.js` that live-follows the head or pins an
absolute clamped moment. Two facts land in the backlog's outcome because
the panel increments consume them: the cursor overlay carries
`pointer-events: none`, so the lane clicks the selection mechanism needs
cannot be swallowed by it (a hazard that would otherwise have surfaced as
a round-zero finding in increment 5); and one resolution per render is the
established discipline, so "as of the chosen moment" has a single source of
truth for a panel to read. Facts for the researchers, not criteria.

**One sentence added to context-inspector, no criterion changed.** Its
delivers-line now says explicitly that it builds the lane-at-time selection
mechanism and that tool-usage rides it. That was always the intent of the
order (the heavy half first), but with scrub-live done the seam between the
panels is now exactly "who builds the selection" — writing it down stops
increment 6's researcher from re-deciding it or building a second one. The
criteria of both increments stand exactly as cut: nothing increment 4
showed reaches their substance, and the review confirmed the diff touched
nothing belonging to the context or tool views.

**What I deliberately did not change.** The context-inspector / tool-usage
seam holds — the two panels still ride different data paths (the stored
request body the content index points at, versus the tool events fetched
on demand), so each remains a reviewable diff of its own, and their order
still puts the heavy half first while budget remains to split it if it
proves too large.

**What stays out.** Two new reviewer observations join the recorded-not-
scheduled list, because neither violates a criterion and neither has a
demonstrated failure: a `refresh()` already in flight when a drag starts
can still replace the slider mid-drag (the scrubbed value survives and a
second grab continues — browser-only, unreproducible in the harness), and
arrow-key scrubbing moves 1 ms per press (`step="1"` is what makes every
millisecond addressable; `Home`/`End`/`PageUp`/`PageDown` and the drag
reach any point). The earlier notes stand unchanged: the 2000-record
ceilings, span-carried tool content unbudgeted, `search=` walking bodies,
the 32 MB ingest cap, and the unused `subagent_completed` end-marker. If a
later increment trips over any of these, it enters the backlog then, with
that increment as its reason.

Budget: 4 of at most 8 increments spent; two remain planned, so the run
still fits with room to split twice if a detail panel demands it.

## After increment 5

**Closed.** context-inspector is `blocked` — the review refused it on round 2
with three findings open, after both correction rounds were spent. This is
the run's first block, and its shape matters for the re-cut: in all three
rounds the reviewer read the production code line by line and found it
meeting the criterion. What failed was never the panel; it was verifiability.
Each round's mutation probes walked the click-to-markup chain one hop further
— round 0 caught the renderer and the lane-to-query mapping, round 1 the
moment on the wire and the fetched record reaching page state, round 2 the
last stretch: the selected lane reaching the panel, the click's own repaint,
and the sizes arriving in the markup. Each correction round closed exactly
what was named and the next probe found the next hop. The chain was simply
longer than two correction rounds.

**The answer is a successor, not a drop.** context-pinning (new id; the old
one stays with the blocked increment) carries the parent criterion forward —
the issue's "lane-at-time selection shows the context as a message list" now
lands in context-pinning, so the criterion map in "The cut" is amended to
that extent — plus three explicit criteria, one per open finding, each
phrased as "the suite goes red when …" with the reviewer's measured mutations
as the reference. Dropping instead would mean reporting the issue's central
view undeliverable while the reviewer attests the code delivers it; the only
missing thing is proof, and the reviewer's round-2 section names exactly what
each test has to catch. That is small, bounded work with an unambiguous
done-condition, which is why it gets its own increment rather than being
folded into tool-usage: folding would hand increment 7's reviewer a diff
mixing a new feature with the repair of an old verdict, and a second refusal
would then take both down together.

**Why the block happened, for the next researcher.** The pattern that closed
findings in every round was the same: lift the hop out of the page module
into the pure, importable module and pin it by value; source-level grepping
over the page module never survived a mutation probe. The reviewer's round-2
text concedes that string assertions are what the harness can do over the
page module without a DOM — and then shows the current ones read too little.
So the open question I put on context-pinning's researcher: for each of the
three hops, decide whether it can be made value-testable (the reviewer
himself suggests lifting the lane lookup beside `laneContextInput`) or
whether a sharpened source assertion that would have caught the measured
mutation is the honest ceiling — and say which, per hop, in the handoff. What
I am not doing is prescribing the split; that is theirs.

**tool-usage stands, one sentence touched.** Its delivers-line now says the
mechanism it rides exists as built and is verified by context-pinning, so its
researcher neither rebuilds the selection nor waits on doubt about it. Its
criteria are unchanged, and it stays last: it carries the `./test.sh` green
criterion that closes the run. Order between the two: context-pinning first,
while the chain and the reviewer's mutation table are fresh, and so that
tool-usage's own panel work starts from a selection mechanism whose
verification discipline is already settled instead of inheriting the same
gap.

**What stays out.** The round-2 observations join the recorded-not-scheduled
list, none violating a criterion, none with a demonstrated failure: a live
refresh collapses expanded blocks when a newer request arrives (a test name
promises more than the code does there — worth tightening if context-pinning
touches that file anyway, not a criterion), the whole body refetched every
refresh cycle, and the `main`/`span`/`agent` parameter names agreeing across
the UI/collector boundary by reading only, since the project rule forbids a
cross-boundary test. The earlier notes stand unchanged: the 2000-record
ceilings, span-carried tool content unbudgeted, `search=` walking bodies,
the 32 MB ingest cap, the unused `subagent_completed` end-marker, the
mid-drag slider replacement, and 1 ms arrow-key steps.

Budget: 5 of at most 8 increments spent; two remain planned, so the run
still fits, with one increment of slack left — enough to split tool-usage
once if it demands it, and a reason to keep context-pinning as narrow as its
criteria.

## After increment 6

**Closed.** context-pinning is `done` — the review accepted it on the first
round with zero findings, the run's first round-zero acceptance. All five
mutations that blocked context-inspector (M-A…M-E) now fail a case, each
measured one at a time in a sandbox worktree, and seven of eight further
variants the reviewer probed along the same chain die too. The suite stands
at 181 pass, exit 0. The successor cut worked as intended: the issue's
"lane-at-time selection shows the context as a message list" criterion,
which context-pinning carried for its blocked parent, is delivered and
demonstrated, so the criterion map in "The cut" is now fully closed except
for tool-usage's two lines.

**What the increment settled beyond its criteria.** The block-and-repair arc
of increments 5 and 6 ends with a measured verification discipline, and that
is a fact tool-usage's researcher should hold before designing anything:
every finding across four rounds of review died the same way — the hop
lifted out of the page module into a pure, importable function and pinned by
value — while assertions over `app.js` source survived only once sharpened
to read the exact statement (the researcher's per-hop table in
`researcher.md`, Increment 6, says which of the two each hop honestly
takes, and the reviewer's acceptance confirms the split). tool-usage builds
a second panel on the same selection mechanism and will face the same
mutation probes; building it value-testable from the start is cheaper than
repeating the arc. That is history handed on, not an implementation order —
the researcher owns the design.

**What I deliberately did not change.** tool-usage stands as cut, its two
criteria untouched; the only edit is one word in its delivers-line
("verifies" became "verified") so it stops promising work that is now done.
No re-cut is warranted: nothing increment 6 showed reaches the substance of
"which tools, and what for" — the data path it rides (tool events fetched
on demand, attributed by `spanId` per increment 3's measurement) was settled
two increments ago, and the selection mechanism it renders under is now the
best-verified surface in the UI.

**What stays out.** One new reviewer observation joins the
recorded-not-scheduled list: M-K', the last unread hop of the click-to-markup
chain — a correct render whose markup never reaches the container leaves the
suite green. It is not scheduled because the accepted increment's criteria
defined the empty-panel case as mutations M-A and M-C and both now fail; it
is not forgotten because tool-usage's panel likely renders through the same
path, which puts that hop inside increment 7's own chain where its reviewer
will probe it — the reviewer already calls the pin a one-line addition for
whoever touches it next. Carried forward unchanged, still none violating a
criterion: the expansion set collapsing when a live refresh lands a newer
record, the whole body refetched every refresh cycle, the cross-boundary
parameter names agreeing by reading only, the 2000-record ceilings,
span-carried tool content unbudgeted, `search=` walking bodies, the 32 MB
ingest cap, the unused `subagent_completed` end-marker, the mid-drag slider
replacement, and 1 ms arrow-key steps.

Budget: 6 of at most 8 increments spent; one remains planned, with one
increment of slack — enough to split tool-usage once if it proves larger
than it reads, and no reason to spend the slack pre-emptively.

## After increment 7

**Closed.** tool-usage is `done` — the review accepted it on round 1 with
zero findings, after one correction round. The reviewer's own words close
the run with it: "The increment is accepted, and with it the issue."
`bash test.sh` reports `PASS: all 5 suites`, exit 0, nothing skipped, so
the closing criterion this increment carried is met by measurement.

**The backlog is finished, not re-cut.** This was the last open increment;
with it done, every issue criterion in the map under "The cut" (as amended
after increment 5, when context-pinning took over the blocked
context-inspector's criterion) has landed in exactly one accepted
increment. There is nothing left to split, merge, reorder or sharpen, and
inventing an eighth increment to spend the slack would be work the issue
never asked for. The run ends at 7 of 8: six accepted increments and one
blocked-and-succeeded pair, which is the shape the backlog now records.

**What the round-0 finding confirmed, for the record.** The one correction
round was exactly the hazard the increment-6 outcome had flagged: the new
panel renders through the same click-to-markup path, and the first cut of
its single-assignment repaint disarmed the increment-6 pin on the context
panel's lane wiring (wiring the context panel to no lane went green). The
correction re-armed it, and the reviewer re-ran that mutation himself plus
three more — all four caught. The M-K' observation from increment 6 played
out as predicted there: the shared path fell inside increment 7's own
chain, where its reviewer probed it, rather than needing an increment of
its own.

**What stays out, at the end.** The recorded-not-scheduled list closes with
the run, none of its entries ever having violated a criterion or shown a
demonstrated failure. The two entries from this final review: the
parameters cap at a declared 2000 characters (the criterion asks for "the
call's parameters", not increment 6's "exact full text"; the cut is
printed, not silent), and a session holding more than 2000 tool results
never fetches the oldest ones (increment 3's poll and watermark, unchanged
by this diff). Carried from earlier, unchanged: the 2000-record content
ceilings, span-carried tool content unbudgeted, `search=` walking bodies,
the 32 MB ingest cap, the unused `subagent_completed` end-marker, the
mid-drag slider replacement, 1 ms arrow-key steps, the expansion set
collapsing on a live refresh, the whole body refetched every refresh
cycle, and the cross-boundary parameter names agreeing by reading only.
Any of these that matters later is a new issue, with this run's handoffs
as its evidence.

Budget: 7 of at most 8 increments spent, zero remaining. The run is
complete.
