import test from 'node:test';
import assert from 'node:assert/strict';

import { contextBlocks, renderContextPanel, PREVIEW_CHARS, laneContentQuery } from '../public/context.js';
import { esc } from '../public/format.js';

// The three factories every case builds its input from — modelled on the
// captured request body (increment 5's finding 3) and nothing else.

const requestBody = (over = {}) =>
  JSON.stringify({
    model: 'claude-sonnet-5',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'ping' }] },
      { role: 'system', content: '<system-reminder>context</system-reminder>' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'thought', signature: 'sig' },
          { type: 'text', text: 'the answer' },
          { type: 'tool_use', id: 'toolu_01', name: 'Write', input: { file_path: '/tmp/notes.txt', content: 'hello' } },
        ],
      },
      { role: 'user', content: [{ tool_use_id: 'toolu_01', type: 'tool_result', content: 'File created' }] },
    ],
    system: [
      { type: 'text', text: 'You are a Claude agent.' },
      { type: 'text', text: 'Long instructions.', cache_control: { type: 'ephemeral' } },
    ],
    tools: [{ name: 'Read', description: 'Reads a file', input_schema: { type: 'object' } }],
    max_tokens: 64000,
    stream: true,
    ...over,
  });

const item = (over = {}) => ({
  seq: 12,
  timeMs: 4000,
  sessionId: 's1',
  spanId: 'sp-a',
  eventName: 'claude_code.api_request_body',
  model: 'claude-sonnet-5',
  truncated: false,
  body: requestBody(),
  ...over,
});

const lane = (over = {}) => ({ key: 'main', kind: 'main', label: 'main session', spanId: null, agent: null, ...over });

// Criterion — selecting a lane at the chosen time shows that agent's context as a
// message list, built from contextBlocks(body).

test('the five kinds the criterion names all reach the list, system prompt first', () => {
  const { blocks } = contextBlocks(requestBody());
  assert.deepEqual(
    blocks.map((b) => b.kind),
    [
      'system',
      'system',
      'user',
      'system',
      'thinking',
      'assistant',
      'tool_use',
      'tool_result',
      'field',
      'field',
      'field',
      'field',
    ],
    'two system-prompt entries, then the messages in order — the assistant\'s reply sits between its thinking and its tool call — then model/tools/max_tokens/stream as fields',
  );
});

test('a block\'s size is the size of the text it expands to', () => {
  const { blocks } = contextBlocks(requestBody());
  const pingBlock = blocks.find((b) => b.text === 'ping');
  assert.ok(pingBlock, 'the ping text block must be present');
  assert.equal(pingBlock.chars, 4);
  for (const block of blocks) {
    assert.equal(block.chars, block.text.length, `block ${block.index} (${block.kind}) must report the size of its own text`);
  }
});

test('the exact full text survives the parse, unescaped and uncut', () => {
  const hostileText = '<script>"x"</script>\nline two';
  const body = requestBody({ system: [{ type: 'text', text: hostileText }] });
  const { blocks } = contextBlocks(body);
  const block = blocks.find((b) => b.kind === 'system');
  assert.equal(block.text, hostileText, 'escaping is the renderer\'s job, not the parser\'s');
});

test('a tool call names its tool and keeps the whole call', () => {
  const { blocks } = contextBlocks(requestBody());
  const toolUseBlock = blocks.find((b) => b.kind === 'tool_use');
  assert.ok(toolUseBlock, 'the assistant\'s tool_use content must yield its own block');
  assert.ok(toolUseBlock.label.includes('Write'), 'the label must name the tool that was called');
  const parsedBack = JSON.parse(toolUseBlock.text);
  assert.equal(parsedBack.id, 'toolu_01');
  assert.equal(parsedBack.name, 'Write');
  assert.deepEqual(parsedBack.input, { file_path: '/tmp/notes.txt', content: 'hello' });
});

test('a tool result expands to the result text and is tied to its call', () => {
  const { blocks } = contextBlocks(requestBody());
  const resultBlock = blocks.find((b) => b.kind === 'tool_result');
  assert.ok(resultBlock, 'the tool_result content must yield its own block');
  assert.equal(resultBlock.text, 'File created');
  assert.ok(resultBlock.label.includes('toolu_01'), 'the label must tie the result back to the call it answers');
});

