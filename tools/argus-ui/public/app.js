/**
 * argus-ui — front end.
 *
 * Reads the JSON API of its own server, which forwards to a collector, and
 * keeps itself current from an SSE stream. There is no framework and no build
 * step on purpose: the whole tool has to be runnable with
 * `node bin/argus-ui.mjs` inside a throwaway sandbox.
 */

import { esc, fmtNum, fmtCost, fmtClock, fmtAgo, isLive, shortId } from './format.js';
import {
  contextEntryIds,
  fetchLaneContext,
  hiddenAfterAll,
  lanePanelInput,
  renderContextPanel,
} from './context.js';
import {
  buildLanes,
  buildDensity,
  mergeToolMarks,
  renderTimeline,
  resolveCursor,
  scrubCursor,
  liveCursor,
  TOOL_EVENT,
} from './timeline.js';
import { pickRunId, renderRun, renderRunList, runFrame, shouldLoadRun } from './run.js';

const TOKEN = new URLSearchParams(location.search).get('token');

const state = {
  sessions: [],
  stats: null,
  config: null,
  selectedSessionId: null,
  session: null,
  content: [],
  // Tool calls, kept as a mark and nothing more — seq, moment and span. That is
  // all a lane's tick marks and its count need, and holding a call's parameters
  // here would be a session's worth of file contents kept for nothing.
  toolMarks: [],
  toolSeq: 0,
  // A session opens live: the cursor sits on the newest data and moves with it
  // as more arrives. Scrubbing pins an absolute moment and leaves live mode.
  cursor: { live: true, timeMs: null },
  // No lane is open until one is clicked, so the timeline stands alone first.
  selectedLane: null,
  // The record the panel is drawn from, tagged with the lane it was fetched
  // for: an answer that arrives after the selection moved on must not be painted.
  laneContext: { key: null, item: null },
  // Which blocks the reader has expanded, so a live refresh does not shut them.
  expanded: new Set(),
  // Which context entries the reader has hidden, whether the filter's own
  // dropdown is open, and what they are searching the context for. All three are
  // page-wide and last until the page is reloaded: hiding a kind and looking for
  // a string are preferences, not positions, so none is reset where `expanded`
  // is, and none is written to storage.
  contextHidden: new Set(),
  contextFilterOpen: false,
  contextSearch: '',
  search: '',
  authError: false,
  // The run view, beside the session view: the runs the collector holds, which
  // one is shown, and the entry fetched for it. The page opens on the sessions.
  runs: [],
  selectedRunId: null,
  run: null,
  view: 'sessions',
};

/* --------------------------------- api ---------------------------------- */

async function api(path, params = {}) {
  const url = new URL(path, location.origin);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== '') url.searchParams.set(key, value);
  }
  if (TOKEN) url.searchParams.set('token', TOKEN);
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  // The status is carried along because 401 is the one failure the page can tell
  // the user how to fix, and "unreachable" would be the wrong thing to say.
  if (!response.ok) {
    throw Object.assign(new Error(`${response.status} ${response.statusText}`), { status: response.status });
  }
  return response.json();
}

/* ------------------------------- top bar -------------------------------- */

function renderStats() {
  const strip = document.getElementById('stat-strip');
  const stats = state.stats;
  if (!stats) {
    strip.innerHTML = '';
    return;
  }
  const t = stats.totals;
  const cards = [
    { label: 'sessions', value: `${t.sessions}${t.activeSessions ? ` · ${t.activeSessions} live` : ''}` },
    { label: 'cost', value: fmtCost(t.costUsd) },
    { label: 'tokens', value: fmtNum(Object.values(t.tokens).reduce((a, b) => a + b, 0)) },
    { label: 'llm calls', value: fmtNum(t.llmRequests) },
    { label: 'tool calls', value: fmtNum(t.toolCalls) },
    {
      label: 'errors',
      value: fmtNum(t.apiErrors + t.toolFailures),
      tone: t.apiErrors + t.toolFailures > 0 ? 'error' : null,
    },
    { label: 'buffered', value: `${fmtNum(stats.buffered.spans)} spans` },
  ];
  strip.innerHTML = cards
    .map(
      (card) => `<div class="stat"${card.tone ? ` data-tone="${card.tone}"` : ''}>
        <span class="stat-value">${esc(card.value)}</span>
        <span class="stat-label">${esc(card.label)}</span>
      </div>`,
    )
    .join('');
}

