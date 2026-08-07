# The timeline is the interface: drop the tabs and the tools box, filter the context panel

## Problem

`tools/argus-ui` grew the timeline (issue
`docs/issues/2026-08-06-argus-timeline-ui`, 7 increments) on top of an
interface that already had six technical tabs, and it kept them. A session's
detail pane is now four stacked things: the head with its chips, the timeline,
`#lane-panel` with two panels in it, and below that the tab nav over
`#tab-body`.

Three of those four have stopped earning their place.

1. **The tabs are dead weight.** Overview, Tasks, Traces, Events, Metrics and
   Attributes were the whole interface before the timeline existed. They are
   the pre-timeline way of asking the same questions, and the human does not
   use them any more. They cost roughly 600 lines in `app.js` and
   `timeline.js`, eight state fields, a `loadTabData()` that fetches
   `/api/traces`, `/api/events`, `/api/facets` and `/api/metrics` on every
   refresh, and the tests that pin them.

2. **The tools box under the timeline is redundant.** `renderLanePanel()`
   paints two panels into `#lane-panel`: the context panel from `context.js`
   and, under it, the tool list from `tools.js`. The tool list answers "what
   had this lane done by this moment" — but the context panel already carries
   every `tool_use` and `tool_result` block of the request that was in flight,
   and the lane bar already carries a tick mark per tool call. The box is a
   third telling of the same thing, and it is the reason `toolCallOf()` keeps
   up to `TOOL_PARAM_CHARS` (2000) characters of call parameters per tool call
   in page state — several megabytes across a long session, for a panel that
   is going away.

3. **The context panel is the good part, and it cannot be narrowed.**
   `contextBlocks()` splits a request body into every block it carries: the
   system prompt, each message part (`user`, `assistant`, `thinking`,
   `tool_use`, `tool_result`, `other`), and one block per remaining top-level
   field of the body — `tools` above all, measured at two-thirds of a real
   context. That completeness is the point, and it is also the problem: a real
   context is dozens of blocks, and a reader who wants to see what the *tools*
   array costs, or read the system prompt without scrolling past forty tool
   results, has no way to say so. Every block is always shown.

## Acceptance criteria

### The tabs go

- [ ] `DETAIL_VIEWS` and `renderDetailViews()` are gone from
      `public/timeline.js`, and no tab nav is rendered anywhere.
- [ ] Gone from `public/app.js`: `renderTabBody()`, `renderOverviewTab()`,
      `renderTodosTab()`, `renderTracesTab()`, `renderWaterfall()`,
      `renderSpanInspector()`, `renderEventsTab()`, `renderMetricsTab()`,
      `renderRawTab()`, `loadTabData()`, the helpers only they used (`kpi`,
      `formatValue`, `spanKind`, `spanNote`, `todoStatusChip`, `SPAN_KINDS`),
      the `#tab-body` container, and the state fields `tab`, `trace`,
      `selectedTraceId`, `selectedSpanId`, `events`, `eventFilters`,
      `metrics`, `facets`.
- [ ] Gone from the wiring in `wireEvents()`: the handlers for `[data-tab]`,
      `[data-trace]`, `[data-span]` and `[data-event-seq]`, the `change`
      handler for `event-filter` and `event-errors`, and the `event-search`
      branch of the `input` handler. The 15-second interval no longer repaints
      a tab body.
- [ ] `renderDetail()` no longer builds the `counts` object, and no refresh
      requests `/api/traces`, `/api/facets` or `/api/metrics`. The `/api/events`
      request that feeds the tool marks stays (see below).
- [ ] No unused import or dead helper is left behind in `app.js` or
      `timeline.js`, and the tests that pinned the removed views are removed
      with them rather than left skipped.
- [ ] `src/server.mjs` is unchanged: it proxies `/api/*` blindly and knows no
      route by name.

### The tools box goes, the tool marks stay

- [ ] `public/tools.js` and `test/tools.test.mjs` are deleted, and `app.js`
      imports neither `laneToolInput` nor `renderToolPanel`.
- [ ] `renderLanePanel()` paints only the context panel into `#lane-panel`.
- [ ] Everything else about tools on the timeline is untouched: the
      `data-kind="tool"` tick marks on the lane track, the `data-tools` count
      in each lane's meta, the `tool call` legend entry, and the incremental
      `/api/events?event=claude_code.tool_result` poll with its `sinceSeq`
      watermark.
- [ ] `toolCallOf()` keeps only what a mark needs — `seq`, `timeMs`, `spanId`
      — and no longer derives or holds `name`, `preview`, `text`, `chars` or
      `truncated`. `TOOL_PARAM_CHARS` and the `paramText()` helper go with it.
      `mergeToolMarks()` keeps its contract: duplicates dropped by `seq`, the
      watermark returned as the highest `seq` actually held, the input array
      untouched.

### The context panel gets a filter

- [ ] The panel head carries a dropdown — a `<details>` popover, no framework
      and no dependency — listing every block kind and every top-level field
      the currently shown request actually contains, one checkbox each, with
      the number of blocks behind that entry (e.g. `tool_result 12`).
- [ ] The list is in two labelled groups: **Blocks** first, holding the block
      kinds present (`assistant`, `other`, `raw`, `system`, `thinking`,
      `tool_result`, `tool_use`, `user`) sorted alphabetically; then
      **Fields**, holding the body's remaining top-level keys (`max_tokens`,
      `metadata`, `model`, `tools`, …) sorted alphabetically. Entries are
      labelled by the kind name and the field key verbatim, so `system` and
      `tools` read as one list.