test('a failed tool result says so on its one line', () => {
  const body = requestBody({
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'ping' }] },
      { role: 'system', content: '<system-reminder>context</system-reminder>' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'thought', signature: 'sig' },
          { type: 'tool_use', id: 'toolu_01', name: 'Write', input: { file_path: '/tmp/notes.txt', content: 'hello' } },
        ],
      },
      {
        role: 'user',
        content: [{ tool_use_id: 'toolu_01', type: 'tool_result', content: 'File created', is_error: true }],
      },
    ],
  });
  const { blocks } = contextBlocks(body);
  const resultBlock = blocks.find((b) => b.kind === 'tool_result');
  assert.ok(resultBlock, 'the tool_result content must yield its own block');
  assert.ok(resultBlock.label.includes('error'), 'a failed tool result must say so on its collapsed line');
});

test('a message whose content is a plain string is one block of that role', () => {
  const { blocks } = contextBlocks(requestBody());
  const stringMessageBlocks = blocks.filter((b) => b.text === '<system-reminder>context</system-reminder>');
  assert.equal(stringMessageBlocks.length, 1, 'the string-content system-role message must yield exactly one block');
  assert.equal(stringMessageBlocks[0].kind, 'system');
});

test('thinking is its own block', () => {
  const { blocks } = contextBlocks(requestBody());
  const thinkingBlock = blocks.find((b) => b.kind === 'thinking');
  assert.ok(thinkingBlock, 'the assistant\'s thinking content must yield its own block');
  assert.equal(thinkingBlock.text, 'thought');
});

test('an unknown content block is kept, labelled by its type', () => {
  const body = requestBody({
    messages: [{ role: 'user', content: [{ type: 'image', source: { data: 'AAA' } }] }],
  });
  const { blocks } = contextBlocks(body);
  const otherBlocks = blocks.filter((b) => b.kind === 'other');
  assert.equal(otherBlocks.length, 1, 'no content block may be silently dropped');
  assert.equal(otherBlocks[0].label, 'image');
  const parsedBack = JSON.parse(otherBlocks[0].text);
  assert.deepEqual(parsedBack, { type: 'image', source: { data: 'AAA' } });
});

test('a system given as a plain string still parses', () => {
  // Note: this pins only the unambiguous half of the case — see this
  // increment's handoff for the conflict between "exactly one kind === 'system'
  // block" and the default fixture's system-role string message, which also
  // parses to a kind === 'system' block by the same rule case 1 relies on.
  const body = requestBody({ system: 'be brief' });
  const { blocks } = contextBlocks(body);
  const systemStringBlocks = blocks.filter((b) => b.kind === 'system' && b.text === 'be brief');
  assert.equal(systemStringBlocks.length, 1, 'a string system prompt must still parse into exactly one block carrying it');
});

test('the fields that are not messages are accounted for, so the sizes tell the truth', () => {
  const body = requestBody();
  const parsed = JSON.parse(body);
  const { blocks } = contextBlocks(body);
  const toolsBlock = blocks.find((b) => b.kind === 'field' && b.label === 'tools');
  assert.ok(toolsBlock, 'the tools array must get a field block of its own — it is two-thirds of a real context');
  assert.equal(toolsBlock.chars, JSON.stringify(parsed.tools, null, 2).length);
  const fieldLabels = blocks.filter((b) => b.kind === 'field').map((b) => b.label);
  assert.ok(!fieldLabels.includes('system'), 'system is rendered by its own rule, never as a field');
  assert.ok(!fieldLabels.includes('messages'), 'messages is rendered by its own rule, never as a field');
});

test('the whole body\'s size is reported alongside the blocks', () => {
  const body = requestBody();
  const result = contextBlocks(body);
  assert.equal(result.chars, body.length);
  assert.equal(result.ok, true);
});