function setLive(stateName, label) {
  const indicator = document.getElementById('live-indicator');
  indicator.dataset.state = stateName;
  indicator.querySelector('.live-label').textContent = label;
}

/* ----------------------------- session list ----------------------------- */

function renderSessionList() {
  const list = document.getElementById('session-list');
  document.getElementById('session-count').textContent = state.sessions.length;
  if (!state.sessions.length) {
    list.innerHTML = '<li class="placeholder">No sessions yet</li>';
    return;
  }
  list.innerHTML = state.sessions
    .map((session) => {
      const errors = session.counts.apiErrors + session.counts.toolFailures;
      // A named session leads with its name; the id stays on the card because it
      // is what every other view, log line and API path refers to.
      return `<li>
        <button type="button" class="session-card" data-session="${esc(session.id)}"
          aria-current="${session.id === state.selectedSessionId}">
          <span class="session-card-top">
            ${isLive(session) ? '<span class="dot-live" aria-label="live"></span>' : ''}
            <span class="${session.name ? 'session-name' : 'session-id'}" title="${esc(session.id)}">${esc(
              session.name || shortId(session.id, 20),
            )}</span>
          </span>
          ${session.name ? `<span class="session-sub" title="${esc(session.id)}">${esc(shortId(session.id, 20))}</span>` : ''}
          <span class="session-card-meta">
            <span>${esc(fmtAgo(session.lastSeenMs))}</span>
            <span>${esc(fmtCost(session.costUsd))}</span>
            <span>${esc(fmtNum(session.tokensTotal))} tok</span>
            ${errors ? `<span class="err">${errors} err</span>` : ''}
          </span>
        </button>
      </li>`;
    })
    .join('');
}

/* -------------------------------- detail -------------------------------- */

function renderDetail() {
  const detail = document.getElementById('detail');
  const session = state.session;
  if (!session) {
    renderEmptyState();
    return;
  }
  const errors = session.counts.apiErrors + session.counts.toolFailures;

  detail.innerHTML = `
    <div class="detail-head">
      <div>
        <h1 class="detail-title"${session.name ? ' data-named="true"' : ''}>${esc(session.name || session.id)}</h1>
        ${session.name ? `<div class="detail-subtitle">${esc(session.id)}</div>` : ''}
        <div class="chips">
          ${isLive(session) ? '<span class="chip" data-tone="live">live</span>' : ''}
          <span class="chip">service <b>${esc(session.serviceName)}</b></span>
          ${session.attrs['app.entrypoint'] ? `<span class="chip">entrypoint <b>${esc(session.attrs['app.entrypoint'])}</b></span>` : ''}
          ${session.attrs['app.version'] ? `<span class="chip">cli <b>${esc(session.attrs['app.version'])}</b></span>` : ''}
          ${session.startTypes.length ? `<span class="chip">start <b>${esc(session.startTypes.join(', '))}</b></span>` : ''}
          <span class="chip">started <b>${esc(new Date(session.firstSeenMs).toLocaleString())}</b></span>
          <span class="chip">last seen <b>${esc(fmtAgo(session.lastSeenMs))}</b></span>
          ${errors ? `<span class="chip" data-tone="error">${errors} error${errors === 1 ? '' : 's'}</span>` : ''}
        </div>
      </div>
    </div>

    ${renderTimeline(
      buildDensity(buildLanes({ session, content: state.content }), {
        content: state.content,
        tools: state.toolMarks,
      }),
      state.cursor,
      state.selectedLane,
    )}

    <div id="lane-panel"></div>
  `;
  renderLanePanel();
}

/* ------------------------------ empty state ----------------------------- */

// Submitting reloads with the token in the query, which is the one request that
// carries it: the server trades it for a cookie and redirects back here without
// it. So the address bar never keeps the secret and nothing has to be retyped.
const TOKEN_PROMPT = `
  <form class="token-form">
    <input name="token" type="password" autocomplete="current-password"
      placeholder="access token" aria-label="Access token" />
    <button type="submit" class="ghost-button">Unlock</button>
  </form>`;

