// Pins that opening a session lands on the timeline view and that the
// technical views open below it, not in place of it. This boots the real
// `public/app.js` against a fake DOM (document/window/location/EventSource/
// fetch/setInterval all stubbed) rather than a browser, so what is pinned is
// the markup app.js composes and the order it composes it in — not pixels.

import test from 'node:test';
import assert from 'node:assert/strict';
import { fmtClock } from '../public/format.js';

const realSetInterval = globalThis.setInterval;
test.after(() => {
  globalThis.setInterval = realSetInterval;
});

/* ------------------------------ fake DOM ------------------------------ */

/** One fake DOM element, shaped like what app.js reaches for on it. */
function fakeElement(id) {
  return {
    id,
    innerHTML: '',
    textContent: '',
    scrollTop: 0,
    hidden: false,
    dataset: {},
    listeners: {},
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    },
    querySelector: () => ({ textContent: '' }),
    showModal() {},
  };
}

/**
 * Installs fake `document`, `window`, `location`, `EventSource`,
 * `setInterval` and `fetch` on `globalThis`, and returns a handle for
 * driving them from a test.
 */
function installFakes(routes) {
  const elements = new Map();
  const paths = [];
  const streamListeners = {};

  function el(id) {
    if (!elements.has(id)) elements.set(id, fakeElement(id));
    return elements.get(id);
  }

  globalThis.document = {
    getElementById(id) {
      return el(id);
    },
    addEventListener() {},
    querySelector: () => null,
    activeElement: null,
  };

  globalThis.window = {
    addEventListener() {},
  };

  globalThis.location = {
    origin: 'http://127.0.0.1:4319',
    search: '',
    hash: '',
  };

  globalThis.EventSource = class {
    constructor(url) {
      this.url = url;
    }
    addEventListener(type, fn) {
      (streamListeners[type] ||= []).push(fn);
    }
  };

  globalThis.setInterval = () => 0;

  globalThis.fetch = async (url) => {
    paths.push(url.pathname);
    const route = routes[url.pathname];
    if (route === undefined) {
      return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) };
    }
    if (route === 'fail') {
      return { ok: false, status: 500, statusText: 'Server Error', json: async () => ({}) };
    }
    const body = typeof route === 'function' ? route(url) : route;
    return { ok: true, status: 200, statusText: 'OK', json: async () => body };
  };

  function fire(id, type, event) {
    for (const fn of el(id).listeners[type] || []) fn(event);
  }

  /** Fires an event on the fake EventSource stream, the way the collector's SSE would. */
  function emit(type, event) {
    for (const fn of streamListeners[type] || []) fn(event);
  }

  async function settle(predicate) {
    for (let i = 0; i < 400; i++) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(
      `settle() timed out; detail.innerHTML so far: ${el('detail').innerHTML.slice(0, 400)}`,
    );
  }

  return { el, fire, emit, paths, settle };
}

let n = 0;
/** Installs the fakes, imports a fresh copy of app.js, and waits for it to settle. */
async function bootApp(routes, predicate) {
  const handle = installFakes(routes);
  await import(`../public/app.js?case=${n++}`);
  await handle.settle(predicate ?? (() => handle.el('detail').innerHTML.includes('data-lane-id=')));
  return handle;
}

/** A click event whose target resolves `sel` to `match` and everything else to null. */
function clickOn(sel, match) {
  return { target: { closest: (s) => (s === sel ? match : null) } };
}

/* ------------------------------ fixtures ------------------------------ */

const T0 = Date.now() - 10_000;

