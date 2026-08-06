/**
 * argus-ui — the session timeline.
 *
 * One lane for the main session and one per subagent, each spanning that
 * agent's lifetime. A lane is a *span*, never a name: two subagents of one type
 * running at once share their `query_source` and differ only by `spanId`, so
 * grouping by name would merge them into a single bar.
 *
 * Everything here is a pure function over the payloads of
 * `GET /api/sessions/<id>`, `GET /api/content` and `GET /api/events` — no
 * `document`, no `fetch`, no `location` — which is what lets `node --test`
 * import it directly.
 */

import { esc, fmtClock, fmtDur, fmtNum, previewOf } from './format.js';

/** A bar narrower than this is invisible, so an instant of activity gets this much. */
export const MIN_LANE_WIDTH_PCT = 0.6;

/** The log event a tool call leaves behind. Its span is the lane's span. */
export const TOOL_EVENT = 'claude_code.tool_result';

/** A tool call's parameters are kept up to this much text; beyond it, a size. */
export const TOOL_PARAM_CHARS = 2000;

/** The content record that *is* the context at that moment. */
export const REQUEST_EVENT = 'claude_code.api_request_body';

/** Activity is bucketed into this many columns, so 2000 records paint at most this many marks. */
export const ACTIVITY_BUCKETS = 120;

/** An area narrower than this is invisible, so a single request gets this much. */
export const MIN_CURVE_WIDTH_PCT = 0.6;

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

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

const sizeOf = (record) => (Number.isFinite(record?.bodyLength) ? record.bodyLength : 0);

const countLabel = ({ kind, count }) =>
  `${count} ${kind === 'tool' ? 'tool call' : 'API request'}${count === 1 ? '' : 's'}`;

/**
 * The one lane-key rule, in one place.
 *
 * A record with no span groups by name, and a record with a span never merges
 * with another span — which is what keeps two concurrent subagents of one type
 * two lanes rather than one.
 */
export function laneKeyOf(record) {
  if (record?.isSubagent !== true) return 'main';
  return `agent:${record.spanId ?? ''}:${record.agent ?? ''}`;
}

/**
 * The lane a key names, or none.
 *
 * One lookup for both panels: a context panel and a tool list that resolved the
 * same key differently would put one agent's tools under another agent's
 * context, and the reader could not tell. No key at all is no lane, which is how
 * both panels disappear when the selection is let go.
 */
export function laneByKey(view, key) {
  if (!key) return null;
  return (view?.lanes ?? []).find((lane) => lane.key === key) ?? null;
}

/**
 * Which lane each span belongs to — agent lanes by their own span, and nothing
 * else.
 *
 * A tool call carries the span of the conversation that made it, so this map
 * plus "the main lane otherwise" is the whole attribution rule: the one the
 * density counts with and the one the tool list is filtered by, so a lane's
 * `data-tools` count and the rows under it can never disagree.
 */