function renderEmptyState() {
  const detail = document.getElementById('detail');
  const env = state.config?.env ?? {};
  const block = Object.entries(env)
    .map(([key, value]) => `export ${key}="${value}"`)
    .join('\n');

  // Without the config there is no env block to show, and printing the promise
  // above an empty box tells the reader nothing about what went wrong.
  if (!block) {
    detail.innerHTML = `
      <div class="empty">
        <h1>${state.authError ? 'Token required' : 'Collector unreachable'}</h1>
        <p>${
          state.authError
            ? 'This interface is protected. Enter the token it was started with — the value ' +
              'of --token, which it also prints on startup. It is stored in a cookie, so this ' +
              'is asked once per browser.'
            : 'The page loaded but the collector did not answer. It may have stopped, or this ' +
              'interface may be pointed at a different address than the one it runs on.'
        }</p>
        ${state.authError ? TOKEN_PROMPT : ''}
      </div>`;
    return;
  }

  detail.innerHTML = `
    <div class="empty">
      <h1>Waiting for telemetry</h1>
      <p>
        Nothing has been exported to this collector yet. Start a Claude Agent SDK or Claude Code
        run with the environment below and sessions will appear here.
      </p>
      <div class="env-block">
        <div class="env-block-head"><span>Agent environment</span>
          <button type="button" class="ghost-button" data-copy="setup-env">Copy</button></div>
        <pre id="setup-env">${esc(block)}</pre>
      </div>
      <p class="muted">
        The block above already carries everything spans and conversation content need. Export
        intervals are lowered to 1s so short runs flush before the process exits.
      </p>
    </div>`;
}

function renderSetupModal() {
  const env = state.config?.env ?? {};
  // Same reason as the empty state: every block in here is built from the
  // config, so without it the dialog is three headings over three empty boxes.
  if (!Object.keys(env).length) {
    document.getElementById('setup-modal-body').innerHTML = `
      <p>${
        state.authError
          ? 'The environment block cannot be shown because this page is not authorized. ' +
            'Enter the token this interface was started with and it will be included below.'
          : 'The collector did not answer, so there is no endpoint to point an agent at yet.'
      }</p>
      ${state.authError ? TOKEN_PROMPT : ''}`;
    return;
  }
  const shell = Object.entries(env)
    .map(([key, value]) => `export ${key}="${value}"`)
    .join('\n');
  const ts = `const otelEnv = ${JSON.stringify(env, null, 2)};

for await (const message of query({
  prompt: "…",
  options: { env: { ...process.env, ...otelEnv } },
})) {
  console.log(message);
}`;
  const py = `OTEL_ENV = ${JSON.stringify(env, null, 4)}

options = ClaudeAgentOptions(env=OTEL_ENV)`;

  document.getElementById('setup-modal-body').innerHTML = `
    <h3>Shell / container</h3>
    <div class="env-block">
      <div class="env-block-head"><span>export</span>
        <button type="button" class="ghost-button" data-copy="env-shell">Copy</button></div>
      <pre id="env-shell">${esc(shell)}</pre>
    </div>
    <p class="muted">
      Claude Code exports no session name of its own. To give a session one, add
      <code>OTEL_RESOURCE_ATTRIBUTES="session.name=…"</code> to the block above <em>before</em>
      starting it — the OTel resource is built once at process start, so it cannot be set
      afterwards. Without it, sessions are listed by their id.
    </p>
    <h3>TypeScript SDK</h3>
    <div class="env-block">
      <div class="env-block-head"><span>options.env replaces the inherited environment</span>
        <button type="button" class="ghost-button" data-copy="env-ts">Copy</button></div>
      <pre id="env-ts">${esc(ts)}</pre>
    </div>
    <h3>Python SDK</h3>
    <div class="env-block">
      <div class="env-block-head"><span>env is merged onto the inherited environment</span>
        <button type="button" class="ghost-button" data-copy="env-py">Copy</button></div>
      <pre id="env-py">${esc(py)}</pre>
    </div>
    <p class="muted">
      Do not use the <code>console</code> exporter with the SDK — stdout is the SDK's message
      channel. Set <code>CLAUDE_CODE_OTEL_DIAG_STDERR=1</code> if exports appear to go missing;
      the CLI drops telemetry silently otherwise.
    </p>`;
}

/* ------------------------------ data loading ---------------------------- */

async function loadSessions() {
  const data = await api('/api/sessions', { search: state.search, limit: 200 });
  state.sessions = data.items;
  if (!state.selectedSessionId && state.sessions.length) {
    selectSession(state.sessions[0].id, { render: false });
  }
  renderSessionList();
}

async function loadStats() {
  state.stats = await api('/api/stats');
  renderStats();
}

