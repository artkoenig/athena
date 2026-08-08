import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CLOSED_STATUSES,
  isClosedIncrement,
  incrementCounts,
  pickRunId,
  runFrame,
  renderRunList,
  renderRun,
  renderNode,
  renderTree,
  childEntries,
  badgeOf,
  hintOf,
  openPathsFor,
  runningView,
  INLINE_CHARS,
  shouldLoadRun,
} from '../public/run.js';
import { fmtAgo, PREVIEW_CHARS } from '../public/format.js';

// The five factories every case builds its input from — modelled on the
// collector's own wire contract (the recorder's backlog document, and the
// entry the run endpoints wrap it in) and nothing else.

const increment = (over = {}) => ({
  id: 'ui',
  title: 'the run view',
  goal: '',
  criteria: [],
  status: 'todo',
  note: '',
  branch: '',
  steps: [],
  ...over,
});

const doc = (over = {}) => ({
  version: 1,
  issue: 'docs/issues/2026-08-08-x',
  workflow: 'agile-loop',
  codemap: 'a.js — a.\nb.js — b.',
  increments: [increment()],
  run: { steps: [] },
  ...over,
});

const runEntry = (over = {}) => ({
  id: 'docs/issues/2026-08-08-x',
  issue: 'docs/issues/2026-08-08-x',
  workflow: 'agile-loop',
  increments: 1,
  updatedAtMs: Date.now() - 5000,
  state: doc(),
  ...over,
});

/** A `/api/runs` list item — the one-run answer without its state. */
const listItem = (over = {}) => {
  const { state, ...rest } = runEntry(over);
  return rest;
};

/** One recorded step, either an increment's or the run's own. */
const step = (over = {}) => ({
  label: 'research:ui',
  at: new Date(Date.now() - 60_000).toISOString(),
  return: { summary: 'a short summary line' },
  ...over,
});

/** The `<details …>` attribute strings a render produced, in document order. */
const detailAttrs = (html) => [...html.matchAll(/<details\b([^>]*)>/g)].map((match) => match[1]);

/** The `data-panel` key of every disclosure, in document order. */
const panelKeys = (html) => [...html.matchAll(/data-panel="([^"]+)"/g)].map((match) => match[1]);

// Criterion 1 — what the run view holds: the issue, the workflow, when it was
// last written, and the recorded document itself.

test('the head names the issue, the workflow and when the run was last written, with the ISO instant in data-updated', () => {
  const entry = runEntry();
  const html = renderRun(entry);
  assert.ok(html.includes(entry.issue), 'the issue must be named');
  assert.ok(html.includes(entry.workflow), 'the workflow must be named');
  assert.ok(html.includes(fmtAgo(entry.updatedAtMs)), 'the relative write time must be shown');
  assert.ok(
    html.includes(`data-updated="${new Date(entry.updatedAtMs).toISOString()}"`),
    'the exact write instant must sit in data-updated, so this case does not depend on the machine\'s locale',
  );
});

test('the closed and open counts are rendered, and sum to the number of increments', () => {
  const incs = [
    increment({ id: 'a', status: 'done' }),
    increment({ id: 'b', status: 'blocked' }),
    increment({ id: 'c', status: 'todo' }),
    increment({ id: 'd', status: '' }),
  ];
  const entry = runEntry({ increments: incs.length, state: doc({ increments: incs }) });
  const html = renderRun(entry);
  const counts = incrementCounts(incs);
  assert.deepEqual(counts, { total: 4, closed: 2, open: 2 }, 'the fixture must actually mix closed and open, or this case is vacuous');
  assert.ok(html.includes(String(counts.closed)), 'the closed count must be printed');
  assert.ok(html.includes(String(counts.open)), 'the open count must be printed');
});

test('everything printed is escaped', () => {
  const incs = [increment({ id: 'x', title: '<script>alert(1)</script>', note: `note "quoted" and 'single'` })];
  const entry = runEntry({ issue: 'issue < other', state: doc({ issue: 'issue < other', increments: incs }) });
  const html = renderRun(entry);
  assert.ok(!html.includes('<script'), 'a raw <script must never reach the markup, from the title, the note or the issue');
});