test('a truncated body becomes one raw block carrying every character it has', () => {
  const truncated = '{"messages":[{"role":"user","cont';
  const result = contextBlocks(truncated);
  assert.equal(result.ok, false);
  assert.equal(result.blocks.length, 1);
  const [block] = result.blocks;
  assert.equal(block.kind, 'raw');
  assert.equal(block.text, truncated, 'the exact text is still there even when JSON.parse cannot make sense of it');
  assert.equal(block.chars, truncated.length);
});

test('no body at all is no blocks, never a crash', () => {
  for (const input of [null, undefined, '', 42]) {
    assert.deepEqual(
      contextBlocks(input),
      { ok: false, chars: 0, blocks: [] },
      `contextBlocks(${JSON.stringify(input)}) must be empty, not a crash`,
    );
  }
});

test('a body that parses to something other than an object is raw, not empty', () => {
  for (const input of ['[1,2]', '"x"']) {
    const result = contextBlocks(input);
    assert.equal(result.ok, false, `${input} is not a plain object and must not be reported ok`);
    assert.equal(result.blocks.length, 1);
    assert.equal(result.blocks[0].kind, 'raw');
  }
});

test('a message with no content contributes nothing', () => {
  const body = requestBody({
    messages: [{ role: 'user' }, { role: 'user', content: [] }, { role: 'user', content: 'x' }],
  });
  const { blocks } = contextBlocks(body);
  const messageBlocks = blocks.filter((b) => b.kind !== 'system' && b.kind !== 'field');
  assert.equal(messageBlocks.length, 1, 'two messages with no usable content must contribute no block');
  assert.equal(messageBlocks[0].text, 'x');
});

test('the one line is a one-line preview', () => {
  const longText = 'a\n\n   b'.repeat(30);
  const body = requestBody({ system: [{ type: 'text', text: longText }] });
  const { blocks } = contextBlocks(body);
  const block = blocks.find((b) => b.kind === 'system');
  assert.ok(!block.preview.includes('\n'), 'a preview must be a single line');
  assert.ok(!block.preview.includes('  '), 'runs of whitespace must collapse to one space');
  assert.ok(block.preview.length <= 121, 'a preview must be cut to 120 characters plus the ellipsis');
  assert.ok(block.preview.endsWith('…'), 'a cut preview must show it was cut');
});

test('block indexes are their positions, in order', () => {
  const { blocks } = contextBlocks(requestBody());
  assert.deepEqual(
    blocks.map((b) => b.index),
    blocks.map((_, i) => i),
  );
});

// renderContextPanel({ lane, item, pending, expanded })

test('nothing selected renders nothing', () => {
  assert.equal(renderContextPanel(), '', 'no lane is selected — no empty panel sits under the timeline');
  assert.equal(renderContextPanel({ lane: null, item: item() }), '');
});

test('a selected lane at a moment renders one expandable block per block, each with its size', () => {
  const { blocks } = contextBlocks(requestBody());
  const html = renderContextPanel({ lane: lane(), item: item() });

  const detailsTags = [...html.matchAll(/<details class="ctx-block" data-kind="([^"]*)"[^>]*>/g)];
  assert.equal(detailsTags.length, blocks.length, 'one <details> per parsed block');
  detailsTags.forEach((match, i) => {
    assert.equal(match[1], blocks[i].kind, `block ${i} must render in the same order it was parsed`);
  });

  for (let i = 0; i < blocks.length; i++) {
    assert.match(html, new RegExp(`data-block="12:${i}"`), `block ${i} must carry the record's seq and its own index`);
  }

  const sizeTags = [...html.matchAll(/<span class="ctx-size" data-chars="\d+">/g)];
  assert.equal(sizeTags.length, blocks.length, 'every block must show its size');
  const preTags = [...html.matchAll(/<pre class="ctx-text">/g)];
  assert.equal(preTags.length, blocks.length, 'every block must expand to its own exact text');
});

test('the head names the lane and the record the context came from', () => {
  const html = renderContextPanel({ lane: lane(), item: item() });
  assert.ok(html.includes(lane().label), 'the head must carry the lane\'s own label');
  assert.match(html, /data-chars="\d+"/);
  assert.match(html, /data-time="4000"/);
  assert.match(html, /data-model="claude-sonnet-5"/);
  assert.match(html, /data-truncated="false"/);
  assert.match(html, /data-state="ready"/);
});

