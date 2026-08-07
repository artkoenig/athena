import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// This file boots the real public/app.js against a fake document, window,
// location, fetch, EventSource and setInterval — everything else (app.js and
// every module it imports, public/index.html read off disk, setTimeout /
// clearTimeout, and the assertions) is real. There is no describe and no
// subtest: every case below is a flat top-level test(), like every other file
// in this suite, and the cases run in the order node:test gives a file,
// because they share the fakes installFakes rebuilds fresh each time.

const INDEX_HTML = fileURLToPath(new URL('../public/index.html', import.meta.url));
const APP_JS_HREF = new URL('../public/app.js', import.meta.url).href;

/* -------------------------------- fixtures -------------------------------- */

const NOW = Date.now();

const SUMMARY = {
  id: 's1',
  name: null,
  serviceName: 'claude-code',
  costUsd: 0.42,
  tokensTotal: 12345,
  firstSeenMs: NOW - 60_000,
  lastSeenMs: NOW - 1000,
  counts: { apiErrors: 0, toolFailures: 0 },
};

const DETAIL = { ...SUMMARY, attrs: {}, startTypes: ['startup'] };

const record = (over = {}) => ({
  seq: 1,
  timeMs: NOW - 50_000,
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
const CONTENT = [record({ seq: 1, timeMs: NOW - 50_000 }), record({ seq: 2, timeMs: NOW - 5_000 })];

const STATS = {
  totals: {
    sessions: 1,
    activeSessions: 1,
    costUsd: 0.42,
    tokens: { input: 100, output: 50 },
    llmRequests: 2,
    toolCalls: 3,
    apiErrors: 0,
    toolFailures: 0,
  },
  buffered: { spans: 7 },
};

const CONTEXT_ITEM = {
  seq: 12,
  timeMs: NOW - 5_000,
  sessionId: 's1',
  spanId: null,
  eventName: 'claude_code.api_request_body',
  model: 'claude-sonnet-5',
  truncated: false,
  body: JSON.stringify({
    model: 'claude-sonnet-5',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
  }),
};

/** Keyed on new URL(url).pathname, so a request to a path nobody mapped is visible, not silently satisfied. */
const DEFAULT_ROUTES = {
  '/api/config': { env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318' } },
  '/api/stats': STATS,
  '/api/sessions': { items: [SUMMARY] },
  '/api/sessions/s1': DETAIL,
  '/api/content': { items: CONTENT },
  '/api/events': { items: [] },
  '/api/content/at': { item: CONTEXT_ITEM },
};

/* --------------------------------- harness -------------------------------- */

/**
 * The source of one id-bearing element, found by its own `id="…"` attribute,
 * balanced against tags of the same name so a `<div>` nested inside it does
 * not end the scan early. Returns null if the raw markup carries no such id.
 */
function findElement(html, id) {
  const openMatch = html.match(new RegExp(`<([a-zA-Z][a-zA-Z0-9]*)\\b[^>]*\\bid="${id}"[^>]*>`));
  if (!openMatch) return null;
  const tag = openMatch[1];
  const openStart = openMatch.index;
  const innerStart = openStart + openMatch[0].length;
  const openRe = new RegExp(`<${tag}\\b`, 'gi');
  const closeRe = new RegExp(`</${tag}>`, 'gi');
  let depth = 1;
  let pos = innerStart;
  while (depth > 0) {
    openRe.lastIndex = pos;
    closeRe.lastIndex = pos;
    const nextOpen = openRe.exec(html);
    const nextClose = closeRe.exec(html);
    if (!nextClose) throw new Error(`unbalanced <${tag}> for id="${id}"`);
    if (nextOpen && nextOpen.index < nextClose.index) {
      depth += 1;
      pos = nextOpen.index + nextOpen[0].length;
    } else {
      depth -= 1;
      pos = nextClose.index + nextClose[0].length;
      if (depth === 0) {
        return { inner: html.slice(innerStart, nextClose.index), openStart, innerStart, innerEnd: nextClose.index, outerEnd: pos };
      }
    }
  }
  return null;
}

/**
 * Installs document, window, location, fetch, EventSource and setInterval as
 * fakes over the real global scope, and returns the handle every case reads
 * and every helper below acts through. `restore()` puts the real globals back
 * — nothing else in this file may call restore twice or skip it.
 *
 * The four regions below (stat-strip, session-list, detail, setup-modal-body)
 * are the only elements app.js ever assigns .innerHTML to directly; every
 * other id a case cares about (lane-panel, timeline-scrub, …) is one the
 * detail region's own markup carries once it is written, and is discovered
 * the same way a real querySelector would find it — by being textually
 * present in currently-rendered markup, not by a fixed list.
 */
function installFakes({ routes = DEFAULT_ROUTES, dropIds = [] } = {}) {
  const raw = fs.readFileSync(INDEX_HTML, 'utf8');
  const containerIds = ['stat-strip', 'session-list', 'detail', 'setup-modal-body'];
  const regions = new Map();
  for (const id of containerIds) {
    const found = findElement(raw, id);
    regions.set(id, found ? found.inner : '');
  }

  // Ids the static shell carries outside the four swappable regions: each
  // region's own inner span is cut out of a scratch copy first, so an id that
  // only exists because a region happens to still hold its original markup is
  // not counted as fixed — booting and overwriting that region must be able to
  // drop it (Case 3). Cut from the end backwards so an earlier region's span
  // does not shift a later region's own recorded offsets.
  const innerSpans = containerIds
    .map((id) => findElement(raw, id))
    .filter(Boolean)
    .map((found) => [found.innerStart, found.innerEnd])
    .sort((a, b) => b[0] - a[0]);
  let scrubbed = raw;
  for (const [start, end] of innerSpans) scrubbed = scrubbed.slice(0, start) + scrubbed.slice(end);
  const fixedIds = new Set([...scrubbed.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

  /** Strips a dropped id's whole element out of a markup string, tag and all. */
  function stripDropped(html) {
    let out = html;
    for (const id of dropIds) {
      const found = findElement(out, id);
      if (found) out = out.slice(0, found.openStart) + out.slice(found.outerEnd);
    }
    return out;
  }
  for (const id of containerIds) regions.set(id, stripDropped(regions.get(id)));

  /** Every id currently reachable by getElementById, computed fresh each call. */
  function visibleIds() {
    const ids = new Set(fixedIds);
    for (const content of regions.values()) {
      for (const m of content.matchAll(/\bid="([^"]+)"/g)) ids.add(m[1]);
    }
    for (const id of dropIds) ids.delete(id);
    return ids;
  }

  const cache = new Map();
  function makeElement(id) {
    const listeners = new Map();
    const node = {
      id,
      dataset: {},
      style: {},
      _listeners: listeners,
      get innerHTML() {
        return regions.get(id) ?? '';
      },
      set innerHTML(value) {
        regions.set(id, stripDropped(String(value)));
      },
      addEventListener(type, handler) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(handler);
      },
      removeEventListener() {},
      // Deliberately dumb: a real selector engine here would rebuild the same
      // conjuring sin over a nested query instead of over an id — this
      // increment does not carry that weight (see the file's own header).
      querySelector: () => null,
      querySelectorAll: () => [],
      closest: () => null,
      setAttribute() {},
      focus() {},
      showModal() {},
    };
    return node;
  }

  // THE DEFECT UNDER TEST — installFakes resolves getElementById through this
  // el(id) helper, which creates and caches a fake element for *any* id it is
  // handed and never returns null: a container the rendered markup does not
  // carry still comes back as a live, writable object. A browser reading that
  // same id would have got null. Fixing this is the whole of Criterion 1: gate
  // the conjure-and-cache below on `visibleIds().has(id)`, as every case in
  // this file already assumes it does.
  function el(id) {
    if (!cache.has(id)) cache.set(id, makeElement(id));
    return cache.get(id);
  }

  const docListeners = new Map();
  const fakeDocument = {
    getElementById: el,
    querySelector: () => null,
    querySelectorAll: () => [],
    activeElement: null,
    addEventListener(type, handler) {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(handler);
    },
    removeEventListener() {},
    _listeners: docListeners,
  };

  const winListeners = new Map();
  const fakeWindow = {
    addEventListener(type, handler) {
      if (!winListeners.has(type)) winListeners.set(type, []);
      winListeners.get(type).push(handler);
    },
    removeEventListener() {},
    _listeners: winListeners,
  };

  const fakeLocation = {
    origin: 'http://127.0.0.1:4319',
    href: 'http://127.0.0.1:4319/',
    search: '',
    hash: '',
  };

  const requests = [];
  const errors = [];

  async function fakeFetch(url) {
    const pathname = new URL(String(url), fakeLocation.origin).pathname;
    requests.push(pathname);
    const route = routes[pathname];
    if (route === undefined) {
      return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({ ok: false, status: 404 }) };
    }
    const body = typeof route === 'function' ? route() : route;
    return { ok: true, status: 200, statusText: 'OK', json: async () => body };
  }

  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this._listeners = new Map();
      this.onerror = null;
    }
    addEventListener(type, handler) {
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type).push(handler);
    }
  }

  // A real setInterval here would keep node --test's process alive between
  // cases; app.js's own slow repaint is not part of what any case below reads.
  function fakeSetInterval() {
    return 0;
  }

  const originals = {
    document: globalThis.document,
    window: globalThis.window,
    location: globalThis.location,
    fetch: globalThis.fetch,
    EventSource: globalThis.EventSource,
    setInterval: globalThis.setInterval,
  };
  const hadOwn = {};
  for (const key of Object.keys(originals)) hadOwn[key] = Object.prototype.hasOwnProperty.call(globalThis, key);

  globalThis.document = fakeDocument;
  globalThis.window = fakeWindow;
  globalThis.location = fakeLocation;
  globalThis.fetch = fakeFetch;
  globalThis.EventSource = FakeEventSource;
  globalThis.setInterval = fakeSetInterval;

  const onUnhandledRejection = (reason) => {
    errors.push(reason instanceof Error ? reason.message : String(reason));
  };
  process.on('unhandledRejection', onUnhandledRejection);

  return {
    doc: fakeDocument,
    win: fakeWindow,
    location: fakeLocation,
    requests,
    errors,
    /** The current inner markup of an id, or null if getElementById itself would answer null. */
    innerHtmlOf(id) {
      const node = fakeDocument.getElementById(id);
      return node ? node.innerHTML : null;
    },
    /** Dispatches a fake event straight to the handlers app.js registered for id/type. */
    fire(id, type, event) {
      const node = cache.get(id) ?? fakeDocument.getElementById(id);
      const handlers = node?._listeners?.get(type) ?? [];
      for (const handler of handlers) handler(event);
    },
    /** Lets whatever chain of real promises and real setTimeouts a boot or a click started finish. */
    async settle() {
      await new Promise((resolve) => setTimeout(resolve, 20));
    },
    restore() {
      process.removeListener('unhandledRejection', onUnhandledRejection);
      for (const key of Object.keys(originals)) {
        if (hadOwn[key]) globalThis[key] = originals[key];
        else delete globalThis[key];
      }
    },
  };
}