test('renderRun(null) is a placeholder with no document tree, for the collector holding no run at all yet', () => {
  const html = renderRun(null);
  assert.ok(html.length > 0, 'null must still render something to show in place of the run view');
  assert.match(html, /class="(?:empty|placeholder)"/, 'a run-less state reuses the page\'s own empty/placeholder styling');
  assert.ok(!html.includes('json-tree'), 'no document tree may render when there is no run to show at all');
});

test('the increments come from state.increments and never from the entry\'s own count', () => {
  const entry = runEntry({
    increments: 99,
    // Pinned, because the assertion below is a search for "99" over the whole
    // markup and the write instant renders into it: a clock that happened to
    // produce 1999, :59:59 or .996 would fail this case for no reason at all.
    updatedAtMs: Date.parse('2026-01-02T03:04:05.123Z'),
    state: doc({ increments: [increment({ id: 'a', title: 'Card Alpha' }), increment({ id: 'b', title: 'Card Bravo' })] }),
  });
  const html = renderRun(entry);
  assert.ok(html.includes('Card Alpha'));
  assert.ok(html.includes('Card Bravo'));
  assert.ok(!html.includes('99'), 'the entry\'s own increment count must never leak into the markup — the document\'s array is the source of truth');
});

test('an opaque document carrying none of the known fields still renders a head and whatever it does hold, never undefined or NaN', () => {
  const entry = runEntry({ issue: 'i', workflow: undefined, state: { issue: 'i' } });
  const html = renderRun(entry);
  assert.ok(html.includes('i'), 'whatever the document does carry must still reach the page');
  assert.ok(!html.includes('undefined'), 'a missing field must never print as the literal string undefined');
  assert.ok(!html.includes('NaN'), 'a missing field must never print as the literal string NaN');
});

test('a run whose state is empty renders a placeholder in place of the tree rather than an empty list', () => {
  const entry = runEntry({ increments: 0, state: {} });
  const html = renderRun(entry);
  assert.match(html, /class="placeholder"/, 'a document with no keys at all says so');
  assert.ok(!html.includes('<ul class="json-tree'), 'an empty document must not render an empty tree');
  assert.ok(!html.includes('undefined'));
  assert.ok(!html.includes('NaN'));
});

// Criterion 2 — the three statuses a close writes, and the counts over them.

test('CLOSED_STATUSES holds exactly the recorder\'s three closing statuses, and isClosedIncrement matches them', () => {
  assert.deepEqual(
    [...CLOSED_STATUSES].sort(),
    ['blocked', 'done', 'dropped'],
    'a fourth status invented here would silently miscount every run',
  );
  for (const status of ['done', 'blocked', 'dropped']) {
    assert.equal(isClosedIncrement(increment({ status })), true, `${status || '(empty)'} must read as closed`);
  }
  for (const status of ['todo', '', 'some-unknown-status']) {
    assert.equal(isClosedIncrement(increment({ status })), false, `${status || '(empty)'} must read as open`);
  }
});

test('incrementCounts totals closed and open, tolerating an empty or a missing array', () => {
  const incs = [
    increment({ status: 'done' }),
    increment({ status: 'blocked' }),
    increment({ status: 'todo' }),
    increment({ status: '' }),
  ];
  assert.deepEqual(incrementCounts(incs), { total: 4, closed: 2, open: 2 });
  assert.deepEqual(incrementCounts([]), { total: 0, closed: 0, open: 0 });
  assert.deepEqual(incrementCounts(undefined), { total: 0, closed: 0, open: 0 }, 'a missing array must count as zero, never throw');
});

// Criterion 3 — opening on the latest run, and switching to any other one.

test('pickRunId opens on the run written to most recently, and falls back when the wanted run is gone', () => {
  const a = listItem({ id: 'a' });
  const b = listItem({ id: 'b' });
  assert.equal(pickRunId([], null), null, 'nothing to show when the collector holds no run');
  assert.equal(
    pickRunId([a, b], null),
    'a',
    'the collector serves latest-write-first, so the first item is the most recently written',
  );
  assert.equal(pickRunId([a, b], 'b'), 'b', 'an existing selection is kept');
  assert.equal(
    pickRunId([a, b], 'gone'),
    'a',
    'a run the collector no longer holds falls back to the latest rather than showing nothing',
  );
});

