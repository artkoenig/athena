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

/** A literal id, safe to splice into a regular expression. */
const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The `id="…"` attribute of one element. The leading whitespace is what keeps
 * `data-ctx-entry-id="x"` from answering for `x`: an id attribute always
 * follows the tag name or another attribute, so it is always preceded by space.
 */
const idAttrRe = (id) => new RegExp(`\\sid=["']${escapeRe(id)}["']`);

/** Text as a browser would put it in the markup when handed .textContent. */
const escapeText = (value) =>
  String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/**
 * The offsets of one id-bearing element inside a markup string: `outerStart`
 * to `outerEnd` spans its opening tag through its matching close, `innerStart`
 * to `innerEnd` spans what sits between them. The close is found by walking
 * tags of the same name forward with a depth counter, so a `<div>` nested
 * inside the element does not end the scan early.
 *
 * Returns null when the markup carries no such id — that answer is the whole
 * point of this file and is never a guess. A tag it cannot close throws and
 * names the id, because only paired tags are supported and a silent fallback
 * would hand a case a range over markup nobody wrote. Every container the
 * tested paths write to (div, section, ol, pre, dialog) is paired.
 */
function elementRange(markup, id) {
  const open = markup.match(
    new RegExp(`<([a-zA-Z][a-zA-Z0-9-]*)\\b[^>]*\\sid=["']${escapeRe(id)}["'][^>]*>`),
  );
  if (!open) return null;
  const tag = open[1];
  const outerStart = open.index;
  const innerStart = outerStart + open[0].length;
  const openRe = new RegExp(`<${tag}\\b`, 'gi');
  const closeRe = new RegExp(`</${tag}\\s*>`, 'gi');
  let depth = 1;
  let pos = innerStart;
  while (depth > 0) {
    openRe.lastIndex = pos;
    closeRe.lastIndex = pos;
    const nextOpen = openRe.exec(markup);
    const nextClose = closeRe.exec(markup);
    if (!nextClose) {
      throw new Error(`the fake document cannot close <${tag}> for id="${id}" — it only supports paired tags`);
    }
    if (nextOpen && nextOpen.index < nextClose.index) {
      depth += 1;
      pos = nextOpen.index + nextOpen[0].length;
      continue;
    }
    depth -= 1;
    pos = nextClose.index + nextClose[0].length;
    if (depth === 0) return { outerStart, innerStart, innerEnd: nextClose.index, outerEnd: pos };
  }
  return null;
}

/**
 * Installs document, window, location, fetch, EventSource and setInterval as
 * fakes over the real global scope, and returns the handle every case reads
 * and every helper below acts through. `restore()` puts the real globals back
 * — nothing else in this file may call restore twice or skip it.
 *
 * One mutable string is the document. It is seeded from public/index.html read
 * off disk, and everything else is derived from it: getElementById resolves an
 * id only while that string carries it, and writing .innerHTML or .textContent
 * splices the new markup between the element's opening tag and its matching
 * close. So ids inside written markup start resolving and ids inside the
 * replaced region stop — #empty-state and #setup-env, which index.html ships
 * inside #detail, are gone the moment renderDetail overwrites #detail, exactly
 * as in a browser. No id is ever conjured: a container the page never wrote
 * answers null, which is the whole reason this file exists.
 *
 * `dropIds` removes each named element, opening tag through matching close,
 * from every piece of markup before it enters the model — from the shell at
 * install and from each .innerHTML value as it is spliced in. That is what
 * makes "the page never rendered this container" a test parameter instead of
 * an edit to app.js.
 */
function installFakes({ routes = DEFAULT_ROUTES, dropIds = [] } = {}) {
  /** Strips every dropped id's whole element out of a markup string, tag and all. */
  function dropAll(html) {
    let out = html;
    for (const id of dropIds) {
      const range = elementRange(out, id);
      if (range) out = out.slice(0, range.outerStart) + out.slice(range.outerEnd);
    }
    return out;
  }

  let markup = dropAll(fs.readFileSync(INDEX_HTML, 'utf8'));

  /** What sits between an id's opening tag and its matching close, right now. */
  function innerOf(id) {
    const range = elementRange(markup, id);
    return range ? markup.slice(range.innerStart, range.innerEnd) : '';
  }

  /** Replaces what sits between an id's opening tag and its matching close. */
  function splice(id, html) {
    const range = elementRange(markup, id);
    if (!range) return;
    markup = markup.slice(0, range.innerStart) + html + markup.slice(range.innerEnd);
  }

  function makeElement(id) {
    const listeners = new Map();
    return {
      id,
      dataset: {},
      style: {},
      scrollTop: 0,
      _listeners: listeners,
      get innerHTML() {
        return innerOf(id);
      },
      set innerHTML(value) {
        splice(id, dropAll(String(value)));
      },
      get textContent() {
        return innerOf(id);
      },
      set textContent(value) {
        splice(id, escapeText(value));
      },
      addEventListener(type, handler) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(handler);
      },
      removeEventListener() {},
      // Deliberately dumb: conjuring a child here would be the same sin in a
      // second place, one nesting level down from the id it was fixed at.
      querySelector: () => null,
      querySelectorAll: () => [],
      closest: () => null,
      setAttribute() {},
      focus() {},
      showModal() {},
    };
  }

  // getElementById, in full: the current markup is asked whether it carries
  // the id, every single call and with no cache in front of that question. A
  // miss is null. A hit is the one element kept under that id, so page code
  // that stores an element and writes to it twice gets the same object back.
  const cache = new Map();
  function elementById(id) {
    if (!idAttrRe(id).test(markup)) return null;
    if (!cache.has(id)) cache.set(id, makeElement(id));
    return cache.get(id);
  }

  const docListeners = new Map();
  const fakeDocument = {
    getElementById: elementById,
    querySelector: () => null,
    querySelectorAll: () => [],
    activeElement: undefined,
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
  const reasons = [];

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

  // boot() is awaited by nobody, so without this a broken fake surfaces as a
  // process-level crash with no case attached to it.
  const onUnhandledRejection = (reason) => {
    reasons.push(reason);
    errors.push(reason instanceof Error ? reason.message : String(reason));
  };
  process.on('unhandledRejection', onUnhandledRejection);

  return {
    doc: fakeDocument,
    win: fakeWindow,
    location: fakeLocation,
    requests,
    errors,
    /** The whole document as it currently stands, for a case that needs to read across containers. */
    markup: () => markup,
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
    /**
     * Lets whatever chain of promises a boot or a click started run out. Every
     * faked answer resolves immediately, so the whole chain settles in far
     * fewer turns than this, and a turn costs microseconds. Anything that
     * rejected along the way is thrown here, where a case is watching.
     */
    async settle() {
      for (let turn = 0; turn < 50; turn += 1) {
        await new Promise((done) => setImmediate(done));
      }
      if (reasons.length) throw reasons[0];
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
