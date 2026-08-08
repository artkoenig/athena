/**
 * argus-ui — the run view.
 *
 * The workflow state an argus collector holds: which runs it has seen, and for
 * one of them the backlog it was recorded from — the issue, the workflow, the
 * step in flight right now, the increments with their goals, their criteria,
 * their statuses, their recorded steps and their earlier attempts, and the
 * codemap. Pure functions returning HTML strings, like `timeline.js` and
 * `context.js`, so the suite imports this module straight into `node --test`
 * and no browser global is reachable here.
 *
 * Two shapes arrive from the collector and must never be confused: a list
 * entry's `increments` is a count, while `state.increments` is the array of
 * increments themselves. Everything shown per increment is read from the
 * state, never from the entry's own count.
 *
 * Nothing recorded is summarised away. A step return, the prompt that produced
 * it and every superseded attempt at it are all reachable from the pane; what
 * the page decides is only what is open by default, because a run holds far
 * more text than a screen does. Everything is laid out — an object as its
 * fields, a list as a list — rather than dumped as JSON, and the raw JSON stays
 * one click away for whatever the layout could not shape.
 *
 * Every `<details>` here carries a `data-panel` key naming its place in the run
 * rather than its position on the page — `inc/<id>/<label>/prompt`,
 * `run/attempts/0/<label>`. A run being worked rewrites this pane on every
 * write, and without those keys each rewrite would close whatever the reader
 * had opened; `renderRunView` in `app.js` reads them before it repaints and
 * puts each panel back the way the reader left it. That is why a key must be
 * stable across writes, and why the running step's key carries its label: a
 * different step is a different panel, and opens by default like the first.
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

/**
 * What a step whose return the recorder shed at close says in place of a
 * preview. A close deletes the `return` key outright, so the line has nothing
 * to show; saying why reads as the record it is rather than as a broken row.
 */
export const STEP_SHED_NOTE = 'return shed at close';

/** Whether a return is a plain object, the one shape a `summary` is read from. */
const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

/** JSON, or the value's own string form where it will not serialise. */
function jsonOf(value) {
  try {
    const text = JSON.stringify(value, null, 2);
    return typeof text === 'string' ? text : String(value);
  } catch {
    return String(value);
  }
}

/**
 * How deep the laid-out rendering goes before it hands the rest to JSON. A
 * step return is two or three levels at most — a list of findings, each with a
 * few fields, one of which may itself be a list — so a bound this size lays out
 * everything a run actually records, and the fall-back is there for the shape
 * nobody anticipated rather than as the ordinary case.
 */
const VALUE_DEPTH = 4;

/** A key as a heading: `testPlan` and `finding_count` read as words. */
export function fieldLabel(key) {
  return String(key ?? '')
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
}

/**
 * One recorded value, laid out.
 *
 * The recorder stores an agent's whole structured return, which is any JSON at
 * all: a paragraph of plan, a list of commands, a list of findings each with a
 * file and a reproduction. Rendering that as `JSON.stringify` output made the
 * page technically complete and practically unreadable — quotes, braces and
 * escaped newlines around the one sentence the reader came for. So each shape
 * gets the markup it is: a multi-line string keeps its lines, a list of strings
 * is a list, an object is its fields under their own names, and only what is
 * deeper than `VALUE_DEPTH` or of no shape at all falls back to JSON.
 */
export function renderValue(value, depth = 0) {
  if (value === null || value === undefined) return '<p class="run-value-empty">–</p>';
  if (typeof value === 'string') {
    if (!value.trim()) return '<p class="run-value-empty">–</p>';
    return value.includes('\n')
      ? `<pre class="run-value-text">${esc(value)}</pre>`
      : `<p class="run-value-text">${esc(value)}</p>`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return `<p class="run-value-scalar"><code>${esc(String(value))}</code></p>`;
  }
  if (depth >= VALUE_DEPTH) return `<pre class="run-value-raw">${esc(jsonOf(value))}</pre>`;
  if (Array.isArray(value)) {
    if (!value.length) return '<p class="run-value-empty">none</p>';
    return `<ul class="run-value-list">${value
      .map((item) => `<li>${renderValue(item, depth + 1)}</li>`)
      .join('')}</ul>`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (!keys.length) return '<p class="run-value-empty">none</p>';
    return `<dl class="run-fields">${keys
      .map(
        (key) =>
          `<dt>${esc(fieldLabel(key))}</dt><dd>${renderValue(value[key], depth + 1)}</dd>`,
      )
      .join('')}</dl>`;
  }
  return `<pre class="run-value-raw">${esc(jsonOf(value))}</pre>`;
}

