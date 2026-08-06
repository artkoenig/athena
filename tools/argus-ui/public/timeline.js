/**
 * argus-ui — the session timeline.
 *
 * One lane for the main session and one per subagent, each spanning that
 * agent's lifetime. A lane is a *span*, never a name: two subagents of one type
 * running at once share their `query_source` and differ only by `spanId`, so
 * grouping by name would merge them into a single bar.
 *
 * Everything here is a pure function over the payloads of
 * `GET /api/sessions/<id>` and `GET /api/content` — no `document`, no `fetch`,
 * no `location` — which is what lets `node --test` import it directly.
 */

import { esc, fmtClock, fmtDur, fmtNum } from './format.js';

/** A bar narrower than this is invisible, so an instant of activity gets this much. */
export const MIN_LANE_WIDTH_PCT = 0.6;

/** The technical views, subordinate to the timeline and all still reachable. */
export const DETAIL_VIEWS = [
  { id: 'overview', label: 'Overview' },
  { id: 'todos', label: 'Tasks' },
  { id: 'traces', label: 'Traces' },
  { id: 'events', label: 'Events' },
  { id: 'metrics', label: 'Metrics' },
  { id: 'raw', label: 'Attributes' },
];

const usableTime = (record) => Number.isFinite(record?.timeMs) && record.timeMs > 0;

/**
 * Derive the lanes of a session from its content index.
 *
 * @param {{ session: object|null, content: object[] }} input
 * @returns {{ startMs: number, endMs: number, durationMs: number, lanes: object[] }}
 */
export function buildLanes({ session = null, content = [] } = {}) {
  const records = (Array.isArray(content) ? content : []).filter(usableTime);

  // The main session exists before its first API request and after its last, so
  // its lane is the session's own window; the records only ever extend it.
  const mainRecords = records.filter((record) => record.isSubagent !== true);
  const firstSeen = Number.isFinite(session?.firstSeenMs) && session.firstSeenMs > 0 ? session.firstSeenMs : null;
  const mainTimes = mainRecords.map((record) => record.timeMs);
  const mainStart = firstSeen ?? (mainTimes.length ? Math.min(...mainTimes) : 0);
  const mainEnd = Math.max(
    Number.isFinite(session?.lastSeenMs) ? session.lastSeenMs : mainStart,
    mainStart,
    ...mainTimes,
  );

  const mainLane = {
    key: 'main',
    kind: 'main',
    agent: null,
    spanId: null,
    label: 'main session',
    startMs: mainStart,
    endMs: mainEnd,
    records: mainRecords.length,
  };

  // One rule, no branch: a record with no span groups by name, and a record with
  // a span never merges with another span.
  const byKey = new Map();
  for (const record of records) {
    if (record.isSubagent !== true) continue;
    const key = `agent:${record.spanId ?? ''}:${record.agent ?? ''}`;
    const lane = byKey.get(key);
    if (!lane) {
      byKey.set(key, {
        key,
        kind: 'agent',
        agent: record.agent ?? null,
        spanId: record.spanId ?? null,
        label: record.agent || 'subagent',
        startMs: record.timeMs,
        endMs: record.timeMs,
        records: 1,
      });
      continue;
    }
    lane.startMs = Math.min(lane.startMs, record.timeMs);
    lane.endMs = Math.max(lane.endMs, record.timeMs);
    lane.records += 1;
  }

  const agentLanes = [...byKey.values()].sort(
    (a, b) => a.startMs - b.startMs || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );

  // Two agents of one type are two lanes; without a number on the label they are
  // told apart only in the DOM, which is no use to a reader.
  const labelCounts = new Map();
  for (const lane of agentLanes) labelCounts.set(lane.label, (labelCounts.get(lane.label) ?? 0) + 1);
  const seen = new Map();
  for (const lane of agentLanes) {
    if (labelCounts.get(lane.label) < 2) continue;
    const nth = (seen.get(lane.label) ?? 0) + 1;
    seen.set(lane.label, nth);
    lane.label = `${lane.label} #${nth}`;
  }

  const lanes = [mainLane, ...agentLanes];
  const startMs = Math.min(...lanes.map((lane) => lane.startMs));
  const endMs = Math.max(...lanes.map((lane) => lane.endMs));
  return { startMs, endMs, durationMs: Math.max(0, endMs - startMs), lanes };
}

/**
 * Where a lane's bar sits in the window, in percent.
 *
 * The `Math.max(1, …)` is what keeps a session with one instant of data from
 * dividing by zero and painting `NaN%` into a style attribute.
 */
export function laneGeometry(lane, window) {
  const span = Math.max(1, window.endMs - window.startMs);
  const leftPct = Math.min(100, Math.max(0, ((lane.startMs - window.startMs) / span) * 100));
  const rawWidth = Math.max(MIN_LANE_WIDTH_PCT, ((lane.endMs - lane.startMs) / span) * 100);
  const widthPct = Math.min(rawWidth, Math.max(MIN_LANE_WIDTH_PCT, 100 - leftPct));
  return { leftPct, widthPct };
}

/**
 * The timeline markup, from the result of `buildLanes`.
 *
 * @param {{ startMs: number, endMs: number, lanes: object[] }} view
 */
export function renderTimeline(view) {
  const lanes = view?.lanes ?? [];
  const window = { startMs: view?.startMs ?? 0, endMs: view?.endMs ?? 0 };
  const span = Math.max(0, window.endMs - window.startMs);

  const ticks = [0, 0.25, 0.5, 0.75, 1]
    .map((fraction) => `<span class="timeline-tick">${esc(fmtClock(window.startMs + span * fraction))}</span>`)
    .join('');

  const rows = lanes
    .map((lane) => {
      const { leftPct, widthPct } = laneGeometry(lane, window);
      return `<div class="lane" data-lane="${esc(lane.key)}" data-kind="${esc(lane.kind)}">
        <span class="lane-label" title="${esc(lane.label)}">${esc(lane.label)}</span>
        <span class="lane-track">
          <span class="lane-bar" data-kind="${esc(lane.kind)}"
            style="left:${leftPct.toFixed(3)}%;width:${widthPct.toFixed(3)}%"></span>
        </span>
        <span class="lane-meta">${esc(fmtDur(lane.endMs - lane.startMs))}</span>
      </div>`;
    })
    .join('');

  return `<div class="panel timeline-panel">
    <div class="timeline">
      <div class="timeline-axis"><span></span><span class="timeline-ticks">${ticks}</span><span></span></div>
      ${rows}
    </div>
  </div>`;
}

/**
 * The nav for the technical views. `selected: null` renders every view reachable
 * and none open, which is where a freshly opened session lands.
 */
export function renderDetailViews({ selected = null, counts = {} } = {}) {
  const buttons = DETAIL_VIEWS.map(
    (view) => `<button type="button" class="tab" role="tab" data-tab="${view.id}"
      aria-selected="${selected === view.id}">${esc(view.label)}${
        counts[view.id] !== undefined ? `<span class="count">${esc(fmtNum(counts[view.id]))}</span>` : ''
      }</button>`,
  ).join('');
  return `<nav class="tabs" role="tablist" aria-label="Technical views">${buttons}</nav>`;
}
