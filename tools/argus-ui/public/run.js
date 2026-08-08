/**
 * argus-ui — the run view.
 *
 * The workflow state an argus collector holds: which runs it has seen, and for
 * one of them the backlog it was recorded from — the issue, the workflow, the
 * increments with their statuses, and the codemap. Pure functions returning
 * HTML strings, like `timeline.js` and `context.js`, so the suite imports this
 * module straight into `node --test` and no browser global is reachable here.
 *
 * Two shapes arrive from the collector and must never be confused: a list
 * entry's `increments` is a count, while `state.increments` is the array of
 * increments themselves. Everything shown per increment is read from the
 * state, never from the entry's own count.
 */

import { esc, fmtAgo } from './format.js';

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

/** One increment card, marked closed when its status says a close wrote it. */
function renderIncrement(increment) {
  const status = typeof increment?.status === 'string' ? increment.status : '';
  const note = typeof increment?.note === 'string' ? increment.note : '';
  // Rendered without a label of its own: a label with nothing after it is the
  // one thing an unset value must never leave behind.
  const worked = typeof increment?.branch === 'string' ? increment.branch : '';
  return `<li class="run-increment"${isClosedIncrement(increment) ? ' data-closed="true"' : ''}>
    <div class="run-increment-head">
      <span class="run-increment-id">${esc(increment?.id)}</span>
      <span class="run-increment-title">${esc(increment?.title)}</span>
      ${status ? `<span class="chip">${esc(status)}</span>` : ''}
    </div>
    ${worked ? `<div class="run-increment-ref"><code>${esc(worked)}</code></div>` : ''}
    ${note ? `<p class="run-note">${esc(note)}</p>` : ''}
  </li>`;
}

/**
 * One run, whole. The collector holds the recorded state opaquely, so every
 * field is treated as possibly absent: what is missing is left out rather than
 * printed as a hole.
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
  const increments = Array.isArray(held.increments) ? held.increments : [];
  const counts = incrementCounts(increments);
  const issue = run.issue || held.issue || run.id || '';
  const workflow = run.workflow || held.workflow || '';
  const codemap = typeof held.codemap === 'string' ? held.codemap : '';

  return `
    <div class="run-head">
      <h1 class="run-title">${esc(issue)}</h1>
      ${run.id ? `<div class="run-subtitle">${esc(run.id)}</div>` : ''}
      <div class="chips">
        <span class="chip" data-updated="${esc(isoOf(run.updatedAtMs))}">written <b>${esc(
          fmtAgo(run.updatedAtMs),
        )}</b></span>
        ${workflow ? `<span class="chip">workflow <b>${esc(workflow)}</b></span>` : ''}
        <span class="chip">closed <b>${counts.closed}</b></span>
        <span class="chip">open <b>${counts.open}</b></span>
      </div>
    </div>

    ${
      increments.length
        ? `<ol class="run-increments">${increments.map(renderIncrement).join('')}</ol>`
        : '<div class="placeholder">No increments recorded for this run</div>'
    }

    ${
      codemap
        ? `<div class="panel run-codemap">
             <div class="run-codemap-head">Codemap</div>
             <pre>${esc(codemap)}</pre>
           </div>`
        : ''
    }
  `;
}
