import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildLanes,
  laneGeometry,
  renderTimeline,
  DETAIL_VIEWS,
  renderDetailViews,
  buildDensity,
  contextPoints,
  areaPolygon,
  activityMarks,
  MIN_CURVE_WIDTH_PCT,
  ACTIVITY_BUCKETS,
  mergeToolMarks,
} from '../public/timeline.js';

// The two shapes every case builds its input from — nothing else.
const session = (over = {}) => ({ id: 's1', name: null, firstSeenMs: 1000, lastSeenMs: 5000, ...over });
const record = (over = {}) => ({
  seq: 1,
  timeMs: 1000,
  sessionId: 's1',
  traceId: 't',
  spanId: '',
  eventName: 'claude_code.api_request_body',
  querySource: 'sdk',
  agent: null,
  isSubagent: false,
  model: 'claude-sonnet-5',
  bodyLength: 10,
  bodyChars: 10,
  truncated: false,
  ...over,
});

// A main record plus three subagent records on one span — reused by several cases.
function threeRecordContent() {
  return [
    record({ seq: 1, timeMs: 1500 }),
    record({
      seq: 2,
      timeMs: 2000,
      spanId: 'sp-a',
      agent: 'code-reviewer',
      isSubagent: true,
      querySource: 'agent:custom:code-reviewer',
    }),
    record({
      seq: 3,
      timeMs: 2500,
      spanId: 'sp-a',
      agent: 'code-reviewer',
      isSubagent: true,
      querySource: 'agent:custom:code-reviewer',
    }),
    record({
      seq: 4,
      timeMs: 3000,
      spanId: 'sp-a',
      agent: 'code-reviewer',
      isSubagent: true,
      querySource: 'agent:custom:code-reviewer',
    }),
  ];
}

// A tool-result mark on one span — reused by the density cases.
const toolMark = (over = {}) => ({ seq: 1, timeMs: 2000, spanId: 'sp-a', ...over });

// Criterion 1 — opening a session lands on the timeline, the technical views stay
// reachable and subordinate.

test('the timeline names exactly six technical views, each with a label', () => {
  assert.equal(DETAIL_VIEWS.length, 6);
  const ids = DETAIL_VIEWS.map((view) => view.id);
  assert.deepEqual([...ids].sort(), ['events', 'metrics', 'overview', 'raw', 'todos', 'traces']);
  for (const view of DETAIL_VIEWS) {
    assert.ok(typeof view.label === 'string' && view.label.length > 0, `${view.id} must have a non-empty label`);
  }
});

