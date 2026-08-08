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
  renderSteps,
  stepView,
  STEP_SHED_NOTE,
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

// Increment ui-steps — the steps of each increment, and the run's own.

test('an increment\'s steps render in the backlog\'s own order, each with its label, its instant and its return', () => {
  const steps = [
    step({ label: 'research:x', at: new Date(Date.now() - 3 * 60_000).toISOString(), return: { summary: 'marker-one' } }),
    step({ label: 'tests:x', at: new Date(Date.now() - 2 * 60_000).toISOString(), return: { summary: 'marker-two' } }),
    step({ label: 'impl:x', at: new Date(Date.now() - 1 * 60_000).toISOString(), return: { summary: 'marker-three' } }),
  ];
  const markers = steps.map((s) => s.return.summary);
  assert.equal(new Set(markers).size, 3, 'the three markers must actually differ, or the order proved below is vacuous');

  const inc = increment({ id: 'x', steps });
  const entry = runEntry({ state: doc({ increments: [inc] }) });
  const html = renderRun(entry);

  for (const s of steps) {
    assert.ok(html.includes(s.label), `the step's label ${s.label} must render`);
    assert.ok(html.includes(`data-at="${s.at}"`), `the step's ISO instant must sit in data-at="${s.at}", not a locale-formatted string`);
  }
  assert.ok(
    html.indexOf('research:x') < html.indexOf('tests:x') && html.indexOf('tests:x') < html.indexOf('impl:x'),
    'the three steps must render in the backlog\'s own order',
  );
  const rows = [...html.matchAll(/<li class="run-step"/g)];
  assert.equal(rows.length, 3, 'exactly one row per recorded step');
});

test('the collapsed line shows a preview and the expanded body shows the whole return', () => {
  const s = step({ return: { summary: 'short summary', plan: 'a marker only the body may carry' } });
  const inc = increment({ id: 'x', steps: [s] });
  const entry = runEntry({ state: doc({ increments: [inc] }) });
  const html = renderRun(entry);

  assert.match(html, /<details/, 'a step must render as a details element');
  assert.match(html, /<\/details>/, 'the details element must close');

  const summaryMatch = html.match(/<summary[^>]*>([\s\S]*?)<\/summary>/);
  assert.ok(summaryMatch, 'the collapsed line must render inside a <summary>');
  const summarySlice = summaryMatch[1];
  assert.ok(summarySlice.includes('short summary'), 'the collapsed line must show the return\'s summary');

  const preMatch = html.match(/<pre class="run-step-return"[^>]*>([\s\S]*?)<\/pre>/);
  assert.ok(preMatch, 'the whole return must render inside a <pre class="run-step-return">');
  const preSlice = preMatch[1];
  assert.ok(preSlice.includes('a marker only the body may carry'), 'the full return must carry the plan marker');
  assert.ok(!summarySlice.includes('a marker only the body may carry'), 'the plan marker must not leak into the collapsed line');
});

test('a very long return collapses to one line and still opens to the whole of it', () => {
  const long = 'x'.repeat(5000);
  const s = step({ return: long });
  const inc = increment({ id: 'x', steps: [s] });
  const entry = runEntry({ state: doc({ increments: [inc] }) });
  const html = renderRun(entry);

  const previewMatch = html.match(/class="run-step-preview"[^>]*>([\s\S]*?)<\/[a-zA-Z]+>/);
  assert.ok(previewMatch, 'the collapsed preview must render in its own run-step-preview element');
  const preview = previewMatch[1];
  assert.ok(
    preview.length <= PREVIEW_CHARS + 1,
    `the collapsed preview must be far shorter than the 5000-character return (was ${preview.length} chars)`,
  );
  assert.ok(preview.endsWith('…'), 'a truncated preview must end with the ellipsis previewOf uses');

  const preMatch = html.match(/<pre class="run-step-return"[^>]*>([\s\S]*?)<\/pre>/);
  assert.ok(preMatch, 'the full return must render inside a <pre>');
  assert.ok(preMatch[1].includes(long), 'the full 5000-character run must reach the expanded body');

  assert.ok(!html.includes('undefined'), 'a long return must never print as the literal string undefined');
  assert.ok(!html.includes('NaN'), 'a long return must never print as the literal string NaN');
});

test('a return of any shape renders, and none of them prints undefined or NaN', () => {
  const nested = { a: { b: { c: 'leaf-marker-deep' } } };
  const steps = [
    step({ label: 's-object', return: { detail: 'no summary field here' } }),
    step({ label: 's-nested', return: nested }),
    step({ label: 's-null', return: null }),
    step({ label: 's-zero', return: 0 }),
    step({ label: 's-string', return: 'a bare string return' }),
  ];
  const inc = increment({ id: 'x', steps });
  const entry = runEntry({ state: doc({ increments: [inc] }) });

  let html;
  assert.doesNotThrow(() => {
    html = renderRun(entry);
  }, 'no shape of return may throw');

  const rows = [...html.matchAll(/<li class="run-step"/g)];
  assert.equal(rows.length, 5, 'every step must render a row, whatever shape its return takes');
  assert.ok(html.includes('leaf-marker-deep'), 'a leaf three levels down a nested return must still reach the markup');
  assert.ok(!html.includes('undefined'), 'no return shape may print as the literal string undefined');
  assert.ok(!html.includes('NaN'), 'no return shape may print as the literal string NaN');
});

