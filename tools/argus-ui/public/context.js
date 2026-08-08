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

/* ------------------------------- the filter ------------------------------ */

/**
 * The id of the filter entry one block belongs to, namespaced by what it is.
 *
 * The namespace is load-bearing: a body may carry a top-level key named `user`
 * or `system`, and a bare-name id would make hiding that field hide the
 * messages with it.
 *
 * @param {{ kind: string, label: string }} block
 * @returns {string} `field:<key>` for a body field, `kind:<kind>` for anything else
 */
export function entryIdOf(block) {
  return block.kind === 'field' ? `field:${block.label}` : `kind:${block.kind}`;
}

/** Codepoint order, not `localeCompare`, whose order depends on the environment. */
const byLabel = (a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0);

/**
 * A block list folded into the entries the filter offers: what this request
 * actually contains, and how much of each.
 *
 * The blocks group comes first, then the fields group, each sorted by its own
 * label. The id is never shown; the label is the bare kind name or the bare
 * field key, so `system` and `tools` read as one list.
 *
 * @param {object[]} blocks
 * @returns {{ id: string, group: 'blocks'|'fields', label: string, count: number }[]}
 */
export function contextFilterEntries(blocks) {
  const byId = new Map();
  for (const block of blocks ?? []) {
    const id = entryIdOf(block);
    const seen = byId.get(id);
    if (seen) {
      seen.count += 1;
      continue;
    }
    byId.set(id, {
      id,
      group: block.kind === 'field' ? 'fields' : 'blocks',
      label: block.kind === 'field' ? block.label : block.kind,
      count: 1,
    });
  }
  const all = [...byId.values()];
  const group = (name) => all.filter((entry) => entry.group === name).sort(byLabel);
  return [...group('blocks'), ...group('fields')];
}

/* ------------------------------- the search ------------------------------ */

/**
 * A query as it is matched: trimmed and case-folded, so a pasted query with a
 * trailing space still finds what a typed one does. An empty result means the
 * search is off, which is the one value every caller branches on.
 */
const normalizeQuery = (query) => String(query ?? '').trim().toLowerCase();

/**
 * Whether one block answers a query.
 *
 * The whole text is searched and not the preview: a reader looking for a string
 * 40 KB into a tool result means that block, and matching the one line it
 * collapsed to would answer that it is not there. The label is searched beside
 * it because `tools` names a field as often as it appears inside a prompt, and
 * the label is the only place a field's name is written.
 *
 * The match is a plain substring and never a regular expression: a query is
 * typed by a reader, so `(` is a character they are looking for rather than a
 * syntax error, and `.` matches a dot and nothing else.
 *
 * @param {{ label?: string, text?: string }} block
 * @param {string} query
 * @returns {boolean} true for every block while the query is empty
 */
export function blockMatches(block, query) {
  const needle = normalizeQuery(query);
  if (!needle) return true;
  return (
    String(block?.label ?? '').toLowerCase().includes(needle) ||
    String(block?.text ?? '').toLowerCase().includes(needle)
  );
}

/**
 * The blocks left once what the reader hid and what the search excludes are
 * taken out.
 *
 * The two narrowings are independent and both must pass: a block of a hidden
 * kind stays hidden however well it matches, and searching never brings back
 * what the filter turned off.
 *
 * Every survivor keeps its own `index`, so the expansion keys stay the same
 * whether the list is filtered or not: hiding one kind must not shut an
 * expanded block of another. No argument is mutated, and `hidden` may be an
 * array or a Set — the same freedom `expanded` already has.
 *
 * @param {object[]} blocks
 * @param {string[]|Set<string>} hidden
 * @param {string} search the query the reader typed; empty excludes nothing
 * @returns {object[]}
 */
export function visibleBlocks(blocks, hidden = [], search = '') {
  const hiddenIds = new Set(hidden ?? []);
  const needle = normalizeQuery(search);
  return (blocks ?? []).filter(
    (block) => !hiddenIds.has(entryIdOf(block)) && (!needle || blockMatches(block, needle)),
  );
}

/**
 * How much of one record the filter leaves on screen, beside how much it holds.
 *
 * `visibleChars` is the sum of the visible blocks' own `chars`, and never the
 * total minus what was hidden: the block texts do not add up to the body, whose
 * JSON scaffolding belongs to no block, so subtracting would let an all-hidden
 * panel claim hundreds of visible characters with no row on screen. The number
 * chosen here is the one a reader can add up from the `data-chars` on the rows,
 * and it is why the total is printed beside it and never replaced.
 *
 * `filtered` keys on a block actually removed, never on `hidden` being
 * non-empty or a query having been typed: an id this request does not carry has
 * hidden nothing, and a query every block matches has excluded nothing — both
 * must leave the panel reading exactly as it does unfiltered.
 *
 * The record `contextBlocks` returns spreads straight in, so a caller may pass
 * it whole — either with `hidden` and `search` as keys of the same object or as
 * further arguments beside it. No argument is mutated, and `hidden` may be an
 * array or a Set.
 *
 * @param {{ blocks?: object[], chars?: number, hidden?: string[]|Set<string>, search?: string }} input
 * @param {string[]|Set<string>} [hiddenIds] the hidden entries, when the record is passed whole
 * @param {string} [query] the search query, when the record is passed whole
 * @returns {{ chars: number, blocks: number, visibleChars: number, visibleBlocks: number, filtered: boolean }}
 */
