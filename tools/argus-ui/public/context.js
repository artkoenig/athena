/**
 * argus-ui — the context behind one lane.
 *
 * Everything the panel behind one lane needs: which record it asks for and at
 * which moment, the one call that goes and gets it through an api function the
 * caller injects, what the page holds turned into what the panel is drawn from,
 * and how the request body that *was* the context at a moment parses into a
 * list of blocks and renders. No `document`, no `fetch`, no `location` — which
 * is what lets `node --test` import this directly, the same contract
 * `timeline.js` keeps.
 *
 * Two-thirds of a real context is the `tools` array, which is not a message, so
 * every top-level field the body carries gets a block of its own: a list that
 * shows only the conversation answers "what fills the context" with the wrong
 * third of it.
 */

import { esc, fmtClock, fmtNum, previewOf, shortId } from './format.js';
import { laneByKey, resolveCursor } from './timeline.js';

/** The roles that get a colour of their own; anything else is `other`. */
const ROLE_KINDS = new Set(['user', 'assistant', 'system']);

const kindOfRole = (role) => (ROLE_KINDS.has(role) ? role : 'other');

/**
 * The one text rule, in one place: a payload that is already a string is shown
 * verbatim, and anything else as pretty JSON. `chars` is then the length of the
 * text the expansion shows, so the number on the collapsed line and the thing
 * behind it are the same measurement.
 */
function textOf(payload) {
  if (typeof payload === 'string') return payload;
  if (payload === undefined) return '';
  return JSON.stringify(payload, null, 2) ?? '';
}

const makeBlock = (index, kind, label, payload) => {
  const text = textOf(payload);
  return { index, kind, label, chars: text.length, preview: previewOf(text), text };
};

/**
 * The blocks of one request body, in the order they sit in the context.
 *
 * `ok` says whether the body parsed: a body cut mid-JSON by the CLI's own
 * content limit still has to render, so it comes back as a single `raw` block
 * carrying every character that did arrive rather than as nothing at all.
 *
 * @param {string} body the exact body as `/api/content/at` served it
 * @returns {{ ok: boolean, chars: number, blocks: object[] }}
 */
export function contextBlocks(body) {
  if (typeof body !== 'string' || body === '') return { ok: false, chars: 0, blocks: [] };
  const chars = body.length;

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, chars, blocks: [makeBlock(0, 'raw', 'raw body', body)] };
  }

  const blocks = [];
  const push = (kind, label, payload) => blocks.push(makeBlock(blocks.length, kind, label, payload));

  // 1. The system prompt, which this CLI sends as an array of text blocks but
  //    the API also allows as a plain string.
  const system = parsed.system;
  if (typeof system === 'string') {
    push('system', 'system prompt', system);
  } else if (Array.isArray(system)) {
    // An entry's own text is the payload, not the wrapper: the wrapper carries
    // only a type and a caching hint, and neither is context.
    for (const entry of system) {
      push('system', 'system prompt', typeof entry?.text === 'string' ? entry.text : entry);
    }
  }

  // 2. The messages, in order. `content` is a string on some and an array of
  //    blocks on others, and both shapes arrive in one real capture.
  for (const message of Array.isArray(parsed.messages) ? parsed.messages : []) {
    const role = typeof message?.role === 'string' ? message.role : '';
    const content = message?.content;
    if (typeof content === 'string') {
      push(kindOfRole(role), role || 'message', content);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      switch (part?.type) {
        case 'text':
          push(kindOfRole(role), role || 'message', part.text);
          break;
        case 'thinking':
          push('thinking', 'thinking', part.thinking);
          break;
        case 'tool_use':
          push('tool_use', part.name ? `tool call · ${part.name}` : 'tool call', part);
          break;
        case 'tool_result': {
          const label = [
            'tool result',
            part.is_error ? 'error' : null,
            part.tool_use_id ? shortId(part.tool_use_id, 12) : null,
          ]
            .filter(Boolean)
            .join(' · ');
          push('tool_result', label, part.content);
          break;
        }
        default:
          // Kept, never dropped: an unknown block is still context, and the
          // sizes only tell the truth when nothing is missing from them.
          push('other', typeof part?.type === 'string' ? part.type : 'block', part);
      }
    }
  }

  // 3. Everything else the body carries, `tools` above all — measured at
  //    two-thirds of a real context, and not a message.
  for (const [key, value] of Object.entries(parsed)) {
    if (key === 'system' || key === 'messages') continue;
    push('field', key, value);
  }

  return { ok: true, chars, blocks };
}

/**
 * The one lane filter that goes on the wire for a lane's context.
 *
 * Main traffic for the main lane; an agent lane's own span — the only thing
 * that tells two concurrent agents of one type apart — and its name only when
 * it carries no span at all. A lane that offers neither gets no query rather
 * than an empty one: an unfiltered request would answer with the main
 * session's context under an agent's lane, which is the one thing this
 * mapping exists to prevent.
 *
 * @param {{ kind: string, spanId: string|null, agent: string|null }|null|undefined} lane
 * @returns {{ main: string }|{ span: string }|{ agent: string }|null}
 */
export function laneContentQuery(lane) {
  if (!lane) return null;
  if (lane.kind === 'main') return { main: '1' };
  if (lane.spanId) return { span: lane.spanId };
  if (lane.agent) return { agent: lane.agent };
  return null;
}

/**
 * The whole request behind one lane's context: which session, which moment,
 * which lane.
 *
 * The moment is resolved here and nowhere else, so "the nearest request at or
 * before the cursor" is one decision in one place: a live cursor asks for the
 * head of the window, a parked one for its own moment, and neither can ask for
 * a moment outside the recorded window. A lane the filter cannot identify gets
 * no request at all — an unfiltered one would answer with the main session's
 * context under an agent's lane.
 *
 * @param {{ session: string|null, key: string|null, view: object|null, cursor: object|null }} input
 * @returns {{ session: string, at: number }|null} plus exactly one of main/span/agent
 */