test('every block is collapsed until it is asked for', () => {
  const html = renderContextPanel({ lane: lane(), item: item() });
  assert.ok(!html.includes(' open'), 'nothing must be expanded until the reader asks for it');
});

test('an expanded block stays expanded, and only that one', () => {
  const htmlFromArray = renderContextPanel({ lane: lane(), item: item(), expanded: ['12:2'] });
  const openTags = [...htmlFromArray.matchAll(/<details class="ctx-block"[^>]*\bopen\b[^>]*>/g)];
  assert.equal(openTags.length, 1, 'exactly one block must be expanded');

  const detailsBlocks = [...htmlFromArray.matchAll(/<details class="ctx-block"[\s\S]*?<\/details>/g)];
  const openBlock = detailsBlocks.find((m) => m[0].includes(' open'));
  assert.ok(openBlock, 'the open block must be findable in the markup');
  assert.ok(openBlock[0].includes('data-block="12:2"'), 'the block asked to expand is the one that expands');

  const htmlFromSet = renderContextPanel({ lane: lane(), item: item(), expanded: new Set(['12:2']) });
  assert.equal(htmlFromSet, htmlFromArray, 'a caller may pass an array or a Set and get byte-identical markup');
});

test('a moment before this lane\'s first request says so, with no blocks', () => {
  const html = renderContextPanel({ lane: lane(), item: null });
  assert.match(html, /data-state="empty"/);
  assert.equal((html.match(/class="placeholder"/g) ?? []).length, 1);
  assert.ok(!html.includes('<details'), 'no block may be shown when there is no request to show');
});

test('a fetch in flight does not claim there is nothing', () => {
  const html = renderContextPanel({ lane: lane(), item: null, pending: true });
  assert.match(html, /data-state="pending"/);
  assert.ok(!html.includes('<details'));
});

test('a truncated record is marked as one', () => {
  const rawBody = '{"messages":[';
  const html = renderContextPanel({ lane: lane(), item: item({ truncated: true, body: rawBody }) });
  assert.match(html, /data-truncated="true"/);
  const rawMatch = html.match(/<details class="ctx-block" data-kind="raw"[\s\S]*?<\/details>/);
  assert.ok(rawMatch, 'a truncated body must still render as one raw block');
  assert.ok(rawMatch[0].includes('messages'), 'the raw block must still carry the text it has');
});

