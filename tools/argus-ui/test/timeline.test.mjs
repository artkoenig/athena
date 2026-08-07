// Pins the timeline view model: that opening a session opens nothing but the
// timeline, that the previous technical views stay reachable but subordinate
// (the view strip), and how agent lanes are laid out — geometry, depth,
// labels — and rendered as markup. None of this touches a DOM: the module
// under test must not touch document, window or location at import time, and
// no case here uses one.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_VIEW,
  SUBORDINATE_VIEWS,
  viewStripHtml,
  timelineHtml,
  laneGeometry,
  agentLabel,
  activityMarks,
  contextAreaPoints,
  contextPeakOf,
  chosenTimePct,
  clampChosenTime,
  scrubStateHtml,
  laneRowsHtml,
  toolCallsUpTo,
  laneDetailHtml,
  MAX_LANE_TOOL_CALLS,
} from '../public/timeline.js';
import { fmtClock } from '../public/format.js';

const VIEW_IDS = ['overview', 'todos', 'traces', 'events', 'metrics', 'raw'];

/** A lane fixture, shaped like one item of `store.getAgents(sessionId).items`. */
function lane({
  id,
  kind,
  agentId = null,
  parentAgentId = null,
  agentType = null,
  firstMs = 0,
  lastMs = 0,
  activity = [],
  activityTotal = activity.length,
  context = [],
  contextPeak = context.reduce((max, sample) => Math.max(max, sample.length), 0),
}) {
  return {
    id,
    kind,
    agentId,
    parentAgentId,
    agentType,
    firstMs,
    lastMs,
    durationMs: lastMs - firstMs,
    spanCount: 1,
    activity,
    activityTotal,
    context,
    contextPeak,
  };
}

/** Every lane row's id and the geometry its bar carries, in markup order. */
function laneBars(html) {
  return [...html.matchAll(/data-lane-id="([^"]+)"[\s\S]*?class="lane-bar"[^>]*style="left:([\d.]+)%;width:([\d.]+)%"/g)]
    .map(([, id, left, width]) => ({ id, left: Number(left), width: Number(width) }));
}

/** The substring of `html` from `data-lane-id="<id>"` to the next `data-lane-id="` (or the end). */
function laneRow(html, id) {
  const start = html.indexOf(`data-lane-id="${id}"`);
  if (start === -1) return '';
  const next = html.indexOf('data-lane-id="', start + 1);
  return next === -1 ? html.slice(start) : html.slice(start, next);
}

/** Every `class="activity-mark"` element in `html`, with its kind and left percentage pulled out
 * regardless of attribute order. */
function activityMarkTags(html) {
  return [...html.matchAll(/<[^>]*class="activity-mark"[^>]*>/g)].map((match) => {
    const tag = match[0];
    return {
      tag,
      kind: (tag.match(/data-activity-kind="([^"]+)"/) || [])[1],
      leftPct: Number((tag.match(/left:([\d.]+)%/) || [])[1]),
    };
  });
}

/** Every `class="lane-playhead"` element's left percentage, as a Number. */
function playheads(html) {
  return [...html.matchAll(/<[^>]*class="lane-playhead"[^>]*>/g)].map((match) => {
    return Number((match[0].match(/left:([\d.]+)%/) || [])[1]);
  });
}

/* ------------------------------ landing on the timeline ------------------------------ */

test('DEFAULT_VIEW is null, so opening a session opens nothing but the timeline', () => {
  assert.equal(DEFAULT_VIEW, null);
});

test('SUBORDINATE_VIEWS still offers every previous technical view, in the old order', () => {
  assert.deepEqual(SUBORDINATE_VIEWS.map((view) => view.id), VIEW_IDS);
});

test('viewStripHtml(null, {}) selects nothing but still offers every view as a button', () => {
  const html = viewStripHtml(null, {});
  assert.ok(!html.includes('aria-selected="true"'));
  for (const id of VIEW_IDS) {
    assert.match(html, new RegExp(`data-view="${id}"`));
  }
});

test('viewStripHtml marks exactly the requested view as selected', () => {
  const html = viewStripHtml('events', {});
  assert.equal((html.match(/aria-selected="true"/g) || []).length, 1);
  const eventsButton = html.match(/<button[^>]*data-view="events"[^>]*>/)[0];
  assert.match(eventsButton, /aria-selected="true"/);
});

/* --------------------------------- lane geometry --------------------------------- */

test('a lane covering the middle half of the window gets left 25 and width 50', () => {
  const window = { startMs: 0, endMs: 1000 };
  const mid = lane({ id: 'main', kind: 'main', firstMs: 250, lastMs: 750 });
  const { leftPct, widthPct } = laneGeometry(mid, [mid], window);
  assert.equal(leftPct, 25);
  assert.equal(widthPct, 50);
});