- [ ] The dropdown holds two buttons, **all on** and **all off**. *All on*
      makes every entry visible. *All off* hides every entry the currently
      shown request contains.
- [ ] Unchecking an entry removes its blocks from the list below; checking it
      puts them back. Neither triggers a fetch: the filter is applied to the
      record the panel already holds, and `/api/content/at` is not called
      again.
- [ ] The selection is one page-wide state, held as the set of *hidden*
      entries. It survives a lane change, a scrub, a live refresh and a session
      change; it is not persisted and a page reload starts with everything
      visible. An entry never hidden is visible, which is what makes an entry
      that appears for the first time — a `thinking` block in a later request,
      a field an earlier body did not carry — arrive visible, including after
      *all off* was pressed on a request that did not contain it.
- [ ] An entry the current request does not contain is not listed, and its
      hidden state is remembered: scrubbing to a request that carries it again
      shows it still unchecked and its blocks still hidden.
- [ ] With nothing hidden, the head line reads as it does today
      (`210.114 chars · 34 blocks`). With something hidden it names both
      numbers — visible of total — for blocks and for characters, so the
      filter can never make a context look smaller than it is. The totals stay
      readable off `data-chars` and `data-blocks`; the visible counts arrive in
      data attributes of their own.
- [ ] With every entry hidden the panel keeps its `data-state="ready"` and
      shows a placeholder in place of the rows, saying every kind is hidden
      and where to turn them back on.
- [ ] The derivation and the markup are pure functions in `public/context.js`
      — no `document`, no `fetch`, no `location`, the contract
      `test/independence.test.mjs` guards — and only the click wiring lives in
      `app.js`.
- [ ] The filter's markup carries no `data-lane` attribute and its `<summary>`
      carries no `data-block`, so opening the dropdown neither toggles the lane
      selection nor a block's expansion.
- [ ] An open dropdown survives a repaint: a live refresh that re-renders
      `#lane-panel` does not snap it shut, the same way `state.expanded` keeps
      expanded blocks open today.

### The suite

- [ ] `npm --prefix tools/argus-ui test` is green, and every criterion above
      has at least one test that goes red when its behaviour is broken or
      removed.
- [ ] `./test.sh` is green.

## Out of scope

- `tools/argus`, the collector. Nothing here changes what is recorded or
  served; this is the interface half only.
- The timeline itself — lanes, curve, marks, scrub, live cursor. It stays as
  the seven increments delivered it, minus nothing.
- The session list, the top stat strip, the setup dialog and the token flow.
- Filtering the *timeline* (hiding lanes, filtering marks). This filter acts
  on the context panel's block list and nothing else.
- Persisting the filter across a page reload. Decided against: it would need
  `localStorage`, which the pure modules may not touch, so it would live
  untestable in `app.js`.
- Restoring any removed view later. If one is wanted back it is a new issue,
  and git holds the old code.

## Decisions

Each records an answer the human gave in the grilling interview of
2026-08-07, and what it was chosen over.

1. **The filter lists block kinds and top-level fields on one level.** The
   human's own example named `tools` and `system_prompt` in one breath, and in
   the code those sit on two levels: `system` is a block kind, `tools` is one
   key inside the catch-all `field` kind. Chosen over listing the eight kinds
   alone (which cannot single out `tools`) and over listing every label
   (which would split `tool call · Read` from `tool call · Bash` and grow the
   list with the session).

2. **The list shows only what the current request contains, with a count per
   entry.** Chosen over a fixed full list with absent entries greyed out: a
   list that names what is there tells the truth about the record on screen.
   The counts stay because the question behind the panel is how much each part
   costs.

3. **The selection is global and lasts until reload.** Chosen over resetting
   per session or per lane: hiding a kind is a preference, not a position.
   `state.expanded` and `state.cursor` reset on a session change because they
   are positions; this does not. Chosen over `localStorage` persistence for
   the purity reason recorded under Out of scope.

4. **The head names visible and total.** Chosen over leaving the head at the
   totals (which would say nothing about what the filter removed) and over
   showing the filtered numbers alone (which would make a filtered context
   look smaller than it is — the one question this panel exists to answer).

5. **The control is a dropdown with checkboxes and two buttons inside.** The
   human asked for this directly, over the three-state `all` chip that had
   been proposed: a chip row grows with the number of fields and pushes the
   block list down, a dropdown does not.

6. **Two groups, Blocks then Fields, alphabetical within each.** The human's
   "by type, and by name within the type" resolved to this rather than to
   ordering the kinds in conversation order (`system, user, assistant, …`),
   which is an order a reader has to know, or to one flat alphabetical list,
   which would put `model` between `assistant` and `other` with nothing to say
   they are different things.

7. **The tabs go out of the code, not just out of the view.** Chosen over
   leaving them unreachable but present, and over keeping Overview's KPI tiles
   as a permanent block: git holds the code, and the top stat strip already
   carries cost, tokens, llm calls, tool calls and errors.

8. **The tools box goes, its tick marks stay, and its ballast goes with the
   box.** Chosen over removing everything tool-related (which would take the
   marks that show *when* an agent worked off the lanes) and over removing the
   box alone (which would leave `toolCallOf` holding megabytes of call
   parameters nobody reads).
