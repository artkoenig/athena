/**
 * argus-ui — the run view.
 *
 * The workflow state an argus collector holds: which runs it has seen, and for
 * one of them the `backlog.json` it was recorded from, shown as the document it
 * is. Pure functions returning HTML strings, like `timeline.js` and
 * `context.js`, so the suite imports this module straight into `node --test`
 * and no browser global is reachable here.
 *
 * Two shapes arrive from the collector and must never be confused: a list
 * entry's `increments` is a count, while `state.increments` is the array of
 * increments themselves. The head's counts are read from the state, never from
 * the entry's own count.
 *
 * The pane is a tree of the recorded document and nothing else. An earlier
 * version laid each part out under a heading of its own — increment cards, step
 * rows, a codemap panel — and a run of any size arrived as one page of prose
 * with no way to fold a part of it away. So the document is now shown as its
 * own structure: every key under the key that holds it, every record and every
 * list a `<details>` that opens onto what is inside it, and nothing renamed,
 * reordered or summarised on the way. What the page decides is only what is
 * open when it arrives — the top level, and the increment being worked.
 *
 * Every `<details>` carries a `data-panel` key naming its path in the document
 * — `tree/increments/2/steps/0/return` — rather than its position on the page.
 * A run being worked rewrites this pane on every write, and without those keys
 * each rewrite would close whatever the reader had opened; `renderRunView` in
 * `app.js` reads them before it repaints and puts each panel back the way the
 * reader left it. A path is stable across writes as long as the value stays
 * where it is, which is what the recorder guarantees.
 */

import { esc, fmtAgo, previewOf } from './format.js';

/** The three statuses a close writes. Anything else — `'todo'`, `''` — is open. */
export const CLOSED_STATUSES = new Set(['done', 'blocked', 'dropped']);

export const isClosedIncrement = (increment) => CLOSED_STATUSES.has(increment?.status);

/** Totals over the backlog's own array, counting a missing one as zero. */
export function incrementCounts(increments) {
  const list = Array.isArray(increments) ? increments : [];
  const closed = list.filter(isClosedIncrement).length;
  return { total: list.length, closed, open: list.length - closed };
}

/**
 * The run to show: the wanted one while the collector still holds it, else the
 * one written to most recently. The collector serves latest-write-first, so
 * that is its first item and this page sorts nothing.
 */
export function pickRunId(items, wanted) {
  const list = Array.isArray(items) ? items : [];
  if (wanted && list.some((item) => item?.id === wanted)) return wanted;
  return list[0]?.id ?? null;
}

/**
 * Whether the shown run's state has to be asked for again. Without a frame this
 * is a boot or an explicit switch, so it always has to be; with one, it has to
 * be when the frame names the run now shown, and when nothing was shown before
 * the picker chose one — the boot that opens on the latest run.
 */
export function shouldLoadRun({ changedId = null, shownId = null, selectedId = null } = {}) {
  if (changedId === null) return true;
  if (!shownId) return true;
  return changedId === selectedId;
}

/** One SSE `run` frame's data string, or null for anything that is not one. */
export function runFrame(data) {
  let parsed;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (typeof parsed.id !== 'string' || !parsed.id) return null;
  return { id: parsed.id, updatedAtMs: parsed.updatedAtMs };
}

/**
 * An id going into an attribute. `esc` already makes a quote harmless; spelling
 * `=` as an entity as well means no fragment of a hostile id can even read like
 * a second attribute in the markup a human inspects. The browser hands the
 * value back through `dataset` exactly as it arrived.
 */
const attr = (value) => esc(value).replace(/=/g, '&#61;');

/** The exact instant, for a machine to read. Empty when the entry carries none. */
function isoOf(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '';
  return new Date(n).toISOString();
}