test('a lane spanning past both edges of the window is clamped to the full width', () => {
  const window = { startMs: 1000, endMs: 2000 };
  const overflow = lane({ id: 'main', kind: 'main', firstMs: 0, lastMs: 5000 });
  const { leftPct, widthPct } = laneGeometry(overflow, [overflow], window);
  assert.equal(leftPct, 0);
  assert.equal(widthPct, 100);
});

test('a zero-width window still yields finite geometry, never NaN', () => {
  const window = { startMs: 1000, endMs: 1000 };
  const only = lane({ id: 'main', kind: 'main', firstMs: 1000, lastMs: 1000 });
  const { leftPct, widthPct } = laneGeometry(only, [only], window);
  assert.ok(Number.isFinite(leftPct));
  assert.ok(Number.isFinite(widthPct));
  const html = timelineHtml([only], window);
  assert.ok(!html.includes('NaN'));
});

test('a zero-duration lane keeps the 0.4 minimum width so an instant agent stays visible', () => {
  const window = { startMs: 0, endMs: 1000 };
  const instant = lane({ id: 'agent:agt-a', kind: 'subagent', agentId: 'agt-a', firstMs: 500, lastMs: 500 });
  const { widthPct } = laneGeometry(instant, [instant], window);
  assert.equal(widthPct, 0.4);
});

test('lane depth follows the parent chain: main and unattributed at 0, direct subagents at 1, nested ones at 2', () => {
  const window = { startMs: 0, endMs: 1000 };
  const main = lane({ id: 'main', kind: 'main', firstMs: 0, lastMs: 1000 });
  const subA = lane({
    id: 'agent:agt-a',
    kind: 'subagent',
    agentId: 'agt-a',
    parentAgentId: 'agt-main',
    agentType: 'agent:builtin:researcher',
    firstMs: 100,
    lastMs: 900,
  });
  const subB = lane({
    id: 'agent:agt-b',
    kind: 'subagent',
    agentId: 'agt-b',
    parentAgentId: 'agt-a',
    agentType: 'agent:builtin:helper',
    firstMs: 200,
    lastMs: 800,
  });
  const orphan = lane({ id: 'unattributed', kind: 'unattributed', firstMs: 0, lastMs: 1000 });
  const lanes = [main, subA, subB, orphan];
  assert.equal(laneGeometry(main, lanes, window).depth, 0);
  assert.equal(laneGeometry(subA, lanes, window).depth, 1);
  assert.equal(laneGeometry(subB, lanes, window).depth, 2);
  assert.equal(laneGeometry(orphan, lanes, window).depth, 0);
});

/* ----------------------------------- agentLabel ----------------------------------- */

test('agentLabel renders the agent type without its namespace prefix', () => {
  const sub = lane({ id: 'agent:agt-a', kind: 'subagent', agentId: 'agt-a', agentType: 'agent:builtin:researcher' });
  assert.equal(agentLabel(sub), 'researcher');
});

test('agentLabel falls back to "subagent" when the type is unknown', () => {
  const sub = lane({ id: 'agent:agt-a', kind: 'subagent', agentId: 'agt-a', agentType: null });
  assert.equal(agentLabel(sub), 'subagent');
});

test('agentLabel names the main lane "main session"', () => {
  const main = lane({ id: 'main', kind: 'main' });
  assert.equal(agentLabel(main), 'main session');
});

test('agentLabel names the unattributed lane "unattributed"', () => {
  const orphan = lane({ id: 'unattributed', kind: 'unattributed' });
  assert.equal(agentLabel(orphan), 'unattributed');
});

/* ----------------------------------- timelineHtml ----------------------------------- */