test('renderRunList renders one button per run, marking the selected one current, with its issue and time', () => {
  const a = listItem({ id: 'a', issue: 'issue-a', updatedAtMs: Date.now() - 1000 });
  const b = listItem({ id: 'b', issue: 'issue-b', updatedAtMs: Date.now() - 200_000 });
  const html = renderRunList({ items: [a, b], selectedId: 'b' });

  const buttonA = html.match(/<button[^>]*data-run="a"[^>]*>/);
  const buttonB = html.match(/<button[^>]*data-run="b"[^>]*>/);
  assert.ok(buttonA, 'a button carrying run a\'s id must render');
  assert.ok(buttonB, 'a button carrying run b\'s id must render');
  assert.match(buttonA[0], /aria-current="false"/, 'the run not selected must say so');
  assert.match(buttonB[0], /aria-current="true"/, 'the selected run must say so');
  assert.ok(html.includes('issue-a') && html.includes('issue-b'), 'each row must show its own run\'s issue');
  assert.ok(html.includes(fmtAgo(a.updatedAtMs)) && html.includes(fmtAgo(b.updatedAtMs)), 'each row must show its own run\'s time');
});

test('renderRunList({ items: [] }) renders a placeholder row, not an empty string', () => {
  const html = renderRunList({ items: [] });
  assert.ok(html.length > 0, 'an empty collector must still render a row, mirroring renderSessionList');
  assert.match(html, /<li/);
  assert.doesNotMatch(html, /data-run=/);
});

test('renderRunList escapes the id and the issue, so a quote cannot break out of the data-run attribute', () => {
  const hostile = listItem({ id: 'a" onclick="x', issue: '<script>y</script>' });
  const html = renderRunList({ items: [hostile], selectedId: null });
  assert.ok(!html.includes('onclick='), 'a raw quote in the id must never break out of the data-run attribute');
  assert.ok(!html.includes('<script>'), 'a raw <script> in the issue must never reach the markup');
});

// Criterion 4 — the SSE frame: it names only which run changed and when.

test('runFrame parses the collector\'s frame verbatim', () => {
  assert.deepEqual(
    runFrame('{"id":"docs/issues/x","updatedAtMs":1712}'),
    { id: 'docs/issues/x', updatedAtMs: 1712 },
    'this is the collector\'s own run frame, unchanged',
  );
});

test('a malformed frame costs the page nothing', () => {
  for (const input of ['not json', '{}', 'null', '']) {
    assert.equal(runFrame(input), null, `runFrame(${JSON.stringify(input)}) must be null, not a thrown error`);
  }
});

// Correction round 2 — the rule that decides when the shown run's state is asked for again.

test('with no frame, the state is always asked for — the boot and the explicit switch', () => {
  assert.equal(
    shouldLoadRun({ changedId: null, shownId: null, selectedId: 'a' }),
    true,
    'a boot with nothing selected must ask for the run the picker chose, or the page opens on "No run yet" instead of the latest run',
  );
  assert.equal(
    shouldLoadRun({ changedId: null, shownId: 'a', selectedId: 'a' }),
    true,
    'an explicit switch to a run already shown must still fetch its state fresh',
  );
  assert.equal(shouldLoadRun(), true, 'a call with nothing to go on must read as a boot, never as "leave the pane empty"');
  assert.equal(shouldLoadRun({}), true, 'a call with nothing to go on must read as a boot, never as "leave the pane empty"');
});

test('a frame naming the run on screen refreshes it — the live update', () => {
  assert.equal(
    shouldLoadRun({ changedId: 'a', shownId: 'a', selectedId: 'a' }),
    true,
    'a frame naming the run already on screen must trigger the live refresh',
  );
});

test('a frame naming another run leaves the shown run alone, so a busy collector costs the pane no request', () => {
  assert.equal(
    shouldLoadRun({ changedId: 'b', shownId: 'a', selectedId: 'a' }),
    false,
    'a frame about a run that is not on screen must never cost the pane a fetch — a `return true` mutation would fail this',
  );
});