async function loadSession() {
  if (!state.selectedSessionId) {
    state.session = null;
    return;
  }
  try {
    state.session = await api(`/api/sessions/${encodeURIComponent(state.selectedSessionId)}`);
  } catch {
    state.session = null;
    state.selectedSessionId = null;
  }
}

/** With no session there is nothing to draw, so every index behind the lanes empties together. */
function clearTimelineIndexes() {
  state.content = [];
  state.toolMarks = [];
  state.toolSeq = 0;
}

/**
 * The two indexes behind the lanes: the content records for the context curve,
 * and the tool results for the activity marks. A failure here costs the lanes,
 * not the page, and each half fails on its own.
 */
async function loadTimeline() {
  const id = state.selectedSessionId;
  if (!id) {
    clearTimelineIndexes();
    return;
  }
  // sinceSeq is why the refresh that fires on every ingest ships nothing it has.
  const [content, tools] = await Promise.all([
    api('/api/content', { session: id, limit: 2000 }).catch(() => null),
    api('/api/events', { session: id, event: TOOL_EVENT, sinceSeq: state.toolSeq, limit: 2000 }).catch(() => null),
  ]);
  // A second refresh can start while these are in flight — selectSession calls
  // refresh() directly. An answer for a session that is no longer selected must
  // be dropped whole: appending it would put another session's tool calls on
  // these lanes and push the watermark past this session's own records.
  if (state.selectedSessionId !== id) return;
  state.content = content?.items ?? [];
  const merged = mergeToolMarks(state.toolMarks, tools?.items ?? []);
  state.toolMarks = merged.marks;
  state.toolSeq = merged.seq;
}

/**
 * The lanes as the page currently holds them. The loader needs the window and
 * the selected lane's span, and a second pure build over at most 2000 records
 * costs nothing — but it must stay out of renderDetail, whose composed
 * expression the suite pins by source order.
 */
function laneView() {
  return buildLanes({ session: state.session, content: state.content });
}

/** With no lane selected there is nothing to draw, so the held answer goes too. */
function clearLaneContext() {
  state.laneContext = { key: null, item: null };
}

/**
 * The context behind the selected lane, as of the cursor's moment.
 *
 * A failed fetch costs the panel and not the page, which is why the rejection
 * is swallowed here rather than thrown at whoever is refreshing.
 */
async function loadLaneContext() {
  const id = state.selectedSessionId;
  const key = state.selectedLane;
  if (!id || !key) {
    clearLaneContext();
    return;
  }
  const held = await fetchLaneContext(api, { session: id, key, view: laneView(), cursor: state.cursor });
  // The selection can move while this is in flight — a click, a scrub or a
  // session change. An answer for a lane the reader has left must never be
  // painted under the lane they are on now.
  if (state.selectedSessionId !== id || state.selectedLane !== key) return;
  state.laneContext = held;
}

/**
 * The panel repaints inside its own container. A full re-render would replace
 * the scrub slider under the pointer and end the drag that asked for it.
 *
 * The repaint still replaces the panel's own search box, and typing in it is
 * what asks for the repaint — so the focus and the caret go back where they
 * were, or the second character of a query could never be typed.
 */
function renderLanePanel() {
  const container = document.getElementById('lane-panel');
  if (!container) return;
  const active = document.activeElement;
  const focusId = active && container.contains(active) ? active.id : null;
  const caret = typeof active?.selectionStart === 'number' ? active.selectionStart : null;
  const view = laneView();
  container.innerHTML = renderContextPanel(
    lanePanelInput({
      view,
      key: state.selectedLane,
      held: state.laneContext,
      expanded: state.expanded,
      hidden: state.contextHidden,
      filterOpen: state.contextFilterOpen,
      search: state.contextSearch,
    }),
  );
  if (!focusId) return;
  const restored = document.getElementById(focusId);
  if (!restored) return;
  restored.focus();
  if (caret !== null && typeof restored.setSelectionRange === 'function') {
    restored.setSelectionRange(caret, caret);
  }
}

let laneContextTimer = null;
/** A drag across the slider fires one fetch when it settles, not one per pixel. */
function scheduleLaneContext(delay = 250) {
  clearTimeout(laneContextTimer);
  laneContextTimer = setTimeout(() => {
    laneContextTimer = null;
    loadLaneContext().then(renderLanePanel);
  }, delay);
}