export function contextCounts({ blocks = [], chars = 0, hidden = [], search = '' } = {}, hiddenIds = hidden, query = search) {
  const all = blocks ?? [];
  const shown = visibleBlocks(all, hiddenIds, query);
  return {
    chars,
    blocks: all.length,
    visibleChars: shown.reduce((total, block) => total + (block.chars ?? 0), 0),
    visibleBlocks: shown.length,
    filtered: shown.length !== all.length,
  };
}

/**
 * The entry ids of the record the panel holds — what *all off* needs, without
 * the page having to re-derive anything of its own.
 *
 * @param {{ body?: string }|null|undefined} item
 * @returns {string[]}
 */
export function contextEntryIds(item) {
  return contextFilterEntries(contextBlocks(item?.body ?? '').blocks).map((entry) => entry.id);
}

/**
 * The hidden set after *all on* or *all off*.
 *
 * *All on* makes every entry visible, unqualified, so it clears the whole set.
 * *All off* adds only what the shown request contains, which is what leaves an
 * entry that was absent at the time visible when it later appears. Neither
 * argument is mutated.
 *
 * @param {string[]|Set<string>} hidden what is hidden now
 * @param {string[]} ids the entries the shown request contains
 * @param {boolean} on true for *all on*, false for *all off*
 * @returns {Set<string>}
 */
export function hiddenAfterAll(hidden, ids, on) {
  return on ? new Set() : new Set([...hidden, ...ids]);
}

/**
 * The filter dropdown: one checkbox per entry, in two labelled groups, over a
 * pair of buttons that turn everything on or off at once.
 *
 * Nothing here may carry `data-lane` or `data-block`: the page binds the first
 * to lane rows and the second to block expansion, so either would make opening
 * the dropdown do something else entirely. The buttons sit in the menu body and
 * not in the `<summary>`, or clicking one would shut the dropdown.
 *
 * @param {{ entries: object[], hidden: string[]|Set<string>, open: boolean }} input
 * @returns {string} `''` when there is nothing to filter
 */
export function renderContextFilter({ entries = [], hidden = [], open = false } = {}) {
  if (!entries.length) return '';
  const hiddenIds = new Set(hidden ?? []);

  // The count is the plain integer and never `fmtNum`: a count of 1200 that
  // reads `1.2k` is no longer a count of anything a reader can check.
  const entryRow = (entry) =>
    `<label class="ctx-filter-entry"><input type="checkbox" data-ctx-entry="${esc(entry.id)}"${
      hiddenIds.has(entry.id) ? '' : ' checked'
    }><span class="ctx-filter-name">${esc(entry.label)}</span> <span class="ctx-filter-count" data-count="${esc(
      entry.count,
    )}">${esc(entry.count)}</span></label>`;

  // A group with nothing in it is left out whole, header and all.
  const group = (name, title) => {
    const rows = entries
      .filter((entry) => entry.group === name)
      .map(entryRow)
      .join('');
    return rows
      ? `<div class="ctx-filter-group" data-group="${name}"><span class="ctx-filter-title">${title}</span>${rows}</div>`
      : '';
  };

  return `<details class="ctx-filter"${open ? ' open' : ''}>
      <summary class="ctx-filter-summary" data-ctx-filter="toggle">filter</summary>
      <div class="ctx-filter-menu">
        <div class="ctx-filter-actions">
          <button type="button" class="ctx-filter-all" data-ctx-all="on">all on</button>
          <button type="button" class="ctx-filter-all" data-ctx-all="off">all off</button>
        </div>
        ${group('blocks', 'Blocks')}${group('fields', 'Fields')}
      </div>
    </details>`;
}

/**
 * The search box, carrying the query the reader typed.
 *
 * It is rendered for every request that has blocks at all, including one whose
 * own query has emptied the list: a box that disappeared with its last match
 * would leave the reader nothing to clear it in.
 *
 * The same rule the dropdown keeps applies here — no `data-lane` and no
 * `data-block`, or every keystroke would toggle a lane or expand a block.
 *
 * @param {string} search
 * @returns {string}
 */