/**
 * A relative time the page keeps current without repainting around it. The
 * instant rides in `data-at` and the element holds nothing but the age, so the
 * slow repaint can rewrite the text of every one of these without touching the
 * markup they sit in — which is what keeps an open `<details>` open while the
 * ages in the pane go on moving.
 *
 * Two pieces rather than one element-building helper, so every class name in
 * this file stays written out in a `class="…"` attribute where the stylesheet
 * guard can see it.
 */
const atAttr = (iso) => `data-at="${attr(iso)}"`;
const agoText = (timeMs) => esc(fmtAgo(timeMs));

/** The picker's rows: one button per run the collector holds. */
export function renderRunList({ items = [], selectedId = null } = {}) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return '<li class="placeholder">No runs yet</li>';
  return list
    .map((item) => {
      const id = item?.id ?? '';
      const count = Number(item?.increments) || 0;
      return `<li>
        <button type="button" class="run-card" data-run="${attr(id)}"
          aria-current="${id === selectedId}">
          <span class="run-card-top">${esc(item?.issue || id)}</span>
          <span class="run-card-meta">
            <span>${esc(fmtAgo(item?.updatedAtMs))}</span>
            ${item?.workflow ? `<span>${esc(item.workflow)}</span>` : ''}
            <span>${count} inc</span>
          </span>
        </button>
      </li>`;
    })
    .join('');
}

/* ---------------------------- the document tree --------------------------- */

/** Whether a value is a record — the one shape whose keys are read by name. */
const isRecord = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

/** Whether a value has children to open onto. */
const isContainer = (value) => Array.isArray(value) || isRecord(value);

/**
 * The children of a container as `[key, value]`, an array's index spelled out
 * as its key. That is what makes a path through a list read the same way as a
 * path through a record, and what makes both stable across a repaint.
 */
export function childEntries(value) {
  if (Array.isArray(value)) return value.map((item, index) => [String(index), item]);
  if (isRecord(value)) return Object.entries(value);
  return [];
}

/** `[4]` for a list of four, `{6}` for a record of six fields. */
export function badgeOf(value) {
  if (Array.isArray(value)) return `[${value.length}]`;
  if (isRecord(value)) return `{${Object.keys(value).length}}`;
  return '';
}

/**
 * The field a record is known by, in the order the backlog actually uses: an
 * increment carries a `title`, a step a `label`, an agent return a `summary`.
 * A record carrying none of them is named by the keys it holds, which is its
 * structure and the next best thing to a name.
 */
const NAME_KEYS = ['title', 'label', 'summary', 'id', 'goal'];

function nameOf(record) {
  for (const key of NAME_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return Object.keys(record).join(', ');
}

/**
 * The one line a collapsed node shows beside its key.
 *
 * Bounded on purpose: a record is named by its own naming field, and a list by
 * the name of its first entry. Walking further would cost a whole subtree per
 * summary and would print the run twice — once folded and once in the hints.
 */
export function hintOf(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    if (!value.length) return '';
    return hintOf(value[0]);
  }
  if (isRecord(value)) return nameOf(value);
  return String(value);
}

/**
 * A string this long, or carrying a line break, gets a disclosure of its own
 * rather than a place on the key's line. Prompts, plans and the codemap are all
 * pages of text, and a page of text on a line is the wall this view replaced.
 */
export const INLINE_CHARS = 80;

const isFolded = (text) => text.includes('\n') || text.length > INLINE_CHARS;

/** The instants the recorder writes, which is the only string an age is added to. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/**
 * The age beside a recorded instant. The value itself is still printed
 * verbatim — this is a reading aid next to it, not a replacement for it — and
 * it carries `data-at`, so the slow tick brings it current without a repaint.
 */
function ageMarkup(text) {
  if (!ISO_INSTANT.test(text)) return '';
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) return '';
  return `<span class="json-ago" ${atAttr(text)}>${agoText(ms)}</span>`;
}