/** Full refresh, preserving scroll position and any focused filter input. */
async function refresh({ sessions = true } = {}) {
  const detail = document.getElementById('detail');
  const scrollTop = detail.scrollTop;
  const active = document.activeElement;
  const focusId = active?.id;
  const selection = typeof active?.selectionStart === 'number' ? active.selectionStart : null;

  // The session list may pick the default selection, so it has to settle before
  // the session detail is fetched.
  try {
    await Promise.all([loadStats(), sessions ? loadSessions() : Promise.resolve()]);
    await loadSession();
    await loadTimeline();
    // Live mode follows the head, so new requests have to reach the panel too.
    await loadLaneContext();
  } catch (error) {
    // A failed load must not skip the render. The empty state is the only thing
    // that can explain the failure, so throwing past it leaves the untouched
    // markup from index.html on screen — which promises data and shows none.
    if (error.status === 401) state.authError = true;
    setLive('offline', state.authError ? 'token required' : 'unreachable');
  }
  renderDetail();

  detail.scrollTop = scrollTop;
  if (focusId && focusId !== 'session-search') {
    const restored = document.getElementById(focusId);
    if (restored) {
      restored.focus();
      if (selection !== null && typeof restored.setSelectionRange === 'function') {
        restored.setSelectionRange(selection, selection);
      }
    }
  }
}

function selectSession(id, { render = true } = {}) {
  if (state.selectedSessionId === id) return;
  state.selectedSessionId = id;
  state.content = [];
  state.toolMarks = [];
  state.toolSeq = 0;
  // A new session never inherits a moment pinned in another one, nor a lane, nor
  // the context and expansions that belonged to it.
  state.cursor = liveCursor();
  state.selectedLane = null;
  state.laneContext = { key: null, item: null };
  state.expanded = new Set();
  location.hash = `#/session/${encodeURIComponent(id)}`;
  if (render) refresh({ sessions: false }).then(renderSessionList);
}

/* -------------------------------- run view ------------------------------- */

/** The picker beside the session list: one row per run the collector holds. */
function renderRunPicker() {
  const list = document.getElementById('run-list');
  if (!list) return;
  document.getElementById('run-count').textContent = state.runs.length;
  list.innerHTML = renderRunList({ items: state.runs, selectedId: state.selectedRunId });
}

/**
 * What the reader's place in the run pane is, so a repaint can put them back:
 * which node they had focused, and — for a `<summary>` — which panel it belongs
 * to. Keyboard readers move through this pane by its disclosures, and a repaint
 * that dropped focus to the document body would end that walk mid-run.
 */
function runFocus(container) {
  const active = document.activeElement;
  if (!active || !container.contains(active)) return null;
  const control = active.closest('[data-tree]');
  if (control) return { tree: control.dataset.tree };
  const panel = active.closest('details[data-panel]');
  return panel ? { panel: panel.dataset.panel } : null;
}

// The markup this pane was last painted with. Compared rather than the DOM,
// which `retimeRunView` edits in place between two paints.
let paintedRun = null;

/**
 * The run pane, which is the whole of what the run view paints outside the
 * picker.
 *
 * A run being worked rewrites this pane on every write, and a rewrite that
 * disturbed a reader mid-page would make the pane unusable exactly while the
 * run is interesting. So a repaint puts back everything about where they were:
 *
 * - **Which nodes were open**, read off the old markup by the `data-panel` key
 *   `run.js` gives each one. The flag is restored in both directions — a node
 *   the reader folded stays folded — and a key that was not there before keeps
 *   whatever default it rendered with, which is how a newly dispatched step
 *   arrives with its prompt already open.
 * - **Where they were on the page**, after the flags and not before: the pane's
 *   height depends on what is open, and a scroll position written against the
 *   folded page would land somewhere else entirely.
 * - **What they had focused**, without scrolling to it, which would undo the
 *   line above.
 *
 * And a paint that would change nothing is not made at all: writing markup
 * identical to what is already there would throw away the reader's text
 * selection for no change on screen.
 */
function renderRunView() {
  const container = document.getElementById('run-detail');
  if (!container) return;
  const markup = renderRun(state.run);
  if (markup === paintedRun) return;

  const remembered = new Map(
    [...container.querySelectorAll('details[data-panel]')].map((node) => [node.dataset.panel, node.open]),
  );
  const scrollTop = container.scrollTop;
  const focus = runFocus(container);

  container.innerHTML = markup;
  paintedRun = markup;

  let refocus = focus?.tree ? container.querySelector(`[data-tree="${focus.tree}"]`) : null;
  for (const node of container.querySelectorAll('details[data-panel]')) {
    const was = remembered.get(node.dataset.panel);
    if (was !== undefined) node.open = was;
    if (focus?.panel === node.dataset.panel) refocus = node.querySelector('summary');
  }
  refocus?.focus({ preventScroll: true });
  container.scrollTop = scrollTop;
}

