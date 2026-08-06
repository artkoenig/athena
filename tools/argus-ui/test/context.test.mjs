import test from 'node:test';
import assert from 'node:assert/strict';

import {
  contextBlocks,
  renderContextPanel,
  PREVIEW_CHARS,
  laneContentQuery,
  fetchLaneContext,
  laneContextInput,
  lanePanelInput,
} from '../public/context.js';
import { esc, fmtNum } from '../public/format.js';

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

const agentLane = (over = {}) =>
  lane({ key: 'agent:sp-b:probe', kind: 'agent', label: 'probe', spanId: 'sp-b', agent: 'probe', ...over });

const view = (over = {}) => ({ startMs: 1000, endMs: 5000, durationMs: 4000, lanes: [lane(), agentLane()], ...over });

/** An api function that records what it was asked for and answers what it was given. */
const recorder = (answer = { item: item() }) => {
  const calls = [];
  return {
    calls,
    api: async (path, params) => {
      calls.push({ path, params });
      return typeof answer === 'function' ? answer() : answer;
    },
  };
};

/** The markup of each rendered block, in the order the panel prints them. */
const blockChunks = (html) => [...html.matchAll(/<details class="ctx-block"[\s\S]*?<\/details>/g)].map((m) => m[0]);

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
  const body = requestBody();
  const html = renderContextPanel({ lane: lane(), item: item({ body }) });
  assert.ok(html.includes(lane().label), 'the head must carry the lane\'s own label');
  assert.match(
    html,
    new RegExp('<span class="context-meta" data-chars="' + body.length + '"'),
    'the head\'s total must be the body\'s own length, not any number',
  );
  assert.ok(
    html.includes(fmtNum(body.length) + ' chars'),
    'the readable line must carry the same total the data attribute does',
  );
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

// fetchLaneContext(api, …) — the request that goes on the wire, and the record
// that comes back.

