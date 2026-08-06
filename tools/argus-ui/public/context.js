/**
 * argus-ui — the context behind one lane.
 *
 * Pure functions over `GET /api/content/at`: which record a lane asks for,
 * how the request body that *was* the context at a moment parses into a list
 * of blocks, and how that list renders. No `document`, no `fetch`, no
 * `location` — which is what lets `node --test` import this directly, the same
 * contract `timeline.js` keeps.
 *
 * Two-thirds of a real context is the `tools` array, which is not a message, so
 * every top-level field the body carries gets a block of its own: a list that
 * shows only the conversation answers "what fills the context" with the wrong
 * third of it.
 */

import { esc, fmtClock, fmtNum, shortId } from './format.js';

/** A collapsed block shows this much of its text on one line. */
export const PREVIEW_CHARS = 120;

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

/**
 * The one line a collapsed block shows.
 *
 * The cut is measured on the text itself rather than on its flattened form, so
 * a block carrying more than one line's worth of text says so even when
 * collapsing its whitespace would have brought it under the limit.
 */
function previewOf(text) {
  const flat = text.slice(0, PREVIEW_CHARS).replace(/\s+/g, ' ').trim();
  return text.length > PREVIEW_CHARS ? `${flat}…` : flat;
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