test('a frame that arrives before anything was shown still paints, whichever run it named', () => {
  assert.equal(
    shouldLoadRun({ changedId: 'a', shownId: null, selectedId: 'a' }),
    true,
    'the first frame to arrive at an empty pane must still paint it',
  );
  assert.equal(
    shouldLoadRun({ changedId: 'x', shownId: null, selectedId: 'a' }),
    true,
    'the frame named a run other than the one the picker chose, and the pane is still empty, so it must be filled — a `return changedId === selectedId` mutation would fail this',
  );
});

// Increment tree-view — the recorded document is shown as its own structure,
// every record and every list folding away on its own.

test('childEntries reads a record by its keys and a list by its indices, and anything else as no children at all', () => {
  assert.deepEqual(childEntries({ a: 1, b: 2 }), [['a', 1], ['b', 2]], 'a record is its own entries');
  assert.deepEqual(
    childEntries(['x', 'y']),
    [['0', 'x'], ['1', 'y']],
    'an index spelled out as a key is what makes a path through a list read like a path through a record',
  );
  for (const leaf of ['text', 7, true, null, undefined]) {
    assert.deepEqual(childEntries(leaf), [], `${JSON.stringify(leaf)} has nothing to open onto`);
  }
});

test('badgeOf counts what is inside a container and says nothing about a leaf', () => {
  assert.equal(badgeOf([1, 2, 3, 4]), '[4]');
  assert.equal(badgeOf({ a: 1, b: 2 }), '{2}');
  assert.equal(badgeOf([]), '[0]');
  assert.equal(badgeOf({}), '{0}');
  assert.equal(badgeOf('text'), '', 'a leaf carries no badge at all');
});

test('hintOf names a record by the field it is known by, and a list by its first entry', () => {
  assert.equal(hintOf({ title: 'MARKER-TITLE', note: 'n' }), 'MARKER-TITLE', 'an increment is known by its title');
  assert.equal(hintOf({ label: 'MARKER-LABEL' }), 'MARKER-LABEL', 'a step is known by its label');
  assert.equal(hintOf({ summary: 'MARKER-SUMMARY' }), 'MARKER-SUMMARY', 'an agent return is known by its summary');
  assert.equal(
    hintOf({ alpha: 1, beta: 2 }),
    'alpha, beta',
    'a record carrying no naming field is named by the keys it holds, which is its structure',
  );
  assert.equal(hintOf([{ title: 'MARKER-FIRST' }, { title: 'second' }]), 'MARKER-FIRST', 'a list is named by its first entry');
  assert.equal(hintOf([]), '', 'an empty list has nothing to be named by');
  assert.equal(hintOf(null), 'null');
  assert.equal(hintOf(4), '4');
  assert.equal(hintOf(false), 'false');
});

test('the tree mirrors the document: every key under the key that holds it, spelled as the recorder wrote it', () => {
  const state = doc({
    increments: [increment({ id: 'a', title: 'Alpha' })],
    run: { steps: [step({ label: 'cut' })] },
  });
  const html = renderTree(state);

  for (const key of Object.keys(state)) {
    assert.ok(html.includes(`<span class="json-key">${key}</span>`), `the top-level key ${key} must render under its own name`);
  }
  assert.ok(
    html.includes('<span class="json-key">codemap</span>'),
    'a key is printed verbatim, never prettified into words — this view mirrors the document rather than describing it',
  );
  assert.ok(!html.includes('code map'), 'a camel- or lower-cased key must reach the page unchanged');

  const incrementsAt = html.indexOf('data-panel="tree/increments"');
  const firstAt = html.indexOf('data-panel="tree/increments/0"');
  const titleAt = html.indexOf('data-panel="tree/increments/0/criteria"');
  assert.ok(incrementsAt >= 0, 'the increments list is a node of its own');
  assert.ok(firstAt > incrementsAt, 'the first increment sits inside it, keyed by its index');
  assert.ok(titleAt > firstAt || html.includes('json-key">criteria'), 'and the increment\'s own fields sit inside that');
});