test('opening a session with nothing selected offers every technical view and opens none', () => {
  const html = renderDetailViews({ selected: null, counts: {} });
  const tabIds = [...html.matchAll(/data-tab="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    [...tabIds].sort(),
    DETAIL_VIEWS.map((view) => view.id).sort(),
  );
  assert.ok(!html.includes('aria-selected="true"'), 'a freshly opened session must open no technical view');
});

test('selecting one technical view marks exactly that one as selected', () => {
  const html = renderDetailViews({ selected: 'events', counts: {} });
  const selectedCount = (html.match(/aria-selected="true"/g) ?? []).length;
  assert.equal(selectedCount, 1, 'exactly one view is open at a time');
  const eventsTagMatch = html.match(/<[^>]*data-tab="events"[^>]*>/);
  assert.ok(eventsTagMatch, 'the events button must be in the markup');
  assert.match(eventsTagMatch[0], /aria-selected="true"/, 'the selected view is the one that was asked for');
});

// Criterion 2 — one lane for the main session, one per subagent, each spanning its
// lifetime.

test('with no content the main lane still spans the whole session', () => {
  const result = buildLanes({ session: session(), content: [] });
  assert.equal(result.lanes.length, 1);
  const [main] = result.lanes;
  assert.equal(main.kind, 'main');
  assert.equal(main.key, 'main');
  assert.equal(main.agent, null);
  assert.equal(main.spanId, null);
  assert.equal(main.label, 'main session');
  assert.equal(main.startMs, 1000);
  assert.equal(main.endMs, 5000);
  assert.equal(result.startMs, 1000);
  assert.equal(result.endMs, 5000);
});

test('a subagent spanning three records on one span gets its own lane', () => {
  const result = buildLanes({ session: session(), content: threeRecordContent() });
  assert.equal(result.lanes.length, 2);
  assert.equal(result.lanes[0].kind, 'main', 'the main lane comes first');
  assert.equal(result.lanes[0].startMs, 1000);
  assert.equal(result.lanes[0].endMs, 5000);
  const agentLane = result.lanes[1];
  assert.equal(agentLane.kind, 'agent');
  assert.equal(agentLane.startMs, 2000);
  assert.equal(agentLane.endMs, 3000);
  assert.equal(agentLane.label, 'code-reviewer');
  assert.equal(agentLane.spanId, 'sp-a');
  assert.equal(agentLane.records, 3);
});

test('lane order does not depend on the order the api returned the records', () => {
  const ascending = buildLanes({ session: session(), content: threeRecordContent() });
  const descending = buildLanes({ session: session(), content: [...threeRecordContent()].reverse() });
  assert.deepEqual(descending, ascending);
});

test('a subagent active past the session end widens the window but not the main lane', () => {
  const content = [
    record({ seq: 1, timeMs: 6000, spanId: 'sp-a', agent: 'late-runner', isSubagent: true }),
    record({ seq: 2, timeMs: 7000, spanId: 'sp-a', agent: 'late-runner', isSubagent: true }),
  ];
  const result = buildLanes({ session: session(), content });
  assert.equal(result.endMs, 7000);
  const main = result.lanes.find((lane) => lane.kind === 'main');
  assert.equal(main.endMs, 5000, 'the main lane is not stretched to cover a subagent');
});

test('records with no usable time widen nothing and change no lane', () => {
  const base = buildLanes({ session: session(), content: threeRecordContent() });
  const noTime = record({ spanId: 'sp-a', agent: 'code-reviewer', isSubagent: true });
  delete noTime.timeMs;
  const noisy = [
    ...threeRecordContent(),
    record({ timeMs: 0, spanId: 'sp-a', agent: 'code-reviewer', isSubagent: true }),
    noTime,
  ];
  const withNoise = buildLanes({ session: session(), content: noisy });
  assert.deepEqual(withNoise, base, 'a record with no usable time must not change any lane');
});

test('lane geometry is exact at round numbers', () => {
  const window = { startMs: 0, endMs: 1000 };
  assert.deepEqual(laneGeometry({ startMs: 0, endMs: 1000 }, window), { leftPct: 0, widthPct: 100 });
  assert.deepEqual(laneGeometry({ startMs: 500, endMs: 1000 }, window), { leftPct: 50, widthPct: 50 });
});

test('a single-instant lane is still a visible bar that never overflows its track', () => {
  const window = { startMs: 0, endMs: 10000 };
  const { leftPct, widthPct } = laneGeometry({ startMs: 5000, endMs: 5000 }, window);
  assert.ok(widthPct >= 0.6, 'an instant of activity must still paint a visible bar');
  assert.ok(leftPct + widthPct <= 100, 'a bar must never overflow its track');
});

test('lane geometry stays finite and in range against a zero-length window', () => {
  const window = { startMs: 1000, endMs: 1000 };
  const { leftPct, widthPct } = laneGeometry({ startMs: 1000, endMs: 1000 }, window);
  assert.ok(Number.isFinite(leftPct), 'a session with one instant of data must not divide by zero into NaN');
  assert.ok(Number.isFinite(widthPct));
  assert.ok(leftPct >= 0 && leftPct <= 100);
  assert.ok(widthPct >= 0 && widthPct <= 100);
});

test('the rendered timeline carries one bar for the main session and one for the subagent, each with valid geometry', () => {
  const html = renderTimeline(buildLanes({ session: session(), content: threeRecordContent() }));
  const laneKeys = [...html.matchAll(/data-lane="([^"]*)"/g)].map((m) => m[1]);
  assert.equal(laneKeys.length, 2);
  assert.ok(laneKeys.includes('main'));
  assert.ok(laneKeys.some((key) => key.includes('sp-a')));

  const styles = [...html.matchAll(/style="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(styles.length > 0, 'at least the two lane bars carry a style attribute');
  for (const style of styles) {
    assert.match(style, /left:/);
    assert.match(style, /width:/);
    assert.doesNotMatch(style, /NaN/);
  }
});

test('a hostile agent label is escaped in the rendered timeline, never raw', () => {
  const content = [
    record({ seq: 1, timeMs: 2000, spanId: 'sp-a', agent: '<img src=x onerror=alert(1)>', isSubagent: true }),
  ];
  const html = renderTimeline(buildLanes({ session: session(), content }));
  assert.ok(!html.includes('<img'), 'a raw <img must never reach the DOM');
  assert.match(html, /&lt;img/, 'the escaped form must be present');
});

// Criterion 3 — two concurrent subagents of one type get two lanes.

test('two concurrent subagents of the same type get two lanes, told apart by span and numbered in the label', () => {
  const content = [
    record({ seq: 1, timeMs: 2000, spanId: 'sp-a', agent: 'general-purpose', isSubagent: true }),
    record({ seq: 2, timeMs: 3000, spanId: 'sp-a', agent: 'general-purpose', isSubagent: true }),
    record({ seq: 3, timeMs: 2200, spanId: 'sp-b', agent: 'general-purpose', isSubagent: true }),
    record({ seq: 4, timeMs: 3400, spanId: 'sp-b', agent: 'general-purpose', isSubagent: true }),
  ];
  const result = buildLanes({ session: session(), content });
  assert.equal(result.lanes.length, 3, 'main plus two agent lanes, never one merged lane');
  const agentLanes = result.lanes.filter((lane) => lane.kind === 'agent');
  assert.equal(agentLanes.length, 2);
  assert.notEqual(agentLanes[0].key, agentLanes[1].key);
  assert.ok(agentLanes[0].key.includes('sp-a'));
  assert.ok(agentLanes[1].key.includes('sp-b'));
  assert.equal(agentLanes[0].startMs, 2000);
  assert.equal(agentLanes[0].endMs, 3000);
  assert.equal(agentLanes[1].startMs, 2200);
  assert.equal(agentLanes[1].endMs, 3400);
  assert.equal(agentLanes[0].label, 'general-purpose #1');
  assert.equal(agentLanes[1].label, 'general-purpose #2');
});

test('the rendered timeline never merges two concurrent same-type subagents into one bar', () => {
  const content = [
    record({ seq: 1, timeMs: 2000, spanId: 'sp-a', agent: 'general-purpose', isSubagent: true }),
    record({ seq: 2, timeMs: 3000, spanId: 'sp-a', agent: 'general-purpose', isSubagent: true }),
    record({ seq: 3, timeMs: 2200, spanId: 'sp-b', agent: 'general-purpose', isSubagent: true }),
    record({ seq: 4, timeMs: 3400, spanId: 'sp-b', agent: 'general-purpose', isSubagent: true }),
  ];
  const html = renderTimeline(buildLanes({ session: session(), content }));
  const laneKeys = [...html.matchAll(/data-lane="([^"]*)"/g)].map((m) => m[1]);
  assert.equal(laneKeys.length, 3);
  assert.ok(laneKeys.some((key) => key.includes('sp-a')));
  assert.ok(laneKeys.some((key) => key.includes('sp-b')));
});

test('a lane is a span, not a record: two requests on one span still make one lane', () => {
  const content = [
    record({ seq: 1, timeMs: 2000, spanId: 'sp-a', agent: 'x', isSubagent: true }),
    record({ seq: 2, timeMs: 3000, spanId: 'sp-a', agent: 'x', isSubagent: true }),
  ];
  const result = buildLanes({ session: session(), content });
  assert.equal(result.lanes.length, 2, 'main lane plus exactly one agent lane');
});

test('two different agent names on different spans get two lanes with no disambiguation suffix', () => {
  const content = [
    record({ seq: 1, timeMs: 2000, spanId: 'sp-a', agent: 'alpha', isSubagent: true }),
    record({ seq: 2, timeMs: 2100, spanId: 'sp-b', agent: 'beta', isSubagent: true }),
  ];
  const result = buildLanes({ session: session(), content });
  const labels = result.lanes.filter((lane) => lane.kind === 'agent').map((lane) => lane.label);
  assert.deepEqual(labels.sort(), ['alpha', 'beta'], 'the suffix fires only where labels actually collide');
});

// Criterion 5 — activity and context growth on the lanes themselves.

test('an empty session still returns a density: no activity, no context, no peak', () => {
  const view = buildDensity(buildLanes({ session: session(), content: [] }), {});
  assert.equal(view.lanes.length, 1);
  assert.equal(view.maxBodyLength, 0);
  const [main] = view.lanes;
  assert.deepEqual(main.context, []);
  assert.deepEqual(main.activity, []);
  assert.equal(main.requests, 0);
  assert.equal(main.toolCalls, 0);
  assert.equal(main.peakBodyLength, 0);
});

test('requests land on the lane that made them', () => {
  const content = threeRecordContent();
  const view = buildDensity(buildLanes({ session: session(), content }), { content, tools: [] });
  const main = view.lanes.find((lane) => lane.kind === 'main');
  const agent = view.lanes.find((lane) => lane.kind === 'agent');
  assert.equal(main.requests, 1);
  assert.equal(agent.requests, 3);
  assert.equal(main.context.length, 1);
  assert.equal(agent.context.length, 3);
});

test('a tool call lands on the lane whose span it carries', () => {
  const content = threeRecordContent();
  const view = buildDensity(buildLanes({ session: session(), content }), {
    content,
    tools: [toolMark({ spanId: 'sp-a', timeMs: 2200 })],
  });
  const main = view.lanes.find((lane) => lane.kind === 'main');
  const agent = view.lanes.find((lane) => lane.kind === 'agent');
  assert.equal(agent.toolCalls, 1);
  assert.equal(main.toolCalls, 0);
});

test('a tool call on a span no lane owns belongs to the main session', () => {
  const content = threeRecordContent();
  const view = buildDensity(buildLanes({ session: session(), content }), {
    content,
    tools: [toolMark({ spanId: 'interaction-1' }), toolMark({ seq: 2, spanId: '' })],
  });
  const main = view.lanes.find((lane) => lane.kind === 'main');
  const agent = view.lanes.find((lane) => lane.kind === 'agent');
  assert.equal(
    main.toolCalls,
    2,
    'a tool call on the conversation span, not the agent tool span, belongs to the main lane',
  );
  assert.equal(agent.toolCalls, 0);
});

test('two concurrent agents of one type keep their own tool calls, never merged', () => {
  const content = [
    record({ seq: 1, timeMs: 2000, spanId: 'sp-a', agent: 'general-purpose', isSubagent: true }),
    record({ seq: 2, timeMs: 3000, spanId: 'sp-a', agent: 'general-purpose', isSubagent: true }),
    record({ seq: 3, timeMs: 2200, spanId: 'sp-b', agent: 'general-purpose', isSubagent: true }),
    record({ seq: 4, timeMs: 3400, spanId: 'sp-b', agent: 'general-purpose', isSubagent: true }),
  ];
  const view = buildDensity(buildLanes({ session: session(), content }), {
    content,
    tools: [toolMark({ spanId: 'sp-a', timeMs: 2500 }), toolMark({ seq: 2, spanId: 'sp-b', timeMs: 2600 })],
  });
  const agentLanes = view.lanes.filter((lane) => lane.kind === 'agent');
  assert.equal(agentLanes.length, 2);
  for (const lane of agentLanes) {
    assert.equal(lane.toolCalls, 1, `${lane.key} must keep only its own tool call, never the other agent's`);
  }
});

test('a response body is neither activity nor context', () => {
  const content = [
    record({ seq: 1, timeMs: 1500 }),
    record({ seq: 2, eventName: 'claude_code.api_response_body', timeMs: 2600, bodyLength: 900 }),
  ];
  const view = buildDensity(buildLanes({ session: session(), content }), { content, tools: [] });
  const main = view.lanes.find((lane) => lane.kind === 'main');
  assert.equal(main.requests, 1);
  assert.equal(main.context.length, 1, 'a response body must not add a second context point');
  const activityTotal = main.activity.reduce((sum, mark) => sum + mark.count, 0);
  assert.equal(activityTotal, 1, 'a response body must contribute no activity mark');
});

test('the curve is scaled across the whole session, not per lane', () => {
  const content = [
    record({ seq: 1, timeMs: 1500, bodyLength: 100000 }),
    record({ seq: 2, timeMs: 2000, spanId: 'sp-a', agent: 'x', isSubagent: true, bodyLength: 25000 }),
  ];
  const view = buildDensity(buildLanes({ session: session(), content }), { content, tools: [] });
  assert.equal(view.maxBodyLength, 100000);
  const main = view.lanes.find((lane) => lane.kind === 'main');
  const agent = view.lanes.find((lane) => lane.kind === 'agent');
  assert.equal(main.context[0].y, 0, 'the session-wide peak sits at the top of the curve');
  assert.equal(agent.context[0].y, 75, 'a quarter of the peak sits three quarters down');
  assert.equal(main.peakBodyLength, 100000);
  assert.equal(agent.peakBodyLength, 25000);
});

test('a session whose requests all report no size still yields a drawable curve', () => {
  const content = [
    record({ seq: 1, timeMs: 1500, bodyLength: 0 }),
    record({ seq: 2, timeMs: 3000, bodyLength: 0 }),
  ];
  const view = buildDensity(buildLanes({ session: session(), content }), { content, tools: [] });
  const main = view.lanes.find((lane) => lane.kind === 'main');
  assert.equal(main.context.length, 2);
  for (const point of main.context) {
    assert.equal(point.y, 100, 'with no size reported anywhere the curve must not divide by zero');
    assert.ok(Number.isFinite(point.x));
  }
});

test('contextPoints places a record by time inside the window, exact at round numbers', () => {
  const window = { startMs: 1000, endMs: 5000 };
  const points = contextPoints(
    [
      record({ seq: 1, timeMs: 1000, bodyLength: 10 }),
      record({ seq: 2, timeMs: 3000, bodyLength: 20 }),
      record({ seq: 3, timeMs: 5000, bodyLength: 20 }),
    ],
    window,
    20,
  );
  assert.deepEqual(points.map((point) => point.x), [0, 50, 100]);
  assert.deepEqual(points.map((point) => point.y), [50, 0, 0]);
});

test('contextPoints survives a zero-length window', () => {
  const window = { startMs: 1000, endMs: 1000 };
  const points = contextPoints(
    [record({ seq: 1, timeMs: 1000, bodyLength: 10 }), record({ seq: 2, timeMs: 1000, bodyLength: 20 })],
    window,
    20,
  );
  assert.equal(points.length, 2);
  for (const point of points) {
    assert.ok(Number.isFinite(point.x), 'a session with one instant of data must not divide by zero into NaN');
    assert.ok(Number.isFinite(point.y));
    assert.ok(point.x >= 0 && point.x <= 100);
    assert.ok(point.y >= 0 && point.y <= 100);
  }
});

test('the area closes on the baseline', () => {
  const points = [
    { x: 10, y: 40 },
    { x: 60, y: 90 },
  ];
  const polygon = areaPolygon(points);
  assert.ok(polygon.startsWith('10.000,100.000'), 'the area must start on the baseline under the first point');
  assert.ok(polygon.endsWith(',100.000'), 'the area must close back onto the baseline');
  assert.match(polygon, /40\.000/, 'the first point\'s y must be present');
  assert.match(polygon, /90\.000/, 'the second point\'s y must be present');
  assert.doesNotMatch(polygon, /NaN/);
});

test('a single request is still a visible area, not a zero-width line', () => {
  const polygon = areaPolygon([{ x: 10, y: 50 }]);
  const vertices = polygon.split(' ').filter(Boolean);
  assert.equal(vertices.length, 4, 'a single point must still close into a four-vertex plateau');
  const lastX = Number(vertices[vertices.length - 1].split(',')[0]);
  assert.ok(lastX >= 10 + MIN_CURVE_WIDTH_PCT, 'the plateau must be at least MIN_CURVE_WIDTH_PCT wide');
  assert.ok(lastX <= 100, 'the plateau must never overflow the track');
});

test('no requests, no polygon', () => {
  assert.equal(areaPolygon([]), '');
});

test('activity in one bucket is one mark carrying its count', () => {
  const window = { startMs: 1000, endMs: 5000 };
  const marks = activityMarks(
    [
      { timeMs: 2000, kind: 'request' },
      { timeMs: 2001, kind: 'request' },
    ],
    window,
  );
  assert.equal(marks.length, 1);
  assert.equal(marks[0].kind, 'request');
  assert.equal(marks[0].count, 2);
});

test('a tool call and an API request at the same moment stay two marks', () => {
  const window = { startMs: 1000, endMs: 5000 };
  const marks = activityMarks(
    [
      { timeMs: 2000, kind: 'request' },
      { timeMs: 2000, kind: 'tool' },
    ],
    window,
  );
  assert.equal(marks.length, 2, 'a request and a tool call at the same moment must not collapse into one mark');
  assert.equal(marks[0].leftPct, marks[1].leftPct);
  assert.deepEqual(
    marks.map((mark) => mark.kind).sort(),
    ['request', 'tool'],
  );
});

test('the marks are bounded however many records arrive, and lose none', () => {
  const window = { startMs: 1000, endMs: 5000 };
  const items = [];
  for (let i = 0; i < 500; i++) {
    items.push({ timeMs: window.startMs + (i / 500) * (window.endMs - window.startMs), kind: 'request' });
  }
  const marks = activityMarks(items, window);
  assert.ok(marks.length <= ACTIVITY_BUCKETS, 'a 2000-record session must not paint one element per record');
  const total = marks.reduce((sum, mark) => sum + mark.count, 0);
  assert.equal(total, 500, 'bucketing must lose no record');
});

test('a mark never leaves the track, even past the window end or against a zero-length window', () => {
  const window = { startMs: 1000, endMs: 5000 };
  const marks = activityMarks(
    [
      { timeMs: window.startMs, kind: 'request' },
      { timeMs: window.endMs, kind: 'request' },
      { timeMs: window.endMs + 1000, kind: 'request' },
    ],
    window,
  );
  for (const mark of marks) {
    assert.ok(
      mark.leftPct >= 0 && mark.leftPct < 100,
      'a mark must never sit at or past the right edge of the track',
    );
  }

  const zeroWindow = { startMs: 1000, endMs: 1000 };
  const zeroMarks = activityMarks([{ timeMs: 1000, kind: 'request' }], zeroWindow);
  for (const mark of zeroMarks) {
    assert.ok(Number.isFinite(mark.leftPct), 'a zero-length window must not divide by zero into NaN');
  }
});

test('the density is rendered behind the bar, not instead of it, for the lane it belongs to', () => {
  const content = threeRecordContent();
  const view = buildDensity(buildLanes({ session: session(), content }), {
    content,
    tools: [toolMark({ spanId: 'sp-a', timeMs: 2200 })],
  });
  const html = renderTimeline(view);
  const laneMatch = html.match(/data-lane="([^"]*sp-a[^"]*)"/);
  assert.ok(laneMatch, 'the agent lane must be present, keyed by its span');
  const laneStart = laneMatch.index;
  const nextLaneStart = html.indexOf('data-lane="', laneStart + 1);
  const row = nextLaneStart === -1 ? html.slice(laneStart) : html.slice(laneStart, nextLaneStart);

  const svgIdx = row.indexOf('<svg class="lane-curve"');
  assert.ok(svgIdx >= 0, 'the agent lane must carry a context curve');
  const barIdx = row.indexOf('<span class="lane-bar');
  assert.ok(barIdx >= 0, 'the agent lane must carry its bar');
  assert.ok(svgIdx < barIdx, 'the curve must sit behind the bar in the markup');

  const pointsMatch = row.match(/<polygon points="([^"]*)"/);
  assert.ok(pointsMatch, 'the curve must carry a points attribute');
  assert.ok(pointsMatch[1].length > 0);
  assert.doesNotMatch(row, /NaN/);
  assert.match(row, /data-kind="request"/, 'the three requests on this lane must leave a request mark');
  assert.match(row, /data-kind="tool"/, 'the tool call on this lane must leave a tool mark');
});

test('a lane with nothing on it renders as a bare lane', () => {
  const view = buildDensity(buildLanes({ session: session(), content: [] }), {});
  const html = renderTimeline(view);
  const laneCount = (html.match(/data-lane="/g) ?? []).length;
  assert.equal(laneCount, 1);
  assert.ok(!html.includes('lane-curve'), 'a lane with no requests must render no curve');
  assert.ok(!html.includes('lane-mark'), 'a lane with no activity must render no mark');
  assert.doesNotMatch(html, /NaN/);
});

test('the lane meta reports the size and the counts as data, not as a pinned sentence', () => {
  const content = threeRecordContent();
  const view = buildDensity(buildLanes({ session: session(), content }), {
    content,
    tools: [toolMark({ spanId: 'sp-a', timeMs: 2200 })],
  });
  const html = renderTimeline(view);
  const laneMatch = html.match(/data-lane="([^"]*sp-a[^"]*)"/);
  assert.ok(laneMatch, 'the agent lane must be present');
  const laneStart = laneMatch.index;
  const nextLaneStart = html.indexOf('data-lane="', laneStart + 1);
  const row = nextLaneStart === -1 ? html.slice(laneStart) : html.slice(laneStart, nextLaneStart);

  assert.match(row, /data-peak="10"/, 'the lane\'s largest body length, from the fixture, must be readable as data');
  assert.match(row, /data-requests="3"/);
  assert.match(row, /data-tools="1"/);
});

test('the timeline still renders from a bare buildLanes view, with no density attached', () => {
  const html = renderTimeline(buildLanes({ session: session(), content: threeRecordContent() }));
  const laneCount = (html.match(/data-lane="/g) ?? []).length;
  assert.equal(laneCount, 2, 'increment 2\'s call shape, renderTimeline(buildLanes(...)), must keep working');
  assert.doesNotMatch(html, /NaN/);
});

// Criterion 5, round 1 — the tool-mark index survives an overlapping refresh.

test('merging into an empty index keeps every item, and only the three fields a mark needs', () => {
  const result = mergeToolMarks(
    [],
    [
      { seq: 4, timeMs: 2000, spanId: 'sp-a', attrs: { tool_input: 'x'.repeat(100) } },
      { seq: 7, timeMs: 3000, spanId: 'sp-b' },
    ],
  );
  assert.deepEqual(result.marks, [
    { seq: 4, timeMs: 2000, spanId: 'sp-a' },
    { seq: 7, timeMs: 3000, spanId: 'sp-b' },
  ]);
  assert.equal(result.seq, 7);
});

test('an event already held is not counted twice', () => {
  const held = [{ seq: 4, timeMs: 2000, spanId: 'sp-a' }];
  const items = [
    { seq: 4, timeMs: 2000, spanId: 'sp-a' },
    { seq: 5, timeMs: 2100, spanId: 'sp-a' },
  ];
  const result = mergeToolMarks(held, items);
  assert.equal(result.marks.length, 2, 'the overlapping-refresh double count must not happen');
  assert.equal(result.marks.filter((mark) => mark.seq === 4).length, 1);
  assert.equal(result.marks.filter((mark) => mark.seq === 5).length, 1);
});

test('merging the same response twice changes nothing the second time', () => {
  const items = [
    { seq: 4, timeMs: 2000, spanId: 'sp-a', attrs: { tool_input: 'x'.repeat(100) } },
    { seq: 7, timeMs: 3000, spanId: 'sp-b' },
  ];
  const first = mergeToolMarks([], items);
  const second = mergeToolMarks(first.marks, items);
  assert.deepEqual(second.marks, first.marks);
  assert.equal(second.seq, first.seq);
});

test('the watermark is what is held, never what was seen', () => {
  const empty = mergeToolMarks([], []);
  assert.deepEqual(empty, { marks: [], seq: 0 });
  const held = mergeToolMarks([{ seq: 9, timeMs: 4000, spanId: 'sp-a' }], []);
  assert.equal(held.seq, 9, 'a watermark can never run ahead of the records behind it');
  assert.equal(held.marks.length, 1);
});

test('an item with no usable seq is dropped rather than held un-deduplicable', () => {
  const items = [
    { timeMs: 2000, spanId: 'sp-a' },
    { seq: null, timeMs: 2100, spanId: 'sp-a' },
    { seq: 'x', timeMs: 2200, spanId: 'sp-a' },
  ];
  const result = mergeToolMarks([], items);
  assert.deepEqual(result.marks, []);
  assert.equal(result.seq, 0);
});

test('merging does not mutate the index it was given', () => {
  const held = [{ seq: 1, timeMs: 1000, spanId: 'sp-a' }];
  const items = [
    { seq: 2, timeMs: 1100, spanId: 'sp-a' },
    { seq: 3, timeMs: 1200, spanId: 'sp-a' },
  ];
  const result = mergeToolMarks(held, items);
  assert.equal(held.length, 1, 'the array passed in must not be mutated');
  assert.notEqual(result.marks, held);
});

test('out-of-order items still leave the highest seq as the watermark', () => {
  const items = [
    { seq: 9, timeMs: 4000, spanId: 'sp-a' },
    { seq: 4, timeMs: 2000, spanId: 'sp-a' },
  ];
  const result = mergeToolMarks([], items);
  assert.equal(result.marks.length, 2);
  assert.equal(result.seq, 9, 'the watermark is the maximum seq held, not the last item merged');
});

test('a missing spanId becomes null rather than undefined', () => {
  const result = mergeToolMarks([], [{ seq: 3, timeMs: 2000 }]);
  assert.deepEqual(result.marks, [{ seq: 3, timeMs: 2000, spanId: null }]);
});

test('the merged index is what the density reads', () => {
  const content = threeRecordContent();
  const merged = mergeToolMarks([], [toolMark({ seq: 5, timeMs: 2200, spanId: 'sp-a' })]);
  const view = buildDensity(buildLanes({ session: session(), content }), {
    content,
    tools: merged.marks,
  });
  const agent = view.lanes.find((lane) => lane.kind === 'agent');
  assert.equal(agent.toolCalls, 1);
  const toolMarksOnLane = agent.activity.filter((mark) => mark.kind === 'tool');
  assert.equal(toolMarksOnLane.length, 1);
});