export function spanLaneKeys(lanes) {
  const bySpan = new Map();
  for (const lane of Array.isArray(lanes) ? lanes : []) {
    if (lane?.kind !== 'agent' || !lane.spanId) continue;
    if (!bySpan.has(lane.spanId)) bySpan.set(lane.spanId, lane.key);
  }
  return bySpan;
}

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

  const byKey = new Map();
  for (const record of records) {
    if (record.isSubagent !== true) continue;
    const key = laneKeyOf(record);
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
 * The context curve of one lane, as points in a 0…100 box.
 *
 * `y` is an SVG coordinate, so 100 is the baseline and 0 the top. The scale is
 * the session's own peak, passed in, never the lane's: a subagent's hill has to
 * read smaller than the main session's mountain, which is the whole point of
 * showing consumption over time.
 */
export function contextPoints(records, window, maxBodyLength) {
  const startMs = window?.startMs ?? 0;
  const span = Math.max(1, (window?.endMs ?? 0) - startMs);
  return (Array.isArray(records) ? records : [])
    .filter(usableTime)
    .slice()
    .sort((a, b) => a.timeMs - b.timeMs)
    .map((record) => ({
      x: clamp(((record.timeMs - startMs) / span) * 100, 0, 100),
      y: maxBodyLength > 0 ? clamp(100 - (sizeOf(record) / maxBodyLength) * 100, 0, 100) : 100,
    }));
}

/**
 * The `points` attribute of the area under a curve, closed on the baseline.
 *
 * A lane with a single request would otherwise be a zero-width line, so its
 * plateau is widened to `MIN_CURVE_WIDTH_PCT` — never past the right edge.
 */
export function areaPolygon(points) {
  const list = Array.isArray(points) ? points : [];
  if (!list.length) return '';
  const first = list[0];
  const last = list[list.length - 1];
  const vertices = [`${first.x.toFixed(3)},${(100).toFixed(3)}`];
  for (const point of list) vertices.push(`${point.x.toFixed(3)},${point.y.toFixed(3)}`);
  let endX = last.x;
  if (endX - first.x < MIN_CURVE_WIDTH_PCT) {
    endX = Math.min(100, first.x + MIN_CURVE_WIDTH_PCT);
    vertices.push(`${endX.toFixed(3)},${last.y.toFixed(3)}`);
  }
  vertices.push(`${endX.toFixed(3)},${(100).toFixed(3)}`);
  return vertices.join(' ');
}

/**
 * Activity marks for one lane, bucketed so a long session paints a bounded
 * number of elements and still loses no record.
 *
 * @param {{ timeMs: number, kind: 'request'|'tool' }[]} items
 */
export function activityMarks(items, window) {
  const startMs = window?.startMs ?? 0;
  const span = Math.max(1, (window?.endMs ?? 0) - startMs);
  const buckets = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (!usableTime(item)) continue;
    const bucket = clamp(
      Math.floor(((item.timeMs - startMs) / span) * ACTIVITY_BUCKETS),
      0,
      ACTIVITY_BUCKETS - 1,
    );
    const key = `${bucket}:${item.kind}`;
    const found = buckets.get(key);
    if (found) {
      found.count += 1;
      continue;
    }
    buckets.set(key, { leftPct: (bucket / ACTIVITY_BUCKETS) * 100, kind: item.kind, count: 1 });
  }
  return [...buckets.values()].sort(
    (a, b) => a.leftPct - b.leftPct || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0),
  );
}

/**
 * Attach what each lane did to the lanes `buildLanes` derived, leaving its
 * argument untouched.
 *
 * A request belongs to the lane that made it, by the same key rule the lanes
 * were built with. A tool call carries no attribution attribute at all — only
 * the span of the conversation that made it, which is exactly the lane's span —
 * so it lands on that lane, and on the main lane when the span owns none.
 *
 * @param {{ startMs: number, endMs: number, lanes: object[] }} view
 * @param {{ content?: object[], tools?: object[] }} sources
 */
export function buildDensity(view, { content = [], tools = [] } = {}) {
  const lanes = view?.lanes ?? [];
  const window = { startMs: view?.startMs ?? 0, endMs: view?.endMs ?? 0 };

  const requests = (Array.isArray(content) ? content : []).filter(
    (record) => record?.eventName === REQUEST_EVENT && usableTime(record),
  );
  const maxBodyLength = requests.reduce((peak, record) => Math.max(peak, sizeOf(record)), 0);

  const spanToLane = spanLaneKeys(lanes);

  // A key that matches no lane is dropped rather than inventing a lane:
  // `buildLanes` owns which lanes exist.
  const owned = new Map(lanes.map((lane) => [lane.key, { requests: [], tools: [] }]));
  for (const record of requests) owned.get(laneKeyOf(record))?.requests.push(record);
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (!usableTime(tool)) continue;
    owned.get(spanToLane.get(tool.spanId) ?? 'main')?.tools.push(tool);
  }

  return {
    ...view,
    maxBodyLength,
    lanes: lanes.map((lane) => {
      const own = owned.get(lane.key) ?? { requests: [], tools: [] };
      return {
        ...lane,
        context: contextPoints(own.requests, window, maxBodyLength),
        activity: activityMarks(
          [
            ...own.requests.map((record) => ({ timeMs: record.timeMs, kind: 'request' })),
            ...own.tools.map((tool) => ({ timeMs: tool.timeMs, kind: 'tool' })),
          ],
          window,
        ),
        requests: own.requests.length,
        toolCalls: own.tools.length,
        peakBodyLength: own.requests.reduce((peak, record) => Math.max(peak, sizeOf(record)), 0),
      };
    }),
  };
}

/** The parameters as text: pretty JSON when they parse, the string as it arrived otherwise. */
function paramText(raw) {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') return JSON.stringify(raw, null, 2) ?? '';
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return JSON.stringify(parsed, null, 2) ?? raw;
  } catch {
    // Not JSON: the string itself is what the call was made with.
  }
  return raw;
}