test('a list keeps the document\'s own order, and each entry is keyed by its index', () => {
  const incs = [
    increment({ id: 'a', title: 'Card Alpha' }),
    increment({ id: 'b', title: 'Card Bravo' }),
    increment({ id: 'c', title: 'Card Charlie' }),
  ];
  const html = renderTree(doc({ increments: incs }));

  assert.ok(
    html.indexOf('Card Alpha') < html.indexOf('Card Bravo') && html.indexOf('Card Bravo') < html.indexOf('Card Charlie'),
    'the three entries must render in the document\'s own order, proved rather than assumed',
  );
  for (const index of [0, 1, 2]) {
    assert.ok(html.includes(`data-panel="tree/increments/${index}"`), `entry ${index} must be keyed by its index`);
  }
});

test('the top level opens and everything under it is folded, so a run of any size arrives on one screen', () => {
  const state = doc({ increments: [increment({ id: 'a', steps: [step()] })] });
  const html = renderTree(state);

  const openAt = (key) => {
    const match = html.match(new RegExp(`<details class="json-fold" data-panel="${key}"( open)?>`));
    assert.ok(match, `${key} must render as a disclosure`);
    return !!match[1];
  };
  assert.equal(openAt('tree/increments'), true, 'the top level of the document is open when the pane arrives');
  assert.equal(openAt('tree/run'), true, 'every top-level container, not only the first');
  assert.equal(openAt('tree/increments/0'), false, 'one level down is folded — this is what replaced the wall of text');
  assert.equal(openAt('tree/increments/0/steps'), false, 'and so is everything under that');
});

test('the increment being worked opens with its steps, so the tree lands where the run is', () => {
  const state = doc({
    running: { label: 'build:b.0', increment: 'b', at: new Date().toISOString(), prompt: 'p' },
    increments: [increment({ id: 'a' }), increment({ id: 'b', steps: [step()] }), increment({ id: 'c' })],
  });

  assert.deepEqual(
    [...openPathsFor(state)].sort(),
    ['tree/increments/1', 'tree/increments/1/steps'],
    'the running increment is found by its id and named by its index, which is what the tree keys it under',
  );

  const html = renderTree(state, { openPaths: openPathsFor(state) });
  assert.match(html, /data-panel="tree\/increments\/1" open>/, 'the increment being worked opens');
  assert.doesNotMatch(html, /data-panel="tree\/increments\/0" open>/, 'and the ones that are not stay folded');

  assert.deepEqual([...openPathsFor(doc())], [], 'a run with no step in flight opens nothing beyond its top level');
  assert.deepEqual(
    [...openPathsFor(doc({ running: { label: 'x', increment: 'gone', at: '' } }))],
    [],
    'a running entry naming an increment the backlog no longer holds opens nothing, and never throws',
  );
});

test('a page of text gets a disclosure of its own, one line collapsed and whole when opened', () => {
  const long = 'x'.repeat(5000);
  const html = renderTree({ codemap: long });

  const hint = html.match(/class="json-hint">([\s\S]*?)<\/span>/);
  assert.ok(hint, 'the folded line must render its preview in a json-hint of its own');
  assert.ok(
    hint[1].length <= PREVIEW_CHARS + 1,
    `the folded line must be far shorter than the 5000-character value (was ${hint[1].length} chars)`,
  );
  assert.ok(hint[1].endsWith('…'), 'a truncated preview must end with the ellipsis previewOf uses');

  const body = html.match(/<pre class="json-text">([\s\S]*?)<\/pre>/);
  assert.ok(body, 'the whole value must render inside a pre of its own');
  assert.ok(body[1].includes(long), 'the full 5000-character value must reach the opened body');
  assert.match(html, /<details class="json-fold" data-panel="tree\/codemap">/, 'and it must arrive folded');
});

test('a multi-line value folds even when it is short, and a short one-line value sits on its key\'s line', () => {
  const folded = renderTree({ note: 'first line\nsecond line' });
  assert.match(folded, /<pre class="json-text">/, 'two lines on one row is the wall this view replaced');

  const inline = renderTree({ note: 'short enough' });
  assert.ok(!inline.includes('json-text'), 'a short one-line value needs no disclosure');
  assert.match(inline, /<li class="json-leaf"><span class="json-key">note<\/span><span class="json-string">short enough<\/span>/);

  assert.ok(INLINE_CHARS > 0, 'the inline bound must be a real threshold');
  const overLong = renderTree({ note: 'y'.repeat(INLINE_CHARS + 1) });
  assert.match(overLong, /<pre class="json-text">/, 'one character past the bound is a folded value');
});