/** One value that fits on its key's line, typed the way JSON types it. */
function scalarMarkup(value) {
  if (value === null || value === undefined) return '<span class="json-null">null</span>';
  if (typeof value === 'boolean') return `<span class="json-bool">${value}</span>`;
  if (typeof value === 'number') return `<span class="json-number">${esc(String(value))}</span>`;
  if (typeof value === 'string') {
    if (!value) return '<span class="json-empty">""</span>';
    return `<span class="json-string">${esc(value)}</span>${ageMarkup(value)}`;
  }
  return `<span class="json-string">${esc(String(value))}</span>`;
}

/**
 * How deep a container opens by default. The top level of the document is open
 * — `version`, `issue`, `increments`, `run` — and everything under it is folded,
 * so a run of any size arrives as a page that fits on a screen.
 */
export const OPEN_DEPTH = 1;

/**
 * One node of the document: its key, what is inside it, and a disclosure where
 * there is something to open.
 *
 * `openPaths` names the nodes that open regardless of depth. Nothing else about
 * the value changes what is rendered — a key is printed as the recorder wrote
 * it, a list keeps its order, and an unexpected shape is a node like any other.
 */
export function renderNode(key, value, { path = 'tree', depth = 0, openPaths = new Set() } = {}) {
  const here = `${path}/${key}`;
  const name = `<span class="json-key">${esc(key)}</span>`;

  if (typeof value === 'string' && isFolded(value)) {
    return `<li class="json-node"><details class="json-fold" data-panel="${attr(here)}"${
      openPaths.has(here) ? ' open' : ''
    }><summary>${name}<span class="json-badge">${value.length} chars</span><span class="json-hint">${esc(
      previewOf(value),
    )}</span></summary><pre class="json-text">${esc(value)}</pre></details></li>`;
  }

  if (!isContainer(value)) {
    return `<li class="json-leaf">${name}${scalarMarkup(value)}</li>`;
  }

  const entries = childEntries(value);
  // An empty list or record is a fact the document states, so it is printed as
  // one rather than as a disclosure that opens onto nothing. Its own brackets
  // say it better than a count of nothing would.
  if (!entries.length) {
    return `<li class="json-leaf">${name}<span class="json-empty">${
      Array.isArray(value) ? '[]' : '{}'
    }</span></li>`;
  }

  const open = depth < OPEN_DEPTH || openPaths.has(here);
  return `<li class="json-node"><details class="json-fold" data-panel="${attr(here)}"${
    open ? ' open' : ''
  }><summary>${name}<span class="json-badge">${esc(badgeOf(value))}</span><span class="json-hint">${esc(
    previewOf(hintOf(value)),
  )}</span></summary><ul class="json-tree">${entries
    .map(([childKey, childValue]) =>
      renderNode(childKey, childValue, { path: here, depth: depth + 1, openPaths }),
    )
    .join('')}</ul></details></li>`;
}

/** The whole document, as the tree of its own keys. */
export function renderTree(value, { path = 'tree', openPaths = new Set() } = {}) {
  const entries = childEntries(value);
  if (!entries.length) return '<div class="placeholder">This run holds no state yet</div>';
  return `<ul class="json-tree json-root">${entries
    .map(([key, child]) => renderNode(key, child, { path, depth: 0, openPaths }))
    .join('')}</ul>`;
}

/**
 * The nodes a run opens on beyond its top level: the increment being worked and
 * the steps recorded under it. Everything else in the document is one click
 * away, and this is the one place a reader wants to be standing when a run is
 * going.
 */
export function openPathsFor(state, path = 'tree') {
  const open = new Set();
  const running = runningView(state);
  if (!running?.increment) return open;
  const increments = Array.isArray(state?.increments) ? state.increments : [];
  const index = increments.findIndex((increment) => increment?.id === running.increment);
  if (index < 0) return open;
  open.add(`${path}/increments/${index}`);
  open.add(`${path}/increments/${index}/steps`);
  return open;
}

/* ----------------------------- the step in flight ------------------------- */

/**
 * The step in flight, read for the page: `{ label, increment, at, timeMs,
 * prompt }`, or null where the state names none.
 *
 * The recorder writes `running` when a step is dispatched and deletes it when
 * that step records its return, so the field's presence is the whole question —
 * an entry without a label is not one, and nothing else here is required.
 */
