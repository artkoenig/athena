import test from 'node:test';
import assert from 'node:assert/strict';

import { laneToolInput, renderToolPanel } from '../public/tools.js';
import { toolCallOf, TOOL_PARAM_CHARS } from '../public/timeline.js';
import { esc, fmtNum, previewOf } from '../public/format.js';

const lane = (over = {}) => ({ key: 'main', kind: 'main', label: 'main session', spanId: null, agent: null, ...over });
const agentLane = (over = {}) =>
  lane({ key: 'agent:sp-b:probe', kind: 'agent', label: 'probe', spanId: 'sp-b', agent: 'probe', ...over });
const view = (over = {}) => ({ startMs: 1000, endMs: 5000, durationMs: 4000, lanes: [lane(), agentLane()], ...over });

/** A call as the merged index holds it: main traffic rides the interaction span. */
const call = (over = {}) =>
  toolCallOf({
    seq: 1,
    timeMs: 2000,
    spanId: 'sp-main',
    attrs: { tool_name: 'Bash', tool_input: JSON.stringify({ command: 'echo hi' }) },
    ...over,
  });

/** The markup of each rendered row, in the order the panel prints them. */
const rowChunks = (html) => [...html.matchAll(/<details class="ctx-block"[\s\S]*?<\/details>/g)].map((m) => m[0]);

// Criterion — a call lands on the lane that made it, and on no other.

test('an agent lane lists its own calls, and the main lane the rest', () => {
  const calls = [
    call({ seq: 1, timeMs: 1500 }),
    call({ seq: 3, timeMs: 2500, attrs: { tool_name: 'Read', tool_input: '{"file_path":"/a"}' } }),
    call({ seq: 2, timeMs: 2000, spanId: 'sp-b', attrs: { tool_name: 'Grep', tool_input: '{"pattern":"x"}' } }),
    call({ seq: 4, timeMs: 2600, spanId: null }),
  ];

  const probe = laneToolInput({ view: view(), key: 'agent:sp-b:probe', calls, cursor: null });
  assert.deepEqual(
    probe.calls.map((c) => c.seq),
    [2],
    'a subagent\'s list showing main-session calls is the mutation this catches',
  );

  const main = laneToolInput({ view: view(), key: 'main', calls, cursor: null });
  assert.deepEqual(
    main.calls.map((c) => c.seq),
    [4, 3, 1],
    'the span-less call belongs to the main lane, and the probe\'s own call must not appear here',
  );
});

test('only the calls made at or before the moment are listed', () => {
  const calls = [
    call({ seq: 1, timeMs: 1500 }),
    call({ seq: 3, timeMs: 2500, attrs: { tool_name: 'Read', tool_input: '{"file_path":"/a"}' } }),
    call({ seq: 2, timeMs: 2000, spanId: 'sp-b', attrs: { tool_name: 'Grep', tool_input: '{"pattern":"x"}' } }),
    call({ seq: 4, timeMs: 2600, spanId: null }),
  ];

  const atBoundary = laneToolInput({ view: view(), key: 'main', calls, cursor: { live: false, timeMs: 2500 } });
  assert.deepEqual(
    atBoundary.calls.map((c) => c.seq),
    [3, 1],
    'the call at exactly 2500 must be included — a boundary that excludes it hides the call the reader scrubbed to',
  );

  const before = laneToolInput({ view: view(), key: 'main', calls, cursor: { live: false, timeMs: 1499 } });
  assert.deepEqual(before.calls, []);

  const past = laneToolInput({ view: view(), key: 'main', calls, cursor: { live: false, timeMs: 9999 } });
  assert.deepEqual(
    past.calls.map((c) => c.seq),
    [4, 3, 1],
    'a moment past the window clamps to the window end',
  );
});