test('the panel escapes everything it prints', () => {
  const body = requestBody({
    messages: [
      { role: 'user', content: [{ type: 'text', text: '<script>alert("x")</script>' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_02', name: '<img>', input: {} }] },
    ],
  });
  const html = renderContextPanel({ lane: lane(), item: item({ body }) });
  assert.match(html, /&lt;script&gt;/, 'the escaped form of the hostile text must be present');
  assert.ok(!html.includes('<script>'), 'a raw <script> must never reach the DOM');
  assert.ok(!html.includes('<img>'), 'a raw <img> must never reach the DOM');
});

test('the panel carries no attribute the lane click handler would catch', () => {
  const html = renderContextPanel({ lane: lane(), item: item() });
  assert.doesNotMatch(
    html,
    /data-lane=/,
    'a data-lane attribute here would make every click inside the panel toggle the lane selection',
  );
});

test('the panel prints no NaN and no undefined', () => {
  const html = renderContextPanel({
    lane: lane({ label: 'agent #1', key: 'agent:sp-a:probe' }),
    item: item({ model: null, timeMs: 0 }),
  });
  assert.ok(!html.includes('NaN'));
  assert.ok(!html.includes('undefined'));
});

// Increment 5 — Round 1: the reviewer's reproduction spec. Two production
// mutations survived the round-0 suite untouched — esc(block.preview) in
// place of esc(block.text) inside <pre class="ctx-text">, and dropping
// 'assistant' from the role kinds — plus a lane→query mapping that a grep
// over prose could satisfy without the code calling anything.

test('an assistant reply reaches the list, and the panel marks it as the assistant\'s', () => {
  const { blocks } = contextBlocks(requestBody());
  const assistantBlocks = blocks.filter((b) => b.kind === 'assistant');
  assert.equal(
    assistantBlocks.length,
    1,
    'the criterion names assistant as one of five kinds — exactly one block must carry it',
  );
  assert.equal(assistantBlocks[0].text, 'the answer');

  const html = renderContextPanel({ lane: lane(), item: item() });
  const assistantDetails = [...html.matchAll(/<details class="ctx-block" data-kind="assistant"[\s\S]*?<\/details>/g)];
  assert.equal(assistantDetails.length, 1, 'exactly one rendered block must be tagged data-kind="assistant"');
  assert.match(
    assistantDetails[0][0],
    /<pre class="ctx-text">[\s\S]*the answer[\s\S]*<\/pre>/,
    'the assistant block must expand to the assistant\'s own text',
  );
});

test('an expanded block shows the exact full text, not the one line it collapsed to', () => {
  const LONG = '<line of output>\n'.repeat(40);
  const body = requestBody({
    messages: [{ role: 'user', content: [{ tool_use_id: 'toolu_01', type: 'tool_result', content: LONG }] }],
  });
  const { blocks } = contextBlocks(body);
  const resultBlock = blocks.find((b) => b.kind === 'tool_result');
  assert.ok(resultBlock, 'the tool_result content must yield its own block');
  assert.ok(
    resultBlock.text.length > PREVIEW_CHARS,
    'the fixture must be long enough that the preview is a real cut, not the whole text — otherwise this case is vacuous',
  );
  assert.notEqual(
    resultBlock.preview,
    resultBlock.text,
    'a preview equal to the text would make this case unable to catch a preview substituted for the text',
  );

  const html = renderContextPanel({ lane: lane(), item: item({ body }) });
  const preContents = [...html.matchAll(/<pre class="ctx-text">([\s\S]*?)<\/pre>/g)].map((m) => m[1]);
  assert.equal(preContents.length, blocks.length, 'one <pre> per parsed block');
  blocks.forEach((block, i) => {
    assert.equal(
      preContents[i],
      esc(block.text),
      `block ${i} (${block.kind}) must expand to its own exact text, escaped but never cut or replaced by its preview`,
    );
  });
});

test('every block expands to its own text, in the order the list shows them', () => {
  const { blocks } = contextBlocks(requestBody());
  const html = renderContextPanel({ lane: lane(), item: item() });
  const preContents = [...html.matchAll(/<pre class="ctx-text">([\s\S]*?)<\/pre>/g)].map((m) => m[1]);
  assert.equal(preContents.length, blocks.length, 'one <pre> per parsed block');
  blocks.forEach((block, i) => {
    assert.equal(
      preContents[i],
      esc(block.text),
      `block ${i} (${block.kind}) must expand to its own exact text, in the order contextBlocks returned it`,
    );
  });
});

// laneContentQuery(lane) — the one lane filter that goes on the wire.

test('the main lane asks for the main session\'s own traffic', () => {
  assert.deepEqual(laneContentQuery(lane()), { main: '1' }, 'exactly one key, main, for the main lane');
});

test('an agent lane asks for its own span, never for the main session', () => {
  const result = laneContentQuery({ key: 'agent:sp-a:probe', kind: 'agent', spanId: 'sp-a', agent: 'probe' });
  assert.deepEqual(
    result,
    { span: 'sp-a' },
    'the span must win over the name, and the object must carry no main key and nothing else',
  );
});

test('an agent lane with no span falls back to its name', () => {
  const result = laneContentQuery({ key: 'agent::probe', kind: 'agent', spanId: null, agent: 'probe' });
  assert.deepEqual(result, { agent: 'probe' });
});

test('a lane that identifies nothing gets no query at all, so no lane ever shows the main session\'s context by accident', () => {
  assert.equal(
    laneContentQuery({ key: 'agent::', kind: 'agent', spanId: null, agent: null }),
    null,
    'an empty filter would send an unfiltered request, which the collector answers with main traffic',
  );
  assert.equal(laneContentQuery(null), null);
  assert.equal(laneContentQuery(undefined), null);
});
