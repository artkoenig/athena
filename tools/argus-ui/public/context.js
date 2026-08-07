/**
 * The selected lane's context at the chosen time: one API request body, read as
 * the message list it is.
 *
 * Pure, like `timeline.js` — no `document`, no `window`, no fetch. What the
 * collector answers with is a record as it was recorded, so the shape of a
 * request body is understood here and nowhere else, and a test can pin it
 * without a DOM.
 *
 * Two things this module never lies about:
 *
 *  - **The size it shows is the reported one.** A body is routinely cut by the
 *    CLI before it is ever exported, so `record.length` — what was actually
 *    sent — is the number in the header, never the length of the text that
 *    arrived.
 *  - **The lane and the moment have to agree.** A loaded context belongs to one
 *    (lane, time) pair; asked for any other pair it renders as pending, so the
 *    body on screen is never a different lane's or a different moment's.
 */

import { esc, fmtClock, fmtNum } from './format.js';

/**
 * A label is short, user-supplied text that sits on the same line as the
 * attributes of the block it names, so it is escaped harder than body text is:
 * `=` and a backtick can end an unquoted attribute value, and a tool name comes
 * from whatever the agent called.
 */
const escLabel = (value) => esc(value).replace(/[=`]/g, (char) => (char === '=' ? '&#61;' : '&#96;'));

/** One block of the list, always carrying the length of its own text. */
function block(kind, label, text) {
  const value = typeof text === 'string' ? text : String(text ?? '');
  return { kind, label, text: value, length: value.length };
}

/** The whole body as one block: what an unparseable — usually cut — body is. */
const rawBlocks = (text) => [block('raw', 'body', text)];

/** The text of a `tool_result` part, whatever shape the result took. */
function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part?.text === 'string' ? part.text : JSON.stringify(part))).join('');
  }
  return JSON.stringify(content ?? null);
}

/** The blocks one part of a message's content array produces. */
function partBlock(part, messageKind, messageLabel) {
  switch (part?.type) {
    case 'text':
      return block(messageKind, messageLabel, part.text ?? '');
    case 'thinking':
      return block('assistant', 'thinking', part.thinking ?? '');
    case 'redacted_thinking':
      return block('assistant', 'redacted thinking', part.data ?? '');
    case 'tool_use':
      return block('tool_call', part.name ?? 'tool', JSON.stringify(part.input ?? null, null, 2));
    case 'tool_result':
      return block('tool_result', part.tool_use_id ?? 'tool result', toolResultText(part.content));
    default:
      return block(messageKind, part?.type ?? 'part', JSON.stringify(part));
  }
}

/**
 * A request body text as the list of blocks it is made of, in the order the
 * model was given them.
 *
 * `body.tools` is deliberately not rendered: the tool definitions are
 * configuration, not conversation, and they would bury the exchange.
 *
 * Anything that does not parse — which is what a body the CLI cut looks like —
 * and anything that parses to something with no message in it at all, answers
 * with the whole text as a single `raw` block, unchanged.
 *
 * @param {string} text the request body as recorded
 * @returns {{kind: string, label: string, text: string, length: number}[]}
 */
export function contextBlocks(text) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return rawBlocks(text);
  }
  if (!body || typeof body !== 'object') return rawBlocks(text);

  const blocks = [];
  if (typeof body.system === 'string') {
    blocks.push(block('system', 'system prompt', body.system));
  } else if (Array.isArray(body.system)) {
    for (const element of body.system) {
      const value = typeof element?.text === 'string' ? element.text : JSON.stringify(element);
      blocks.push(block('system', 'system prompt', value));
    }
  }

  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      // Anything that is not the assistant is the user's side of the exchange;
      // the label keeps the role as it was actually given.
      const kind = message?.role === 'assistant' ? 'assistant' : 'user';
      const label = String(message?.role ?? kind);
      const content = message?.content;
      if (typeof content === 'string') blocks.push(block(kind, label, content));
      else if (Array.isArray(content)) {
        for (const part of content) blocks.push(partBlock(part, kind, label));
      }
    }
  }

  return blocks.length ? blocks : rawBlocks(text);
}

/** One block, collapsed to its label and its size, expanding to the full text. */
function blockHtml(entry) {
  // A transcript line is preformatted text; the system prompt is prose, and
  // `.ctx-block-text` gives both the same wrapping.
  const text =
    entry.kind === 'system'
      ? `<div class="ctx-block-text">${esc(entry.text)}</div>`
      : `<pre class="ctx-block-text">${esc(entry.text)}</pre>`;
  return `<details class="ctx-block" data-block-kind="${esc(entry.kind)}" data-block-size="${esc(entry.length)}">
    <summary><span class="ctx-block-label">${escLabel(entry.label)}</span><span class="ctx-block-size">${esc(
      fmtNum(entry.length),
    )} chars</span></summary>
    ${text}
  </details>`;
}

/**
 * The context section of the lane detail panel.
 *
 * `context` is the page's loaded state — `{laneId, atMs, status, record}` — or
 * null while nothing has been loaded. It is only shown when it agrees with the
 * `laneId` and `atMs` asked for here; any other answer is still in flight, and
 * the section says so rather than showing what the previous moment held.
 *
 * The state is on the container as `data-context-state`: `loading`, `error`,
 * `none` (nothing was sent on this lane in this bound), `absent` (a size was
 * reported but no text was exported) or `ready`.
 *
 * @param {null | {laneId: string, atMs: number, status: string, record: object|null}} context
 * @param {string} laneId the lane the panel is showing
 * @param {number|null} atMs the chosen time the panel is read at
 * @returns {string} markup
 */
export function contextSectionHtml(context, laneId, atMs) {
  const open = (state, extra = '') =>
    `<section class="ctx" data-lane-context="${esc(laneId)}" data-context-state="${state}"${extra}>`;

  if (!context || context.laneId !== laneId || context.atMs !== atMs) {
    return `${open('loading')}
      <p class="placeholder">Reading this lane's context as of ${esc(fmtClock(atMs))}…</p>
    </section>`;
  }
  if (context.status === 'error') {
    return `${open('error')}
      <p class="placeholder">This lane's context as of ${esc(fmtClock(atMs))} could not be loaded.</p>
    </section>`;
  }

  const record = context.record ?? null;
  if (!record) {
    return `${open('none')}
      <p class="placeholder">No API request was made on this lane at or before ${esc(fmtClock(atMs))}.</p>
    </section>`;
  }

  // Always the reported size, never the delivered text's length.
  const marks = ` data-context-length="${esc(record.length ?? 0)}"${
    record.truncated ? ' data-context-truncated="true"' : ''
  }`;
  const head = `<div class="ctx-head">
    <span class="ctx-title">context sent at ${esc(fmtClock(record.timeMs))}</span>
    <span class="ctx-size">${esc(fmtNum(record.length ?? 0))} chars</span>
    ${record.model ? `<span class="ctx-model">${esc(record.model)}</span>` : ''}
  </div>`;

  if (record.text === null || record.text === undefined) {
    // A record that reports a size but exports neither text nor a reference is
    // still the truth about how much context was sent, so it is shown as such.
    const ref = record.ref
      ? ` It was written to a file on the agent's own host: <code class="ctx-ref">${esc(record.ref)}</code>.`
      : '';
    return `${open('absent', marks)}
      ${head}
      <p class="placeholder">This request carries no body text — only its reported size of ${esc(
        fmtNum(record.length ?? 0),
      )} characters.${ref}</p>
    </section>`;
  }

  const cut = record.truncated
    ? `<p class="ctx-cut">The CLI cut this body before it was exported: ${esc(
        fmtNum(record.text.length),
      )} of ${esc(fmtNum(record.length ?? 0))} characters arrived.</p>`
    : '';
  const blocks = contextBlocks(record.text);
  return `${open('ready', marks)}
    ${head}
    ${cut}
    <div class="ctx-blocks">${blocks.map(blockHtml).join('')}</div>
  </section>`;
}