test('every JSON type renders as itself, and a falsy value is a value rather than a hole', () => {
  const html = renderTree({ n: 0, f: false, t: true, s: '', z: null, big: 12.5 });
  assert.match(html, /<span class="json-number">0<\/span>/, 'zero is a number the document recorded');
  assert.match(html, /<span class="json-bool">false<\/span>/, 'so is false');
  assert.match(html, /<span class="json-bool">true<\/span>/);
  assert.match(html, /<span class="json-number">12\.5<\/span>/);
  assert.match(html, /<span class="json-null">null<\/span>/, 'null says null rather than nothing');
  assert.match(html, /<span class="json-empty">""<\/span>/, 'an empty string says so rather than leaving the row blank');
  assert.ok(!html.includes('undefined'), 'no type may print as the literal string undefined');
  assert.ok(!html.includes('NaN'), 'no type may print as the literal string NaN');
});

test('an empty list and an empty record are stated rather than folded onto nothing', () => {
  const html = renderTree({ steps: [], attempts: {} });
  assert.match(html, /<span class="json-key">steps<\/span><span class="json-empty">\[\]<\/span>/);
  assert.match(html, /<span class="json-key">attempts<\/span><span class="json-empty">\{\}<\/span>/);
  assert.ok(!html.includes('json-fold'), 'neither may render a disclosure that opens onto nothing');
});

test('nothing recorded is dropped, however deep it sits or whatever shape it takes', () => {
  const state = doc({
    increments: [
      increment({
        id: 'x',
        steps: [
          step({
            label: 'review:x.0',
            return: {
              findings: [{ file: 'a.js', why: 'MARKER-WHY-A' }, { file: 'b.js', why: 'MARKER-WHY-B' }],
              deep: { a: { b: { c: { d: { e: 'MARKER-DEEP' } } } } },
              checks: ['./test.sh', 'npm test'],
            },
          }),
        ],
      }),
    ],
  });
  const html = renderTree(state);

  for (const marker of ['MARKER-WHY-A', 'MARKER-WHY-B', 'MARKER-DEEP', './test.sh', 'npm test']) {
    assert.ok(html.includes(marker), `${marker} must reach the markup — a depth bound would drop it`);
  }
  assert.ok(
    html.includes('data-panel="tree/increments/0/steps/0/return/deep/a/b/c/d"'),
    'a node five levels down is still a node with a path of its own, not a JSON dump',
  );
});

test('a recorded instant keeps its own text and gains an age that the slow tick can retime', () => {
  const at = new Date(Date.now() - 60_000).toISOString();
  const html = renderTree({ at });
  assert.ok(html.includes(at), 'the recorded value is printed as the document holds it');
  assert.match(html, new RegExp(`<span class="json-ago" data-at="${at.replace(/[.]/g, '\\.')}">`), 'and the age beside it carries the instant');
  assert.ok(html.includes(fmtAgo(Date.parse(at))), 'the age is formatted by the same formatter the head uses');

  const plain = renderTree({ branch: 'claude/x--b' });
  assert.ok(!plain.includes('json-ago'), 'a string that is not an instant gains nothing');
});

test('every disclosure is keyed by its path in the document, and no two share a key', () => {
  const state = doc({
    running: { label: 'build:a.0', increment: 'a', at: new Date().toISOString(), prompt: 'p' },
    increments: [
      // The same label under two increments: position on the page is not a key,
      // place in the document is.
      increment({ id: 'a', steps: [step({ label: 'research:0', prompt: 'p' })] }),
      increment({ id: 'b', steps: [step({ label: 'research:0', prompt: 'p' })] }),
    ],
    run: { steps: [step({ label: 'research:0' })] },
  });
  const html = renderRun(runEntry({ state }));

  const attrs = detailAttrs(html);
  assert.ok(attrs.length >= 6, `the fixture must actually produce several disclosures (found ${attrs.length})`);
  for (const one of attrs) {
    assert.match(one, /data-panel="[^"]+"/, 'every details element must be keyed, or a repaint closes it');
  }

  const keys = panelKeys(html);
  assert.equal(new Set(keys).size, keys.length, 'two panels sharing a key would restore each other\'s open state');
  assert.ok(
    keys.includes('tree/increments/0/steps/0') && keys.includes('tree/increments/1/steps/0'),
    'the same label under two increments must be two keys, named by where each one sits',
  );
});