test('a step whose return was shed still renders its label and its time, with no return body', () => {
  const shed = (() => {
    const { return: _drop, ...rest } = step({ label: 'impl:shed' });
    return rest;
  })();
  assert.ok(!('return' in shed), 'the fixture must actually lack the return key, not merely hold it as undefined — this is what the recorder\'s close leaves behind');

  const inc = increment({ id: 'x', steps: [shed] });
  const entry = runEntry({ state: doc({ increments: [inc] }) });
  const html = renderRun(entry);

  assert.ok(html.includes('impl:shed'), 'the label must still render');
  assert.ok(html.includes(`data-at="${shed.at}"`), 'the instant must still render');
  assert.ok(html.includes(STEP_SHED_NOTE), 'the shed note must mark the line');
  assert.ok(!html.includes('run-step-return'), 'a shed step must render no return body');
  assert.ok(!html.includes('undefined'), 'a shed return must never print as the literal string undefined');
});

test('an increment the backlog holds with no steps renders as the ordinary card it is', () => {
  const closedEmpty = increment({ id: 'closed-one', status: 'done', note: 'accepted', steps: [] });
  const { steps: _drop, ...noStepsField } = increment({ id: 'no-steps-field', title: 'Card No Steps' });
  const entry = runEntry({ state: doc({ increments: [closedEmpty, noStepsField] }) });
  const html = renderRun(entry);

  assert.ok(html.includes(closedEmpty.id), 'the closed card must carry its id');
  assert.ok(html.includes(noStepsField.id), 'the steps-less card must carry its id');
  assert.ok(html.includes(closedEmpty.title), 'the closed card\'s title must render');
  assert.ok(html.includes(noStepsField.title), 'the steps-less card\'s title must render');
  assert.ok(html.includes('done'), 'the closed card\'s status must render');
  assert.ok(html.includes('accepted'), 'the closed card\'s note must render');

  assert.ok(!html.includes('run-steps'), 'no steps list may render for an increment with no steps, empty array or missing field alike');
  assert.ok(!html.includes('run-step'), 'no step row may render for either increment');
  assert.ok(!html.includes('undefined'), 'a steps-less increment must never print as the literal string undefined');
  assert.ok(!html.includes('NaN'), 'a steps-less increment must never print as the literal string NaN');
  assert.match(html, /data-closed="true"/, 'the closed card must still carry its closed mark, unaffected by having no steps');
});

test('the run\'s own steps render in the order the backlog holds them, in a panel of their own', () => {
  const ownSteps = [step({ label: 'cut' }), step({ label: 'close:ui' }), step({ label: 'publish' })];
  const inc = increment({ id: 'x', steps: [] });
  const entry = runEntry({ state: doc({ increments: [inc], run: { steps: ownSteps } }) });
  const html = renderRun(entry);

  assert.ok(
    html.indexOf('cut') < html.indexOf('close:ui') && html.indexOf('close:ui') < html.indexOf('publish'),
    'the run\'s own steps must render in the backlog\'s own order',
  );
  for (const cls of ['run-step', 'run-step-label', 'run-step-return']) {
    assert.ok(html.includes(cls), `the run\'s own steps must reuse the ${cls} class the increment steps use`);
  }

  const incrementsIdx = html.indexOf('run-increments');
  const panelIdx = html.indexOf('run-steps-panel');
  assert.ok(incrementsIdx >= 0, 'the increment cards must sit in a run-increments container');
  assert.ok(panelIdx >= 0, 'the run\'s own steps must sit in a run-steps-panel container');
  assert.ok(incrementsIdx < panelIdx, 'the run\'s own steps must sit outside and after the increment cards');

  const between = html.slice(incrementsIdx, panelIdx);
  assert.ok(
    !between.includes('run-step-label'),
    'the run\'s own step labels must land in the panel, not in the step-less card above it',
  );

  const stepsHtml = renderSteps(ownSteps);
  assert.ok(
    html.includes(stepsHtml),
    'the run\'s own steps must be rendered by the very same step-list renderer the increment cards use, not a second reimplementation, or the two could silently drift apart',
  );
});