/**
 * One recorded step, read for the page: `{ label, at, timeMs, hasReturn, text,
 * preview, prompt, history }`.
 *
 * The recorder writes `{ label, at, return }` with `at` an ISO-8601 string and
 * `return` the agent's whole structured return — any JSON value at all — plus
 * `prompt`, the dispatch prompt verbatim, and `history`, the entries this label
 * superseded, oldest first. So every field is treated as possibly absent or of
 * an unexpected shape, and an unparseable instant reads as `0`, which `fmtAgo`
 * prints as "never" rather than as `NaN`.
 *
 * The key's presence is what decides `hasReturn`, never its truthiness: a
 * return recorded as `null`, `0`, `''` or `false` is a return that was made.
 */
export function stepView(step) {
  const entry = step && typeof step === 'object' ? step : {};
  const label = typeof entry.label === 'string' ? entry.label : '';
  const at = typeof entry.at === 'string' ? entry.at : '';
  const parsed = Date.parse(at);
  const timeMs = Number.isFinite(parsed) ? parsed : 0;
  const hasReturn = Object.hasOwn(entry, 'return') && entry.return !== undefined;

  let text = '';
  if (hasReturn) {
    const value = entry.return;
    text = typeof value === 'string' ? value : jsonOf(value);
    if (typeof text !== 'string') text = String(value);
  }

  // The collapsed line prefers the return's own summary — every uroboros agent
  // return carries one — and falls back to the serialised text, so a return of
  // any other shape still shows something rather than nothing.
  const summary =
    hasReturn && isPlainObject(entry.return) && typeof entry.return.summary === 'string'
      ? entry.return.summary
      : '';
  const preview = hasReturn ? previewOf(summary || text) : STEP_SHED_NOTE;

  const prompt = typeof entry.prompt === 'string' ? entry.prompt : '';
  const history = Array.isArray(entry.history) ? entry.history : [];

  return { label, at, timeMs, hasReturn, text, preview, prompt, history, value: entry.return };
}

/**
 * The panels under one step: what the agent was asked, what it returned laid
 * out, the same return as raw JSON, and every attempt this one superseded.
 *
 * All four are `<details>` of their own and all four start closed. A step body
 * that opened with a page of prompt in it would bury the return underneath it,
 * and the return is what a reader opens a step for.
 */
function stepPanels(view, key) {
  const parts = [];
  if (view.prompt) {
    parts.push(
      `<details class="run-panel" data-panel="${attr(key)}/prompt"><summary>Prompt<span class="run-panel-hint">${esc(
        previewOf(view.prompt),
      )}</span></summary><pre class="run-prompt">${esc(view.prompt)}</pre></details>`,
    );
  }
  if (view.hasReturn) {
    parts.push(`<div class="run-return">${renderValue(view.value)}</div>`);
    parts.push(
      `<details class="run-panel" data-panel="${attr(
        key,
      )}/raw"><summary>Raw JSON</summary><pre class="run-step-return">${esc(
        view.text,
      )}</pre></details>`,
    );
  }
  if (view.history.length) {
    parts.push(
      `<details class="run-panel" data-panel="${attr(key)}/superseded"><summary>Superseded<span class="run-panel-hint">${
        view.history.length
      } earlier attempt(s)</span></summary><ol class="run-steps">${view.history
        .map((entry, at) => renderStep(entry, `${key}/history/${at}`))
        .join('')}</ol></details>`,
    );
  }
  return parts.join('');
}

/**
 * One step row: the collapsed line in the `<summary>`, everything the step
 * holds in the body. Native `<details>`, so opening one costs the page no state
 * of its own — and costs nothing to keep open across a repaint that only
 * rewrites the ages.
 */
function renderStep(step, keyPrefix = '') {
  const view = stepView(step);
  const key = `${keyPrefix}/${view.label}`;
  return `<li class="run-step"><details data-panel="${attr(
    key,
  )}"><summary><span class="run-step-label">${esc(
    view.label,
  )}</span><span class="run-step-preview">${esc(view.preview)}</span><span class="run-step-time" ${atAttr(
    view.at,
  )}>${agoText(view.timeMs)}</span></summary>${stepPanels(view, key)}</details></li>`;
}

/**
 * A list of recorded steps, in the order the backlog holds them and never
 * sorted. Empty for a list that is missing, not an array, or empty: a closed
 * increment's steps are shed by design, and its card should read as the
 * ordinary closed card it is rather than carry an empty panel.
 */
export function renderSteps(steps, keyPrefix = '') {
  const list = Array.isArray(steps) ? steps : [];
  if (!list.length) return '';
  return `<ol class="run-steps">${list.map((step) => renderStep(step, keyPrefix)).join('')}</ol>`;
}

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
 * This is the one panel that opens by default. It is the answer to the question
 * a reader has while a run is going — what is happening right now — and it is
 * gone from the state the moment that step returns, so it can never accumulate.
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

