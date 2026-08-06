import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fmtClock,
  freshSessionView,
  pinToTimeline,
  scrubTo,
  resumeLive,
  toggleTechnicalTab,
  playheadPercent,
  paintScrubRow,
  createRefreshGate,
  scrubGrabbed,
  refreshHeldBack,
  scrubReleased,
} from '../public/timeline.js';

/** Just enough of the scrub row for paintScrubRow: three nodes behind querySelector. */
function scrubRow() {
  const nodes = {
    '.lane-playhead': { style: { left: '' } },
    '.scrub-clock': { textContent: '' },
    '.scrub-live': { attrs: {}, setAttribute(name, value) { this.attrs[name] = value; } },
  };
  return { nodes, querySelector: (selector) => nodes[selector] ?? null };
}

test('a freshly opened session lands on its timeline, live, with no technical view open', () => {
  assert.deepEqual(
    freshSessionView(),
    { timeline: null, slice: null, selectedLaneId: 'main', atMs: 0, live: true, technicalTab: null },
    'this is the whole contract selectSession and the initial state both take',
  );
});

test('a technical view opens, closes on a second click, and gives way to another', () => {
  const view = { technicalTab: null };
  toggleTechnicalTab(view, 'events');
  assert.equal(view.technicalTab, 'events', 'a first click opens the named view');
  toggleTechnicalTab(view, 'events');
  assert.equal(view.technicalTab, null, 'clicking the open tab again closes it');
  toggleTechnicalTab(view, 'traces');
  assert.equal(view.technicalTab, 'traces', 'a different tab replaces the open one directly');
});

test('a live view follows the head, and picks a lane that exists', () => {
  const timeline = { firstMs: 1000, lastMs: 3000, lanes: [{ id: 'main' }, { id: 'sub' }] };

  const defaultView = { ...freshSessionView() };
  pinToTimeline(defaultView, timeline);
  assert.equal(defaultView.selectedLaneId, 'main', 'the default selection is the main lane');
  assert.equal(defaultView.atMs, 3000, 'a live view is pinned to the newest record');

  const subView = { ...freshSessionView(), selectedLaneId: 'sub' };
  pinToTimeline(subView, timeline);
  assert.equal(subView.selectedLaneId, 'sub', 'a lane that still exists in the timeline stays selected');

  const goneView = { ...freshSessionView(), selectedLaneId: 'gone' };
  pinToTimeline(goneView, timeline);
  assert.equal(goneView.selectedLaneId, 'main', 'a lane that no longer exists falls back to the first lane');

  const noLanesView = { ...freshSessionView(), selectedLaneId: 'gone' };
  pinToTimeline(noLanesView, { firstMs: 1000, lastMs: 3000, lanes: [] });
  assert.equal(noLanesView.selectedLaneId, 'main', 'no lanes at all falls back to the literal main id');

  const noLanesFieldView = { ...freshSessionView(), selectedLaneId: 'gone' };
  assert.doesNotThrow(() => pinToTimeline(noLanesFieldView, { firstMs: 1000, lastMs: 3000 }));
  assert.equal(noLanesFieldView.selectedLaneId, 'main', 'lanes missing entirely is handled the same as lanes: []');
});

test('a scrubbed moment survives the next timeline, clamped into the recorded range', () => {
  const timeline = { firstMs: 1000, lastMs: 3000, lanes: [] };

  const withinRange = { ...freshSessionView(), live: false, atMs: 2000 };
  pinToTimeline(withinRange, timeline);
  assert.equal(withinRange.atMs, 2000, 'a moment already inside the window is left alone');

  const beforeStart = { ...freshSessionView(), live: false, atMs: 10 };
  pinToTimeline(beforeStart, timeline);
  assert.equal(beforeStart.atMs, 1000, 'a moment older than the window (aged out) clamps up to firstMs');

  const afterEnd = { ...freshSessionView(), live: false, atMs: 9999 };
  pinToTimeline(afterEnd, timeline);
  assert.equal(afterEnd.atMs, 3000, 'a moment past the window clamps down to lastMs');

  const neverScrubbed = { ...freshSessionView(), live: false, atMs: 0 };
  pinToTimeline(neverScrubbed, timeline);
  assert.equal(neverScrubbed.atMs, 3000, 'atMs 0 means no moment was ever chosen, not the epoch, so it jumps to the head');
});

test('scrubbing leaves live mode', () => {
  const view = { ...freshSessionView(), live: true, atMs: 3000 };
  scrubTo(view, '2500');
  assert.equal(view.live, false, "a scrub is the user saying 'back then' — the control has to stop claiming live");
  assert.equal(view.atMs, 2500, 'the moment scrubbed to is stored');
  assert.equal(typeof view.atMs, 'number', 'the range input hands over a string; scrubTo must convert it');
});