/**
 * One tool-result event turned into the row a panel draws: which tool, what it
 * was called with, and how much of that there was.
 *
 * The call carries no attribution of its own — only the span of the
 * conversation that made it — so `spanId` is what later decides whose lane it
 * belongs to. The parameters arrive as a JSON string under `tool_input`
 * (`tool_parameters` on CLI versions before 2.1) and are pretty-printed so the
 * row is readable.
 *
 * `chars` is the whole size and `text` is capped at TOOL_PARAM_CHARS: a single
 * Write call carries a file's entire content, and a session's worth of those
 * kept in page state is megabytes held for a line nobody reads to the end.
 * `truncated` says the two differ, so the panel can never imply it is showing
 * everything when it is not.
 */
export function toolCallOf(item) {
  const attrs = item?.attrs ?? {};
  const text = paramText(attrs.tool_input ?? attrs.tool_parameters);
  const name = typeof attrs.tool_name === 'string' && attrs.tool_name ? attrs.tool_name : 'tool';
  return {
    seq: item.seq,
    timeMs: item.timeMs,
    spanId: item.spanId ?? null,
    name,
    chars: text.length,
    preview: previewOf(text),
    text: text.slice(0, TOOL_PARAM_CHARS),
    truncated: text.length > TOOL_PARAM_CHARS,
  };
}

/**
 * Merge a page of tool events into the calls already held.
 *
 * Each event is projected through `toolCallOf`, so what is held is the row a
 * panel draws — the tool's name and its parameters capped at
 * `TOOL_PARAM_CHARS` — and never the whole event.
 *
 * The watermark comes back as the highest `seq` *held*, never as the highest
 * seen: a record that was not kept can then never be skipped as already seen,
 * which is what turns a stale or duplicated response into a no-op instead of a
 * permanent hole. Duplicates are dropped by `seq`, and the input array is left
 * untouched.
 *
 * @param {ReturnType<typeof toolCallOf>[]} marks
 * @param {object[]} items
 * @returns {{ marks: object[], seq: number }}
 */
export function mergeToolMarks(marks, items) {
  const held = Array.isArray(marks) ? marks : [];
  const merged = held.slice();
  const seen = new Set(held.map((mark) => mark?.seq));
  let seq = 0;
  for (const mark of held) if (Number.isFinite(mark?.seq) && mark.seq > seq) seq = mark.seq;
  for (const item of Array.isArray(items) ? items : []) {
    if (!Number.isFinite(item?.seq) || seen.has(item.seq)) continue;
    seen.add(item.seq);
    merged.push(toolCallOf(item));
    if (item.seq > seq) seq = item.seq;
  }
  return { marks: merged, seq };
}

/**
 * A cursor that follows the newest data. A fresh object every call: a shared
 * constant would be mutable-by-reference from the page.
 *
 * @returns {{ live: boolean, timeMs: null }}
 */
export function liveCursor() {
  return { live: true, timeMs: null };
}

/**
 * The cursor a scrub produces: a moment inside the window, and out of live mode.
 *
 * Landing exactly on the head is still a scrub. Live is a *following* mode, and
 * a moment a human parked on the current head must not silently start moving
 * when the next record arrives; the Live control is the only way back.
 */
export function scrubCursor(timeMs, window) {
  const startMs = window?.startMs ?? 0;
  const endMs = Math.max(startMs, window?.endMs ?? startMs);
  return { live: false, timeMs: clamp(Number.isFinite(timeMs) ? timeMs : endMs, startMs, endMs) };
}

/**
 * Where the cursor sits in a window, leaving the cursor it was given untouched.
 *
 * `live === false` is the only thing that is not live, so `null`, `undefined`
 * and `{}` all resolve live — which is what keeps `renderTimeline(view)`, the
 * call shape of increments 2 and 3, working with no cursor at all.
 *
 * @returns {{ live: boolean, timeMs: number, leftPct: number }}
 */
export function resolveCursor(cursor, window) {
  const startMs = window?.startMs ?? 0;
  const endMs = Math.max(startMs, window?.endMs ?? startMs);
  const live = cursor?.live !== false;
  const timeMs = live
    ? endMs
    : clamp(Number.isFinite(cursor?.timeMs) ? cursor.timeMs : endMs, startMs, endMs);
  const span = endMs - startMs;
  // A one-instant session puts the cursor on the head rather than at 0, so both
  // modes agree there and no division by zero can reach a style attribute.
  const leftPct = span > 0 ? clamp(((timeMs - startMs) / span) * 100, 0, 100) : 100;
  return { live, timeMs, leftPct };
}

