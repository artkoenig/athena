import test from 'node:test';
import assert from 'node:assert/strict';

import {
  contextBlocks,
  renderContextPanel,
  laneContentQuery,
  fetchLaneContext,
  laneContextInput,
  lanePanelInput,
  contextFilterEntries,
  visibleBlocks,
  hiddenAfterAll,
  contextEntryIds,
  contextCounts,
  blockMatches,
  renderContextSearch,
} from '../public/context.js';
import { esc, fmtNum, PREVIEW_CHARS } from '../public/format.js';

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
    assert.ok(blocks[i].key, `block ${i} must have been given a key to render with`);
    assert.match(html, new RegExp(`data-block="${esc(blocks[i].key)}"`), `block ${i} must carry its own key`);
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
  const htmlFromArray = renderContextPanel({ lane: lane(), item: item(), expanded: ['kind:user#0'] });
  const openTags = [...htmlFromArray.matchAll(/<details class="ctx-block"[^>]*\bopen\b[^>]*>/g)];
  assert.equal(openTags.length, 1, 'exactly one block must be expanded');

  const detailsBlocks = [...htmlFromArray.matchAll(/<details class="ctx-block"[\s\S]*?<\/details>/g)];
  const openBlock = detailsBlocks.find((m) => m[0].includes(' open'));
  assert.ok(openBlock, 'the open block must be findable in the markup');
  assert.ok(openBlock[0].includes('data-block="kind:user#0"'), 'the block asked to expand is the one that expands');

  const htmlFromSet = renderContextPanel({ lane: lane(), item: item(), expanded: new Set(['kind:user#0']) });
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
    expanded: ['kind:system#0'],
  });
  assert.deepEqual(out, {
    lane: v.lanes[1],
    item: rec,
    pending: false,
    expanded: ['kind:system#0'],
    hidden: [],
    filterOpen: false,
    search: '',
  });
  assert.equal(
    out.lane,
    v.lanes[1],
    'the agent lane itself — a lookup that lands on the main lane puts a subagent under the main session\'s heading',
  );

  const mainOut = lanePanelInput({
    view: v,
    key: 'main',
    held: { key: 'main', item: rec },
    expanded: ['kind:system#0'],
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
  assert.deepEqual(noArgOut, {
    lane: null,
    item: null,
    pending: true,
    expanded: [],
    hidden: [],
    filterOpen: false,
    search: '',
  });

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

// Increment 1 — the context panel's block filter: what the request contains,
// and what the reader hid.

test('the filter lists every kind and every field the request contains, grouped, sorted, counted', () => {
  const { blocks } = contextBlocks(requestBody());
  const entries = contextFilterEntries(blocks);
  assert.deepEqual(
    entries,
    [
      { id: 'kind:assistant', group: 'blocks', label: 'assistant', count: 1 },
      { id: 'kind:system', group: 'blocks', label: 'system', count: 3 },
      { id: 'kind:thinking', group: 'blocks', label: 'thinking', count: 1 },
      { id: 'kind:tool_result', group: 'blocks', label: 'tool_result', count: 1 },
      { id: 'kind:tool_use', group: 'blocks', label: 'tool_use', count: 1 },
      { id: 'kind:user', group: 'blocks', label: 'user', count: 1 },
      { id: 'field:max_tokens', group: 'fields', label: 'max_tokens', count: 1 },
      { id: 'field:model', group: 'fields', label: 'model', count: 1 },
      { id: 'field:stream', group: 'fields', label: 'stream', count: 1 },
      { id: 'field:tools', group: 'fields', label: 'tools', count: 1 },
    ],
    'one deepEqual over the whole list proves membership, grouping, order and the counts at once — the fixture writes ' +
      'its fields as model, tools, max_tokens, stream, so this order is proof the fields group is sorted, not copied',
  );
});

test('what the request does not contain is not listed', () => {
  const { blocks } = contextBlocks(
    requestBody({ messages: [{ role: 'user', content: 'hi' }], metadata: { user_id: 'u' } }),
  );
  const entries = contextFilterEntries(blocks);
  const ids = entries.map((e) => e.id);
  for (const missing of ['kind:thinking', 'kind:tool_use', 'kind:tool_result']) {
    assert.ok(!ids.includes(missing), `${missing} must not be listed — this request carries no such block`);
  }
  assert.deepEqual(
    entries.find((e) => e.id === 'field:metadata'),
    { id: 'field:metadata', group: 'fields', label: 'metadata', count: 1 },
    'a field this request does carry must be listed, counted once',
  );
  assert.deepEqual(
    entries.find((e) => e.id === 'kind:user'),
    { id: 'kind:user', group: 'blocks', label: 'user', count: 1 },
    'the one user message this request carries must be listed, counted once',
  );
});

test('an unparsable body lists one raw entry and no fields group at all', () => {
  const { blocks } = contextBlocks('{"messages":[');
  assert.deepEqual(
    contextFilterEntries(blocks),
    [{ id: 'kind:raw', group: 'blocks', label: 'raw', count: 1 }],
    'a body that could not be parsed is one raw block, and the filter must not invent a fields group for it',
  );
});

test('a field named like a kind cannot collide with it', () => {
  const { blocks } = contextBlocks(requestBody({ user: 'an account id' }));
  const entries = contextFilterEntries(blocks);
  assert.deepEqual(
    entries.find((e) => e.id === 'kind:user'),
    { id: 'kind:user', group: 'blocks', label: 'user', count: 1 },
    'the user message block must still be listed under its own id',
  );
  assert.deepEqual(
    entries.find((e) => e.id === 'field:user'),
    { id: 'field:user', group: 'fields', label: 'user', count: 1 },
    'the user field must be listed under its own id, on the fields side, not merged with the message kind',
  );

  const kept = visibleBlocks(blocks, ['field:user']);
  assert.ok(
    kept.some((b) => b.text === 'ping'),
    'hiding the field must leave the user message block alone',
  );
  assert.ok(
    !kept.some((b) => b.kind === 'field' && b.label === 'user'),
    'hiding the field must remove the field block, and only the field block',
  );
});

test('hiding an entry removes exactly that entry\'s blocks, and touches neither input', () => {
  const { blocks } = contextBlocks(requestBody());

  const withoutSystem = visibleBlocks(blocks, ['kind:system']);
  assert.equal(withoutSystem.length, 9, 'hiding kind:system must remove exactly its three blocks');
  assert.ok(
    !withoutSystem.some((b) => b.kind === 'system'),
    'no system block may survive when kind:system is hidden',
  );
  assert.equal(
    withoutSystem[0].index,
    2,
    'the surviving blocks must keep their original index — the array is non-contiguous, which is what keeps expansion keys stable',
  );

  assert.equal(visibleBlocks(blocks, []).length, 12, 'nothing hidden must show every block');

  assert.equal(blocks.length, 12, 'the input blocks array must not be mutated by visibleBlocks');
  const hiddenSet = new Set(['kind:system']);
  visibleBlocks(blocks, hiddenSet);
  assert.equal(hiddenSet.size, 1, 'a hidden Set passed in must not be mutated by visibleBlocks');
});

test('all off hides what is shown and keeps what was already hidden; all on clears everything', () => {
  const before = new Set(['kind:thinking']);
  const ids = contextEntryIds(item({ body: requestBody({ messages: [{ role: 'user', content: 'hi' }] }) }));
  assert.ok(!ids.includes('kind:thinking'), 'the fixture for this case must carry no thinking block');

  const afterOff = hiddenAfterAll(before, ids, false);
  assert.ok(afterOff instanceof Set, 'all off must answer with a Set');
  assert.deepEqual(
    [...afterOff].sort(),
    [...new Set([...before, ...ids])].sort(),
    'all off must hide every entry the request contains, and keep an already-hidden entry the request does not contain',
  );

  const afterOn = hiddenAfterAll(before, ids, true);
  assert.deepEqual([...afterOn], [], 'all on must clear the hidden set entirely');

  assert.equal(before.size, 1, 'neither call may mutate the Set the caller passed in');
});

test('the ids of the held record, and nothing without one', () => {
  assert.deepEqual(
    contextEntryIds(item()),
    [
      'kind:assistant',
      'kind:system',
      'kind:thinking',
      'kind:tool_result',
      'kind:tool_use',
      'kind:user',
      'field:max_tokens',
      'field:model',
      'field:stream',
      'field:tools',
    ],
    'the ids must be the same ten, in the same order, as contextFilterEntries reports for this fixture',
  );
  assert.deepEqual(contextEntryIds(null), [], 'no record at all must yield no ids');
  assert.deepEqual(contextEntryIds({}), [], 'a record with no body must yield no ids');
});

test('the dropdown sits in the head, one checkbox per entry, checked, counted, in two labelled groups with two buttons', () => {
  const html = renderContextPanel({ lane: lane(), item: item() });

  assert.equal(
    (html.match(/<details class="ctx-filter"/g) ?? []).length,
    1,
    'exactly one filter dropdown must be rendered',
  );
  assert.ok(
    html.indexOf('<details class="ctx-filter"') < html.indexOf('<div class="ctx-blocks">'),
    'the dropdown must sit in the panel head, before the block list',
  );

  assert.equal(
    (html.match(/data-ctx-entry="/g) ?? []).length,
    10,
    'one entry per kind and field the fixture carries',
  );
  assert.ok(html.includes('data-ctx-entry="kind:tool_result"'));
  assert.ok(html.includes('data-ctx-entry="field:tools"'));

  assert.match(
    html,
    /tool_result<\/span>\s*<span class="ctx-filter-count" data-count="1">\s*1/,
    'the name and the count behind it must sit side by side, e.g. "tool_result 1"',
  );
  const systemEntryStart = html.indexOf('data-ctx-entry="kind:system"');
  assert.ok(systemEntryStart >= 0, 'the kind:system entry must be present');
  const nextEntryStart = html.indexOf('data-ctx-entry="', systemEntryStart + 1);
  const systemEntryChunk = html.slice(systemEntryStart, nextEntryStart === -1 ? html.length : nextEntryStart);
  assert.match(
    systemEntryChunk,
    /data-count="3"/,
    'the system entry — the fixture\'s three system blocks — must show a count of 3',
  );

  const blocksTitleIdx = html.indexOf('>Blocks<');
  const fieldsTitleIdx = html.indexOf('>Fields<');
  assert.ok(blocksTitleIdx >= 0, 'the Blocks group must be titled');
  assert.ok(fieldsTitleIdx >= 0, 'the Fields group must be titled');
  assert.ok(blocksTitleIdx < fieldsTitleIdx, 'Blocks must come before Fields');
  assert.ok(html.includes('data-group="blocks"'));
  assert.ok(html.includes('data-group="fields"'));

  assert.ok(html.includes('data-ctx-all="on"'));
  assert.ok(html.includes('data-ctx-all="off"'));
  assert.ok(html.includes('all on'));
  assert.ok(html.includes('all off'));

  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 10, 'ten checkboxes, one per entry');
  assert.equal(
    (html.match(/ checked>/g) ?? []).length,
    10,
    'with nothing hidden, every one of the ten checkboxes must be checked',
  );
});

test('unchecking an entry removes its blocks below and only unchecks that box', () => {
  const bothHtml = renderContextPanel({ lane: lane(), item: item(), hidden: ['kind:tool_result'] });

  const chunks = blockChunks(bothHtml);
  assert.equal(chunks.length, 11, 'hiding kind:tool_result must remove exactly its one block');
  assert.ok(
    !chunks.some((c) => c.includes('data-kind="tool_result"')),
    'no tool_result block may remain in the list',
  );

  assert.match(
    bothHtml,
    /data-ctx-entry="kind:tool_result"(?! checked)/,
    'the hidden entry\'s own checkbox must not carry checked',
  );
  assert.equal(
    (bothHtml.match(/ checked>/g) ?? []).length,
    9,
    'the nine entries still visible must still carry checked — hiding one entry must not touch the others',
  );

  assert.match(
    bothHtml,
    /data-blocks="12"/,
    'the head\'s total block count must stay the fixture\'s own total — the totals are what stop the filter making the context look smaller than it is',
  );
  assert.match(
    bothHtml,
    new RegExp(`data-chars="${requestBody().length}"`),
    'the head\'s total character count must stay the fixture\'s own total — the totals are what stop the filter making the context look smaller than it is',
  );

  assert.equal(
    renderContextPanel({ lane: lane(), item: item(), hidden: [] }),
    renderContextPanel({ lane: lane(), item: item() }),
    'checking the entry back must restore the list byte for byte',
  );
});

test('a field entry hides its field only', () => {
  const html = renderContextPanel({ lane: lane(), item: item(), hidden: ['field:tools'] });
  const chunks = blockChunks(html);
  assert.equal(chunks.length, 11, 'hiding field:tools must remove exactly its one block');
  assert.ok(
    !chunks.some((c) => /class="ctx-label">tools<\/span>/.test(c)),
    'no block labelled tools may remain',
  );
  assert.ok(
    chunks.some((c) => /class="ctx-label">model<\/span>/.test(c)),
    'the model field must still be there — only tools was hidden',
  );
  assert.equal(
    chunks.filter((c) => c.includes('data-kind="system"')).length,
    3,
    'the three system blocks are untouched by hiding a field',
  );
});

test('everything hidden shows a placeholder in place of the rows, and a reader can still turn entries back on', () => {
  const hidden = contextEntryIds(item());
  const html = renderContextPanel({ lane: lane(), item: item(), hidden });
  assert.deepEqual(blockChunks(html), [], 'every block must be hidden');
  assert.match(html, /data-state="ready"/, 'the panel stays ready — this is not the empty-record state');
  assert.equal((html.match(/data-ctx-entry="/g) ?? []).length, 10, 'every entry must still be listed');
  assert.equal(
    (html.match(/ checked>/g) ?? []).length,
    0,
    'with every entry hidden, no checkbox may carry checked',
  );
  assert.equal(
    (html.match(/class="placeholder"/g) ?? []).length,
    1,
    'exactly one placeholder must replace the hidden rows',
  );
  assert.ok(
    !html.includes('<div class="ctx-blocks">'),
    'with everything hidden there must be no block-list container at all, only the placeholder',
  );
  const placeholderIdx = html.indexOf('class="placeholder"');
  assert.ok(placeholderIdx >= 0, 'the placeholder\'s own markup must be findable');
  const placeholderText = html.slice(placeholderIdx);
  assert.match(placeholderText, /hidden/, 'the placeholder must say every kind is hidden');
  assert.match(placeholderText, /filter/, 'the placeholder must say where to turn entries back on');
  assert.match(
    html,
    /data-visible-blocks="0"/,
    'the meta span must report zero visible blocks when everything is hidden',
  );
});

test('an entry hidden but absent from this request changes nothing and is not listed, and its hidden state is remembered', () => {
  const bodyWithoutThinking = requestBody({ messages: [{ role: 'user', content: 'hi' }] });
  const withHidden = renderContextPanel({ lane: lane(), item: item({ body: bodyWithoutThinking }), hidden: ['kind:thinking'] });
  const withoutHidden = renderContextPanel({ lane: lane(), item: item({ body: bodyWithoutThinking }) });
  assert.equal(withHidden, withoutHidden, 'hiding an entry the request does not carry must change nothing');
  assert.ok(!withHidden.includes('kind:thinking'), 'an absent entry must not be listed at all');

  const withThinking = renderContextPanel({ lane: lane(), item: item(), hidden: ['kind:thinking'] });
  assert.match(
    withThinking,
    /data-ctx-entry="kind:thinking"(?! checked)/,
    'scrubbing back to a request that carries the entry must show it still unchecked',
  );
  assert.ok(
    !blockChunks(withThinking).some((c) => c.includes('data-kind="thinking"')),
    'and its blocks still hidden',
  );
});

test('a caller may pass hidden as an array or a Set', () => {
  assert.equal(
    renderContextPanel({ lane: lane(), item: item(), hidden: ['kind:user'] }),
    renderContextPanel({ lane: lane(), item: item(), hidden: new Set(['kind:user']) }),
    'an array and a Set of the same ids must render byte-identical markup',
  );
});

test('the dropdown opens only when asked, and stays open across a repaint', () => {
  const openHtml = renderContextPanel({ lane: lane(), item: item(), filterOpen: true });
  assert.match(openHtml, /<details class="ctx-filter" open>/, 'filterOpen: true must render the dropdown open');

  const closedHtml = renderContextPanel({ lane: lane(), item: item() });
  const tag = closedHtml.match(/<details class="ctx-filter"[^>]*>/);
  assert.ok(tag, 'the filter dropdown must still be rendered');
  assert.equal(tag[0], '<details class="ctx-filter">', 'without filterOpen the dropdown\'s own tag must carry no open');

  assert.equal(
    renderContextPanel({ lane: lane(), item: item(), filterOpen: true }),
    renderContextPanel({ lane: lane(), item: item(), filterOpen: true }),
    'the markup is a pure function of the flag — two renders with the same flag must be byte-identical, which is what ' +
      '"a repaint does not snap it shut" means on this side',
  );
});

test('the filter catches no click meant for a lane or a block', () => {
  const html = renderContextPanel({ lane: lane(), item: item(), filterOpen: true });
  const filterMatch = html.match(/<details class="ctx-filter"[\s\S]*?<\/details>/);
  assert.ok(filterMatch, 'the filter dropdown must be present to slice out');
  const filter = filterMatch[0];

  assert.doesNotMatch(filter, /data-lane=/, 'a data-lane attribute here would make opening the dropdown toggle the lane selection');
  assert.doesNotMatch(filter, /data-block=/, 'a data-block attribute here would make opening the dropdown expand a block');

  const summaryMatch = filter.match(/<summary[^>]*>/);
  assert.ok(summaryMatch, 'the dropdown must have its own summary');
  assert.doesNotMatch(summaryMatch[0], /data-lane=/, 'the summary itself must carry no data-lane');
  assert.doesNotMatch(summaryMatch[0], /data-block=/, 'the summary itself must carry no data-block');

  assert.doesNotMatch(html, /data-lane=/, 'the whole panel must still carry no data-lane attribute');
});

test('no entries at all renders no filter and does not throw', () => {
  const html = renderContextPanel({ lane: lane(), item: item({ body: '{"messages":[]}' }) });
  assert.ok(!html.includes('ctx-filter'), 'with nothing in the request there is nothing to filter');
});

test('the panel\'s whole input still comes from one builder', () => {
  const withFilterState = lanePanelInput({
    view: view(),
    key: 'main',
    held: { key: 'main', item: item() },
    expanded: [],
    hidden: ['kind:user'],
    filterOpen: true,
  });
  assert.deepEqual(withFilterState.hidden, ['kind:user']);
  assert.equal(withFilterState.filterOpen, true);

  const withoutFilterState = lanePanelInput({
    view: view(),
    key: 'main',
    held: { key: 'main', item: item() },
    expanded: [],
  });
  assert.deepEqual(withoutFilterState.hidden, [], 'no hidden set given must default to nothing hidden');
  assert.equal(withoutFilterState.filterOpen, false, 'no filterOpen given must default to closed');
});

// Increment 2 — the panel tells the truth about how much it is hiding:
// contextCounts derives visible-of-total for blocks and characters, the head
// names both when something is hidden, and an all-hidden panel shows a
// placeholder in place of the rows instead of an empty list.

test('the counts of an unfiltered record are its own totals', () => {
  const record = contextBlocks(requestBody());
  const sum = record.blocks.reduce((total, block) => total + block.chars, 0);
  assert.deepEqual(
    contextCounts(record, []),
    { chars: requestBody().length, blocks: 12, visibleBlocks: 12, visibleChars: sum, filtered: false },
    'with nothing hidden, the visible counts must equal the record\'s own totals',
  );
  assert.ok(
    sum < requestBody().length,
    'the sum of the blocks\' own texts must be strictly below the body\'s own length — the JSON scaffolding around ' +
      'them belongs to no block, and without that gap the following cases cannot tell the two definitions of ' +
      'visibleChars apart and the suite goes vacuous',
  );
});

test('hiding one entry takes its blocks and its characters out of the visible counts', () => {
  const record = contextBlocks(requestBody());
  const sum = record.blocks.reduce((total, block) => total + block.chars, 0);
  const toolResultBlock = record.blocks.find((block) => block.kind === 'tool_result');
  const counts = contextCounts(record, ['kind:tool_result']);
  assert.equal(
    counts.visibleBlocks,
    11,
    'hiding the request\'s one tool_result block must drop the visible block count by exactly one',
  );
  assert.equal(
    counts.visibleChars,
    sum - toolResultBlock.chars,
    'hiding the tool_result entry must take its own characters, and only its own, out of the visible total',
  );
  assert.equal(counts.filtered, true, 'hiding a non-empty entry must mark the record as filtered');
  assert.equal(counts.chars, requestBody().length, 'the total character count must stay the record\'s own, filter or no filter');
  assert.equal(counts.blocks, 12, 'the total block count must stay the record\'s own, filter or no filter');
});

test('an id the record does not carry hides nothing and does not count as filtered', () => {
  const body = requestBody({ messages: [{ role: 'user', content: 'hi' }] });
  const record = contextBlocks(body);
  const sum = record.blocks.reduce((total, block) => total + block.chars, 0);
  const counts = contextCounts(record, ['kind:thinking', 'field:absent']);
  assert.equal(counts.filtered, false, 'hiding ids this record does not carry must not count as a filter');
  assert.equal(counts.visibleBlocks, counts.blocks, 'with nothing this record carries hidden, every one of its blocks stays visible');
  assert.equal(counts.visibleChars, sum, 'with nothing this record carries hidden, the visible characters must be this record\'s own block sum');
});

test('every entry hidden leaves nothing visible at all', () => {
  const record = contextBlocks(requestBody());
  const counts = contextCounts(record, contextEntryIds(item()));
  assert.equal(counts.visibleBlocks, 0, 'hiding every entry the record carries must leave no block visible');
  assert.equal(counts.visibleChars, 0, 'hiding every entry the record carries must leave no character visible');
  assert.equal(counts.filtered, true, 'hiding every entry is still a filter');
  assert.equal(counts.chars, requestBody().length, 'the total character count must stay the record\'s own even with everything hidden');
  assert.equal(counts.blocks, 12, 'the total block count must stay the record\'s own even with everything hidden');
});

test('the counts hold with no arguments and with a Set', () => {
  assert.deepEqual(
    contextCounts(),
    { chars: 0, blocks: 0, visibleChars: 0, visibleBlocks: 0, filtered: false },
    'no record and no hidden set at all must count as nothing, not a crash',
  );
  assert.deepEqual(
    contextCounts(contextBlocks(requestBody()), new Set(['kind:user'])),
    contextCounts(contextBlocks(requestBody()), ['kind:user']),
    'a Set of hidden ids and an array of the same ids must produce the same counts',
  );
});

test('with nothing hidden the head line and its attributes are exactly what they were', () => {
  const html = renderContextPanel({ lane: lane(), item: item() });
  const metaMatch = html.match(/<span class="context-meta"[\s\S]*?<\/span>/);
  assert.ok(metaMatch, 'the meta span must be present');
  const meta = metaMatch[0];
  assert.match(
    meta,
    new RegExp(`data-chars="${requestBody().length}"`),
    'the meta span must still carry the body\'s own total as data-chars',
  );
  assert.match(meta, /data-blocks="12"/, 'the meta span must still carry the fixture\'s own block total as data-blocks');
  assert.ok(meta.includes(`${fmtNum(requestBody().length)} chars`), 'the readable line must still carry the unfiltered chars total');
  assert.ok(meta.includes('12 blocks'), 'the readable line must still carry the unfiltered blocks total');
  assert.ok(
    !html.includes('data-visible-chars'),
    'an unfiltered head must carry no data-visible-chars — nothing is hidden to report',
  );
  assert.ok(
    !html.includes('data-visible-blocks'),
    'an unfiltered head must carry no data-visible-blocks — nothing is hidden to report',
  );
  assert.ok(!meta.includes(' of '), 'the meta span of an unfiltered panel must say nothing about a filter');
});

test('a filtered head names the visible numbers beside the totals', () => {
  const { blocks } = contextBlocks(requestBody());
  const toolResultBlock = blocks.find((block) => block.kind === 'tool_result');
  const visibleChars = blocks.reduce((total, block) => total + block.chars, 0) - toolResultBlock.chars;
  const html = renderContextPanel({ lane: lane(), item: item(), hidden: ['kind:tool_result'] });
  assert.match(
    html,
    /data-visible-blocks="11"/,
    'a filtered head must name how many blocks are visible, arriving in a data attribute of its own',
  );
  assert.match(
    html,
    new RegExp(`data-visible-chars="${visibleChars}"`),
    'a filtered head must name how many characters are visible, arriving in a data attribute of its own',
  );
  assert.ok(
    html.includes('11 of 12 blocks'),
    'the readable line must name visible of total for blocks, so a filtered context cannot look smaller than it is',
  );
  assert.ok(
    html.includes(`${fmtNum(visibleChars)} of ${fmtNum(requestBody().length)} chars`),
    'the readable line must name visible of total for characters, so a filtered context cannot look smaller than it is',
  );
});

test('a request with no blocks at all shows no all-hidden placeholder', () => {
  const html = renderContextPanel({ lane: lane(), item: item({ body: '{"messages":[]}' }) });
  assert.match(html, /data-state="ready"/, 'a request that parses but carries no blocks is still a ready panel');
  assert.ok(!html.includes('class="placeholder"'), 'nothing is hidden here, so nothing may say it is');
  assert.ok(
    html.includes('<div class="ctx-blocks">'),
    'the empty blocks container must still be present, not swapped for the all-hidden placeholder',
  );
});

// The context search: a query typed into the panel's own head narrows the block
// list to what carries it, over and beside the kind filter.

test('a query keeps the blocks whose own text carries it, and drops the rest', () => {
  const { blocks } = contextBlocks(requestBody());
  const kept = visibleBlocks(blocks, [], 'ping');
  assert.deepEqual(
    kept.map((b) => b.text),
    ['ping'],
    'the one block of this request whose text carries the query is the one that survives it',
  );
  assert.equal(kept[0].index, 2, 'a survivor keeps its own index, so the expansion keys hold across a search');
});

test('a query matches a block by its label too, which is where a field\'s name is written', () => {
  const { blocks } = contextBlocks(requestBody());
  const kept = visibleBlocks(blocks, [], 'max_tokens');
  assert.equal(kept.length, 1, 'exactly the max_tokens field block');
  assert.equal(kept[0].label, 'max_tokens');
  assert.equal(
    kept[0].text,
    '64000',
    'the block matched on its label alone — its own text carries the query nowhere, which is the point',
  );
});

test('a query matches the whole text, not the one line the block collapsed to', () => {
  const buried = `${'x'.repeat(PREVIEW_CHARS * 2)}needle`;
  const body = requestBody({ system: [{ type: 'text', text: buried }] });
  const { blocks } = contextBlocks(body);
  const systemBlock = blocks.find((b) => b.text === buried);
  assert.ok(systemBlock, 'the fixture block must be present');
  assert.ok(
    !systemBlock.preview.includes('needle'),
    'the fixture must bury the query past the preview cut, or this case cannot tell text from preview',
  );
  assert.deepEqual(
    visibleBlocks(blocks, [], 'needle').map((b) => b.text),
    [buried],
    'a string 240 characters into a block is in that block, and a search that says otherwise is lying',
  );
});

test('the query is case-folded and trimmed', () => {
  const { blocks } = contextBlocks(requestBody());
  const expected = visibleBlocks(blocks, [], 'file created').map((b) => b.index);
  assert.equal(expected.length, 1, 'the fixture must carry exactly one match, or this case is vacuous');
  for (const query of ['File created', 'FILE CREATED', '  file created  ']) {
    assert.deepEqual(
      visibleBlocks(blocks, [], query).map((b) => b.index),
      expected,
      `${JSON.stringify(query)} must find the same block a plain lowercase query does`,
    );
  }
});

test('a query is matched literally, never as a regular expression', () => {
  const body = requestBody({ system: [{ type: 'text', text: 'a.c' }, { type: 'text', text: 'abc' }] });
  const { blocks } = contextBlocks(body);
  assert.deepEqual(
    visibleBlocks(blocks, [], 'a.c').map((b) => b.text),
    ['a.c'],
    'a reader typing a dot is looking for a dot — as a pattern this query would take abc with it',
  );
  assert.deepEqual(
    visibleBlocks(blocks, [], '(unclosed').map((b) => b.text),
    [],
    'a query that is not valid regular-expression syntax must find nothing, never throw',
  );
});

test('an empty query excludes nothing', () => {
  const { blocks } = contextBlocks(requestBody());
  for (const query of ['', '   ', null, undefined]) {
    assert.equal(
      visibleBlocks(blocks, [], query).length,
      blocks.length,
      `${JSON.stringify(query)} is not a search and must leave every block on screen`,
    );
  }
  assert.equal(blockMatches({ label: 'x', text: 'y' }, ''), true);
  assert.equal(blockMatches(undefined, 'z'), false, 'no block matches a real query, and asking must not throw');
});

test('the search and the kind filter both apply, and neither undoes the other', () => {
  const { blocks } = contextBlocks(requestBody());
  assert.deepEqual(
    visibleBlocks(blocks, ['kind:user'], 'ping'),
    [],
    'a matching block of a hidden kind stays hidden — searching must not bring back what the filter turned off',
  );
  assert.deepEqual(
    visibleBlocks(blocks, ['kind:system'], 'ping').map((b) => b.text),
    ['ping'],
    'hiding a kind the query does not reach must leave the match alone',
  );

  const hiddenSet = new Set(['kind:user']);
  visibleBlocks(blocks, hiddenSet, 'ping');
  assert.equal(hiddenSet.size, 1, 'the hidden Set the caller passed in must not be mutated');
  assert.equal(blocks.length, 12, 'the blocks array the caller passed in must not be mutated');
});

test('a query narrows the visible counts and marks the record narrowed', () => {
  const record = contextBlocks(requestBody());
  const counts = contextCounts({ ...record, hidden: [], search: 'ping' });
  assert.equal(counts.visibleBlocks, 1, 'one block of twelve carries the query');
  assert.equal(counts.visibleChars, 4, 'and the visible characters are that block\'s own four');
  assert.equal(counts.filtered, true);
  assert.equal(counts.blocks, 12, 'the totals stay the record\'s own — a search must not make the context look smaller');
  assert.equal(counts.chars, requestBody().length);

  assert.deepEqual(
    contextCounts(record, [], 'ping'),
    counts,
    'the query may be passed as a third argument beside a record passed whole',
  );
  assert.equal(
    contextCounts({ ...record, search: 'e' }).filtered,
    contextCounts(record, [], 'e').filtered,
    'both spellings must agree on whether anything was excluded',
  );
});

test('a query every block matches has excluded nothing, so the head says nothing about it', () => {
  const { blocks } = contextBlocks(requestBody({ messages: [{ role: 'user', content: 'hi' }] }));
  const all = blocks.map((b) => b.index);
  assert.deepEqual(
    visibleBlocks(blocks, [], 'e').map((b) => b.index),
    all,
    'the fixture must have every block carrying an e, or this case is vacuous',
  );
  assert.equal(contextCounts({ blocks, chars: 1, search: 'e' }).filtered, false);
});

test('the search box sits in the head, before the list it narrows and beside the filter', () => {
  const html = renderContextPanel({ lane: lane(), item: item(), search: 'ping' });
  assert.equal((html.match(/data-ctx-search/g) ?? []).length, 1, 'exactly one search box must be rendered');

  const searchIdx = html.indexOf('data-ctx-search');
  const filterIdx = html.indexOf('<details class="ctx-filter"');
  const listIdx = html.indexOf('<div class="ctx-blocks">');
  assert.ok(filterIdx >= 0, 'the kind filter must still be rendered beside the search');
  assert.ok(listIdx >= 0, 'this query matches, so the block list must be present to sit below the box');
  assert.ok(searchIdx < filterIdx, 'the search comes first, the dropdown it sits beside second');
  assert.ok(filterIdx < listIdx, 'and both sit in the head, above the list they narrow');
  assert.ok(html.includes('value="ping"'), 'the box must show the query back');
});

test('the query is escaped on its way back into the box', () => {
  const html = renderContextPanel({ lane: lane(), item: item(), search: '"ping" & <b>' });
  assert.ok(
    html.includes('value="&quot;ping&quot; &amp; &lt;b&gt;"'),
    'a raw quote here would break out of the attribute and the rest of the query would be markup',
  );
  assert.ok(!html.includes('<b>'), 'a raw tag from a query must never reach the DOM');
  assert.ok(!html.includes('NaN') && !html.includes('undefined'));
});

test('the search box carries no attribute the lane or block handlers would catch', () => {
  const box = renderContextSearch('q');
  assert.doesNotMatch(box, /data-lane=/, 'a data-lane here would make every keystroke toggle the lane selection');
  assert.doesNotMatch(box, /data-block=/, 'a data-block here would make every keystroke expand a block');
  assert.ok(box.includes('value="q"'));
});

test('a query narrows the rows on screen and leaves the head\'s totals alone', () => {
  const html = renderContextPanel({ lane: lane(), item: item(), search: 'ping' });
  const chunks = blockChunks(html);
  assert.equal(chunks.length, 1, 'only the matching block may be listed');
  assert.ok(chunks[0].includes('data-kind="user"'));
  assert.ok(html.includes('1 of 12 blocks'), 'the head must name visible of total, so a searched context cannot look smaller');
  assert.match(html, /data-visible-blocks="1"/);
  assert.match(html, new RegExp(`data-chars="${requestBody().length}"`), 'the total stays the body\'s own');
  assert.equal(
    (html.match(/data-ctx-entry="/g) ?? []).length,
    10,
    'the kind filter still lists what the request contains — a search narrows the list, not the request',
  );
});

test('clearing the query restores the list byte for byte', () => {
  const plain = renderContextPanel({ lane: lane(), item: item() });
  for (const query of ['', '   ']) {
    assert.equal(
      renderContextPanel({ lane: lane(), item: item(), search: query }),
      plain,
      `a query of ${JSON.stringify(query)} must render exactly what no query renders`,
    );
  }
});

test('a query that matches nothing says so, and leaves the box to clear it in', () => {
  const html = renderContextPanel({ lane: lane(), item: item(), search: 'zzz-no-such-string' });
  assert.deepEqual(blockChunks(html), [], 'no block may be listed');
  assert.match(html, /data-state="ready"/, 'this is not the empty-record state');
  assert.equal((html.match(/class="placeholder"/g) ?? []).length, 1, 'exactly one placeholder replaces the rows');
  assert.ok(
    html.includes('data-ctx-search'),
    'the box must survive its own last match, or there is nothing left to clear the query in',
  );
  assert.ok(html.includes('value="zzz-no-such-string"'), 'and it must still carry the query that emptied the list');

  const placeholderText = html.slice(html.indexOf('class="placeholder"'));
  assert.match(placeholderText, /matches/, 'the placeholder must say the query matched nothing');
  assert.match(placeholderText, /search/, 'and that clearing the search is what brings the rows back');
  assert.match(placeholderText, /zzz-no-such-string/, 'and it must name the query it is talking about');
  assert.match(html, /data-visible-blocks="0"/);
});

test('with the kinds all hidden the placeholder names the filter, whatever was also typed', () => {
  const hidden = contextEntryIds(item());
  const html = renderContextPanel({ lane: lane(), item: item(), hidden, search: 'ping' });
  const placeholderText = html.slice(html.indexOf('class="placeholder"'));
  assert.match(
    placeholderText,
    /filter/,
    'clearing the search would not bring one row back here, so the placeholder must point at the filter instead',
  );
  assert.doesNotMatch(placeholderText, /matches/, 'and it must not blame the query for what the filter did');
});

test('a request with no blocks at all carries no search box', () => {
  const html = renderContextPanel({ lane: lane(), item: item({ body: '{"messages":[]}' }), search: 'ping' });
  assert.ok(!html.includes('ctx-search'), 'with nothing in the request there is nothing to search');
  assert.ok(!html.includes('class="placeholder"'), 'and an empty request is not a query that found nothing');
});

test('the query reaches the panel through the one builder', () => {
  const withSearch = lanePanelInput({
    view: view(),
    key: 'main',
    held: { key: 'main', item: item() },
    expanded: [],
    search: 'ping',
  });
  assert.equal(withSearch.search, 'ping');
  assert.equal(lanePanelInput({ view: view(), key: 'main', held: null }).search, '', 'no query given is no search');

  const html = renderContextPanel(withSearch);
  assert.equal(blockChunks(html).length, 1, 'the query the builder carried must be the one the panel applied');
});

// A live session writes a new record on every API call, and under a live cursor
// the panel follows the head. A block's key therefore names what the block is
// and never which record carried it, or the reader's open blocks shut under
// them each time the agent calls the API again.

test('a block is keyed by what it is, and carries nothing of the record it came from', () => {
  const { blocks } = contextBlocks(requestBody());
  const keys = blocks.map((block) => block.key);

  assert.equal(new Set(keys).size, keys.length, 'two blocks of one body must never share a key');
  for (const key of keys) {
    assert.match(key, /^(kind|field):.+#\d+$/, `${key} must name an entry and its ordinal`);
    assert.doesNotMatch(key, /\b12\b/, `${key} must not carry the record's seq — that is what used to shut open blocks`);
  }
  assert.deepEqual(
    keys.slice(0, 3),
    ['kind:system#0', 'kind:system#1', 'kind:user#0'],
    'the ordinal counts blocks of the same entry, in the order the body holds them',
  );
  assert.ok(keys.includes('field:tools#0'), 'a body field is keyed by its own name, so it survives the messages growing');
});

test('a block the reader opened stays open as the conversation grows', () => {
  const first = item();
  const grown = item({
    seq: 13,
    body: requestBody({
      messages: [
        ...JSON.parse(requestBody()).messages,
        { role: 'assistant', content: [{ type: 'text', text: 'and one more turn' }] },
      ],
    }),
  });

  const openKey = contextBlocks(first.body).blocks.find((block) => block.label === 'tools').key;
  const before = renderContextPanel({ lane: lane(), item: first, expanded: [openKey] });
  const after = renderContextPanel({ lane: lane(), item: grown, expanded: [openKey] });

  assert.equal(
    [...before.matchAll(/<details class="ctx-block"[^>]*\bopen\b/g)].length,
    1,
    'the fixture must open exactly one block before the conversation grows',
  );
  const openAfter = blockChunks(after).filter((chunk) => /<details class="ctx-block"[^>]*\bopen\b/.test(chunk));
  assert.equal(openAfter.length, 1, 'the next record must leave exactly that one block open, not zero and not two');
  assert.ok(openAfter[0].includes('>tools<'), 'and it must be the same block — the tools field, not whatever landed at its index');
});

test('a body that never parsed keys its one raw block too', () => {
  const { blocks } = contextBlocks('{"messages":[{"role":"user"');
  assert.equal(blocks.length, 1, 'a cut body is one raw block');
  assert.equal(blocks[0].key, 'kind:raw#0', 'a raw block is remembered like any other, so a repaint leaves it open');
});