/** Fakes installed over the index.html shell alone — app.js is never imported. */
async function withFakes(options, run) {
  const page = installFakes(options);
  try {
    await run(page);
  } finally {
    page.restore();
  }
}

let importCounter = 0;
/** Fakes installed, then the real app.js booted fresh against them and settled. */
async function withPage(options, run) {
  const page = installFakes(options);
  try {
    importCounter += 1;
    await import(`${APP_JS_HREF}?t=${importCounter}`);
    await page.settle();
    await run(page);
  } finally {
    page.restore();
  }
}

/** The two assertions every lane-panel case in this file reads. */
function assertPanelRendered(page) {
  const inner = page.innerHtmlOf('lane-panel');
  assert.ok(
    inner !== null,
    'the page must render a #lane-panel container — a browser reading an id it never wrote gets null and the panel never appears',
  );
  assert.match(inner, /data-context-lane="main"/, 'the context panel for the selected lane must reach the container');
}

/** The closest() a real click event.target on a lane row would answer. */
function laneClickEvent(lane) {
  return {
    target: {
      closest: (selector) => (selector === '[data-lane]' ? { dataset: { lane } } : null),
    },
  };
}

/* ---------------------------------- cases --------------------------------- */

// Criterion 1 — installFakes resolves an unrendered id to null.