test('a live cursor lists everything recorded, a parked one does not', () => {
  const calls = [
    call({ seq: 1, timeMs: 1500 }),
    call({ seq: 3, timeMs: 2500, attrs: { tool_name: 'Read', tool_input: '{"file_path":"/a"}' } }),
    call({ seq: 2, timeMs: 2000, spanId: 'sp-b', attrs: { tool_name: 'Grep', tool_input: '{"pattern":"x"}' } }),
    call({ seq: 4, timeMs: 2600, spanId: null }),
  ];

  const noCursor = laneToolInput({ view: view(), key: 'main', calls, cursor: null });
  assert.deepEqual(noCursor.calls.map((c) => c.seq), [4, 3, 1]);
  assert.equal(noCursor.atMs, 5000);

  const live = laneToolInput({ view: view(), key: 'main', calls, cursor: { live: true, timeMs: null } });
  assert.deepEqual(live.calls.map((c) => c.seq), [4, 3, 1]);
  assert.equal(live.atMs, 5000);

  const parked = laneToolInput({ view: view(), key: 'main', calls, cursor: { live: false, timeMs: 2000 } });
  assert.deepEqual(
    parked.calls.map((c) => c.seq),
    [1],
    'the tool list and the context fetch resolve the moment by the same rule, so one click cannot show two moments',
  );
  assert.equal(parked.atMs, 2000);
});

test('the newest call is the first row', () => {
  const calls = [call({ seq: 1, timeMs: 1500 }), call({ seq: 2, timeMs: 2000 }), call({ seq: 3, timeMs: 2500 })];
  const out = laneToolInput({ view: view(), key: 'main', calls, cursor: null });
  assert.deepEqual(
    out.calls.map((c) => c.timeMs),
    [2500, 2000, 1500],
  );

  const tied = [call({ seq: 1, timeMs: 2000 }), call({ seq: 2, timeMs: 2000 })];
  const tiedOut = laneToolInput({ view: view(), key: 'main', calls: tied, cursor: null });
  assert.deepEqual(
    tiedOut.calls.map((c) => c.seq),
    [2, 1],
    'two calls at the same moment come back highest-seq first',
  );
});

test('no lane selected leaves nothing to list, and nothing to draw', () => {
  const noKey = laneToolInput({ view: view(), key: null, calls: [call()] });
  assert.equal(noKey.lane, null);
  assert.deepEqual(noKey.calls, []);

  const goneKey = laneToolInput({ view: view(), key: 'agent:gone:x', calls: [call()] });
  assert.equal(goneKey.lane, null);
  assert.deepEqual(goneKey.calls, []);

  const noArg = laneToolInput();
  assert.equal(noArg.lane, null);
  assert.deepEqual(noArg.calls, []);

  assert.equal(
    renderToolPanel(laneToolInput({ view: view(), key: null, calls: [call()] })),
    '',
    'no lane selected, no tool panel under the timeline',
  );
  assert.equal(renderToolPanel(), '');
});

test('the index the page holds is not reordered under it', () => {
  const calls = [call({ seq: 1, timeMs: 1500 }), call({ seq: 2, timeMs: 2500 })];
  const before = calls.slice();
  laneToolInput({ view: view(), key: 'main', calls });
  assert.deepEqual(calls, before, 'the sort must not run on the array page state holds');
});

// Criterion — the panel says which tool, and what it was called with.

test('every row names its own tool', () => {
  const calls = [
    call({ seq: 1, timeMs: 1500, attrs: { tool_name: 'Bash', tool_input: JSON.stringify({ command: 'echo hi' }) } }),
    call({ seq: 2, timeMs: 2000, attrs: { tool_name: 'Read', tool_input: JSON.stringify({ file_path: '/tmp/a.txt' }) } }),
    call({ seq: 3, timeMs: 2500, attrs: { tool_name: 'Grep', tool_input: JSON.stringify({ pattern: 'needle' }) } }),
  ];
  const { lane: l, calls: sorted, atMs, expanded } = laneToolInput({ view: view(), key: 'main', calls, cursor: null });
  const html = renderToolPanel({ lane: l, calls: sorted, atMs, expanded });
  const rows = rowChunks(html);
  assert.equal(rows.length, 3);
  sorted.forEach((expectedCall, i) => {
    const m = rows[i].match(/<span class="ctx-label">([\s\S]*?)<\/span>/);
    assert.ok(m, `row ${i} must carry a ctx-label span`);
    assert.equal(
      m[1],
      esc(expectedCall.name),
      'row i must name its own tool — one name printed for every row is the mutation this catches',
    );
    assert.match(rows[i], new RegExp(`data-tool="${expectedCall.name}"`));
  });
});