test('two lanes of the same agent type stay visually distinct by agent id', () => {
  const window = { startMs: 0, endMs: 1000 };
  const a = lane({
    id: 'agent:agt-a',
    kind: 'subagent',
    agentId: 'agt-a',
    agentType: 'agent:builtin:researcher',
    firstMs: 100,
    lastMs: 400,
  });
  const b = lane({
    id: 'agent:agt-b',
    kind: 'subagent',
    agentId: 'agt-b',
    agentType: 'agent:builtin:researcher',
    firstMs: 200,
    lastMs: 500,
  });
  const html = timelineHtml([a, b], window);
  assert.match(html, /agt-a/);
  assert.match(html, /agt-b/);
  assert.equal((html.match(/data-lane-id="/g) || []).length, 2);
});

test('an empty lane list renders a placeholder mentioning spans instead of a bare panel', () => {
  const html = timelineHtml([], { startMs: 0, endMs: 1000 });
  assert.match(html, /span/i);
});

test('a lane whose agent type contains markup is escaped in the rendered output', () => {
  const window = { startMs: 0, endMs: 1000 };
  const hostile = lane({
    id: 'agent:agt-x',
    kind: 'subagent',
    agentId: 'agt-x',
    agentType: '<script>x</script>',
    firstMs: 100,
    lastMs: 200,
  });
  const html = timelineHtml([hostile], window);
  assert.ok(!html.includes('<script'));
});

test('timelineHtml draws each lane at its own left and width, so a vertical slice tells the lanes apart', () => {
  const window = { startMs: 0, endMs: 1000 };
  const a = lane({
    id: 'agent:agt-a',
    kind: 'subagent',
    agentId: 'agt-a',
    agentType: 'agent:builtin:researcher',
    firstMs: 100,
    lastMs: 400,
  });
  const b = lane({
    id: 'agent:agt-b',
    kind: 'subagent',
    agentId: 'agt-b',
    agentType: 'agent:builtin:researcher',
    firstMs: 200,
    lastMs: 500,
  });
  const lanes = [a, b];
  const html = timelineHtml(lanes, window);
  assert.deepEqual(laneBars(html), [
    { id: 'agent:agt-a', left: 10, width: 30 },
    { id: 'agent:agt-b', left: 20, width: 30 },
  ]);
  for (const l of lanes) {
    const { leftPct, widthPct } = laneGeometry(l, lanes, window);
    const bar = laneBars(html).find((b) => b.id === l.id);
    assert.equal(bar.left, leftPct);
    assert.equal(bar.width, widthPct);
  }
});

test('timelineHtml clamps a lane overflowing the window to the full width and keeps an instant lane visible', () => {
  const window = { startMs: 0, endMs: 1000 };
  const overflow = lane({ id: 'main', kind: 'main', firstMs: -500, lastMs: 5000 });
  const instant = lane({ id: 'agent:agt-i', kind: 'subagent', agentId: 'agt-i', firstMs: 500, lastMs: 500 });
  const html = timelineHtml([overflow, instant], window);
  assert.deepEqual(laneBars(html), [
    { id: 'main', left: 0, width: 100 },
    { id: 'agent:agt-i', left: 50, width: 0.4 },
  ]);
});

test('timelineHtml indents each lane label by its depth, so a nested subagent reads as nested', () => {
  const window = { startMs: 0, endMs: 1000 };
  const main = lane({ id: 'main', kind: 'main', firstMs: 0, lastMs: 1000 });
  const subA = lane({
    id: 'agent:agt-a',
    kind: 'subagent',
    agentId: 'agt-a',
    parentAgentId: 'agt-main',
    agentType: 'agent:builtin:researcher',
    firstMs: 100,
    lastMs: 900,
  });
  const subB = lane({
    id: 'agent:agt-b',
    kind: 'subagent',
    agentId: 'agt-b',
    parentAgentId: 'agt-a',
    agentType: 'agent:builtin:helper',
    firstMs: 200,
    lastMs: 800,
  });
  const html = timelineHtml([main, subA, subB], window);
  const pairs = [...html.matchAll(/data-lane-id="([^"]+)"[\s\S]*?class="lane-label" style="padding-left:(\d+)px"/g)]
    .map(([, id, padding]) => [id, Number(padding)]);
  assert.deepEqual(pairs, [
    ['main', 0],
    ['agent:agt-a', 14],
    ['agent:agt-b', 28],
  ]);
});

/* -------------------------- activity marks and the context curve -------------------------- */

test('activity is placed at the time it occurred', () => {
  const window = { startMs: 0, endMs: 1000 };
  const l = lane({
    id: 'main',
    kind: 'main',
    firstMs: 0,
    lastMs: 1000,
    activity: [
      { atMs: 250, kind: 'tool' },
      { atMs: 750, kind: 'llm_request' },
    ],
  });
  const marks = activityMarks(l, window);
  assert.deepEqual(marks.map((m) => [m.leftPct, m.kind]), [
    [25, 'tool'],
    [75, 'llm_request'],
  ]);
});

test('an entry at atMs 0 or below is dropped, and out-of-window entries clamp to the window edges', () => {
  const zero = lane({
    id: 'main',
    kind: 'main',
    firstMs: 0,
    lastMs: 1000,
    activity: [
      { atMs: 0, kind: 'tool' },
      { atMs: -50, kind: 'tool' },
    ],
  });
  assert.deepEqual(activityMarks(zero, { startMs: 0, endMs: 1000 }), []);

  const window = { startMs: 1000, endMs: 2000 };
  const l = lane({
    id: 'main',
    kind: 'main',
    firstMs: 1000,
    lastMs: 2000,
    activity: [
      { atMs: 500, kind: 'tool' },
      { atMs: 5000, kind: 'llm_request' },
    ],
  });
  const marks = activityMarks(l, window);
  assert.deepEqual(marks.map((m) => m.leftPct), [0, 100]);
});

test("marks are drawn on their own lane's row", () => {
  const window = { startMs: 0, endMs: 1000 };
  const main = lane({
    id: 'main',
    kind: 'main',
    firstMs: 0,
    lastMs: 1000,
    activity: [{ atMs: 100, kind: 'llm_request', name: 'claude-opus-5' }],
  });
  const subA = lane({
    id: 'agent:agt-a',
    kind: 'subagent',
    agentId: 'agt-a',
    agentType: 'agent:builtin:researcher',
    firstMs: 300,
    lastMs: 700,
    activity: [
      { atMs: 400, kind: 'tool', name: 'Read' },
      { atMs: 600, kind: 'tool', name: 'Bash' },
    ],
  });
  const html = timelineHtml([main, subA], window);

  const mainRow = laneRow(html, 'main');
  const mainMarks = activityMarkTags(mainRow);
  assert.equal(mainMarks.filter((m) => m.kind === 'llm_request').length, 1);
  assert.equal(mainMarks.filter((m) => m.kind === 'tool').length, 0);

  const subRow = laneRow(html, 'agent:agt-a');
  const subMarks = activityMarkTags(subRow);
  assert.equal(subMarks.filter((m) => m.kind === 'tool').length, 2);

  const expectedMain = activityMarks(main, window).map((m) => Number(m.leftPct.toFixed(3)));
  const expectedSub = activityMarks(subA, window).map((m) => Number(m.leftPct.toFixed(3)));
  assert.deepEqual(mainMarks.map((m) => m.leftPct), expectedMain);
  assert.deepEqual(subMarks.map((m) => m.leftPct), expectedSub);
});

test('activity that resolves to no agent instance stays visible', () => {
  const window = { startMs: 0, endMs: 1000 };
  const main = lane({ id: 'main', kind: 'main', firstMs: 0, lastMs: 1000 });
  const subA = lane({
    id: 'agent:agt-a',
    kind: 'subagent',
    agentId: 'agt-a',
    agentType: 'agent:builtin:researcher',
    firstMs: 100,
    lastMs: 400,
  });
  const unattributed = lane({
    id: 'unattributed',
    kind: 'unattributed',
    firstMs: 0,
    lastMs: 1000,
    activity: [{ atMs: 500, kind: 'tool', name: 'Bash' }],
  });
  const html = timelineHtml([main, subA, unattributed], window);

  assert.equal(activityMarkTags(laneRow(html, 'unattributed')).length, 1);
  assert.equal(activityMarkTags(laneRow(html, 'main')).length, 0);
});

test("contextAreaPoints traces the curve's geometry", () => {
  const l = lane({
    id: 'main',
    kind: 'main',
    firstMs: 0,
    lastMs: 1000,
    context: [
      { atMs: 0, length: 100 },
      { atMs: 500, length: 200 },
      { atMs: 1000, length: 400 },
    ],
  });
  const points = contextAreaPoints(l, { startMs: 0, endMs: 1000 }, 400);
  assert.equal(points, '0.000,100.000 0.000,75.000 50.000,50.000 100.000,0.000 100.000,100.000');
});

test('contextAreaPoints returns nothing for an empty context or a zero peak', () => {
  const empty = lane({ id: 'main', kind: 'main', firstMs: 0, lastMs: 1000, context: [] });
  assert.equal(contextAreaPoints(empty, { startMs: 0, endMs: 1000 }, 400), '');

  const withSamples = lane({
    id: 'main',
    kind: 'main',
    firstMs: 0,
    lastMs: 1000,
    context: [{ atMs: 500, length: 100 }],
  });
  assert.equal(contextAreaPoints(withSamples, { startMs: 0, endMs: 1000 }, 0), '');
});

test('a single sample keeps a minimum-width instant curve visible', () => {
  const l = lane({
    id: 'main',
    kind: 'main',
    firstMs: 0,
    lastMs: 1000,
    context: [{ atMs: 500, length: 400 }],
  });
  const points = contextAreaPoints(l, { startMs: 0, endMs: 1000 }, 400);
  assert.equal(points, '50.000,100.000 50.000,0.000 50.400,0.000 50.400,100.000');
});

test('growth is readable, and lanes are comparable', () => {
  const window = { startMs: 0, endMs: 1000 };
  const small = lane({
    id: 'agent:agt-a',
    kind: 'subagent',
    agentId: 'agt-a',
    firstMs: 0,
    lastMs: 1000,
    context: [{ atMs: 500, length: 100 }],
    contextPeak: 100,
  });
  const big = lane({
    id: 'agent:agt-b',
    kind: 'subagent',
    agentId: 'agt-b',
    firstMs: 0,
    lastMs: 1000,
    context: [{ atMs: 500, length: 400 }],
    contextPeak: 400,
  });
  const items = [small, big];
  assert.equal(contextPeakOf(items), 400);

  const html = timelineHtml(items, window);

  const bigRow = laneRow(html, 'agent:agt-b');
  const bigPolygon = (bigRow.match(/<polygon points="([^"]*)"/) || [])[1];
  assert.ok(bigPolygon, 'expected a polygon in the high-consumption lane row');
  const bigYs = bigPolygon.trim().split(' ').map((pair) => Number(pair.split(',')[1]));
  assert.ok(bigYs.includes(0), 'the lane at the session peak must reach y 0');

  const smallRow = laneRow(html, 'agent:agt-a');
  const smallPolygon = (smallRow.match(/<polygon points="([^"]*)"/) || [])[1];
  assert.ok(smallPolygon, 'expected a polygon in the low-consumption lane row');
  const smallYs = smallPolygon.trim().split(' ').map((pair) => Number(pair.split(',')[1]));
  assert.equal(
    Math.min(...smallYs),
    75,
    'a lane consuming a quarter as much as the session peak must draw a quarter as high',
  );
});

test('the curve is drawn behind the activity, in the rendered markup', () => {
  const window = { startMs: 0, endMs: 1000 };
  const withCurve = lane({
    id: 'agent:agt-a',
    kind: 'subagent',
    agentId: 'agt-a',
    firstMs: 100,
    lastMs: 900,
    activity: [{ atMs: 300, kind: 'tool', name: 'Read' }],
    context: [{ atMs: 300, length: 100 }],
  });
  const noCurve = lane({ id: 'agent:agt-b', kind: 'subagent', agentId: 'agt-b', firstMs: 100, lastMs: 900 });
  const html = timelineHtml([withCurve, noCurve], window);

  const rowWithCurve = laneRow(html, 'agent:agt-a');
  const contextIndex = rowWithCurve.indexOf('class="lane-context"');
  const barIndex = rowWithCurve.indexOf('class="lane-bar"');
  const markIndex = rowWithCurve.indexOf('class="activity-mark"');
  assert.ok(contextIndex > -1, 'expected a lane-context element');
  assert.ok(contextIndex < barIndex, 'the curve must precede the lane bar');
  assert.ok(barIndex < markIndex, 'the lane bar must precede the activity mark');
  const polygon = (rowWithCurve.match(/<polygon points="([^"]*)"/) || [])[1];
  assert.ok(polygon && polygon.trim().length > 0, 'the polygon must carry points');

  const rowWithoutCurve = laneRow(html, 'agent:agt-b');
  assert.ok(!rowWithoutCurve.includes('class="lane-context"'), 'a lane with no samples must draw no curve');
});

test('the view names the measure', () => {
  const window = { startMs: 0, endMs: 1000 };
  const withContext = lane({
    id: 'main',
    kind: 'main',
    firstMs: 0,
    lastMs: 1000,
    context: [{ atMs: 500, length: 100 }],
  });
  const html = timelineHtml([withContext], window);
  assert.match(html, /request body length/i);
  assert.match(html, /characters/i);

  const empty = lane({ id: 'main', kind: 'main', firstMs: 0, lastMs: 1000 });
  const emptyHtml = timelineHtml([empty], window);
  assert.match(emptyHtml, /request bod/i);
  assert.ok(!emptyHtml.includes('<polygon'), 'a session with nothing to show must draw no curve');
});

test('per-lane growth is readable as a number', () => {
  const window = { startMs: 0, endMs: 1000 };
  const l = lane({
    id: 'main',
    kind: 'main',
    firstMs: 0,
    lastMs: 1000,
    activityTotal: 12,
    context: [{ atMs: 500, length: 90000 }],
    contextPeak: 90000,
  });
  const html = timelineHtml([l], window);
  const row = laneRow(html, 'main');
  assert.match(row, /90\.0k/);
  assert.match(row, /(?<!\d)12(?!\d)/);
});

test('the old lane shape without activity/context renders cleanly', () => {
  const window = { startMs: 0, endMs: 1000 };
  const oldShape = {
    id: 'main',
    kind: 'main',
    agentId: null,
    parentAgentId: null,
    agentType: null,
    firstMs: 0,
    lastMs: 1000,
    durationMs: 1000,
    spanCount: 1,
  };
  const html = timelineHtml([oldShape], window);
  const row = laneRow(html, 'main');
  assert.ok(!row.includes('class="activity-mark"'));
  assert.ok(!row.includes('class="lane-context"'));
  assert.ok(!html.includes('NaN'));
});

test('a hostile activity name is escaped in the rendered output', () => {
  const window = { startMs: 0, endMs: 1000 };
  const hostile = lane({
    id: 'main',
    kind: 'main',
    firstMs: 0,
    lastMs: 1000,
    activity: [{ atMs: 500, kind: 'tool', name: '<script>x</script>' }],
  });
  const html = timelineHtml([hostile], window);
  assert.ok(!html.includes('<script'));
});

/* ------- the chosen time, scrubbing and live mode ------- */

test('chosenTimePct places the chosen time against the shared window', () => {
  const window = { startMs: 0, endMs: 1000 };
  assert.equal(chosenTimePct(500, window), 50);
  assert.equal(chosenTimePct(0, window), 0);
  assert.equal(chosenTimePct(1000, window), 100);
});

test('chosenTimePct clamps to the window edges and stays finite for a zero-width window', () => {
  const window = { startMs: 0, endMs: 1000 };
  assert.equal(chosenTimePct(-50, window), 0);
  assert.equal(chosenTimePct(5000, window), 100);
  assert.ok(Number.isFinite(chosenTimePct(1000, { startMs: 1000, endMs: 1000 })));
});

test('clampChosenTime reaches any point of the recorded session and no other, parking a broken input at the head', () => {
  const window = { startMs: 0, endMs: 1000 };
  assert.equal(clampChosenTime(400, window), 400);
  assert.equal(clampChosenTime(-5, window), 0);
  assert.equal(clampChosenTime(9999, window), 1000);
  assert.equal(clampChosenTime('abc', window), 1000);
});

test('the chosen time is one shared value: every lane draws its playhead at the same left percentage', () => {
  const window = { startMs: 0, endMs: 1000 };
  const main = lane({ id: 'main', kind: 'main', firstMs: 0, lastMs: 1000 });
  const subA = lane({
    id: 'agent:agt-a',
    kind: 'subagent',
    agentId: 'agt-a',
    firstMs: 100,
    lastMs: 900,
  });
  const subB = lane({
    id: 'agent:agt-b',
    kind: 'subagent',
    agentId: 'agt-b',
    firstMs: 200,
    lastMs: 800,
  });
  const html = timelineHtml([main, subA, subB], window, { atMs: 250 });
  const marks = playheads(html);
  assert.equal(marks.length, 3);
  const expected = Number(chosenTimePct(250, window).toFixed(3));
  assert.deepEqual(marks, [expected, expected, expected]);
});

test('the playhead lines up with the activity mark and the context curve at the chosen instant', () => {
  const window = { startMs: 0, endMs: 1000 };
  const l = lane({
    id: 'main',
    kind: 'main',
    firstMs: 0,
    lastMs: 1000,
    activity: [{ atMs: 250, kind: 'tool', name: 'Read' }],
    context: [{ atMs: 250, length: 100 }],
  });
  const html = timelineHtml([l], window, { atMs: 250 });
  const row = laneRow(html, 'main');

  const marks = activityMarkTags(row);
  assert.equal(marks.length, 1);
  assert.equal(marks[0].leftPct, 25);

  const [playheadLeft] = playheads(row);
  assert.equal(playheadLeft, 25);

  const polygon = (row.match(/<polygon points="([^"]*)"/) || [])[1];
  assert.ok(polygon, 'expected a polygon in the row');
  const firstPointX = Number(polygon.trim().split(' ')[0].split(',')[0]);
  assert.equal(firstPointX, 25);
});

test('nothing scrub-related is drawn before a chosen time exists', () => {
  const window = { startMs: 0, endMs: 1000 };
  const main = lane({ id: 'main', kind: 'main', firstMs: 0, lastMs: 1000 });
  const html = timelineHtml([main], window);
  assert.ok(!html.includes('lane-playhead'));
  assert.ok(!html.includes('id="timeline-scrub"'));
  assert.ok(!html.includes('data-timeline-live'));
});

test('the scrub control spans the window and its value is the chosen time, with a readable readout', () => {
  const window = { startMs: 1000, endMs: 5000 };
  const main = lane({ id: 'main', kind: 'main', firstMs: 1000, lastMs: 5000 });
  const html = timelineHtml([main], window, { atMs: 2000 });

  const scrubTag = (html.match(/<[^>]*id="timeline-scrub"[^>]*>/) || [])[0];
  assert.ok(scrubTag, 'expected a timeline-scrub control');
  assert.match(scrubTag, /min="1000"/);
  assert.match(scrubTag, /max="5000"/);
  assert.match(scrubTag, /value="2000"/);
  assert.match(scrubTag, /step="1"/);

  assert.ok(html.includes(fmtClock(2000)), 'expected the state row to show the chosen time');
});

test('scrubStateHtml renders a live control whose pressed state reflects following', () => {
  const following = scrubStateHtml(2000, true);
  assert.match(following, /data-timeline-live/);
  assert.match(following, /aria-pressed="true"/);

  const paused = scrubStateHtml(2000, false);
  assert.match(paused, /data-timeline-live/);
  assert.match(paused, /aria-pressed="false"/);
});

test('an empty lane list draws no scrub control and no playhead even with a chosen time', () => {
  const html = timelineHtml([], { startMs: 0, endMs: 1000 }, { atMs: 500 });
  assert.match(html, /span/i);
  assert.ok(!html.includes('id="timeline-scrub"'));
  assert.ok(!html.includes('lane-playhead'));
});

test('the in-place repaint cannot drift from the full render', () => {
  const window = { startMs: 0, endMs: 1000 };
  const main = lane({ id: 'main', kind: 'main', firstMs: 0, lastMs: 1000 });
  const subA = lane({ id: 'agent:agt-a', kind: 'subagent', agentId: 'agt-a', firstMs: 100, lastMs: 900 });
  const items = [main, subA];
  const atMs = 250;
  const html = timelineHtml(items, window, { atMs });
  assert.ok(html.includes(laneRowsHtml(items, window, atMs)));
});

/* ------- selecting a lane, and its tool use up to the chosen time ------- */

test('toolCallsUpTo bounds the listing by the chosen time and orders newest first, never including llm_request', () => {
  const l = lane({
    id: 'agent:agt-a',
    kind: 'subagent',
    agentId: 'agt-a',
    firstMs: 0,
    lastMs: 300,
    activity: [
      { atMs: 100, kind: 'tool', name: 'Read', params: '{"a":1}' },
      { atMs: 200, kind: 'llm_request', name: 'claude-opus-5', params: null },
      { atMs: 300, kind: 'tool', name: 'Write', params: '{"b":2}' },
    ],
  });

  let result = toolCallsUpTo(l, 200);
  assert.equal(result.total, 1);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].name, 'Read');

  result = toolCallsUpTo(l, 300);
  assert.equal(result.total, 2);
  assert.equal(result.items[0].name, 'Write');
  assert.equal(result.items[1].name, 'Read');
  assert.ok(!result.items.some((item) => item.kind === 'llm_request'), 'an llm_request entry never appears');
});

test('toolCallsUpTo: the chosen time is an inclusive bound, and a missing lane or activity answers empty without throwing', () => {
  const l = lane({
    id: 'agent:agt-a',
    kind: 'subagent',
    agentId: 'agt-a',
    firstMs: 0,
    lastMs: 300,
    activity: [
      { atMs: 100, kind: 'tool', name: 'Read', params: '{"a":1}' },
      { atMs: 200, kind: 'llm_request', name: 'claude-opus-5', params: null },
      { atMs: 300, kind: 'tool', name: 'Write', params: '{"b":2}' },
    ],
  });

  assert.equal(toolCallsUpTo(l, 100).items.length, 1, 'the call exactly at the chosen time is included');
  assert.deepEqual(toolCallsUpTo(l, 50), { total: 0, items: [] });
  assert.deepEqual(toolCallsUpTo(l, null), { total: 0, items: [] });
  assert.deepEqual(toolCallsUpTo(l, NaN), { total: 0, items: [] });
  assert.deepEqual(toolCallsUpTo({}, 1000), { total: 0, items: [] });
  const noActivityKey = lane({ id: 'main', kind: 'main', firstMs: 0, lastMs: 1 });
  assert.deepEqual(toolCallsUpTo(noActivityKey, 1000), { total: 0, items: [] });
});

test('toolCallsUpTo caps the returned items at MAX_LANE_TOOL_CALLS while total still counts every call', () => {
  const count = MAX_LANE_TOOL_CALLS + 10;
  const activity = [];
  for (let i = 1; i <= count; i++) {
    activity.push({ atMs: i, kind: 'tool', name: `Tool${i}`, params: null });
  }
  const l = lane({ id: 'main', kind: 'main', firstMs: 0, lastMs: count, activity });
  const result = toolCallsUpTo(l, count);
  assert.equal(result.items.length, MAX_LANE_TOOL_CALLS);
  assert.equal(result.total, count);
  assert.equal(result.items[0].name, `Tool${count}`, 'the newest call leads the capped list');
});

test('laneDetailHtml renders nothing with no selection, or a selection naming a lane that is not in the list', () => {
  const items = [lane({ id: 'main', kind: 'main', firstMs: 0, lastMs: 500 })];
  assert.equal(laneDetailHtml(items, 500, null), '');
  assert.equal(laneDetailHtml(items, 500, 'agent:nope'), '');
});

test('laneDetailHtml names the selected lane and lists each call by name and parameters, bounded by the chosen time', () => {
  const mainLane = lane({ id: 'main', kind: 'main', firstMs: 0, lastMs: 500 });
  const subLane = lane({
    id: 'agent:agt-a',
    kind: 'subagent',
    agentId: 'agt-a',
    agentType: 'agent:builtin:researcher',
    firstMs: 0,
    lastMs: 500,
    activity: [
      { atMs: 100, kind: 'tool', name: 'Grep', params: '{"pattern":"needle"}' },
      { atMs: 400, kind: 'tool', name: 'Write', params: '{"file_path":"/late.md"}' },
    ],
  });
  const html = laneDetailHtml([mainLane, subLane], 300, 'agent:agt-a');
  assert.match(html, new RegExp(agentLabel(subLane)));
  assert.match(html, /Grep/);
  assert.match(html, /needle/);
  assert.ok(!html.includes('Write'), 'a call after the chosen time must not appear');
  assert.ok(!html.includes('/late.md'), 'a call after the chosen time must not appear');
});

test('an empty lane says so and renders no tool-call entries', () => {
  const empty = lane({ id: 'main', kind: 'main', firstMs: 0, lastMs: 500 });
  const html = laneDetailHtml([empty], 500, 'main');
  assert.match(html, /no tool calls/i);
  assert.ok(!html.includes('<li class="tool-call"'));
});

test('a call with no recorded parameters renders its name with an empty-params marker, not a gap', () => {
  const l = lane({
    id: 'main',
    kind: 'main',
    firstMs: 0,
    lastMs: 500,
    activity: [{ atMs: 100, kind: 'tool', name: 'Read', params: null }],
  });
  const html = laneDetailHtml([l], 500, 'main');
  assert.match(html, /Read/);
  assert.match(html, /data-empty="true"/);
});

test('a truncated call is marked data-truncated', () => {
  const l = lane({
    id: 'main',
    kind: 'main',
    firstMs: 0,
    lastMs: 500,
    activity: [{ atMs: 100, kind: 'tool', name: 'Bash', params: 'x'.repeat(1000), paramsTruncated: true }],
  });
  const html = laneDetailHtml([l], 500, 'main');
  assert.match(html, /data-truncated="true"/);
});

test('a hostile tool name or parameters text is escaped in laneDetailHtml', () => {
  const l = lane({
    id: 'main',
    kind: 'main',
    firstMs: 0,
    lastMs: 500,
    activity: [{ atMs: 100, kind: 'tool', name: '<script>x</script>', params: '{"a":"<script>y</script>"}' }],
  });
  const html = laneDetailHtml([l], 500, 'main');
  assert.ok(!html.includes('<script'));
});

test('the selected lane is marked aria-current, and every other lane is marked aria-current="false"', () => {
  const window = { startMs: 0, endMs: 1000 };
  const main = lane({ id: 'main', kind: 'main', firstMs: 0, lastMs: 1000 });
  const subA = lane({ id: 'agent:agt-a', kind: 'subagent', agentId: 'agt-a', firstMs: 100, lastMs: 900 });
  const items = [main, subA];
  const html = timelineHtml(items, window, { atMs: 250, selectedLaneId: 'agent:agt-a' });
  assert.match(laneRow(html, 'agent:agt-a'), /aria-current="true"/);
  assert.match(laneRow(html, 'main'), /aria-current="false"/);

  const unselected = timelineHtml(items, window, { atMs: 250 });
  assert.ok(!unselected.includes('aria-current="true"'), 'with no selectedLaneId, nothing is marked current');
});

test('the in-place repaint cannot drift, extended to the selected lane', () => {
  const window = { startMs: 0, endMs: 1000 };
  const main = lane({ id: 'main', kind: 'main', firstMs: 0, lastMs: 1000 });
  const subA = lane({ id: 'agent:agt-a', kind: 'subagent', agentId: 'agt-a', firstMs: 100, lastMs: 900 });
  const items = [main, subA];
  const atMs = 250;
  const selectedLaneId = 'agent:agt-a';
  const html = timelineHtml(items, window, { atMs, selectedLaneId });
  assert.ok(html.includes(laneRowsHtml(items, window, atMs, selectedLaneId)));
});
