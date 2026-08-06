/**
 * argus-ui — the tools one lane has used, up to a moment.
 *
 * The sibling of `context.js` under the same click: that module answers "what
 * was in this agent's context at this moment", this one answers "what had it
 * done by then, and what for". It needs no fetch of its own — every tool call
 * of the session is already in page state, put there by the incremental
 * `/api/events` poll the lanes are drawn from — so the list paints the instant
 * a lane is clicked, whether or not the context has arrived.
 *
 * No `document`, no `fetch`, no `location`, the same contract `timeline.js` and
 * `context.js` keep.
 */

import { esc, fmtClock, fmtNum } from './format.js';
import { laneByKey, resolveCursor, spanLaneKeys } from './timeline.js';

/**
 * The calls one lane had made by the cursor's moment, newest first.
 *
 * The moment is resolved by the same rule the context panel asks with — a live
 * cursor means the head of the window, a parked one its own moment — so the two
 * panels under one click can never be showing two different moments. A call
 * belongs to the agent lane whose span it carries and to the main lane
 * otherwise, which is the rule the lane's own tool count was computed with.
 *
 * @param {{ view: object|null, key: string|null, calls: object[], cursor: object|null, expanded: string[]|Set<string> }} input
 * @returns {{ lane: object|null, calls: object[], atMs: number, expanded: string[]|Set<string> }}
 */
export function laneToolInput({ view = null, key = null, calls = [], cursor = null, expanded = [] } = {}) {
  const lane = laneByKey(view, key);
  const atMs = resolveCursor(cursor, view).timeMs;
  if (!lane) return { lane: null, calls: [], atMs, expanded };
  const owners = spanLaneKeys(view?.lanes ?? []);
  const mine = (Array.isArray(calls) ? calls : []).filter(
    (call) =>
      Number.isFinite(call?.timeMs) &&
      call.timeMs <= atMs &&
      (owners.get(call.spanId) ?? 'main') === lane.key,
  );
  // Newest first: the reader parked the cursor on a moment and asks what led up
  // to it, so the calls nearest that moment are the ones to read first.
  mine.sort((a, b) => b.timeMs - a.timeMs || b.seq - a.seq);
  return { lane, calls: mine, atMs, expanded };
}

/**
 * The tool list for the selected lane, as of the cursor's moment.
 *
 * No attribute named `data-lane` may appear in here: the page binds
 * `[data-lane]` to lane rows, so one in this markup would make every click
 * inside the panel toggle the lane selection. The expansion keys are prefixed
 * `tool:` so they cannot collide with a context block's `<seq>:<index>`.
 *
 * @param {{ lane: object|null, calls: object[], atMs: number, expanded: string[]|Set<string> }} input
 */
export function renderToolPanel({ lane = null, calls = [], atMs = 0, expanded = [] } = {}) {
  if (!lane) return '';

  const list = Array.isArray(calls) ? calls : [];
  const head = `<div class="context-head"><span class="context-title">${esc(lane.label)} · tools</span>
      <span class="tools-meta" data-calls="${esc(list.length)}" data-time="${esc(atMs)}">${esc(
        `${list.length} tool call${list.length === 1 ? '' : 's'} · up to ${fmtClock(atMs)}`,
      )}</span>
    </div>`;
  const shell = (dataState, inner) =>
    `<div class="panel tools-panel" data-state="${dataState}" data-tools-lane="${esc(lane.key)}">${head}${inner}</div>`;

  if (!list.length) {
    return shell('empty', '<div class="placeholder">No tool call on this lane at or before this moment.</div>');
  }

  const openKeys = new Set(expanded ?? []);
  const rows = list
    .map((call) => {
      const key = `tool:${call.seq}`;
      const cut = call.truncated
        ? `\n… ${fmtNum(call.chars - call.text.length)} more characters, not kept in the page`
        : '';
      return `<details class="ctx-block" data-kind="tool_use" data-tool="${esc(call.name)}"${
        openKeys.has(key) ? ' open' : ''
      }>
      <summary data-block="${esc(key)}">
        <span class="tool-time">${esc(fmtClock(call.timeMs))}</span><span class="ctx-label">${esc(call.name)}</span>
        <span class="ctx-preview">${esc(call.preview)}</span>
        <span class="ctx-size" data-chars="${esc(call.chars)}">${esc(fmtNum(call.chars))}</span>
      </summary>
      <pre class="ctx-text">${esc(call.text)}${esc(cut)}</pre>
    </details>`;
    })
    .join('');

  return shell('ready', `<div class="ctx-blocks">${rows}</div>`);
}