test('every row carries that call\'s own parameters, in full where they fit', () => {
  const calls = [
    call({ seq: 1, timeMs: 1500, attrs: { tool_name: 'Bash', tool_input: JSON.stringify({ command: 'echo hi' }) } }),
    call({ seq: 2, timeMs: 2000, attrs: { tool_name: 'Read', tool_input: JSON.stringify({ file_path: '/tmp/a.txt' }) } }),
    call({ seq: 3, timeMs: 2500, attrs: { tool_name: 'Grep', tool_input: JSON.stringify({ pattern: 'needle' }) } }),
  ];
  const { lane: l, calls: sorted, atMs, expanded } = laneToolInput({ view: view(), key: 'main', calls, cursor: null });
  const html = renderToolPanel({ lane: l, calls: sorted, atMs, expanded });
  const rows = rowChunks(html);
  sorted.forEach((expectedCall, i) => {
    const m = rows[i].match(/<pre class="ctx-text">([\s\S]*?)<\/pre>/);
    assert.ok(m, `row ${i} must carry a ctx-text pre`);
    assert.equal(m[1], esc(expectedCall.text));
  });
  assert.ok(rows.some((row) => row.includes('/tmp/a.txt')), 'the parameters are what answers "what for"');
  const bashRow = rows.find((row) => row.includes('data-tool="Bash"'));
  assert.ok(bashRow, 'the Bash row must be present');
  assert.ok(!bashRow.includes('/tmp/a.txt'), 'one call\'s parameters under another call\'s name is unreadable and wrong');
});

test('every collapsed row shows that call\'s own size and its own one line', () => {
  const calls = [
    call({ seq: 1, timeMs: 1500, attrs: { tool_name: 'Bash', tool_input: JSON.stringify({ command: 'echo hi' }) } }),
    call({ seq: 2, timeMs: 2000, attrs: { tool_name: 'Read', tool_input: JSON.stringify({ file_path: '/tmp/a-much-longer-path-name.txt' }) } }),
    call({ seq: 3, timeMs: 2500, attrs: { tool_name: 'Grep', tool_input: JSON.stringify({ pattern: 'needle', flags: 'i', context: 5 }) } }),
  ];
  assert.ok(
    new Set(calls.map((c) => c.chars)).size > 1,
    'the fixture must carry calls of differing sizes, or one size printed for all of them would pass',
  );
  const { lane: l, calls: sorted, atMs, expanded } = laneToolInput({ view: view(), key: 'main', calls, cursor: null });
  const html = renderToolPanel({ lane: l, calls: sorted, atMs, expanded });
  const rows = rowChunks(html);
  assert.ok(
    sorted.every((c) => c.preview.length > 0),
    'no call in the fixture may preview as nothing',
  );
  sorted.forEach((expectedCall, i) => {
    const sizeMatch = rows[i].match(/<span class="ctx-size" data-chars="(\d+)">([\s\S]*?)<\/span>/);
    assert.ok(sizeMatch, `row ${i} must carry a ctx-size span`);
    assert.equal(Number(sizeMatch[1]), expectedCall.chars);
    assert.equal(sizeMatch[2], esc(fmtNum(expectedCall.chars)));

    const previewMatch = rows[i].match(/<span class="ctx-preview">([\s\S]*?)<\/span>/);
    assert.ok(previewMatch, `row ${i} must carry a ctx-preview span`);
    assert.equal(previewMatch[1], esc(expectedCall.preview));
  });
});

test('a call whose parameters were cut says how much is missing, and still reports the whole size', () => {
  const big = 'x'.repeat(50_000);
  const cut = call({
    seq: 1,
    timeMs: 1500,
    attrs: { tool_name: 'Write', tool_input: JSON.stringify({ file_path: '/tmp/big', content: big }) },
  });
  const { lane: l, calls: sorted, atMs, expanded } = laneToolInput({ view: view(), key: 'main', calls: [cut], cursor: null });
  const html = renderToolPanel({ lane: l, calls: sorted, atMs, expanded });

  const sizeMatch = html.match(/<span class="ctx-size" data-chars="(\d+)">/);
  assert.ok(sizeMatch, 'the row must carry a ctx-size span');
  assert.equal(Number(sizeMatch[1]), cut.chars, 'the untruncated size must still be reported');

  const preMatch = html.match(/<pre class="ctx-text">([\s\S]*?)<\/pre>/);
  assert.ok(preMatch, 'the row must carry a ctx-text pre');
  assert.ok(preMatch[1].startsWith(esc(cut.text)));
  assert.ok(preMatch[1].includes('more characters, not kept in the page'));
  assert.ok(
    !html.includes('x'.repeat(TOOL_PARAM_CHARS + 1)),
    'the panel may not paint what the page deliberately did not keep',
  );
});

