/**
 * The session timeline: one lane for the main session and one per subagent
 * instance, each spanning that agent's lifetime.
 *
 * This is the testable half of the view — pure functions over the payload of
 * `GET /api/sessions/:id/agents`, returning geometry and markup. Nothing here
 * touches `document`, `window` or `location`, so the whole view model can be
 * pinned without a DOM.
 */

import { esc, fmtClock, fmtDur, fmtNum, shortId } from './format.js';

/**
 * The technical views, unchanged in content and order — they are what used to
 * be the session's tabs, and they now open *below* the timeline instead of
 * replacing it.
 */
export const SUBORDINATE_VIEWS = [
  { id: 'overview', label: 'Overview' },
  { id: 'todos', label: 'Tasks' },
  { id: 'traces', label: 'Traces' },
  { id: 'events', label: 'Events' },
  { id: 'metrics', label: 'Metrics' },
  { id: 'raw', label: 'Attributes' },
];

/** No technical view open: a freshly opened session is the timeline alone. */
export const DEFAULT_VIEW = null;

/** A zero-duration lane still gets this much width, or an instant agent vanishes. */
const MIN_WIDTH_PCT = 0.4;
/** Pixels of indent per level of the agent tree. */
const INDENT_PX = 14;
/** How far up the agent chain a depth is walked before it is called deep enough. */
const MAX_DEPTH_WALK = 64;

const clampPct = (value) => Math.min(100, Math.max(0, value));

/** The lane's human label: the agent type without its namespace, or the lane kind. */
export function agentLabel(lane) {
  if (lane?.kind === 'main') return 'main session';
  if (lane?.kind === 'unattributed') return 'unattributed';
  const type = lane?.agentType;
  if (!type) return 'subagent';
  const segments = String(type).split(':');
  return segments[segments.length - 1] || String(type);
}

/**
 * How deeply nested a lane is. The main agent's id is never emitted as an
 * `agent_id`, so a `parentAgentId` matching no lane means "child of main" and
 * sits at depth 1; a subagent spawned by another subagent sits one deeper.
 */
function laneDepth(lane, lanes, seen = new Set()) {
  if (lane?.kind !== 'subagent') return 0;
  if (seen.size >= MAX_DEPTH_WALK) return 1;
  seen.add(lane.id);
  const parent = lane.parentAgentId
    ? lanes.find((other) => other.agentId && other.agentId === lane.parentAgentId)
    : null;
  // A cycle can only come from a malformed export, but it must not hang the page.
  if (!parent || seen.has(parent.id)) return 1;
  return 1 + laneDepth(parent, lanes, seen);
}

/**
 * Where one lane's bar sits in the window, as percentages, plus its depth.
 *
 * @param {object} lane one item of the `/agents` payload
 * @param {object[]} lanes every lane in the same panel, for the parent lookup
 * @param {{startMs: number, endMs: number}} window
 * @returns {{leftPct: number, widthPct: number, depth: number}}
 */
export function laneGeometry(lane, lanes = [], { startMs = 0, endMs = 0 } = {}) {
  // A window of zero width is what a session with a single instant span gives;
  // dividing by it would put NaN into every bar on the page.
  const total = Math.max(endMs - startMs, 1);
  const left = clampPct(((lane.firstMs - startMs) / total) * 100);
  const right = clampPct(((lane.lastMs - startMs) / total) * 100);
  return {
    leftPct: left,
    widthPct: Math.min(Math.max(right - left, MIN_WIDTH_PCT), 100),
    depth: laneDepth(lane, lanes),
  };
}

/** Every lane with its geometry attached, in the order the payload gave them. */
export function laneRows(items = [], window = { startMs: 0, endMs: 0 }) {
  return items.map((lane) => ({ ...lane, ...laneGeometry(lane, items, window) }));
}

/** The timeline panel: an axis, then one row per lane. */
export function timelineHtml(items = [], window = { startMs: 0, endMs: 0 }) {
  if (!items.length) {
    return `<div class="placeholder">
      No spans for this session, so there are no agent lanes to draw. Spans are the beta signal —
      set <code>CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1</code> and <code>OTEL_TRACES_EXPORTER=otlp</code>.
    </div>`;
  }

  const startMs = window?.startMs ?? 0;
  const endMs = window?.endMs ?? 0;
  const span = Math.max(endMs - startMs, 0);
  const ticks = [0, 0.25, 0.5, 0.75, 1]
    .map(
      (fraction) =>
        `<span class="axis-tick" style="left:${(fraction * 100).toFixed(2)}%">${esc(
          fmtClock(startMs + span * fraction),
        )}</span>`,
    )
    .join('');

  const rows = laneRows(items, { startMs, endMs })
    .map((lane) => {
      // Two instances of one agent type share a label, so the id rides along:
      // it is the only thing on screen that tells them apart.
      const id = lane.agentId ? `<span class="lane-id">${esc(shortId(lane.agentId, 10))}</span>` : '';
      return `<div class="lane-row" data-lane-id="${esc(lane.id)}">
        <span class="lane-label" style="padding-left:${lane.depth * INDENT_PX}px">
          <span class="name">${esc(agentLabel(lane))}</span>
          ${id}
          <span class="lane-spans">${esc(fmtNum(lane.spanCount))} spans</span>
        </span>
        <span class="lane-track">
          <span class="lane-bar" data-kind="${esc(lane.kind)}"
            style="left:${lane.leftPct.toFixed(3)}%;width:${lane.widthPct.toFixed(3)}%"></span>
        </span>
        <span class="lane-duration">${esc(fmtDur(lane.durationMs))}</span>
      </div>`;
    })
    .join('');

  return `<div class="panel" style="padding:12px">
    <div class="timeline">
      <div class="timeline-axis"><span></span><span class="axis-ticks">${ticks}</span><span></span></div>
      ${rows}
    </div>
  </div>`;
}

/** The strip of subordinate views, with the open one — if any — marked. */
export function viewStripHtml(openId = null, counts = {}) {
  const buttons = SUBORDINATE_VIEWS.map(
    (view) => `<button type="button" class="tab" role="tab" data-view="${view.id}"
      aria-selected="${openId === view.id}">${esc(view.label)}${
        counts[view.id] !== undefined ? `<span class="count">${esc(fmtNum(counts[view.id]))}</span>` : ''
      }</button>`,
  ).join('');
  return `<nav class="tabs" role="tablist">${buttons}</nav>`;
}