test('the Live control returns to live mode at the newest record', () => {
  const view = {
    ...freshSessionView(),
    live: false,
    atMs: 2000,
    timeline: { firstMs: 1000, lastMs: 3000, lanes: [] },
  };
  resumeLive(view);
  assert.equal(view.live, true, 'the Live control re-enters live mode');
  assert.equal(view.atMs, 3000, 'live mode jumps straight to the newest record');

  const noTimelineView = { ...freshSessionView(), live: false, atMs: 2000, timeline: null };
  resumeLive(noTimelineView);
  assert.equal(noTimelineView.live, true, 'live mode is entered even with no timeline to jump to');
  assert.equal(noTimelineView.atMs, 2000, 'with no timeline there is nowhere to jump, so the moment stays put');
});

test('after a scrub the row says live mode was left', () => {
  // Finding 1a: the Live control kept claiming live after a scrub because the
  // scrub handler never repainted `.scrub-live`. paintScrubRow fixes that by
  // owning the whole row, mode included.
  const view = {
    ...freshSessionView(),
    timeline: { firstMs: 1000, lastMs: 3000, lanes: [] },
    atMs: 3000,
  };
  const root = scrubRow();

  scrubTo(view, 2000);
  paintScrubRow(root, view);
  assert.equal(root.nodes['.scrub-live'].attrs['aria-pressed'], 'false', 'a scrub must turn the Live control off');
  assert.equal(root.nodes['.scrub-clock'].textContent, fmtClock(2000), 'the clock must show the scrubbed time');
  assert.equal(root.nodes['.lane-playhead'].style.left, '50.000%', 'the playhead moves to the scrubbed position');

  resumeLive(view);
  paintScrubRow(root, view);
  assert.equal(root.nodes['.scrub-live'].attrs['aria-pressed'], 'true', 'Live must turn the control back on');
  assert.equal(root.nodes['.lane-playhead'].style.left, '100.000%', 'the playhead follows the head again');
  assert.equal(root.nodes['.scrub-clock'].textContent, fmtClock(3000), 'the clock must show the head time');
});

test('a session with no axis has no playhead to move', () => {
  assert.equal(playheadPercent(null, 5), null, 'no timeline at all has no axis to scale by');
  assert.equal(
    playheadPercent({ firstMs: 7, lastMs: 7 }, 7),
    null,
    'a single-instant timeline has no span to scale by either',
  );
  assert.equal(playheadPercent({ firstMs: 1000, lastMs: 3000 }, 0), 0, 'a moment before the window clamps to 0%');
  assert.equal(
    playheadPercent({ firstMs: 1000, lastMs: 3000 }, 9999),
    100,
    'a moment past the window clamps to 100%, never off the track',
  );

  const root = scrubRow();
  const view = {
    ...freshSessionView(),
    timeline: { firstMs: 7, lastMs: 7, lanes: [] },
    atMs: 7,
  };
  paintScrubRow(root, view);
  assert.equal(
    root.nodes['.lane-playhead'].style.left,
    '',
    'a row that cannot be positioned must leave the playhead alone rather than write a bogus position',
  );
  assert.equal(root.nodes['.scrub-clock'].textContent, fmtClock(7), 'the clock is still written even without an axis');
  assert.equal(
    root.nodes['.scrub-live'].attrs['aria-pressed'],
    'true',
    'the mode control still tells the truth even without an axis',
  );
});

test('a refresh landing mid-drag is held back until the scrubber is let go', () => {
  // Finding 1b: a refresh mid-drag replaced the range input under the
  // pointer and killed the drag. The gate holds a refresh back for as long
  // as the pointer holds the scrubber.
  const gate = createRefreshGate();
  assert.equal(refreshHeldBack(gate), false, 'nothing is held back before any drag starts');

  scrubGrabbed(gate);
  assert.equal(refreshHeldBack(gate), true, 'a refresh arriving during the drag is held back');
  assert.equal(refreshHeldBack(gate), true, 'a second refresh during the same drag is held back too');
  assert.equal(scrubReleased(gate), true, 'releasing reports that a refresh was missed, so the caller can run one');
  assert.equal(refreshHeldBack(gate), false, 'after the release, refreshes run normally again');
  assert.equal(scrubReleased(gate), false, 'a second release with nothing new held back reports nothing missed');

  const quietGate = createRefreshGate();
  scrubGrabbed(quietGate);
  assert.equal(scrubReleased(quietGate), false, 'a drag during which nothing was held back reports nothing missed');

  const pendingGate = createRefreshGate();
  scrubGrabbed(pendingGate, { refreshPending: true });
  assert.equal(
    scrubReleased(pendingGate),
    true,
    'a refresh already scheduled when the pointer lands counts as held back too',
  );
});