/** An increment's own acceptance criteria, as the planner cut them. */
function renderCriteria(criteria) {
  const list = Array.isArray(criteria) ? criteria.filter((c) => typeof c === 'string' && c) : [];
  if (!list.length) return '';
  return `<ul class="run-criteria">${list.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>`;
}

/**
 * The rounds this increment already closed. `close` moves an attempt's steps
 * into `attempts` rather than deleting them, so this is where the work of a
 * blocked first attempt is read back from — the one part of the record that was
 * written down and shown nowhere.
 */
function renderAttempts(attempts, keyPrefix = '') {
  const list = Array.isArray(attempts) ? attempts : [];
  if (!list.length) return '';
  return `<details class="run-panel" data-panel="${attr(
    keyPrefix,
  )}/attempts"><summary>Earlier attempts<span class="run-panel-hint">${
    list.length
  } closed</span></summary>${list
    .map((attempt, round) => {
      const closedAs = typeof attempt?.closedAs === 'string' ? attempt.closedAs : '';
      const at = typeof attempt?.at === 'string' ? attempt.at : '';
      const parsed = Date.parse(at);
      const timeMs = Number.isFinite(parsed) ? parsed : 0;
      return `<div class="run-attempt">
        <div class="run-attempt-head">
          ${closedAs ? `<span class="chip">${esc(closedAs)}</span>` : ''}
          <span class="run-step-time" ${atAttr(at)}>${agoText(timeMs)}</span>
        </div>
        ${renderSteps(attempt?.steps, `${keyPrefix}/attempts/${round}`)}
      </div>`;
    })
    .join('')}</details>`;
}

/**
 * One increment card, marked closed when its status says a close wrote it and
 * marked running while it is the one being worked. Everything the planner cut
 * into it is here — the goal it delivers and the criteria it is judged by, not
 * only its title and its status — because that is the brief every step under
 * the card was working to.
 */
function renderIncrement(increment, runningId = '') {
  const status = typeof increment?.status === 'string' ? increment.status : '';
  const note = typeof increment?.note === 'string' ? increment.note : '';
  const goal = typeof increment?.goal === 'string' ? increment.goal : '';
  // Rendered without a label of its own: a label with nothing after it is the
  // one thing an unset value must never leave behind.
  const worked = typeof increment?.branch === 'string' ? increment.branch : '';
  const isRunning = !!runningId && increment?.id === runningId;
  return `<li class="run-increment"${isClosedIncrement(increment) ? ' data-closed="true"' : ''}${
    isRunning ? ' data-running="true"' : ''
  }>
    <div class="run-increment-head">
      <span class="run-increment-id">${esc(increment?.id)}</span>
      <span class="run-increment-title">${esc(increment?.title)}</span>
      ${status ? `<span class="chip">${esc(status)}</span>` : ''}
      ${isRunning ? '<span class="chip run-chip-live">running</span>' : ''}
    </div>
    ${goal ? `<p class="run-goal">${esc(goal)}</p>` : ''}
    ${renderCriteria(increment?.criteria)}
    ${worked ? `<div class="run-increment-ref"><code>${esc(worked)}</code></div>` : ''}
    ${note ? `<p class="run-note">${esc(note)}</p>` : ''}
    ${renderSteps(increment?.steps, `inc/${increment?.id ?? ''}`)}
    ${renderAttempts(increment?.attempts, `inc/${increment?.id ?? ''}`)}
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
  const running = runningView(held);
  // The run's own steps — the opening cut, each close, the publish. The backlog
  // holds them under `run` rather than under any increment, so they sit in a
  // panel of their own: showing one inside a card would attribute a close or a
  // publish to whichever increment it landed near.
  const runSteps =
    held.run && typeof held.run === 'object' && Array.isArray(held.run.steps) ? held.run.steps : [];
  const runAttempts =
    held.run && typeof held.run === 'object' && Array.isArray(held.run.attempts)
      ? held.run.attempts
      : [];

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

    ${
      increments.length
        ? `<ol class="run-increments">${increments
            .map((increment) => renderIncrement(increment, running?.increment ?? ''))
            .join('')}</ol>`
        : '<div class="placeholder">No increments recorded for this run</div>'
    }

    ${
      runSteps.length || runAttempts.length
        ? `<div class="panel run-steps-panel">
             <div class="run-steps-head">Run steps</div>
             ${renderSteps(runSteps, 'run')}
             ${renderAttempts(runAttempts, 'run')}
           </div>`
        : ''
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