/**
 * The timeline markup, from the result of `buildLanes` — or of `buildDensity`,
 * which only ever adds to it. The density is optional on purpose: a lane with
 * none renders as a bare bar rather than not at all.
 *
 * The cursor is resolved exactly once here, and the thumb, the line and the
 * readout all read that one result: two call sites computing a position
 * independently is how a thumb and a line drift apart.
 *
 * @param {{ startMs: number, endMs: number, lanes: object[] }} view
 * @param {{ live: boolean, timeMs: number|null }|null} cursor
 * @param {string|null} selectedKey the lane whose context is open, if any
 */
export function renderTimeline(view, cursor = null, selectedKey = null) {
  const lanes = view?.lanes ?? [];
  const window = { startMs: view?.startMs ?? 0, endMs: view?.endMs ?? 0 };
  const span = Math.max(0, window.endMs - window.startMs);

  const ticks = [0, 0.25, 0.5, 0.75, 1]
    .map((fraction) => `<span class="timeline-tick">${esc(fmtClock(window.startMs + span * fraction))}</span>`)
    .join('');

  const rows = lanes
    .map((lane) => {
      const { leftPct, widthPct } = laneGeometry(lane, window);
      const requests = lane.requests ?? 0;
      const toolCalls = lane.toolCalls ?? 0;
      const peak = lane.peakBodyLength ?? 0;
      const duration = fmtDur(lane.endMs - lane.startMs);

      // The curve is written before the bar so it sits behind it, not instead
      // of it; a lane with no requests gets no <svg> at all.
      const points = areaPolygon(lane.context ?? []);
      const curve = points
        ? `<svg class="lane-curve" data-kind="${esc(lane.kind)}" viewBox="0 0 100 100"
            preserveAspectRatio="none" aria-hidden="true"><polygon points="${esc(points)}"></polygon></svg>`
        : '';

      const marks = (lane.activity ?? [])
        .map(
          (mark) => `<span class="lane-mark" data-kind="${esc(mark.kind)}"
            style="left:${mark.leftPct.toFixed(3)}%" title="${esc(countLabel(mark))}"></span>`,
        )
        .join('');

      // The numbers live in data attributes so what a lane carries can be read
      // without reading a sentence.
      const meta = `<span class="lane-meta" data-peak="${esc(peak)}" data-requests="${esc(requests)}"
        data-tools="${esc(toolCalls)}" title="${esc(
          `${duration} · ${countLabel({ kind: 'request', count: requests })} · ${countLabel({
            kind: 'tool',
            count: toolCalls,
          })} · peak context ${fmtNum(peak)} chars`,
        )}">${esc(peak > 0 ? `${duration} · ${fmtNum(peak)}` : duration)}</span>`;

      // A real button, so selecting a lane works from the keyboard and reads as
      // a control to a screen reader — the pattern .span-row already follows.
      return `<button type="button" class="lane" data-lane="${esc(lane.key)}" data-kind="${esc(lane.kind)}"
        aria-current="${lane.key === selectedKey}">
        <span class="lane-label" title="${esc(lane.label)}">${esc(lane.label)}</span>
        <span class="lane-track">
          ${curve}<span class="lane-bar" data-kind="${esc(lane.kind)}"
            style="left:${leftPct.toFixed(3)}%;width:${widthPct.toFixed(3)}%"></span>${marks}
        </span>
        ${meta}
      </button>`;
    })
    .join('');

  // The range's min/max *are* the window in milliseconds and its value is the
  // cursor's own moment, so no fraction arithmetic sits between the control and
  // the model — and the page can read the window back off the element.
  const active = resolveCursor(cursor, window);
  const left = `left:${active.leftPct.toFixed(3)}%`;
  const scrub = `<div class="timeline-scrub">
        <span class="scrub-time" id="timeline-cursor-time" data-time="${esc(active.timeMs)}">${esc(fmtClock(active.timeMs))}</span>
        <input type="range" id="timeline-scrub" class="scrub-range" min="${esc(window.startMs)}" max="${esc(window.endMs)}" step="1" value="${esc(active.timeMs)}" aria-label="Time cursor">
        <button type="button" class="ghost-button scrub-live" data-cursor-live aria-pressed="${esc(active.live)}">Live</button>
      </div>`;

  return `<div class="panel timeline-panel">
    <div class="timeline">
      <div class="timeline-legend"><span data-kind="context">context size</span><span data-kind="request">API request</span><span data-kind="tool">tool call</span></div>
      ${scrub}
      <div class="timeline-axis"><span></span><span class="timeline-ticks">${ticks}</span><span></span></div>
      <div class="timeline-lanes">
        <div class="timeline-cursor" aria-hidden="true"><span class="timeline-ahead" data-cursor-pos style="${left}"></span><span class="timeline-cursor-line" data-cursor-pos style="${left}"></span></div>
        ${rows}
      </div>
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
