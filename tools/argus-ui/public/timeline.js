/**
 * argus-ui — the timeline's decision logic, without a DOM.
 *
 * Everything here is a pure state transition or a tiny piece of geometry, so it
 * can be run by `node --test` (see `test/timeline.test.mjs`) while `app.js`,
 * which needs a browser, cannot be. The one DOM-aware function takes the root to
 * paint into as a parameter rather than reaching for `document`, which is what
 * lets the same file load in the page and in Node.
 *
 * It imports nothing and touches no global at import time, on purpose: adding a
 * DOM library would be a runtime dependency, and this project takes none.
 */

/** The wall clock a time view shows: HH:MM:SS.mmm, local time. */
export function fmtClock(ms) {
  if (!ms) return '–';
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(
    date.getSeconds(),
  ).padStart(2, '0')}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

/**
 * The view state a freshly opened session starts in: on its timeline, live, at
 * the main lane, with no technical view open. `atMs: 0` means "no moment chosen
 * yet" rather than the epoch — `pinToTimeline` reads it that way.
 */
export function freshSessionView() {
  return {
    timeline: null,
    slice: null,
    selectedLaneId: 'main',
    atMs: 0,
    live: true,
    technicalTab: null,
  };
}

/**
 * Fit lane and moment to a timeline that has just arrived. Mutates and returns
 * `view`, because it is the page's own state object.
 */
export function pinToTimeline(view, timeline) {
  const lanes = timeline?.lanes ?? [];
  if (!lanes.some((lane) => lane.id === view.selectedLaneId)) view.selectedLaneId = lanes[0]?.id ?? 'main';
  // In live mode the playhead follows the newest record, so an open session
  // keeps showing its present rather than freezing where it was first opened.
  if (view.live || !view.atMs) view.atMs = timeline.lastMs;
  // A window that has aged out from under a scrubbed moment must not leave the
  // playhead off the track.
  view.atMs = Math.min(Math.max(view.atMs, timeline.firstMs), timeline.lastMs);
  return view;
}

/** A scrub is an explicit "show me back then", so it leaves live mode. */
export function scrubTo(view, value) {
  view.live = false;
  // An `<input type="range">` hands its value over as a string.
  view.atMs = Number(value);
  return view;
}

/** The Live control: follow the newest record again. */
export function resumeLive(view) {
  view.live = true;
  view.atMs = view.timeline?.lastMs ?? view.atMs;
  return view;
}

/**
 * Clicking the open technical view closes it again, so the timeline can always
 * be got back to without leaving the session.
 */
export function toggleTechnicalTab(view, tab) {
  view.technicalTab = view.technicalTab === tab ? null : tab;
  return view;
}

/**
 * Where the playhead sits, in percent of the track. `null` when there is no axis
 * to scale by — a session covering a single instant would otherwise be a
 * division by zero.
 */
export function playheadPercent(timeline, atMs) {
  if (!timeline) return null;
  const total = timeline.lastMs - timeline.firstMs;
  if (!(total > 0)) return null;
  const clamped = Math.min(Math.max(atMs, timeline.firstMs), timeline.lastMs);
  return ((clamped - timeline.firstMs) / total) * 100;
}

/**
 * Repaint the scrub row in place — playhead, clock and mode control together.
 *
 * The row is repainted rather than re-rendered because a re-render would replace
 * the range input while it is being dragged. One function owns all three nodes:
 * the defect this replaces was a scrub handler that moved the playhead and the
 * clock but left the Live control claiming live mode, which on a finished
 * session nothing else ever came along to correct.
 *
 * `root` is anything with `querySelector` — `document` in the page. A missing
 * node is skipped, never an error.
 */
export function paintScrubRow(root, view) {
  const percent = playheadPercent(view.timeline, view.atMs);
  const playhead = root.querySelector('.lane-playhead');
  if (playhead && percent !== null) playhead.style.left = `${percent.toFixed(3)}%`;
  const clock = root.querySelector('.scrub-clock');
  if (clock) clock.textContent = fmtClock(view.atMs);
  const live = root.querySelector('.scrub-live');
  if (live) live.setAttribute('aria-pressed', String(view.live));
}

/**
 * Refreshes are held back while the pointer holds the scrubber: a refresh
 * re-renders the detail pane wholesale, which would replace the range input
 * under the pointer and kill the drag.
 */
export function createRefreshGate() {
  return { dragging: false, missed: false };
}

/**
 * The pointer has taken hold of the scrubber. A refresh already scheduled when
 * that happens counts as held back, because its timer would otherwise fire into
 * the drag.
 */
export function scrubGrabbed(gate, { refreshPending = false } = {}) {
  gate.dragging = true;
  if (refreshPending) gate.missed = true;
  return gate;
}

/** True when the caller must skip this refresh; it is remembered for the release. */
export function refreshHeldBack(gate) {
  if (!gate.dragging) return false;
  gate.missed = true;
  return true;
}

/** The pointer let go. Returns whether a refresh was missed and has to be run now. */
export function scrubReleased(gate) {
  const missed = gate.missed;
  gate.dragging = false;
  gate.missed = false;
  return missed;
}