test('the fake document resolves only the ids the rendered markup carries', async () => {
  await withFakes({}, async (page) => {
    assert.ok(page.doc.getElementById('detail'), 'the shell carries #detail — a real browser resolves it');
    assert.ok(page.doc.getElementById('stat-strip'), 'the shell carries #stat-strip — a real browser resolves it');
    assert.ok(page.doc.getElementById('session-list'), 'the shell carries #session-list — a real browser resolves it');
    assert.ok(
      page.doc.getElementById('setup-modal-body'),
      'the shell carries #setup-modal-body — a real browser resolves it',
    );

    // The load-bearing edge: these three are real ids of the running page that
    // only exist once renderDetail has run. A harness that conjures elements
    // for any id passes this half only by accident.
    assert.strictEqual(
      page.doc.getElementById('lane-panel'),
      null,
      'the shell has not rendered #lane-panel yet — a real browser would have got null here',
    );
    assert.strictEqual(
      page.doc.getElementById('timeline-scrub'),
      null,
      'the shell has not rendered #timeline-scrub yet — a real browser would have got null here',
    );
    assert.strictEqual(
      page.doc.getElementById('timeline-cursor-time'),
      null,
      'the shell has not rendered #timeline-cursor-time yet — a real browser would have got null here',
    );
    assert.strictEqual(
      page.doc.getElementById('no-such-container-anywhere'),
      null,
      'no markup anywhere carries this id — a real browser would have got null here',
    );
  });
});

