/**
 * An Anthropic Messages API request body -> the blocks that fill a context.
 *
 * `claude_code.api_request_body` events carry the whole conversation the CLI
 * sent: the system prompt, the tool definitions, every prior turn, every tool
 * result. That is what the timeline shows when a moment is selected, so this
 * module's one job is turning that JSON string into a flat, ordered list of
 * blocks with a size on each — the sizes are the point, because what actually
 * fills a context is rarely what the reader expects.
 *
 * Nothing here throws. A body arrives truncated far more often than not (see
 * CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH in claude.mjs), and a view that fails on
 * a truncated body is a view that fails on the interesting sessions.
 *
 * Extended-thinking content is redacted by the CLI itself, whatever else is
 * configured. A thinking block therefore arrives as a redaction marker and
 * there is nothing here to recover; it is passed through as it came.
 */

import { bool, num } from './claude.mjs';

/** Pretty-print for the expanded view; a value that will not serialize stays a string. */
function pretty(value) {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** A tool_result's `content` is a string, or the same block shapes as a message. */
function flattenResultContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content === undefined ? '' : pretty(content);
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && typeof part.text === 'string') return part.text;
      return pretty(part);
    })
    .join('\n');
}

/** Bytes an image/document block occupies, without ever putting them in `text`. */
function mediaSize(block) {
  const data = block?.source?.data;
  return typeof data === 'string' ? data.length : 0;
}

function emptyResult(attrs, blocks = []) {
  const body = typeof attrs?.body === 'string' ? attrs.body : null;
  return {
    parsed: false,
    bodyLength: num(attrs?.body_length, body ? body.length : 0),
    truncated: bool(attrs?.body_truncated),
    // File mode (`OTEL_LOG_RAW_API_BODIES=file:<dir>`) puts the body on the
    // *agent's* disk and sends only this path. The collector may be running on
    // another machine entirely, so it reports the path and never reads it.
    bodyRef: typeof attrs?.body_ref === 'string' ? attrs.body_ref : null,
    model: typeof attrs?.model === 'string' ? attrs.model : null,
    totalChars: blocks.reduce((sum, block) => sum + block.chars, 0),
    blocks,
  };
}

/**
 * @param {object} attrs attributes of a `claude_code.api_request_body` record
 * @returns {{parsed: boolean, bodyLength: number, truncated: boolean,
 *   bodyRef: string|null, model: string|null, totalChars: number,
 *   blocks: {index: number, role: string, type: string, name: string|null,
 *     toolUseId: string|null, chars: number, text: string}[]}}
 */
export function parseRequestBody(attrs = {}) {
  const body = typeof attrs?.body === 'string' ? attrs.body : null;
  if (body === null) return emptyResult(attrs);

  let parsedBody;
  try {
    parsedBody = JSON.parse(body);
  } catch {
    // Almost always a truncated body. The exact text stays reachable as a
    // single raw block rather than being dropped for not being valid JSON.
    return emptyResult(attrs, [
      { index: 0, role: 'raw', type: 'raw', name: null, toolUseId: null, chars: body.length, text: body },
    ]);
  }
  if (!parsedBody || typeof parsedBody !== 'object') return emptyResult(attrs);

  const blocks = [];
  const push = (role, type, text, { name = null, toolUseId = null, chars = null } = {}) => {
    const value = typeof text === 'string' ? text : pretty(text);
    blocks.push({
      index: blocks.length,
      role,
      type,
      name,
      toolUseId,
      chars: chars ?? value.length,
      text: value,
    });
  };

  const system = parsedBody.system;
  if (typeof system === 'string') push('system', 'text', system);
  else if (Array.isArray(system)) {
    for (const entry of system) {
      if (typeof entry === 'string') push('system', 'text', entry);
      else if (entry && typeof entry.text === 'string') push('system', 'text', entry.text);
      else push('system', 'text', pretty(entry));
    }
  }

  // Tool schemas are a large and invisible part of what fills a context, which
  // is exactly the thing this view exists to make visible.
  if (Array.isArray(parsedBody.tools) && parsedBody.tools.length) {
    push('system', 'tools', pretty(parsedBody.tools), { name: `tools (${parsedBody.tools.length})` });
  }

  const messages = Array.isArray(parsedBody.messages) ? parsedBody.messages : [];
  for (const message of messages) {
    const role = typeof message?.role === 'string' ? message.role : 'user';
    const content = message?.content;
    if (typeof content === 'string') {
      push(role, 'text', content);
      continue;
    }
    if (!Array.isArray(content)) {
      if (content !== undefined && content !== null) push(role, 'text', pretty(content));
      continue;
    }
    for (const block of content) {
      if (typeof block === 'string') {
        push(role, 'text', block);
        continue;
      }
      switch (block?.type) {
        case 'text':
          push(role, 'text', typeof block.text === 'string' ? block.text : pretty(block));
          break;
        case 'tool_use':
          push(role, 'tool_use', pretty(block.input), {
            name: typeof block.name === 'string' ? block.name : null,
            toolUseId: typeof block.id === 'string' ? block.id : null,
          });
          break;
        case 'tool_result':
          push(role, 'tool_result', flattenResultContent(block.content), {
            toolUseId: typeof block.tool_use_id === 'string' ? block.tool_use_id : null,
          });
          break;
        case 'thinking':
        case 'redacted_thinking':
          push(role, 'thinking', typeof block.thinking === 'string' ? block.thinking : (block.data ?? ''));
          break;
        case 'image':
        case 'document': {
          const bytes = mediaSize(block);
          const mediaType = block?.source?.media_type ?? block.type;
          // Never inline base64 — but charge the block its real size, so the
          // accounting of what fills the context stays honest.
          push(role, 'image', `<${mediaType}, ${bytes} bytes>`, { chars: bytes });
          break;
        }
        default:
          push(role, typeof block?.type === 'string' ? block.type : 'unknown', pretty(block));
          break;
      }
    }
  }

  return {
    parsed: true,
    bodyLength: num(attrs?.body_length, body.length),
    truncated: bool(attrs?.body_truncated),
    bodyRef: typeof attrs?.body_ref === 'string' ? attrs.body_ref : null,
    model: typeof attrs?.model === 'string' ? attrs.model : null,
    totalChars: blocks.reduce((sum, block) => sum + block.chars, 0),
    blocks,
  };
}