function laneContentRequest({ session = null, key = null, view = null, cursor = null } = {}) {
  if (!session || !key) return null;
  const filter = laneContentQuery(laneByKey(view, key));
  if (!filter) return null;
  return { session, at: resolveCursor(cursor, view).timeMs, ...filter };
}

/**
 * Fetch the record one lane's context is drawn from, through the api function
 * the caller hands in — this module reaches the network through nothing of its
 * own.
 *
 * The rejection is swallowed here: a failed fetch costs the panel and not the
 * page that is refreshing it. The record comes back tagged with the lane it was
 * fetched for, which is what lets the caller drop an answer for a lane the
 * reader has already left.
 *
 * @param {(path: string, params: object) => Promise<{ item?: object|null }>} api
 * @param {{ session: string|null, key: string|null, view: object|null, cursor: object|null }} input
 * @returns {Promise<{ key: string|null, item: object|null }>}
 */
export async function fetchLaneContext(api, { session = null, key = null, view = null, cursor = null } = {}) {
  const request = laneContentRequest({ session, key, view, cursor });
  const answer = request ? await api('/api/content/at', request).catch(() => null) : null;
  return { key, item: answer?.item ?? null };
}

/**
 * What the panel is drawn from, out of what the page holds.
 *
 * The held answer belongs to the lane it was fetched for; anything else means a
 * fetch is still in flight, which is not the same answer as "there is nothing
 * here". The two keys are the two fields `renderContextPanel` reads, so the
 * result spreads straight into its input.
 *
 * @param {string|null} key the lane the reader has open
 * @param {{ key: string|null, item: object|null }|null} held
 * @returns {{ item: object|null, pending: boolean }}
 */
export function laneContextInput(key, held) {
  const fresh = held?.key === key;
  return { item: fresh ? (held.item ?? null) : null, pending: !fresh };
}

/**
 * Everything `renderContextPanel` is drawn from, out of what the page holds.
 *
 * The lane is looked up by the key the reader selected and by nothing else: a
 * lookup that lands on another lane paints one agent's context under another
 * agent's heading, and the reader cannot tell. A key no lane in the view
 * carries — and no key at all — resolves to no lane, which is how the panel
 * disappears when the selection is let go.
 *
 * The four keys are the four `renderContextPanel` reads, so the result is its
 * argument whole: the page cannot drop one of them on the way.
 *
 * @param {{ view: object|null, key: string|null, held: object|null, expanded: string[]|Set<string> }} input
 * @returns {{ lane: object|null, item: object|null, pending: boolean, expanded: string[]|Set<string> }}
 */
export function lanePanelInput({ view = null, key = null, held = null, expanded = [] } = {}) {
  const lane = laneByKey(view, key);
  return { lane, ...laneContextInput(key, held), expanded };
}

/**
 * The panel for the selected lane, as of the cursor's moment.
 *
 * No attribute named `data-lane` may appear anywhere in here: the page binds
 * `[data-lane]` to lane rows, so one in this markup would make every click
 * inside the panel toggle the lane selection.
 *
 * @param {{ lane: object|null, item: object|null, pending: boolean, expanded: string[]|Set<string> }} input
 */
export function renderContextPanel({ lane = null, item = null, pending = false, expanded = [] } = {}) {
  if (!lane) return '';

  const title = `<span class="context-title">${esc(lane.label)}</span>`;
  const shell = (dataState, inner) =>
    `<div class="panel context-panel" data-state="${dataState}" data-context-lane="${esc(lane.key)}">${inner}</div>`;

  if (!item) {
    // A fetch in flight is not the same answer as "there is nothing here", and
    // saying the second while the first is true is how a panel lies.
    const message = pending
      ? 'Reading the context at this moment…'
      : 'No API request on this lane at or before this moment.';
    return shell(
      pending ? 'pending' : 'empty',
      `<div class="context-head">${title}</div><div class="placeholder">${esc(message)}</div>`,
    );
  }

  const { chars, blocks } = contextBlocks(item.body);
  const openKeys = new Set(expanded ?? []);

  const line = [fmtClock(item.timeMs), item.model, `${fmtNum(chars)} chars`, `${blocks.length} blocks`]
    .filter(Boolean)
    .map((part) => esc(part))
    .join(' · ');

  // The numbers ride in data attributes so what the panel is built from can be
  // read without reading a sentence.
  const head = `<div class="context-head">${title}
      <span class="context-meta" data-chars="${esc(chars)}" data-blocks="${esc(blocks.length)}"
        data-time="${esc(item.timeMs)}" data-model="${esc(item.model ?? '')}"
        data-truncated="${item.truncated === true}">${line}</span>
    </div>`;

  const rows = blocks
    .map((block) => {
      // Keyed by the record too: when the cursor lands on a different request
      // the keys stop matching and everything collapses, which is right — it is
      // a different context.
      const key = `${item.seq}:${block.index}`;
      return `<details class="ctx-block" data-kind="${esc(block.kind)}"${openKeys.has(key) ? ' open' : ''}>
      <summary data-block="${esc(key)}">
        <span class="ctx-label">${esc(block.label)}</span><span class="ctx-preview">${esc(block.preview)}</span>
        <span class="ctx-size" data-chars="${esc(block.chars)}">${esc(fmtNum(block.chars))}</span>
      </summary>
      <pre class="ctx-text">${esc(block.text)}</pre>
    </details>`;
    })
    .join('');

  return shell('ready', `${head}<div class="ctx-blocks">${rows}</div>`);
}