test('a document carrying no run steps renders no run-steps panel', () => {
  const codemap = 'codemap-marker-line';
  const variants = [
    doc({ codemap, run: { steps: [] } }),
    doc({ codemap, run: null }),
    doc({ codemap, run: 'not an object' }),
    (() => {
      const { run: _drop, ...rest } = doc({ codemap });
      return rest;
    })(),
  ];

  for (const state of variants) {
    const entry = runEntry({ state });
    let html;
    assert.doesNotThrow(() => {
      html = renderRun(entry);
    }, `renderRun must not throw for run: ${JSON.stringify(state.run)}`);
    assert.ok(!html.includes('run-steps-panel'), 'no panel may render when the document carries no run steps');
    assert.ok(!html.includes('undefined'), 'a run-less document must never print as the literal string undefined');
    assert.ok(!html.includes('NaN'), 'a run-less document must never print as the literal string NaN');
    assert.ok(html.includes(codemap), 'the codemap must still render, proving the panel alone was skipped and not the whole tail');
  }
});

test('stepView reads a step\'s label, instant and return, and never yields NaN', () => {
  const s = step();
  const view = stepView(s);
  assert.equal(view.label, s.label);
  assert.equal(view.at, s.at);
  assert.equal(view.timeMs, Date.parse(s.at));
  assert.equal(view.hasReturn, true);
  assert.ok(view.preview.length > 0, 'a step carrying a return must yield a non-empty preview');

  for (const bad of [step({ at: '' }), step({ at: 'not a date' }), step({ at: undefined })]) {
    const badView = stepView(bad);
    assert.equal(badView.timeMs, 0, `an unparseable instant must read as 0, not NaN, for at=${JSON.stringify(bad.at)}`);

    const inc = increment({ id: 'x', steps: [bad] });
    const entry = runEntry({ state: doc({ increments: [inc] }) });
    const html = renderRun(entry);
    assert.ok(html.includes(fmtAgo(0)), 'an unparseable instant must render as fmtAgo(0), which reads "never"');
    assert.ok(!html.includes('NaN'), 'an unparseable instant must never print as the literal string NaN');
  }

  for (const empty of [stepView(undefined), stepView(null)]) {
    assert.equal(empty.label, '', 'stepView(undefined/null) must still hand back an empty label, never throw');
    assert.equal(empty.timeMs, 0, 'stepView(undefined/null) must still hand back timeMs 0, never throw');
    assert.equal(empty.hasReturn, false, 'stepView(undefined/null) must still hand back hasReturn false, never throw');
  }
});

test('a return recorded as null, 0, empty string or false is a return, not a shed one', () => {
  const steps = [
    step({ label: 's-null', return: null }),
    step({ label: 's-zero', return: 0 }),
    step({ label: 's-empty', return: '' }),
    step({ label: 's-false', return: false }),
  ];
  for (const s of steps) {
    assert.equal(
      stepView(s).hasReturn,
      true,
      `a return of ${JSON.stringify(s.return)} must read as present — a truthiness check would fail this`,
    );
  }

  const inc = increment({ id: 'x', steps });
  const entry = runEntry({ state: doc({ increments: [inc] }) });
  const html = renderRun(entry);
  const returnBodies = [...html.matchAll(/<pre class="run-step-return"/g)];
  assert.equal(returnBodies.length, 4, 'all four steps must render a return body, whatever falsy value the return itself is');
  assert.ok(!html.includes(STEP_SHED_NOTE), 'the shed note must never appear when a return, however falsy, is actually present');
});

test('everything a step prints is escaped', () => {
  const hostile = step({
    label: '<script>alert(1)</script>',
    at: '2026-01-01T00:00:00.000Z" onmouseover="x',
    return: { summary: `<script>y</script> "double" 'single'` },
  });
  const inc = increment({ id: 'x', steps: [hostile] });
  const entry = runEntry({ state: doc({ increments: [inc] }) });
  const html = renderRun(entry);
  assert.ok(!html.includes('<script'), 'a raw <script must never reach the markup, from the label or the return');
  assert.ok(!html.includes('onmouseover='), 'a hostile at value must never break out of the data-at attribute');
});

test('a rendered run carries the steps of the entry it was given and of no other', () => {
  const a = runEntry({
    id: 'a',
    state: doc({
      increments: [increment({ id: 'inc-a', steps: [step({ label: 'a-inc-step' })] })],
      run: { steps: [step({ label: 'a-run-step' })] },
    }),
  });
  const b = runEntry({
    id: 'b',
    state: doc({
      increments: [increment({ id: 'inc-b', steps: [step({ label: 'b-inc-step' })] })],
      run: { steps: [step({ label: 'b-run-step' })] },
    }),
  });

  const htmlA = renderRun(a);
  assert.ok(htmlA.includes('a-inc-step') && htmlA.includes('a-run-step'), 'A\'s own steps must render');
  assert.ok(
    !htmlA.includes('b-inc-step') && !htmlA.includes('b-run-step'),
    'B\'s steps must never leak into A\'s render',
  );

  const htmlB = renderRun(b);
  assert.ok(htmlB.includes('b-inc-step') && htmlB.includes('b-run-step'), 'B\'s own steps must render');
  assert.ok(
    !htmlB.includes('a-inc-step') && !htmlB.includes('a-run-step'),
    'A\'s steps must never leak into B\'s render',
  );
});