export function renderContextSearch(search = '') {
  return `<label class="ctx-search">
        <span class="visually-hidden">Search this context</span>
        <input id="ctx-search" type="search" data-ctx-search autocomplete="off"
          placeholder="search context…" value="${esc(search)}">
      </label>`;
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
 * The keys are the keys `renderContextPanel` reads, so the result is its
 * argument whole: the page cannot drop one of them on the way.
 *
 * @param {{ view: object|null, key: string|null, held: object|null, expanded: string[]|Set<string>,
 *   hidden: string[]|Set<string>, filterOpen: boolean, search: string }} input
 * @returns {{ lane: object|null, item: object|null, pending: boolean, expanded: string[]|Set<string>,
 *   hidden: string[]|Set<string>, filterOpen: boolean, search: string }}
 */
export function lanePanelInput({
  view = null,
  key = null,
  held = null,
  expanded = [],
  hidden = [],
  filterOpen = false,
  search = '',
} = {}) {
  const lane = laneByKey(view, key);
  return { lane, ...laneContextInput(key, held), expanded, hidden, filterOpen, search };
}

/**
 * The panel for the selected lane, as of the cursor's moment.
 *
 * No attribute named `data-lane` may appear anywhere in here: the page binds
 * `[data-lane]` to lane rows, so one in this markup would make every click
 * inside the panel toggle the lane selection.
 *
 * @param {{ lane: object|null, item: object|null, pending: boolean, expanded: string[]|Set<string>,
 *   hidden: string[]|Set<string>, filterOpen: boolean, search: string }} input
 */
export function renderContextPanel({
  lane = null,
  item = null,
  pending = false,
  expanded = [],
  hidden = [],
  filterOpen = false,
  search = '',
} = {}) {
  if (!lane) return '';

  // Matching already treats a whitespace-only query as no query, so the box
  // renders it as none too — otherwise clearing the search leaves a panel
  // that differs from the never-searched one by invisible bytes in `value`.
  if (!normalizeQuery(search)) search = '';

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
  const entries = contextFilterEntries(blocks);

  // Both numbers only when the filter or the search actually took a block out of
  // this record: hiding a kind the request does not carry leaves the head as it
  // was, and an unnarrowed head is byte-for-byte the one that was there before
  // either existed.
  const counts = contextCounts({ chars, blocks, hidden, search });
  const charsPart = counts.filtered
    ? `${fmtNum(counts.visibleChars)} of ${fmtNum(counts.chars)} chars`
    : `${fmtNum(chars)} chars`;
  const blocksPart = counts.filtered
    ? `${counts.visibleBlocks} of ${counts.blocks} blocks`
    : `${blocks.length} blocks`;

  const line = [fmtClock(item.timeMs), item.model, charsPart, blocksPart]
    .filter(Boolean)
    .map((part) => esc(part))
    .join(' · ');

  // The numbers ride in data attributes so what the panel is built from can be
  // read without reading a sentence. `data-chars` and `data-blocks` are the
  // whole record's, filtered or not: what the request holds does not change
  // because a reader stopped looking at part of it. The visible pair joins them
  // only while something is hidden, so their absence means nothing is.
  const visibleAttrs = counts.filtered
    ? ` data-visible-chars="${esc(counts.visibleChars)}" data-visible-blocks="${esc(counts.visibleBlocks)}"`
    : '';
  const head = `<div class="context-head">${title}
      <span class="context-meta" data-chars="${esc(chars)}" data-blocks="${esc(blocks.length)}"${visibleAttrs}
        data-time="${esc(item.timeMs)}" data-model="${esc(item.model ?? '')}"
        data-truncated="${item.truncated === true}">${line}</span>
      ${
        blocks.length
          ? `<div class="context-controls">${renderContextSearch(search)}${renderContextFilter({
              entries,
              hidden,
              open: filterOpen,
            })}</div>`
          : ''
      }
    </div>`;

  const shownBlocks = visibleBlocks(blocks, hidden, search);

  // A request with no blocks at all keeps today's empty container: nothing is
  // narrowed there, so nothing may claim it is. The placeholder is for the one
  // case a reader cannot otherwise explain — rows that exist and none on screen
  // — and it has to name the right cause of the two, because clearing the
  // search does not help when the kinds are all turned off. So the filter alone
  // is asked first: if it empties the list by itself, that is what the reader
  // has to undo, whatever they also typed.
  if (blocks.length > 0 && shownBlocks.length === 0) {
    const message = visibleBlocks(blocks, hidden).length === 0
      ? 'Every kind in this request is hidden. Turn them back on in the filter above.'
      : `Nothing in this request matches “${String(search).trim()}”. Clear the search to see it again.`;
    return shell('ready', `${head}<div class="placeholder">${esc(message)}</div>`);
  }

  const rows = shownBlocks
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