test('the request carries the cursor\'s own moment, for that lane only', async () => {
  const { api, calls } = recorder();
  await fetchLaneContext(api, { session: 's1', key: 'main', view: view(), cursor: { live: false, timeMs: 3000 } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/content/at');
  assert.deepEqual(
    calls[0].params,
    { session: 's1', at: 3000, main: '1' },
    'exactly those three keys, so a request with no at (which the collector answers with the head, at every cursor position) fails here',
  );
});

test('a live cursor asks for the head of the recorded window', async () => {
  const { api, calls } = recorder();
  await fetchLaneContext(api, { session: 's1', key: 'main', view: view(), cursor: { live: true, timeMs: null } });
  assert.equal(calls[0].params.at, 5000, 'the view\'s own endMs');
});

test('a moment outside the window is clamped to it, never sent raw', async () => {
  const { api: apiHigh, calls: callsHigh } = recorder();
  await fetchLaneContext(apiHigh, { session: 's1', key: 'main', view: view(), cursor: { live: false, timeMs: 9_000_000 } });
  assert.equal(callsHigh[0].params.at, 5000);

  const { api: apiLow, calls: callsLow } = recorder();
  await fetchLaneContext(apiLow, { session: 's1', key: 'main', view: view(), cursor: { live: false, timeMs: 0 } });
  assert.equal(callsLow[0].params.at, 1000, 'the moment goes through resolveCursor, not straight from cursor.timeMs');
});

test('an agent lane asks with its own span, at the same moment', async () => {
  const { api, calls } = recorder();
  await fetchLaneContext(api, {
    session: 's1',
    key: 'agent:sp-b:probe',
    view: view(),
    cursor: { live: false, timeMs: 3000 },
  });
  assert.deepEqual(
    calls[0].params,
    { session: 's1', at: 3000, span: 'sp-b' },
    'no main key, and the moment travels with the filter',
  );
});

test('the fetched record comes back under the lane it was fetched for', async () => {
  const rec = item();
  const { api } = recorder({ item: rec });
  const result = await fetchLaneContext(api, { session: 's1', key: 'main', view: view(), cursor: { live: true, timeMs: null } });
  assert.deepEqual(result, { key: 'main', item: rec });
  assert.equal(result.item, rec, 'the record itself, not a copy and not null');
});

test('a lane the filter cannot identify fires no request at all', async () => {
  const noFilterView = view({
    lanes: [lane(), lane({ key: 'agent::', kind: 'agent', label: 'subagent', spanId: null, agent: null })],
  });

  const { api: apiEmpty, calls: callsEmpty } = recorder();
  const emptyResult = await fetchLaneContext(apiEmpty, {
    session: 's1',
    key: 'agent::',
    view: noFilterView,
    cursor: { live: true, timeMs: null },
  });
  assert.equal(callsEmpty.length, 0);
  assert.deepEqual(emptyResult, { key: 'agent::', item: null });

  const { api: apiGone, calls: callsGone } = recorder();
  const goneResult = await fetchLaneContext(apiGone, {
    session: 's1',
    key: 'agent:gone:x',
    view: noFilterView,
    cursor: { live: true, timeMs: null },
  });
  assert.equal(
    callsGone.length,
    0,
    'an unfiltered request would answer with the main session\'s context under an agent\'s lane',
  );
  assert.deepEqual(goneResult, { key: 'agent:gone:x', item: null });
});

test('with no lane open, or no session, nothing is asked for', async () => {
  const { api: apiNoLane, calls: callsNoLane } = recorder();
  const noLaneResult = await fetchLaneContext(apiNoLane, {
    session: 's1',
    key: null,
    view: view(),
    cursor: { live: true, timeMs: null },
  });
  assert.equal(callsNoLane.length, 0);
  assert.deepEqual(noLaneResult, { key: null, item: null });

  const { api: apiNoSession, calls: callsNoSession } = recorder();
  const noSessionResult = await fetchLaneContext(apiNoSession, {
    session: null,
    key: 'main',
    view: view(),
    cursor: { live: true, timeMs: null },
  });
  assert.equal(callsNoSession.length, 0);
  assert.deepEqual(noSessionResult, { key: 'main', item: null });

  const { api: apiNoInput, calls: callsNoInput } = recorder();
  const noInputResult = await fetchLaneContext(apiNoInput);
  assert.equal(callsNoInput.length, 0);
  assert.deepEqual(noInputResult, { key: null, item: null });
});

test('a failed fetch costs the panel and not the page', async () => {
  const api = async () => {
    throw new Error('offline');
  };
  const result = await fetchLaneContext(api, { session: 's1', key: 'main', view: view(), cursor: { live: true, timeMs: null } });
  assert.deepEqual(result, { key: 'main', item: null });
});

test('an answer with no record is held as no record', async () => {
  for (const answer of [{}, null, { item: null }]) {
    const { api } = recorder(answer);
    const result = await fetchLaneContext(api, {
      session: 's1',
      key: 'main',
      view: view(),
      cursor: { live: true, timeMs: null },
    });
    assert.equal(result.item, null, `answer ${JSON.stringify(answer)} must be held as no record`);
    assert.equal(result.key, 'main');
  }
});

test('the held record for the open lane is what the panel is drawn from', () => {
  const rec = item();
  const out = laneContextInput('main', { key: 'main', item: rec });
  assert.deepEqual(out, { item: rec, pending: false });
  assert.equal(out.item, rec);
});

test('an answer held for another lane means a fetch in flight, not an empty context', () => {
  assert.deepEqual(
    laneContextInput('agent:sp-b:probe', { key: 'main', item: item() }),
    { item: null, pending: true },
    'saying "no API request here" while a fetch is in flight is the panel lying',
  );
  assert.deepEqual(laneContextInput('main', { key: null, item: null }), { item: null, pending: true });
  assert.deepEqual(laneContextInput('main', null), { item: null, pending: true });
});

test('what the page holds spreads straight into the panel, and the record\'s own content is what it shows', () => {
  const rec = item();
  const readyHtml = renderContextPanel({ lane: lane(), ...laneContextInput('main', { key: 'main', item: rec }), expanded: [] });
  assert.match(readyHtml, /data-state="ready"/);
  assert.ok(readyHtml.includes('You are a Claude agent.'), 'the fixture\'s own system prompt must be present');
  assert.ok(readyHtml.includes('the answer'), 'the fixture\'s own assistant text must be present');

  const pendingHtml = renderContextPanel({
    lane: lane(),
    ...laneContextInput('agent:sp-b:probe', { key: 'main', item: rec }),
    expanded: [],
  });
  assert.match(pendingHtml, /data-state="pending"/);
});

// Increment 6 — lanePanelInput(view, key, held, expanded): the panel's whole
// input becomes one pure value, so the lane lookup that decides whose context
// is drawn is itself value-testable (reviewer's increment 5 round 2, findings
// 1 and 3).

test('the panel input is built from the lane whose key the reader selected', () => {
  const v = view();
  const rec = item();
  const out = lanePanelInput({
    view: v,
    key: 'agent:sp-b:probe',
    held: { key: 'agent:sp-b:probe', item: rec },
    expanded: ['12:0'],
  });
  assert.deepEqual(out, { lane: v.lanes[1], item: rec, pending: false, expanded: ['12:0'] });
  assert.equal(
    out.lane,
    v.lanes[1],
    'the agent lane itself — a lookup that lands on the main lane puts a subagent under the main session\'s heading',
  );

  const mainOut = lanePanelInput({
    view: v,
    key: 'main',
    held: { key: 'main', item: rec },
    expanded: ['12:0'],
  });
  assert.equal(mainOut.lane, v.lanes[0]);
});

test('a key no lane carries, and no key at all, leave nothing to draw', () => {
  const noneOut = lanePanelInput({ view: view(), key: 'agent:gone:x', held: null });
  assert.equal(noneOut.lane, null);

  const nullKeyOut = lanePanelInput({ view: view(), key: null, held: { key: null, item: null } });
  assert.equal(nullKeyOut.lane, null);

  const noArgOut = lanePanelInput();
  assert.equal(noArgOut.lane, null);
  assert.deepEqual(noArgOut, { lane: null, item: null, pending: true, expanded: [] });

  assert.equal(
    renderContextPanel(lanePanelInput({ view: view(), key: null, held: null })),
    '',
    'no lane selected, no panel under the timeline',
  );
});

test('a subagent lane\'s context is drawn under that subagent\'s own heading', () => {
  const rec = item();
  const html = renderContextPanel(
    lanePanelInput({
      view: view(),
      key: 'agent:sp-b:probe',
      held: { key: 'agent:sp-b:probe', item: rec },
      expanded: [],
    }),
  );
  assert.match(
    html,
    /data-state="ready"/,
    'an input with no lane renders the empty string — this is the case a dropped lane fails',
  );
  assert.ok(html.includes('data-context-lane="agent:sp-b:probe"'));
  assert.ok(html.includes('probe'));
  assert.ok(
    !html.includes('main session'),
    'the main session\'s heading over a subagent\'s context is the mutation this case exists to catch',
  );
  assert.ok(html.includes('the answer'), 'the record\'s own content must be what the panel shows');

  const mainHtml = renderContextPanel(
    lanePanelInput({ view: view(), key: 'main', held: { key: 'main', item: rec }, expanded: [] }),
  );
  assert.ok(mainHtml.includes('data-context-lane="main"'));
  assert.ok(mainHtml.includes('main session'));
});

// Increment 6 — the sizes and the one-line preview must reach the markup
// (reviewer's increment 5 round 2, finding 3, mutations M-D and M-E).

test('every collapsed line shows that block\'s own size', () => {
  const { blocks } = contextBlocks(requestBody());
  const chunks = blockChunks(renderContextPanel({ lane: lane(), item: item() }));
  assert.ok(
    new Set(blocks.map((b) => b.chars)).size > 1,
    'the fixture must carry blocks of differing sizes, or one size printed for all of them would pass',
  );
  assert.equal(chunks.length, blocks.length);
  blocks.forEach((block, i) => {
    const m = chunks[i].match(/<span class="ctx-size" data-chars="(\d+)">([\s\S]*?)<\/span>/);
    assert.ok(m, `block ${i} must carry a ctx-size span`);
    assert.equal(Number(m[1]), block.chars, `block ${i} must advertise its own measured size`);
    assert.equal(
      m[2],
      esc(fmtNum(block.chars)),
      'and the reader must see that same size, not another block\'s and not zero',
    );
  });
});

test('the one line a collapsed block shows reaches the markup', () => {
  const { blocks } = contextBlocks(requestBody());
  const chunks = blockChunks(renderContextPanel({ lane: lane(), item: item() }));
  assert.ok(
    blocks.every((b) => b.preview.length > 0),
    'no block of the fixture may preview as nothing, or an emptied preview span would pass',
  );
  assert.ok(
    blocks.some((b) => b.preview.endsWith('…')),
    'at least one preview must be a real cut, so this case cannot pass on previews that are just the whole text',
  );
  blocks.forEach((block, i) => {
    const m = chunks[i].match(/<span class="ctx-preview">([\s\S]*?)<\/span>/);
    assert.ok(m, `block ${i} must carry a ctx-preview span`);
    assert.equal(m[1], esc(block.preview), `block ${i}'s collapsed line must be its own preview`);
  });
});
