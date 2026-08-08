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
} from '../public/run.js';
import { fmtAgo } from '../public/format.js';

// The four factories every case builds its input from — modelled on the
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

// Criterion 1 — what the run view holds: the issue, the workflow, when it was
// last written, its increments in order, the closed/open counts, the codemap.

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

test('one card per increment, in the document\'s own order, each carrying its id, title, status, branch and note', () => {
  const incs = [
    increment({ id: 'a', title: 'Card Alpha' }),
    increment({ id: 'b', title: 'Card Bravo', status: 'done', note: 'accepted', branch: 'claude/x--b' }),
    increment({ id: 'c', title: 'Card Charlie' }),
  ];
  const entry = runEntry({ increments: incs.length, state: doc({ increments: incs }) });
  const html = renderRun(entry);

  for (const inc of incs) {
    assert.ok(html.includes(inc.id), `the card must carry increment id ${inc.id}`);
    assert.ok(html.includes(inc.title), `the card must carry increment title ${inc.title}`);
  }
  assert.ok(html.includes('done'), 'the second card\'s status must be shown');
  assert.ok(html.includes('accepted'), 'the second card\'s note must be shown');
  assert.ok(html.includes('claude/x--b'), 'the second card\'s branch must be shown');

  assert.ok(
    html.indexOf('Card Alpha') < html.indexOf('Card Bravo') && html.indexOf('Card Bravo') < html.indexOf('Card Charlie'),
    'the three cards must render in the backlog\'s own order, proved rather than assumed',
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

test('the codemap is rendered whole, escaped', () => {
  const codemap = 'first line of the map\nsecond line & more';
  const entry = runEntry({ state: doc({ codemap }) });
  const html = renderRun(entry);
  assert.ok(html.includes('first line of the map'), 'the first codemap line must be present');
  assert.ok(html.includes('second line'), 'the second codemap line must be present');
  assert.ok(html.includes('&amp;'), 'the & must be escaped');
});

test('everything printed is escaped', () => {
  const incs = [increment({ id: 'x', title: '<script>alert(1)</script>', note: `note "quoted" and 'single'` })];
  const entry = runEntry({ issue: 'issue < other', state: doc({ issue: 'issue < other', increments: incs }) });
  const html = renderRun(entry);
  assert.ok(!html.includes('<script'), 'a raw <script must never reach the markup, from the title, the note or the issue');
});

test('renderRun(null) is a placeholder with no increment card, for the collector holding no run at all yet', () => {
  const html = renderRun(null);
  assert.ok(html.length > 0, 'null must still render something to show in place of the run view');
  assert.match(html, /class="(?:empty|placeholder)"/, 'a run-less state reuses the page\'s own empty/placeholder styling');
  assert.ok(!html.includes('data-closed'), 'no increment card may render when there is no run to show at all');
});

test('the increments come from state.increments and never from the entry\'s own count', () => {
  const entry = runEntry({
    increments: 99,
    state: doc({ increments: [increment({ id: 'a', title: 'Card Alpha' }), increment({ id: 'b', title: 'Card Bravo' })] }),
  });
  const html = renderRun(entry);
  assert.ok(html.includes('Card Alpha'));
  assert.ok(html.includes('Card Bravo'));
  assert.ok(!html.includes('99'), 'the entry\'s own increment count must never leak into the markup — the document\'s array is the source of truth');
});

test('an opaque document carrying none of the known fields still renders a head and a placeholder, never undefined or NaN', () => {
  const entry = runEntry({ issue: 'i', workflow: undefined, state: { issue: 'i' } });
  const html = renderRun(entry);
  assert.ok(html.includes('i'), 'whatever the document does carry must still reach the page');
  assert.ok(!html.includes('undefined'), 'a missing field must never print as the literal string undefined');
  assert.ok(!html.includes('NaN'), 'a missing field must never print as the literal string NaN');
  assert.ok(!html.includes('data-closed'), 'no increment card may render when the document carries no increments array at all');
});

test('a run with zero increments shows zero closed and zero open, and a placeholder instead of an empty block', () => {
  const entry = runEntry({ increments: 0, state: doc({ increments: [] }) });
  const html = renderRun(entry);
  assert.deepEqual(incrementCounts([]), { total: 0, closed: 0, open: 0 });
  assert.ok(!html.includes('data-closed'), 'no increment card may render when the array is empty');
  assert.ok(!html.includes('undefined'));
  assert.ok(!html.includes('NaN'));
});

// Criterion 2 — a closed increment reads as closed, with its status and its
// note.

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

test('a closed increment\'s card is marked closed and shows its status and its note; an open one carries neither the mark nor a note', () => {
  const closed = increment({ id: 'closed-one', status: 'done', note: 'accepted at round 0' });
  const open = increment({ id: 'open-one', status: 'todo', note: '' });
  const entry = runEntry({ increments: 2, state: doc({ increments: [closed, open] }) });
  const html = renderRun(entry);

  const closedIdx = html.indexOf('closed-one');
  const openIdx = html.indexOf('open-one');
  assert.ok(closedIdx >= 0 && openIdx > closedIdx, 'both cards must render, the closed one first');

  const markMatches = [...html.matchAll(/data-closed="true"/g)];
  assert.equal(markMatches.length, 1, 'exactly one card — the closed one — may carry the closed mark');
  assert.ok(
    markMatches[0].index < openIdx,
    'the closed mark must belong to the closed card, which renders before the open one',
  );

  assert.ok(
    html.indexOf('done') >= 0 && html.indexOf('done') < openIdx,
    'the closed card must show its own status before the next card starts',
  );
  assert.ok(
    html.indexOf('accepted at round 0') >= 0 && html.indexOf('accepted at round 0') < openIdx,
    'the closed card must show its own note before the next card starts',
  );
  assert.ok(!html.includes('undefined'), 'the open card\'s empty note must never render as the literal string undefined');
});

test('a closed increment with an empty note still reads as closed, printing no undefined', () => {
  const entry = runEntry({ increments: 1, state: doc({ increments: [increment({ id: 'x', status: 'dropped', note: '' })] }) });
  const html = renderRun(entry);
  assert.match(html, /data-closed="true"/, 'an increment with no steps and no note is still a closed increment');
  assert.ok(html.includes('dropped'), 'the status must still be shown');
  assert.ok(!html.includes('undefined'), 'an empty note must never render as the literal string undefined');
});

test('an increment with an empty branch renders no branch label at all', () => {
  const entry = runEntry({ increments: 1, state: doc({ increments: [increment({ id: 'plain-one', branch: '' })] }) });
  const html = renderRun(entry);
  assert.ok(!/branch/i.test(html), 'a dangling "branch" label with nothing after it must never render');
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
