import test from 'node:test';
import assert from 'node:assert/strict';

import { buildLanes, laneGeometry, renderTimeline, DETAIL_VIEWS, renderDetailViews } from '../public/timeline.js';

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