/**
 * Every node of the document tree opened or folded at once.
 *
 * The tree is native `<details>`, so this is the whole of it: no state of the
 * page's own is touched, and the next repaint reads the flags back off the
 * markup by their `data-panel` keys exactly as it does after a click.
 */
function setTreeOpen(open) {
  const container = document.getElementById('run-detail');
  if (!container) return;
  for (const node of container.querySelectorAll('details[data-panel]')) node.open = open;
}

/**
 * The ages in the run pane, brought current without repainting it.
 *
 * A run writes its state once per step, and a step runs for minutes: between
 * two writes the only thing in the pane that has moved is how long the step in
 * flight has been running. Repainting the pane to show that would collapse
 * every `<details>` the reader had opened, so this rewrites the text of the
 * elements that carry an instant in `data-at` and touches nothing else. It
 * fetches nothing — the state it is showing has not changed, only the clock.
 */
function retimeRunView() {
  const container = document.getElementById('run-detail');
  if (!container) return;
  for (const node of container.querySelectorAll('[data-at]')) {
    const at = Date.parse(node.dataset.at ?? '');
    node.textContent = fmtAgo(Number.isFinite(at) ? at : 0);
  }
}

/**
 * The runs the collector holds. The list arrives latest-write-first, so which
 * run to show is a pick over it and never a sort.
 */
async function loadRuns() {
  const data = await api('/api/runs');
  state.runs = Array.isArray(data?.items) ? data.items : [];
  state.selectedRunId = pickRunId(state.runs, state.selectedRunId);
}

/**
 * The selected run, state included. A failure costs the pane and not the page,
 * and an answer for a run the reader has left is dropped whole.
 */
async function loadRun() {
  const id = state.selectedRunId;
  if (!id) {
    state.run = null;
    return;
  }
  try {
    const held = await api(`/api/runs/${encodeURIComponent(id)}`);
    if (state.selectedRunId !== id) return;
    state.run = held;
  } catch {
    if (state.selectedRunId !== id) return;
    state.run = null;
  }
}

/**
 * The run view, brought up to date. `changedId` is the run an SSE frame named;
 * whether that means the shown run's state has to be asked for again is
 * shouldLoadRun's decision. A collector that serves no run endpoints costs the
 * page nothing.
 */
async function refreshRuns(changedId = null) {
  try {
    const shown = state.selectedRunId;
    await loadRuns();
    if (shouldLoadRun({ changedId, shownId: shown, selectedId: state.selectedRunId })) await loadRun();
    renderRunPicker();
    renderRunView();
  } catch {
    // Nothing to show and nothing to say: the session view is unaffected.
  }
}

/** Switching runs: the address bar follows, so the view survives a reload. */
async function selectRun(id) {
  if (state.selectedRunId === id) return;
  state.selectedRunId = id;
  location.hash = `#/run/${encodeURIComponent(id)}`;
  renderRunPicker();
  await loadRun();
  renderRunView();
}

/** Which of the two views is on screen. The stylesheet switches on the body flag. */
function setView(name) {
  state.view = name;
  document.body.dataset.view = name;
  for (const button of document.querySelectorAll('.view-switch [data-view]')) {
    button.setAttribute('aria-current', String(button.dataset.view === name));
  }
}

/* --------------------------------- wiring -------------------------------- */

function copyFrom(id) {
  const node = document.getElementById(id);
  if (!node) return;
  navigator.clipboard?.writeText(node.textContent ?? '').then(() => {
    const button = document.querySelector(`[data-copy="${id}"]`);
    if (!button) return;
    const original = button.textContent;
    button.textContent = 'Copied';
    setTimeout(() => {
      button.textContent = original;
    }, 1200);
  });
}

// True while a pointer is holding the scrub thumb. The pointer is often
// released outside the slider, so the release is watched on the window.
let scrubbing = false;

/**
 * The cursor's position, written straight into the DOM: a full re-render would
 * replace the slider under the pointer and end the drag. The window is read off
 * the control itself, and the position is resolved once so the line, the thumb
 * and the readout cannot disagree.
 */