test('an id resolves to the same element for as long as it is in the markup', async () => {
  await withFakes({}, async (page) => {
    assert.strictEqual(
      page.doc.getElementById('detail'),
      page.doc.getElementById('detail'),
      'page code that stores an element and writes to it twice needs the same object back both times',
    );

    page.doc.getElementById('detail').innerHTML = '<p>nothing here</p>';
    assert.strictEqual(
      page.doc.getElementById('empty-state'),
      null,
      'the id was inside the region just replaced — a real browser would have got null here, not a cached leftover',
    );
  });
});

test('booting the page adds the ids it renders and drops the ids it overwrote', async () => {
  await withPage({}, async (page) => {
    assert.ok(
      page.doc.getElementById('lane-panel'),
      'renderDetail must have written #lane-panel once the page has booted',
    );
    assert.ok(
      page.doc.getElementById('timeline-scrub'),
      'renderTimeline must have written #timeline-scrub once the page has booted',
    );

    // The same assertion set as the previous case, inverted by the boot — which
    // is what proves the index is live rather than a fixed list.
    assert.strictEqual(
      page.doc.getElementById('empty-state'),
      null,
      '#empty-state sat inside #detail and was overwritten by renderDetail — a real browser would have got null here',
    );
    assert.strictEqual(
      page.doc.getElementById('setup-env'),
      null,
      '#setup-env sat inside #detail and was overwritten by renderDetail — a real browser would have got null here',
    );

    assert.ok(page.doc.getElementById('detail'), '#detail itself is never overwritten, only what is inside it');
  });
});

// Criterion 3 — a case in the suite proves the harness.

test('the page boots against a faked collector and composes its detail markup', async () => {
  await withPage({}, async (page) => {
    assert.match(
      page.innerHtmlOf('detail'),
      /class="panel timeline-panel"/,
      'renderDetail must compose the timeline panel into #detail',
    );
    assert.match(page.innerHtmlOf('detail'), /id="lane-panel"/, 'renderDetail must leave the lane panel container behind');
    assert.match(page.innerHtmlOf('stat-strip'), /stat-value/, 'renderStats must have painted the stat strip');
    assert.match(page.innerHtmlOf('session-list'), /session-card/, 'renderSessionList must have painted the one session');

    for (const path of ['/api/config', '/api/stats', '/api/sessions', '/api/sessions/s1', '/api/content', '/api/events']) {
      assert.ok(page.requests.includes(path), `boot must have asked the collector for ${path}`);
    }
    assert.deepEqual(page.errors, [], 'a clean boot against a well-formed fixture must raise nothing unhandled');
  });
});

test('selecting a lane writes the context panel into the container the timeline rendered', async () => {
  await withPage({}, async (page) => {
    page.fire('detail', 'click', laneClickEvent('main'));
    await page.settle();

    assertPanelRendered(page);
    assert.ok(
      page.requests.includes('/api/content/at'),
      "the lane's context must have been fetched through the page's own click-handling code, not asserted around it",
    );
  });
});

test('removing the panel container from the rendered markup turns the panel case red', async () => {
  await withPage({ dropIds: ['lane-panel'] }, async (page) => {
    page.fire('detail', 'click', laneClickEvent('main'));
    await page.settle();

    assert.throws(
      () => assertPanelRendered(page),
      { name: 'AssertionError', message: /lane-panel/ },
      'with the old conjuring harness this same assertion stayed green after #lane-panel was removed — that is the trap this file exists to close',
    );

    assert.match(
      page.innerHtmlOf('detail'),
      /class="panel timeline-panel"/,
      'only the one container was removed — the rest of the page must still be there',
    );
    assert.deepEqual(
      page.errors,
      [],
      "renderLanePanel's own `if (!container) return;` guard must absorb the missing container, not crash the page",
    );
  });
});
