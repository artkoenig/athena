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
} from '../public/timeline.js';

const VIEW_IDS = ['overview', 'todos', 'traces', 'events', 'metrics', 'raw'];

/** A lane fixture, shaped like one item of `store.getAgents(sessionId).items`. */
function lane({ id, kind, agentId = null, parentAgentId = null, agentType = null, firstMs = 0, lastMs = 0 }) {
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
  };
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