test('a hostile key or value is escaped, and cannot break out of the panel key it is written into', () => {
  const html = renderTree({
    '<script>k</script>': 'v',
    'a" onclick="x': ['w'],
    goal: '<script>b</script>',
    criteria: ['<script>c</script>'],
    prompt: '<script>d</script>\nsecond line',
  });
  assert.ok(!html.includes('<script'), 'no raw script tag may reach the markup, from a key or from a value');

  const keys = panelKeys(html);
  assert.ok(
    keys.some((key) => key.includes('onclick')),
    'the fixture must actually put the hostile key into a data-panel attribute, or this case is vacuous',
  );
  for (const key of keys) {
    assert.ok(!key.includes('='), 'no fragment of a panel key may read like a second attribute — the = is spelled as an entity');
    assert.ok(!key.includes('"'), 'and a raw quote can never close the attribute early');
  }
});

test('a document of any shape renders without throwing, and prints no undefined and no NaN', () => {
  const shapes = [
    doc({ increments: 'not an array' }),
    doc({ run: null }),
    doc({ run: 'not an object' }),
    doc({ increments: [null, 7, 'text', []] }),
    doc({ codemap: undefined }),
    { version: 1 },
  ];
  for (const state of shapes) {
    let html;
    assert.doesNotThrow(() => {
      html = renderRun(runEntry({ state }));
    }, `renderRun must not throw for ${JSON.stringify(state).slice(0, 60)}`);
    assert.ok(!html.includes('undefined'), 'no shape may print as the literal string undefined');
    assert.ok(!html.includes('NaN'), 'no shape may print as the literal string NaN');
  }
});

test('renderNode is the one renderer the whole tree is built from, so no level can drift from another', () => {
  const value = { steps: [step({ label: 'cut' })] };
  const whole = renderTree({ run: value });
  const one = renderNode('run', value, { path: 'tree', depth: 0 });
  assert.ok(
    whole.includes(one),
    'the tree must be its nodes and nothing else — a second reimplementation for the top level could silently drift apart',
  );
});

test('a rendered run carries the document of the entry it was given and of no other', () => {
  const a = runEntry({ id: 'a', state: doc({ increments: [increment({ id: 'inc-a', steps: [step({ label: 'a-step' })] })] }) });
  const b = runEntry({ id: 'b', state: doc({ increments: [increment({ id: 'inc-b', steps: [step({ label: 'b-step' })] })] }) });

  const htmlA = renderRun(a);
  assert.ok(htmlA.includes('a-step'), 'A\'s own steps must render');
  assert.ok(!htmlA.includes('b-step'), 'B\'s steps must never leak into A\'s render');

  const htmlB = renderRun(b);
  assert.ok(htmlB.includes('b-step'), 'B\'s own steps must render');
  assert.ok(!htmlB.includes('a-step'), 'A\'s steps must never leak into B\'s render');
});

test('the pane offers one control to open the whole document and one to fold it back', () => {
  const html = renderRun(runEntry());
  assert.match(html, /data-tree="open"/, 'a reader looking for a string wants the whole document open at once');
  assert.match(html, /data-tree="close"/, 'and folded back afterwards, without reloading the page');
  assert.ok(html.includes('backlog.json'), 'the panel says which document it is showing');
});

// Workflow details — the step in flight, announced above the document.

const running = (over = {}) => ({
  increment: 'ui',
  label: 'build:ui.0',
  at: new Date(Date.now() - 4 * 60_000).toISOString(),
  prompt: 'Goal: paint the run view.\nCriteria:\n  - it shows the step in flight',
  ...over,
});

