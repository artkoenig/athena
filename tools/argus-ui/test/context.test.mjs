// Pins the pure half of the context view: turning one collector /context
// answer into a structured message list, and rendering that list (and its
// not-ready states) as markup. No `document`, no fetch — the DOM-facing half
// is proved in app.test.mjs against the rendered page.

import test from 'node:test';
import assert from 'node:assert/strict';

import { contextBlocks, contextSectionHtml } from '../public/context.js';
import { fmtNum } from '../public/format.js';

/** A record shaped like one `record` of the collector's /context answer. */
function record(over = {}) {
  return {
    seq: 1,
    timeMs: 1_000,
    spanId: 'llm-a',
    traceId: 't',
    length: 0,
    truncated: false,
    text: null,
    ref: null,
    model: 'claude-opus-5',
    requestId: 'req_1',
    ...over,
  };
}

/** The loaded context state the page holds for one lane at one moment. */
const loaded = (rec, laneId = 'main', atMs = 2_000) => ({ laneId, atMs, status: 'ready', record: rec });

test('a request body parses into the five block kinds, in message order', () => {
  const body = JSON.stringify({
    system: 'You are a researcher.',
    messages: [
      { role: 'user', content: 'find the needle' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'searching' },
          { type: 'tool_use', name: 'Grep', input: { pattern: 'needle' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '42 hits' }],
      },
    ],
  });
  const blocks = contextBlocks(body);
  assert.deepEqual(
    blocks.map((block) => block.kind),
    ['system', 'user', 'assistant', 'tool_call', 'tool_result'],
  );
  const toolCall = blocks.find((block) => block.kind === 'tool_call');
  assert.match(toolCall.text, /pattern/);
  assert.match(toolCall.text, /needle/);
  const toolResult = blocks.find((block) => block.kind === 'tool_result');
  assert.equal(toolResult.text, '42 hits');
  for (const block of blocks) {
    assert.equal(block.length, block.text.length, `${block.kind} must report its own text's length`);
  }
});

test('a body the CLI truncated — or anything else unparseable — yields one raw block, text unchanged', () => {
  const truncated = '{"model":"m","messages":[{"role":"user","content":"…';
  const blocks = contextBlocks(truncated);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'raw');
  assert.equal(blocks[0].text, truncated);

  const empty = contextBlocks('');
  assert.equal(empty.length, 1);
  assert.equal(empty[0].kind, 'raw');

  const number = contextBlocks('42');
  assert.equal(number.length, 1);
  assert.equal(number[0].kind, 'raw');
});

test("a truncated record shows the collector's reported size, not the delivered text's length", () => {
  const html = contextSectionHtml(
    loaded(record({ text: '{"m":1}', length: 120_000, truncated: true })),
    'main',
    2_000,
  );
  assert.match(html, /data-context-state="ready"/);
  assert.match(html, /data-context-truncated="true"/);
  assert.match(html, /data-context-length="120000"/);
  assert.ok(
    !html.includes('data-context-length="7"'),
    'the delivered text\'s length (7) must never be presented as the size',
  );
});

test('a reported length with no body text is shown as absent, not as an empty context', () => {
  const html = contextSectionHtml(loaded(record({ text: null, length: 900 })), 'main', 2_000);
  assert.match(html, /data-context-state="absent"/);
  assert.match(html, /data-context-length="900"/);
  assert.match(html, /no body text/i);
  assert.ok(!html.includes('<details'));
});

test('a file reference is named when there is no inline text', () => {
  const html = contextSectionHtml(
    loaded(record({ text: null, ref: '/tmp/body.json', length: 5_000 })),
    'main',
    2_000,
  );
  assert.match(html, /data-context-state="absent"/);
  assert.match(html, /\/tmp\/body\.json/);
});

test('a lane with no api request at or before the chosen time says so, not another lane\'s context', () => {
  const html = contextSectionHtml({ laneId: 'main', atMs: 2_000, status: 'ready', record: null }, 'main', 2_000);
  assert.match(html, /data-context-state="none"/);
  assert.match(html, /no api request/i);
});

test('the section only renders ready when the loaded state agrees with the lane and time asked for', () => {
  const state = loaded(
    record({ text: '{"messages":[{"role":"user","content":"stale"}]}', length: 40 }),
    'main',
    1_000,
  );
  const wrongTime = contextSectionHtml(state, 'main', 2_000);
  assert.match(wrongTime, /data-context-state="loading"/);
  assert.ok(!wrongTime.includes('stale'));

  const wrongLane = contextSectionHtml(state, 'agent:agt-a', 1_000);
  assert.match(wrongLane, /data-context-state="loading"/);
  assert.ok(!wrongLane.includes('stale'));

  assert.match(contextSectionHtml(null, 'main', 2_000), /data-context-state="loading"/);
});

test('a failed fetch is shown as an error, with nothing to expand', () => {
  const html = contextSectionHtml({ laneId: 'main', atMs: 2_000, status: 'error', record: null }, 'main', 2_000);
  assert.match(html, /data-context-state="error"/);
  assert.ok(!html.includes('<details'));
});

test('one collapsed line carries the size, and the whole text is there to expand', () => {
  const text = 'x'.repeat(3_000);
  const body = JSON.stringify({ messages: [{ role: 'user', content: text }] });
  const html = contextSectionHtml(loaded(record({ text: body, length: body.length })), 'main', 2_000);
  assert.match(html, /data-block-size="3000"/);
  assert.ok(html.includes(fmtNum(3_000)), 'expected a human-readable size in the collapsed line');
  const detailsTag = html.match(/<details[^>]*>/)[0];
  assert.ok(!/ open(?:[\s>]|=)/.test(detailsTag), 'a block must render collapsed, not open');
  const pre = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/);
  assert.ok(pre && pre[1].includes(text), 'the full 3000 characters must be present to expand into');
});

test('block text and tool names are escaped', () => {
  const body = JSON.stringify({
    messages: [
      { role: 'user', content: '<script>alert(1)</script>' },
      { role: 'assistant', content: [{ type: 'tool_use', name: '<img onerror=1>', input: {} }] },
    ],
  });
  const html = contextSectionHtml(loaded(record({ text: body, length: body.length })), 'main', 2_000);
  assert.ok(!html.includes('<script'));
  assert.ok(!html.includes('onerror='));
});

test("the tool listing's class name is not borrowed for a context block", () => {
  const body = JSON.stringify({
    messages: [{ role: 'assistant', content: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'x' } }] }],
  });
  const html = contextSectionHtml(loaded(record({ text: body, length: body.length })), 'main', 2_000);
  assert.ok(!html.includes('tool-call'), 'a context block must not carry the tool listing\'s "tool-call" class');
});