const config = { env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318' } };

const stats = {
  totals: {
    sessions: 2,
    activeSessions: 1,
    costUsd: 0.12,
    tokens: { input: 100, output: 20 },
    llmRequests: 2,
    toolCalls: 3,
    apiErrors: 0,
    toolFailures: 0,
  },
  buffered: { spans: 6 },
};

const sessionsList = {
  items: [
    {
      id: 'sess-1',
      name: 'first session',
      lastSeenMs: T0 + 10_000,
      costUsd: 0.12,
      tokensTotal: 180,
      counts: { apiErrors: 0, toolFailures: 0 },
    },
    {
      id: 'sess-2',
      name: null,
      lastSeenMs: T0 + 9_000,
      costUsd: 0.01,
      tokensTotal: 20,
      counts: { apiErrors: 0, toolFailures: 0 },
    },
  ],
};

/** The full shape `/api/sessions/:id` returns. */
function sessionDetail(id, name) {
  return {
    id,
    name,
    serviceName: 'claude-code',
    resource: { 'service.name': 'claude-code' },
    attrs: { 'app.version': '2.1.220', 'app.entrypoint': 'cli' },
    firstSeenMs: T0,
    lastSeenMs: T0 + 10_000,
    durationMs: 10_000,
    counts: {
      spans: 6,
      logs: 4,
      metricPoints: 2,
      interactions: 1,
      llmRequests: 2,
      toolCalls: 3,
      toolFailures: 0,
      hooks: 0,
      userPrompts: 1,
      apiRequests: 2,
      apiErrors: 0,
    },
    tokens: { input: 100, output: 20, cacheRead: 50, cacheCreation: 10 },
    tokensTotal: 180,
    tokenSource: 'metrics',
    costUsd: 0.12,
    costSource: 'metrics',
    linesAdded: 3,
    linesRemoved: 1,
    commits: 0,
    pullRequests: 0,
    editDecisions: { accept: 1, reject: 0 },
    activeTimeSec: { user: 2, cli: 3 },
    startTypes: ['startup'],
    models: [],
    tools: [],
    todos: { callsSeen: 0, legacy: null, legacyAtMs: null, tasks: [], unlinkedCreates: [] },
    toolFailuresFromEvents: 0,
    traceCount: 1,
    lastError: null,
    traces: [],
  };
}

/**
 * `/api/sessions/sess-1/agents`: two concurrent instances of one agent type plus an
 * unattributed lane, now carrying activity marks and a context curve per lane — this
 * is the only fixture that proves the drawn result reaches the page (see D1/D2 below).
 */
const agentsOne = {
  sessionId: 'sess-1',
  firstMs: T0,
  lastMs: T0 + 10_000,
  items: [
    {
      id: 'main', kind: 'main', agentId: null, parentAgentId: null, agentType: null,
      firstMs: T0, lastMs: T0 + 10_000, durationMs: 10_000, spanCount: 4,
      activity: [
        { atMs: T0 + 500, kind: 'llm_request', name: 'claude-opus-5', params: null },
        { atMs: T0 + 3_000, kind: 'tool', name: 'Read', params: '{"file_path":"/early.md"}', paramsTruncated: false },
        { atMs: T0 + 9_000, kind: 'tool', name: 'Write', params: '{"file_path":"/late.md"}', paramsTruncated: false },
      ],
      activityTotal: 3,
      context: [
        { atMs: T0 + 500, length: 20_000 },
        { atMs: T0 + 8_000, length: 90_000 },
      ],
      contextPeak: 90_000,
    },
    {
      id: 'agent:agt-a', kind: 'subagent', agentId: 'agt-a', parentAgentId: null, agentType: 'agent:builtin:researcher',
      firstMs: T0 + 1_000, lastMs: T0 + 4_000, durationMs: 3_000, spanCount: 3,
      activity: [{ atMs: T0 + 1_500, kind: 'tool', name: 'Grep', params: '{"pattern":"needle"}', paramsTruncated: false }],
      activityTotal: 1,
      context: [{ atMs: T0 + 1_500, length: 30_000 }],
      contextPeak: 30_000,
    },
    {
      id: 'agent:agt-b', kind: 'subagent', agentId: 'agt-b', parentAgentId: null, agentType: 'agent:builtin:researcher',
      firstMs: T0 + 2_000, lastMs: T0 + 5_000, durationMs: 3_000, spanCount: 2,
      activity: [],
      activityTotal: 0,
      context: [],
      contextPeak: 0,
    },
    {
      id: 'unattributed', kind: 'unattributed', agentId: null, parentAgentId: null, agentType: null,
      firstMs: T0 + 6_000, lastMs: T0 + 7_000, durationMs: 1_000, spanCount: 1,
      activity: [{ atMs: T0 + 6_500, kind: 'tool', name: 'Bash', params: '{"command":"ls -la"}', paramsTruncated: false }],
      activityTotal: 1,
      context: [{ atMs: T0 + 6_500, length: 5_000 }],
      contextPeak: 5_000,
    },
  ],
};

/**
 * `/api/sessions/sess-2/agents`: main plus one subagent of a different type. Deliberately
 * left without activity/context fields, so it doubles as the old-shape case in the
 * existing switch-session test.
 */
const agentsTwo = {
  sessionId: 'sess-2',
  firstMs: T0,
  lastMs: T0 + 10_000,
  items: [
    { id: 'main', kind: 'main', agentId: null, parentAgentId: null, agentType: null, firstMs: T0, lastMs: T0 + 10_000, durationMs: 10_000, spanCount: 4 },
    { id: 'agent:agt-c', kind: 'subagent', agentId: 'agt-c', parentAgentId: null, agentType: 'agent:builtin:helper', firstMs: T0 + 1_000, lastMs: T0 + 4_000, durationMs: 3_000, spanCount: 3 },
  ],
};

const baseRoutes = {
  '/api/config': config,
  '/api/stats': stats,
  '/api/sessions': sessionsList,
  '/api/sessions/sess-1': sessionDetail('sess-1', 'first session'),
  '/api/sessions/sess-1/agents': agentsOne,
  '/api/sessions/sess-2': sessionDetail('sess-2', null),
  '/api/sessions/sess-2/agents': agentsTwo,
};

/* ------------------------------ landing on the timeline ------------------------------ */

test('opening a session draws a lane per agent and opens no technical view', async () => {
  const handle = await bootApp({ ...baseRoutes });
  const html = handle.el('detail').innerHTML;
  assert.equal((html.match(/data-lane-id="/g) || []).length, 4);
  assert.match(html, /data-lane-id="main"/);
  assert.match(html, /data-lane-id="agent:agt-a"/);
  assert.match(html, /data-lane-id="agent:agt-b"/);
  assert.match(html, /data-lane-id="unattributed"/);
  assert.ok(!html.includes('aria-selected="true"'));
  assert.equal(handle.el('view-body').innerHTML, '');
});

test('the strip of technical views is rendered below the timeline, not in place of it', async () => {
  const handle = await bootApp({ ...baseRoutes });
  const html = handle.el('detail').innerHTML;
  const laneIndex = html.indexOf('data-lane-id=');
  const tablistIndex = html.indexOf('role="tablist"');
  const viewBodyIndex = html.indexOf('id="view-body"');
  assert.ok(laneIndex > -1);
  assert.ok(laneIndex < tablistIndex);
  assert.ok(tablistIndex < viewBodyIndex);
  for (const id of ['overview', 'todos', 'traces', 'events', 'metrics', 'raw']) {
    assert.match(html, new RegExp(`data-view="${id}"`));
  }
});

test('clicking a technical view opens it under the timeline and leaves the lanes drawn', async () => {
  const handle = await bootApp({ ...baseRoutes });
  handle.fire('detail', 'click', clickOn('[data-view]', { dataset: { view: 'raw' } }));
  await handle.settle(() => handle.el('view-body').innerHTML.includes('Resource attributes'));

  assert.match(handle.el('view-body').innerHTML, /Resource attributes/);

  const html = handle.el('detail').innerHTML;
  assert.equal((html.match(/data-lane-id="/g) || []).length, 4);
  assert.equal((html.match(/aria-selected="true"/g) || []).length, 1);
  const rawButton = html.match(/<button[^>]*data-view="raw"[^>]*>/)[0];
  assert.match(rawButton, /aria-selected="true"/);
  assert.ok(html.indexOf('data-lane-id=') < html.indexOf('role="tablist"'));
});

test("opening a session asks the collector for that session's agent lanes", async () => {
  const handle = await bootApp({ ...baseRoutes });
  assert.ok(handle.paths.includes('/api/sessions/sess-1/agents'));
});

test("switching sessions returns to the timeline alone, with the new session's lanes", async () => {
  const handle = await bootApp({ ...baseRoutes });
  handle.fire('detail', 'click', clickOn('[data-view]', { dataset: { view: 'raw' } }));
  await handle.settle(() => handle.el('view-body').innerHTML.includes('Resource attributes'));

  handle.fire('session-list', 'click', clickOn('[data-session]', { dataset: { session: 'sess-2' } }));
  await handle.settle(
    () => handle.paths.includes('/api/sessions/sess-2/agents') && handle.el('detail').innerHTML.includes('agent:agt-c'),
  );

  const html = handle.el('detail').innerHTML;
  assert.match(html, /data-lane-id="agent:agt-c"/);
  assert.ok(!html.includes('aria-selected="true"'));
  assert.equal(handle.el('view-body').innerHTML, '');
});

test('a session whose agent lanes cannot be fetched still lands on the timeline, not on a technical tab', async () => {
  const routes = { ...baseRoutes, '/api/sessions/sess-1/agents': 'fail' };
  // The default predicate looks for `data-lane-id=`, which this session never draws, so a
  // dedicated predicate is needed; it reaches for the fake document directly rather than
  // through the handle, which does not exist yet while bootApp is still settling.
  const handle = await bootApp(routes, () =>
    globalThis.document.getElementById('detail').innerHTML.includes('role="tablist"'),
  );

  const html = handle.el('detail').innerHTML;
  assert.ok(!html.includes('data-lane-id="'));
  const placeholder = /no agent lanes/i.exec(html);
  assert.ok(placeholder, 'expected a placeholder mentioning "no agent lanes"');
  assert.ok(!html.includes('aria-selected="true"'));
  assert.ok(placeholder.index < html.indexOf('role="tablist"'));
  assert.equal(handle.el('view-body').innerHTML, '');
});

/* ------------------------ activity marks and the context curve ------------------------ */

/** The substring of `html` from `data-lane-id="<id>"` to the next `data-lane-id="` (or the end). */
function laneRow(html, id) {
  const start = html.indexOf(`data-lane-id="${id}"`);
  if (start === -1) return '';
  const next = html.indexOf('data-lane-id="', start + 1);
  return next === -1 ? html.slice(start) : html.slice(start, next);
}

test('booting the app draws activity marks and the context curve reaches the page', async () => {
  const handle = await bootApp({ ...baseRoutes });
  const html = handle.el('detail').innerHTML;

  const mainRow = laneRow(html, 'main');
  assert.match(mainRow, /data-activity-kind="llm_request"/);
  assert.match(mainRow, /data-activity-kind="tool"/);
  const mainPolygon = (mainRow.match(/<polygon points="([^"]*)"/) || [])[1];
  assert.ok(
    mainPolygon && mainPolygon.trim().length > 0,
    'expected a non-empty context curve on the main lane',
  );

  const agtBRow = laneRow(html, 'agent:agt-b');
  assert.ok(!agtBRow.includes('<polygon'), 'a lane with no context samples must draw no curve');

  assert.equal((html.match(/data-lane-id="/g) || []).length, 4);
  assert.ok(!html.includes('aria-selected="true"'));
});

test('unattributed activity reaches the page, and the page names the measure', async () => {
  const handle = await bootApp({ ...baseRoutes });
  const html = handle.el('detail').innerHTML;

  const unattributedRow = laneRow(html, 'unattributed');
  assert.match(unattributedRow, /data-activity-kind="tool"/);

  assert.match(html, /request body length/i);
});

/* ------- scrubbing and live mode ------- */

/** Every `class="lane-playhead"` element's left percentage, as a Number. */
function playheads(html) {
  return [...html.matchAll(/<[^>]*class="lane-playhead"[^>]*>/g)].map((match) => {
    return Number((match[0].match(/left:([\d.]+)%/) || [])[1]);
  });
}

test('opening a session starts in live mode, with the scrub control at the head', async () => {
  const handle = await bootApp({ ...baseRoutes });
  const html = handle.el('detail').innerHTML;

  const scrubTag = (html.match(/<[^>]*id="timeline-scrub"[^>]*>/) || [])[0];
  assert.ok(scrubTag, 'expected a timeline-scrub control');
  assert.match(scrubTag, new RegExp(`value="${T0 + 10_000}"`));
  assert.match(scrubTag, new RegExp(`max="${T0 + 10_000}"`));

  const liveTag = (html.match(/<[^>]*data-timeline-live[^>]*>/) || [])[0];
  assert.ok(liveTag, 'expected a data-timeline-live control');
  assert.match(liveTag, /aria-pressed="true"/);

  for (const id of ['main', 'agent:agt-a', 'agent:agt-b', 'unattributed']) {
    const marks = playheads(laneRow(html, id));
    assert.equal(marks.length, 1);
    assert.equal(marks[0].toFixed(3), '100.000');
  }
});

test('the timeline can be scrubbed backward and forward to any point, and the chosen time is visible', async () => {
  const handle = await bootApp({ ...baseRoutes });

  handle.fire('detail', 'input', { target: { id: 'timeline-scrub', value: String(T0 + 2_500) } });
  let marks = playheads(handle.el('timeline-lanes').innerHTML);
  assert.equal(marks.length, 4);
  for (const m of marks) assert.equal(m.toFixed(3), '25.000');
  assert.ok(handle.el('timeline-scrub-state').innerHTML.includes(fmtClock(T0 + 2_500)));

  handle.fire('detail', 'input', { target: { id: 'timeline-scrub', value: String(T0 + 1_000) } });
  marks = playheads(handle.el('timeline-lanes').innerHTML);
  assert.equal(marks.length, 4);
  for (const m of marks) assert.equal(m.toFixed(3), '10.000');
});

test('scrubbing away from the head leaves live mode', async () => {
  const handle = await bootApp({ ...baseRoutes });
  handle.fire('detail', 'input', { target: { id: 'timeline-scrub', value: String(T0 + 2_500) } });
  assert.match(handle.el('timeline-scrub-state').innerHTML, /aria-pressed="false"/);
});

test('live mode keeps following as later data extends the session window', async () => {
  let headMs = T0 + 10_000;
  const routes = {
    ...baseRoutes,
    '/api/sessions/sess-1/agents': () => ({ ...agentsOne, lastMs: headMs }),
  };
  const handle = await bootApp(routes);

  headMs = T0 + 20_000;
  handle.emit('ingest');
  await handle.settle(() => handle.el('detail').innerHTML.includes(`max="${T0 + 20_000}"`));

  const html = handle.el('detail').innerHTML;
  const scrubTag = (html.match(/<[^>]*id="timeline-scrub"[^>]*>/) || [])[0];
  assert.match(scrubTag, new RegExp(`value="${T0 + 20_000}"`));

  const marks = playheads(html);
  assert.equal(marks.length, 4);
  for (const m of marks) assert.equal(m.toFixed(3), '100.000');

  assert.match(html, /aria-pressed="true"/);
});

test('a chosen time scrubbed away from the head is not dragged along by new data', async () => {
  let headMs = T0 + 10_000;
  const routes = {
    ...baseRoutes,
    '/api/sessions/sess-1/agents': () => ({ ...agentsOne, lastMs: headMs }),
  };
  const handle = await bootApp(routes);

  handle.fire('detail', 'input', { target: { id: 'timeline-scrub', value: String(T0 + 2_500) } });

  headMs = T0 + 20_000;
  handle.emit('ingest');
  await handle.settle(() => handle.el('detail').innerHTML.includes(`max="${T0 + 20_000}"`));

  const html = handle.el('detail').innerHTML;
  const scrubTag = (html.match(/<[^>]*id="timeline-scrub"[^>]*>/) || [])[0];
  assert.match(scrubTag, new RegExp(`value="${T0 + 2_500}"`));

  const marks = playheads(html);
  assert.equal(marks.length, 4);
  for (const m of marks) assert.equal(m.toFixed(3), '12.500');

  assert.match(html, /aria-pressed="false"/);
});

test('the live control returns to live mode, and following actually resumes', async () => {
  let headMs = T0 + 10_000;
  const routes = {
    ...baseRoutes,
    '/api/sessions/sess-1/agents': () => ({ ...agentsOne, lastMs: headMs }),
  };
  const handle = await bootApp(routes);

  handle.fire('detail', 'input', { target: { id: 'timeline-scrub', value: String(T0 + 2_500) } });
  handle.fire('detail', 'click', clickOn('[data-timeline-live]', { dataset: {} }));

  let html = handle.el('detail').innerHTML;
  let scrubTag = (html.match(/<[^>]*id="timeline-scrub"[^>]*>/) || [])[0];
  assert.match(scrubTag, new RegExp(`value="${T0 + 10_000}"`));
  assert.match(html, /aria-pressed="true"/);
  let marks = playheads(html);
  assert.equal(marks.length, 4);
  for (const m of marks) assert.equal(m.toFixed(3), '100.000');

  headMs = T0 + 20_000;
  handle.emit('ingest');
  await handle.settle(() => handle.el('detail').innerHTML.includes(`max="${T0 + 20_000}"`));

  html = handle.el('detail').innerHTML;
  scrubTag = (html.match(/<[^>]*id="timeline-scrub"[^>]*>/) || [])[0];
  assert.match(scrubTag, new RegExp(`value="${T0 + 20_000}"`));
  marks = playheads(html);
  assert.equal(marks.length, 4);
  for (const m of marks) assert.equal(m.toFixed(3), '100.000');
});

/* ------- selecting a lane, and its tool use up to the chosen time ------- */

test('with no lane selected the session view renders as it does today: no lane detail, no aria-current, no tool-call listing', async () => {
  const handle = await bootApp({ ...baseRoutes });
  assert.equal(handle.el('lane-detail').innerHTML, '');
  const html = handle.el('detail').innerHTML;
  assert.ok(!html.includes('aria-current="true"'));
  assert.ok(!html.includes('tool-call'));
});

test('clicking a lane row records the selection and marks it on the timeline', async () => {
  const handle = await bootApp({ ...baseRoutes });
  handle.fire('detail', 'click', clickOn('[data-lane-id]', { dataset: { laneId: 'agent:agt-a' } }));
  await handle.settle(() => handle.el('lane-detail').innerHTML.includes('Grep'));

  const detailHtml = handle.el('detail').innerHTML;
  assert.match(laneRow(detailHtml, 'agent:agt-a'), /aria-current="true"/);
  assert.match(laneRow(detailHtml, 'main'), /aria-current="false"/);

  const panel = handle.el('lane-detail').innerHTML;
  assert.match(panel, /Grep/);
  assert.match(panel, /needle/);
});

test('the listing is bounded by the chosen time and follows it as it moves, repainted in place', async () => {
  const handle = await bootApp({ ...baseRoutes });
  handle.fire('detail', 'click', clickOn('[data-lane-id]', { dataset: { laneId: 'main' } }));
  await handle.settle(() => handle.el('lane-detail').innerHTML.includes('/late.md'));
  assert.match(handle.el('lane-detail').innerHTML, /\/early\.md/);
  assert.match(handle.el('lane-detail').innerHTML, /\/late\.md/);

  handle.fire('detail', 'input', { target: { id: 'timeline-scrub', value: String(T0 + 5_000) } });
  assert.match(handle.el('lane-detail').innerHTML, /\/early\.md/);
  assert.ok(!handle.el('lane-detail').innerHTML.includes('/late.md'), 'a call after the chosen time must drop out');
  assert.match(
    handle.el('detail').innerHTML,
    new RegExp(`value="${T0 + 10_000}"`),
    'the wholesale render did not run, which keeps the range input alive mid-drag',
  );

  handle.fire('detail', 'input', { target: { id: 'timeline-scrub', value: String(T0 + 9_500) } });
  assert.match(handle.el('lane-detail').innerHTML, /\/late\.md/);
});

test('the unattributed lane answers too: selecting it lists its tool calls', async () => {
  const handle = await bootApp({ ...baseRoutes });
  handle.fire('detail', 'click', clickOn('[data-lane-id]', { dataset: { laneId: 'unattributed' } }));
  await handle.settle(() => handle.el('lane-detail').innerHTML.includes('Bash'));
  const panel = handle.el('lane-detail').innerHTML;
  assert.match(panel, /Bash/);
  assert.match(panel, /ls -la/);
});

test('a lane with no tool calls before the chosen time says so', async () => {
  const handle = await bootApp({ ...baseRoutes });
  handle.fire('detail', 'click', clickOn('[data-lane-id]', { dataset: { laneId: 'agent:agt-b' } }));
  await handle.settle(() => /no tool calls/i.test(handle.el('lane-detail').innerHTML));
  const panel = handle.el('lane-detail').innerHTML;
  assert.match(panel, /no tool calls/i);
  assert.ok(!panel.includes('tool-call-name'));
});

test('the selection survives new data arriving, and the panel keeps following it', async () => {
  let headMs = T0 + 10_000;
  const routes = {
    ...baseRoutes,
    '/api/sessions/sess-1/agents': () => ({ ...agentsOne, lastMs: headMs }),
  };
  const handle = await bootApp(routes);
  handle.fire('detail', 'click', clickOn('[data-lane-id]', { dataset: { laneId: 'agent:agt-a' } }));
  await handle.settle(() => handle.el('lane-detail').innerHTML.includes('Grep'));

  headMs = T0 + 20_000;
  handle.emit('ingest');
  await handle.settle(() => handle.el('detail').innerHTML.includes(`max="${T0 + 20_000}"`));

  const detailHtml = handle.el('detail').innerHTML;
  assert.match(laneRow(detailHtml, 'agent:agt-a'), /aria-current="true"/);
  assert.match(handle.el('lane-detail').innerHTML, /Grep/);
});

test('clicking the selected lane a second time closes the panel', async () => {
  const handle = await bootApp({ ...baseRoutes });
  handle.fire('detail', 'click', clickOn('[data-lane-id]', { dataset: { laneId: 'agent:agt-a' } }));
  await handle.settle(() => handle.el('lane-detail').innerHTML.includes('Grep'));

  handle.fire('detail', 'click', clickOn('[data-lane-id]', { dataset: { laneId: 'agent:agt-a' } }));
  await handle.settle(() => handle.el('lane-detail').innerHTML === '');
  assert.equal(handle.el('lane-detail').innerHTML, '');
  assert.ok(!handle.el('detail').innerHTML.includes('aria-current="true"'));
});

test('switching sessions drops the selection', async () => {
  const handle = await bootApp({ ...baseRoutes });
  handle.fire('detail', 'click', clickOn('[data-lane-id]', { dataset: { laneId: 'agent:agt-a' } }));
  await handle.settle(() => handle.el('lane-detail').innerHTML.includes('Grep'));

  handle.fire('session-list', 'click', clickOn('[data-session]', { dataset: { session: 'sess-2' } }));
  await handle.settle(
    () => handle.paths.includes('/api/sessions/sess-2/agents') && handle.el('detail').innerHTML.includes('agent:agt-c'),
  );
  assert.equal(handle.el('lane-detail').innerHTML, '');
});