function paintCursor() {
  const input = document.getElementById('timeline-scrub');
  if (!input) return;
  const active = resolveCursor(state.cursor, { startMs: Number(input.min), endMs: Number(input.max) });
  for (const node of document.querySelectorAll('[data-cursor-pos]')) {
    node.style.left = `${active.leftPct.toFixed(3)}%`;
  }
  input.value = String(active.timeMs);
  const readout = document.getElementById('timeline-cursor-time');
  if (readout) {
    readout.textContent = fmtClock(active.timeMs);
    readout.dataset.time = String(active.timeMs);
  }
  const control = document.querySelector('[data-cursor-live]');
  if (control) control.setAttribute('aria-pressed', String(active.live));
}

/** A drag reads its window off the control it came from. */
function scrubTo(input) {
  state.cursor = scrubCursor(Number(input.value), { startMs: Number(input.min), endMs: Number(input.max) });
  paintCursor();
  scheduleLaneContext();
}

let refreshTimer = null;
function scheduleRefresh(delay = 400) {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    // A re-render mid-drag replaces the slider under the pointer and the scrub
    // dies with it, so a refresh waits for the pointer to be released.
    if (scrubbing) {
      scheduleRefresh(delay);
      return;
    }
    refresh().catch(() => setLive('offline', 'error'));
  }, delay);
}

function connectStream() {
  const url = TOKEN ? `/api/stream?token=${encodeURIComponent(TOKEN)}` : '/api/stream';
  const source = new EventSource(url);
  source.addEventListener('hello', () => setLive('live', 'live'));
  source.addEventListener('ingest', () => {
    setLive('live', 'live');
    scheduleRefresh();
  });
  // The frame names which run changed and when, never its state, so the view
  // has to ask for it. The stream is proof of life either way, which is why the
  // indicator is set whether or not the frame parsed.
  source.addEventListener('run', (event) => {
    const changed = runFrame(event.data)?.id;
    if (changed) refreshRuns(changed);
    setLive('live', 'live');
  });
  source.onerror = () => {
    setLive('offline', 'reconnecting');
    // EventSource reconnects on its own; nothing to do but reflect the state.
  };
}