export function runningView(state) {
  const entry = state && typeof state.running === 'object' ? state.running : null;
  if (!entry) return null;
  const label = typeof entry.label === 'string' ? entry.label : '';
  if (!label) return null;
  const at = typeof entry.at === 'string' ? entry.at : '';
  const parsed = Date.parse(at);
  return {
    label,
    increment: typeof entry.increment === 'string' ? entry.increment : '',
    at,
    timeMs: Number.isFinite(parsed) ? parsed : 0,
    prompt: typeof entry.prompt === 'string' ? entry.prompt : '',
  };
}

/**
 * The banner for the step now running: which agent, on which increment, since
 * when, and the whole prompt it was dispatched with, which is where its goal
 * and its acceptance criteria are written.
 *
 * It sits above the tree because "what is happening right now" is the question
 * a reader has while a run is going, and answering it should not cost a walk
 * down the tree. The state's own `running` key is in the tree all the same:
 * the tree shows the document, whole.
 */
export function renderRunning(running) {
  if (!running) return '';
  return `<div class="panel run-running">
    <div class="run-running-head">
      <span class="run-running-dot" aria-hidden="true"></span>
      <span class="run-running-label">${esc(running.label)}</span>
      ${running.increment ? `<span class="chip">${esc(running.increment)}</span>` : ''}
      <span class="run-running-since">running since <b ${atAttr(running.at)}>${agoText(
        running.timeMs,
      )}</b></span>
    </div>
    ${
      running.prompt
        ? `<details class="run-panel" data-panel="running/${attr(
            running.label,
          )}/prompt" open><summary>Prompt<span class="run-panel-hint">what this step was asked for</span></summary><pre class="run-prompt">${esc(
            running.prompt,
          )}</pre></details>`
        : '<p class="run-note">No prompt was recorded with this step.</p>'
    }
  </div>`;
}

/**
 * One run, whole. The collector holds the recorded state opaquely, so the head
 * treats every field it names as possibly absent — but the tree below it names
 * nothing: it renders whatever keys the document has, which is what keeps this
 * view correct for a state the recorder has not written yet.
 */
export function renderRun(run) {
  if (!run) {
    return `<div class="empty">
      <h1>No run yet</h1>
      <p>
        No run state has reached this collector. A uroboros run records its backlog as it
        works, and the one written to most recently opens here as soon as it does.
      </p>
    </div>`;
  }

  const held = run.state && typeof run.state === 'object' ? run.state : {};
  const counts = incrementCounts(held.increments);
  const issue = run.issue || held.issue || run.id || '';
  const workflow = run.workflow || held.workflow || '';
  const running = runningView(held);

  return `
    <div class="run-head">
      <h1 class="run-title">${esc(issue)}</h1>
      ${run.id ? `<div class="run-subtitle">${esc(run.id)}</div>` : ''}
      <div class="chips">
        <span class="chip" data-updated="${esc(isoOf(run.updatedAtMs))}">written <b ${atAttr(
          isoOf(run.updatedAtMs),
        )}>${agoText(run.updatedAtMs)}</b></span>
        ${workflow ? `<span class="chip">workflow <b>${esc(workflow)}</b></span>` : ''}
        <span class="chip">closed <b>${counts.closed}</b></span>
        <span class="chip">open <b>${counts.open}</b></span>
        ${running ? '<span class="chip run-chip-live">running</span>' : ''}
      </div>
    </div>

    ${renderRunning(running)}

    <div class="panel run-tree-panel">
      <div class="run-tree-head">
        <span class="run-tree-title">backlog.json</span>
        <span class="run-tree-controls">
          <button type="button" class="ghost-button" data-tree="open">Expand all</button>
          <button type="button" class="ghost-button" data-tree="close">Collapse all</button>
        </span>
      </div>
      ${renderTree(held, { openPaths: openPathsFor(held) })}
    </div>
  `;
}