test('the panel names the lane it was drawn for, and how many calls up to when', () => {
  const probeCall = call({ seq: 1, timeMs: 2000, spanId: 'sp-b' });
  const probe = laneToolInput({
    view: view(),
    key: 'agent:sp-b:probe',
    calls: [probeCall],
    cursor: { live: false, timeMs: 3000 },
  });
  const html = renderToolPanel(probe);
  assert.match(html, /data-tools-lane="agent:sp-b:probe"/);
  assert.match(html, /data-state="ready"/);
  assert.match(html, /data-calls="1"/);
  assert.match(html, /data-time="3000"/);
  assert.ok(html.includes('probe'));
  assert.ok(html.includes('1 tool call'));
  assert.ok(!html.includes('tool calls'), 'one call must read in the singular');
  assert.ok(!html.includes('main session'), 'a subagent\'s tools under the main session\'s heading is the mutation this catches');

  const mainCalls = [call({ seq: 1, timeMs: 1500 }), call({ seq: 2, timeMs: 2000 })];
  const main = laneToolInput({ view: view(), key: 'main', calls: mainCalls, cursor: { live: false, timeMs: 3000 } });
  const mainHtml = renderToolPanel(main);
  assert.match(mainHtml, /data-calls="2"/);
  assert.ok(mainHtml.includes('2 tool calls'));
});

test('a lane that had used no tool by that moment says so rather than vanishing', () => {
  const calls = [call({ seq: 1, timeMs: 3000 }), call({ seq: 2, timeMs: 4000 })];
  const out = laneToolInput({ view: view(), key: 'main', calls, cursor: { live: false, timeMs: 1000 } });
  const html = renderToolPanel(out);
  assert.match(html, /data-state="empty"/);
  assert.equal((html.match(/class="placeholder"/g) ?? []).length, 1);
  assert.equal(rowChunks(html).length, 0);
  assert.ok(
    html.includes('data-tools-lane="main"'),
    'the panel stays, so the reader can tell "nothing yet" from "nothing selected"',
  );
});

test('an expanded row stays open across a repaint, and its key cannot collide with a context block\'s', () => {
  const calls = [call({ seq: 1, timeMs: 1500 }), call({ seq: 2, timeMs: 2000 }), call({ seq: 3, timeMs: 2500 })];
  const out = laneToolInput({ view: view(), key: 'main', calls, cursor: null, expanded: ['tool:2'] });
  const html = renderToolPanel(out);

  const rows = rowChunks(html);
  const openRow = rows.find((row) => row.includes('data-block="tool:2"'));
  assert.ok(openRow, 'the row for seq 2 must be present');
  assert.match(openRow, /<details class="ctx-block"[^>]*\bopen\b/);
  const otherRows = rows.filter((row) => !row.includes('data-block="tool:2"'));
  for (const row of otherRows) {
    assert.doesNotMatch(row, /<details class="ctx-block"[^>]*\bopen\b/);
  }

  const blockKeys = [...html.matchAll(/data-block="([^"]+)"/g)].map((m) => m[1]);
  for (const key of blockKeys) assert.ok(key.startsWith('tool:'), `${key} must be namespaced under tool:`);
  assert.ok(!/data-lane=/.test(html), 'a data-lane attribute here would make every click inside the panel toggle the lane selection');
});

test('a parameter that looks like markup is shown, not run', () => {
  const hostile = call({
    seq: 1,
    timeMs: 1500,
    attrs: { tool_name: 'Bash', tool_input: JSON.stringify({ command: '<script>alert(1)</script> && echo "a" & b' }) },
  });
  const out = laneToolInput({ view: view(), key: 'main', calls: [hostile], cursor: null });
  const html = renderToolPanel(out);
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});