function wireEvents() {
  document.getElementById('session-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-session]');
    if (button) selectSession(button.dataset.session);
  });

  document.getElementById('run-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-run]');
    if (button) selectRun(button.dataset.run);
  });

  document.getElementById('run-detail').addEventListener('click', (event) => {
    const control = event.target.closest('[data-tree]');
    if (control) setTreeOpen(control.dataset.tree === 'open');
  });

  document.querySelector('.view-switch').addEventListener('click', (event) => {
    const button = event.target.closest('[data-view]');
    if (button) setView(button.dataset.view);
  });

  document.getElementById('detail').addEventListener('click', (event) => {
    const copy = event.target.closest('[data-copy]');
    if (copy) {
      copyFrom(copy.dataset.copy);
      return;
    }
    const live = event.target.closest('[data-cursor-live]');
    if (live) {
      // Returning to live is a full re-render, which is safe: no drag is in flight.
      state.cursor = liveCursor();
      renderDetail();
      // The moment moved with it, so the panel has to be fetched again.
      loadLaneContext().then(renderLanePanel);
      return;
    }
    const laneRow = event.target.closest('[data-lane]');
    if (laneRow) {
      // Clicking the lane that is already open closes it again, so the timeline
      // stands alone without a second control to press.
      state.selectedLane = state.selectedLane === laneRow.dataset.lane ? null : laneRow.dataset.lane;
      state.expanded = new Set();
      renderLanePanel();
      loadLaneContext().then(renderLanePanel);
      return;
    }
    const block = event.target.closest('summary[data-block]');
    if (block) {
      // The browser has already opened or closed the <details>; this only
      // remembers which, so the next repaint does not undo it. Bound to the
      // summary alone: selecting text inside an expanded block is not a toggle.
      if (state.expanded.has(block.dataset.block)) state.expanded.delete(block.dataset.block);
      else state.expanded.add(block.dataset.block);
      return;
    }
    const filter = event.target.closest('summary[data-ctx-filter]');
    if (filter) {
      // The browser has already opened or shut the dropdown; this only
      // remembers which, so the next repaint does not undo it.
      state.contextFilterOpen = !state.contextFilterOpen;
      return;
    }
    const all = event.target.closest('[data-ctx-all]');
    if (all) {
      // The record the panel is drawn from is already held: turning entries on
      // or off never goes back to the collector for it.
      state.contextHidden = hiddenAfterAll(
        state.contextHidden,
        contextEntryIds(state.laneContext.item),
        all.dataset.ctxAll === 'on',
      );
      renderLanePanel();
      return;
    }
  });

  document.getElementById('detail').addEventListener('change', (event) => {
    // A wrapping <label> fires two click events for one press, so the filter's
    // checkboxes are toggled on `change`, which fires exactly once.
    const entry = event.target.closest('input[data-ctx-entry]');
    if (entry) {
      const id = entry.dataset.ctxEntry;
      if (state.contextHidden.has(id)) state.contextHidden.delete(id);
      else state.contextHidden.add(id);
      renderLanePanel();
    }
  });

  // A drag has to be known about before the next scheduled refresh fires.
  document.getElementById('detail').addEventListener('pointerdown', (event) => {
    if (event.target.id === 'timeline-scrub') scrubbing = true;
  });
  for (const name of ['pointerup', 'pointercancel']) {
    window.addEventListener(name, () => {
      scrubbing = false;
    });
  }

  document.getElementById('detail').addEventListener('input', (event) => {
    // Keyboard scrubbing (arrow keys on a range) arrives here too.
    if (event.target.id === 'timeline-scrub') {
      scrubTo(event.target);
      return;
    }
    // The search runs over the record the panel already holds, so a keystroke
    // costs a repaint and never a request. The type="search" clear button and
    // Escape both arrive here as an input event with an empty value, which is
    // exactly what turning the search off looks like.
    if (event.target.matches('input[data-ctx-search]')) {
      state.contextSearch = event.target.value;
      renderLanePanel();
    }
  });

  let sessionSearchTimer = null;
  document.getElementById('session-search').addEventListener('input', (event) => {
    state.search = event.target.value;
    clearTimeout(sessionSearchTimer);
    sessionSearchTimer = setTimeout(() => loadSessions(), 200);
  });

  const modal = document.getElementById('setup-modal');
  document.getElementById('setup-button').addEventListener('click', () => {
    renderSetupModal();
    modal.showModal();
  });
  modal.addEventListener('click', (event) => {
    const copy = event.target.closest('[data-copy]');
    if (copy) {
      event.preventDefault();
      copyFrom(copy.dataset.copy);
    }
  });

  // Delegated: the prompt is rendered into both the detail pane and the dialog,
  // and both get replaced wholesale on every render.
  document.addEventListener('submit', (event) => {
    const form = event.target.closest('.token-form');
    if (!form) return;
    event.preventDefault();
    const value = form.elements.token.value.trim();
    if (value) location.search = `?token=${encodeURIComponent(value)}`;
  });

  window.addEventListener('hashchange', () => {
    const match = location.hash.match(/^#\/session\/(.+)$/);
    if (match) selectSession(decodeURIComponent(match[1]));
    const runMatch = location.hash.match(/^#\/run\/(.+)$/);
    if (runMatch) {
      selectRun(decodeURIComponent(runMatch[1]));
      setView('runs');
    }
  });
}

async function boot() {
  wireEvents();
  try {
    state.config = await api('/api/config');
  } catch (error) {
    state.authError = error.status === 401;
    setLive('offline', state.authError ? 'token required' : 'unreachable');
  }
  const match = location.hash.match(/^#\/session\/(.+)$/);
  if (match) state.selectedSessionId = decodeURIComponent(match[1]);
  const runMatch = location.hash.match(/^#\/run\/(.+)$/);
  if (runMatch) {
    state.selectedRunId = decodeURIComponent(runMatch[1]);
    setView('runs');
  }
  await refresh();
  // EventSource reconnects on its own forever, which for a rejected token means
  // a request every few seconds that can never succeed. The page has already
  // said what to do about it; retrying adds noise, not a recovery.
  if (!state.authError) connectStream();
  // Sessions age out of "live" and relative timestamps drift; repaint slowly.
  // The run pane is retimed rather than repainted, so a reader's open panels
  // survive the tick — and neither half asks the collector for anything.
  setInterval(() => {
    renderSessionList();
    retimeRunView();
  }, 15_000);
}

/**
 * The page. The session view boots first, then the run view fills itself once
 * — it lives outside boot() so that no timer inside boot can ever be read as
 * the thing that fetches run state, which a source-text guard pins.
 */
async function start() {
  await boot();
  await refreshRuns();
}

start();