test('runningView reads the step in flight, and reads none where the state names none', () => {
  const view = runningView(doc({ running: running() }));
  assert.ok(view, 'a state carrying a running entry has a step in flight');
  assert.equal(view.label, 'build:ui.0');
  assert.equal(view.increment, 'ui');
  assert.ok(view.timeMs > 0, 'the ISO instant must parse to a usable millisecond value');

  assert.equal(runningView(doc()), null, 'a state with no running key has no step in flight');
  assert.equal(runningView(doc({ running: {} })), null, 'an entry with no label is not a step in flight');
  assert.equal(runningView(doc({ running: { at: 'x' } })), null, 'the label is what makes it one, not the instant');
  assert.equal(runningView(null), null, 'no state at all is no step in flight');
});

test('a step in flight is announced above the document, with its label, its increment and how long it has been running', () => {
  const entry = runEntry({ state: doc({ running: running({ label: 'MARKER-LABEL' }) }) });
  const html = renderRun(entry);

  assert.ok(html.includes('MARKER-LABEL'), 'the running step must be named');
  assert.ok(html.includes('run-running'), 'it must render in the banner of its own');
  assert.ok(html.includes('running since'), 'the banner must say since when, which is the one thing that moves between two writes');
  assert.ok(
    html.indexOf('run-running') < html.indexOf('json-tree'),
    'what is happening right now belongs above the document, not somewhere down it',
  );
  assert.ok(
    html.includes('<span class="json-key">running</span>'),
    'and the state\'s own running key is still in the tree — the tree shows the document, whole',
  );
});

test('the running banner shows the prompt open, because the goal and the criteria of the step are in it', () => {
  const prompt = 'Goal: MARKER-GOAL\nCriteria:\n  - MARKER-CRITERION';
  const entry = runEntry({ state: doc({ running: running({ prompt }) }) });
  const html = renderRun(entry);

  assert.ok(html.includes('MARKER-GOAL'), 'the prompt the step was dispatched with must render');
  assert.ok(html.includes('MARKER-CRITERION'), 'that includes the criteria it names');
  assert.match(
    html,
    /<details class="run-panel" data-panel="running\/[^"]*\/prompt" open>/,
    'the running prompt is the one panel outside the tree that opens by default — it is the answer to the question a reader has while a run is going',
  );
});

test('a step in flight with no prompt recorded says so instead of rendering an empty panel', () => {
  const entry = runEntry({ state: doc({ running: running({ prompt: undefined }) }) });
  const html = renderRun(entry);
  assert.ok(html.includes('run-running'), 'the banner still renders — the step is still running');
  assert.ok(html.includes('No prompt was recorded'), 'an absent prompt reads as the record it is, not as a broken panel');
});

test('every instant in the pane carries data-at, so the ages can be retimed without repainting the markup around them', () => {
  const entry = runEntry({
    state: doc({
      running: running(),
      increments: [increment({ id: 'ui', steps: [step()] })],
    }),
  });
  const html = renderRun(entry);
  const stamped = [...html.matchAll(/data-at="([^"]*)"/g)];
  assert.ok(stamped.length >= 3, `the write time, the running step and the recorded step must each be retimeable (found ${stamped.length})`);
  for (const [, iso] of stamped) {
    assert.ok(Number.isFinite(Date.parse(iso)), `data-at must hold a parseable instant, not a formatted age: ${iso}`);
  }
});

test('a hostile prompt is escaped like everything else', () => {
  const entry = runEntry({ state: doc({ running: running({ prompt: '<script>a</script>' }) }) });
  const html = renderRun(entry);
  assert.ok(!html.includes('<script'), 'no raw script tag may reach the markup from the banner either');
});

test('the running prompt is keyed on its own step, so the next step arrives with its prompt open again', () => {
  const first = renderRun(runEntry({ state: doc({ running: running({ label: 'research:ui.0' }) }) }));
  const second = renderRun(runEntry({ state: doc({ running: running({ label: 'build:ui.0' }) }) }));
  const keyOf = (html) => html.match(/data-panel="(running\/[^"]*)"/)?.[1];
  assert.ok(keyOf(first) && keyOf(second), 'both renders must key the running prompt');
  assert.notEqual(keyOf(first), keyOf(second), 'a different step is a different panel, not the same one the reader may have closed');
});
