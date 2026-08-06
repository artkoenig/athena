import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));

/** Every file under public/, recursively. */
function walk(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, found);
    else if (entry.isFile()) found.push(full);
  }
  return found;
}

/** The source of one top-level function declaration, up to the next one. */
function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `app.js must still declare ${name}()`);
  const body = source.slice(start + 1);
  const next = body.search(/\n(?:async )?function \w+\(/);
  return next === -1 ? body : body.slice(0, next);
}

/** The body of one delegated listener on #detail, up to the next addEventListener. */
function detailListener(source, type) {
  const anchor = `document.getElementById('detail').addEventListener('${type}'`;
  const start = source.indexOf(anchor);
  assert.ok(start >= 0, `app.js must still delegate ${type} on #detail`);
  const rest = source.slice(start + anchor.length);
  const next = rest.indexOf('.addEventListener(');
  return next === -1 ? rest : rest.slice(0, next);
}

// Criterion 1 — opening a session lands on the timeline, the technical views stay
// reachable and subordinate.

test('app.js imports the timeline module, and index.html loads app.js as a module', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  assert.match(
    appJs,
    /from\s+['"]\.\/timeline\.js['"]/,
    'app.js must import timeline.js so the timeline is reached by the page, not tested as an island',
  );

  const indexHtml = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const scriptTags = indexHtml.match(/<script\b[^>]*>/gi) ?? [];
  const loadsAppAsModule = scriptTags.some(
    (tag) => /src=["']\/app\.js["']/.test(tag) && /type=["']module["']/.test(tag),
  );
  assert.ok(loadsAppAsModule, 'index.html must load /app.js as a module, so its import of timeline.js can resolve');
});

test('the page loads with no technical view open', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const start = appJs.indexOf('const state = {');
  assert.ok(start >= 0, 'app.js must still declare the state literal');
  const end = appJs.indexOf('\n};', start);
  assert.ok(end >= 0, 'the state literal must still close with `\\n};`');
  const stateSlice = appJs.slice(start, end);

  assert.match(
    stateSlice,
    /\btab:\s*null\b/,
    'the initial state must open on the timeline, with no technical view selected',
  );
  assert.doesNotMatch(
    stateSlice,
    /\btab:\s*['"]/,
    'a string default (e.g. "overview") would open a technical view on load instead of the timeline',
  );
});

test('selecting a session returns to the timeline', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const selectSession = functionSource(appJs, 'selectSession');

  assert.match(
    selectSession,
    /state\.tab\s*=\s*null/,
    'every session must open on its timeline, whatever technical view the previous session was left on',
  );
});

test('the timeline is rendered above the technical views', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const renderDetail = functionSource(appJs, 'renderDetail');

  const timelineIdx = renderDetail.indexOf('renderTimeline(');
  assert.ok(timelineIdx >= 0, 'renderDetail must call renderTimeline(...)');
  const viewsIdx = renderDetail.indexOf('renderDetailViews(');
  assert.ok(viewsIdx >= 0, 'renderDetail must call renderDetailViews(...)');
  const tabBodyIdx = renderDetail.indexOf('id="tab-body"');
  assert.ok(tabBodyIdx >= 0, 'renderDetail must render the tab-body container');

  assert.ok(
    timelineIdx < viewsIdx,
    'the timeline must be composed before the technical-views nav, so it sits above it',
  );
  assert.ok(
    viewsIdx < tabBodyIdx,
    'the technical-views nav must be composed before the tab-body container it controls',
  );
});

// Criterion 4 — the UI no longer advises a flag argus env sets by default.

const FLAGS_ARGUS_ENV_NOW_SETS = [
  'CLAUDE_CODE_ENABLE_TELEMETRY',
  'CLAUDE_CODE_ENHANCED_TELEMETRY_BETA',
  'CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH',
  'OTEL_METRICS_EXPORTER',
  'OTEL_LOGS_EXPORTER',
  'OTEL_TRACES_EXPORTER',
  'OTEL_EXPORTER_OTLP_PROTOCOL',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_LOG_USER_PROMPTS',
  'OTEL_LOG_TOOL_DETAILS',
  'OTEL_LOG_TOOL_CONTENT',
  'OTEL_LOG_RAW_API_BODIES',
  'OTEL_METRIC_EXPORT_INTERVAL',
  'OTEL_LOGS_EXPORT_INTERVAL',
  'OTEL_TRACES_EXPORT_INTERVAL',
];

test('no file under public names a flag argus env now sets by default', () => {
  const problems = [];
  for (const file of walk(PUBLIC)) {
    const source = fs.readFileSync(file, 'utf8');
    const relative = path.relative(PUBLIC, file);
    for (const flag of FLAGS_ARGUS_ENV_NOW_SETS) {
      if (source.includes(flag)) problems.push(`${relative} names ${flag}`);
    }
  }
  assert.deepEqual(problems, [], 'a reader must never be told to go and set a flag the tool already sets');
});

test('flags argus env does not set are still advised in app.js', () => {
  // Case 19's absence rule must not take collateral damage: these two names stay,
  // because argus env sets neither of them.
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  assert.match(appJs, /OTEL_RESOURCE_ATTRIBUTES/, 'the setup dialog still advises this — argus env does not set it');
  assert.match(
    appJs,
    /CLAUDE_CODE_OTEL_DIAG_STDERR/,
    'the SDK block still advises this — argus env does not set it',
  );
});

// Criterion 5 — activity and context growth on the lanes themselves.

test('the page asks the collector for the tool calls, incrementally', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const loadTimeline = functionSource(appJs, 'loadTimeline');
  assert.match(loadTimeline, /\/api\/events/, 'loadTimeline must fetch tool events from the collector');
  assert.match(loadTimeline, /TOOL_EVENT/, 'the tool-event fetch must be scoped to the tool-result event');
  assert.match(loadTimeline, /sinceSeq/, 'the tool-event fetch must be incremental, or every refresh ships megabytes');
});

test('selecting a session forgets the previous session\'s tool calls', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const selectSession = functionSource(appJs, 'selectSession');
  assert.match(
    selectSession,
    /state\.toolMarks\s*=\s*\[\]/,
    'a newly selected session must not inherit the previous session\'s tool marks',
  );
  assert.match(
    selectSession,
    /state\.toolSeq\s*=\s*0/,
    'the incremental watermark must reset too, or the new session\'s early tool calls are skipped as already seen',
  );
});

test('the timeline is composed with its density, not around it', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const renderDetail = functionSource(appJs, 'renderDetail');
  const timelineIdx = renderDetail.indexOf('renderTimeline(');
  assert.ok(timelineIdx >= 0, 'renderDetail must call renderTimeline(...)');
  const densityIdx = renderDetail.indexOf('buildDensity(');
  assert.ok(densityIdx >= 0, 'renderDetail must call buildDensity(...)');
  assert.ok(
    timelineIdx < densityIdx,
    'renderTimeline(buildDensity(...)) means the renderTimeline( call opens before the buildDensity( call',
  );
});

// Criterion 5, round 1 — a refresh answer for another session never reaches these lanes.

test('the timeline loader drops an answer that arrived after the selection moved on', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const loadTimeline = functionSource(appJs, 'loadTimeline');

  const awaitIdx = loadTimeline.indexOf('await');
  assert.ok(awaitIdx >= 0, 'loadTimeline must await its fetches');
  const guardIdx = loadTimeline.search(/state\.selectedSessionId\s*!==\s*id/);
  assert.ok(guardIdx >= 0, 'loadTimeline must guard against a stale session before writing state');
  const contentWriteIdx = loadTimeline.indexOf('state.content =');
  assert.ok(contentWriteIdx >= 0, 'loadTimeline must still write state.content');

  assert.ok(guardIdx > awaitIdx, 'the guard must come after the fetches are awaited');
  assert.ok(guardIdx < contentWriteIdx, 'the guard must come before state is written');
});

test('the timeline loader merges tool events instead of appending them blind', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const loadTimeline = functionSource(appJs, 'loadTimeline');
  assert.match(loadTimeline, /mergeToolMarks\(/, 'loadTimeline must delegate the accumulation to mergeToolMarks');
  assert.doesNotMatch(
    loadTimeline,
    /state\.toolMarks\.push\(/,
    'the de-duplicating merge must be the only way tool marks reach page state',
  );
});

test('app.js takes the merge from the timeline module', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  assert.match(
    appJs,
    /import\s*\{[^}]*\bmergeToolMarks\b[^}]*\}\s*from\s*['"]\.\/timeline\.js['"]/,
    'app.js must import mergeToolMarks from timeline.js, so the tested function is the one the page runs',
  );
});

// Criterion 6 — the timeline scrubs, and a live mode follows the head.

test('the page opens live', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const start = appJs.indexOf('const state = {');
  assert.ok(start >= 0, 'app.js must still declare the state literal');
  const end = appJs.indexOf('\n};', start);
  assert.ok(end >= 0, 'the state literal must still close with `\\n};`');
  const stateSlice = appJs.slice(start, end);

  assert.match(stateSlice, /\bcursor:\s*\{\s*live:\s*true\b/, 'a session must open with the cursor in live mode');
  assert.doesNotMatch(
    stateSlice,
    /\bcursor:\s*\{\s*live:\s*false\b/,
    'the landing state must not pin a moment before any session is even open',
  );
});

test('the timeline is rendered with the page\'s cursor', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const renderDetail = functionSource(appJs, 'renderDetail');
  const timelineIdx = renderDetail.indexOf('renderTimeline(');
  assert.ok(timelineIdx >= 0, 'renderDetail must call renderTimeline(...)');
  const cursorIdx = renderDetail.indexOf('state.cursor');
  assert.ok(cursorIdx >= 0, 'renderDetail must pass state.cursor to the renderer');
  assert.ok(
    timelineIdx < cursorIdx,
    'state.cursor must reach the renderTimeline( call, not some other call in renderDetail',
  );
});

test('selecting a session returns to live', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const selectSession = functionSource(appJs, 'selectSession');
  assert.match(
    selectSession,
    /state\.cursor\s*=\s*liveCursor\(\)/,
    'a new session must never inherit a moment pinned in another one',
  );
});

test('a drag moves the cursor without re-rendering the page under the pointer', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const scrubTo = functionSource(appJs, 'scrubTo');
  assert.match(scrubTo, /scrubCursor\(/, 'a drag must resolve to a scrubbed cursor');
  assert.match(scrubTo, /paintCursor\(/, 'a drag must paint its new position');
  assert.doesNotMatch(
    scrubTo,
    /renderDetail\(/,
    'a full re-render would replace the slider under the pointer and end the drag',
  );
});

test('the cursor is painted from one resolution, so the line and the readout cannot disagree', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const paintCursor = functionSource(appJs, 'paintCursor');
  assert.match(paintCursor, /resolveCursor\(/, 'paintCursor must resolve the cursor itself, once');
  assert.match(paintCursor, /data-cursor-pos/, 'paintCursor must write the position onto the cursor-position hooks');
});

test('a control returns the page to live', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const wireEvents = functionSource(appJs, 'wireEvents');
  assert.match(wireEvents, /data-cursor-live/, 'wireEvents must act on the live control the markup renders');
  assert.match(
    wireEvents,
    /state\.cursor\s*=\s*liveCursor\(\)/,
    'clicking the live control must write a fresh live cursor back',
  );
});

test('a refresh never yanks the slider out from under a drag', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const scheduleRefresh = functionSource(appJs, 'scheduleRefresh');
  assert.match(scheduleRefresh, /scrubbing/, 'a refresh in flight during a drag must defer rather than re-render');
});

test('app.js takes the cursor functions from the timeline module', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  for (const name of ['resolveCursor', 'scrubCursor', 'liveCursor']) {
    const re = new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*['"]\\./timeline\\.js['"]`);
    assert.match(appJs, re, `app.js must import ${name} from timeline.js, so the tested function is the one the page runs`);
  }
});

// Criterion 6, round 1 — the scrub control is wired to the scrub, and a drag is registered.

test('the scrub control\'s input reaches the scrub', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const slice = detailListener(appJs, 'input');
  assert.match(slice, /timeline-scrub/, 'the slider must route its input event to the scrub, or dragging it does nothing');
  assert.match(slice, /scrubTo\(/, 'a drag must call scrubTo with the control it came from');
  assert.ok(
    slice.indexOf('timeline-scrub') < slice.indexOf('event-search'),
    'the slider branch must come before the event-search early return, which would otherwise swallow it',
  );
});

test('a drag is registered before the next refresh can fire', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const slice = detailListener(appJs, 'pointerdown');
  assert.match(slice, /timeline-scrub/, 'a pointer press must be recognised as a drag on the scrub control specifically');
  assert.match(slice, /scrubbing\s*=\s*true/, 'a drag must set the scrubbing flag scheduleRefresh checks');
  assert.ok(
    slice.indexOf('timeline-scrub') < slice.search(/scrubbing\s*=\s*true/),
    'the flag must be set for the slider, not for every press in the detail pane',
  );
});

test('releasing the pointer lets refreshes resume', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const wireEvents = functionSource(appJs, 'wireEvents');
  assert.match(wireEvents, /pointerup/, 'a drag must end on pointerup');
  assert.match(wireEvents, /pointercancel/, 'a cancelled drag must end too, or refreshes stop forever');
  assert.match(wireEvents, /scrubbing\s*=\s*false/, 'releasing the pointer must clear the scrubbing flag');
});

// Increment 5 — selecting a lane at a time shows that agent's context as a
// message list.

test('app.js takes the context panel from its module', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  assert.match(
    appJs,
    /import\s*\{[^}]*\brenderContextPanel\b[^}]*\}\s*from\s*['"]\.\/context\.js['"]/,
    'app.js must import renderContextPanel from context.js, so the tested function is the one the page runs',
  );
});

test('the context panel has a container of its own, between the timeline and the technical views', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const renderDetail = functionSource(appJs, 'renderDetail');
  assert.ok(renderDetail.includes('id="lane-panel"'), 'renderDetail must render a container for the lane panel');
  const timelineIdx = renderDetail.indexOf('renderTimeline(');
  const panelIdx = renderDetail.indexOf('id="lane-panel"');
  const viewsIdx = renderDetail.indexOf('renderDetailViews(');
  assert.ok(timelineIdx >= 0 && timelineIdx < panelIdx, 'the lane panel must sit after the timeline');
  assert.ok(panelIdx >= 0 && panelIdx < viewsIdx, 'the lane panel must sit before the technical-views nav');
});

test('a full render repaints the panel', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const renderDetail = functionSource(appJs, 'renderDetail');
  assert.match(renderDetail, /renderLanePanel\(/, 'renderDetail must repaint the lane panel too');
});

test('the timeline is told which lane is selected', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const renderDetail = functionSource(appJs, 'renderDetail');
  const timelineIdx = renderDetail.indexOf('renderTimeline(');
  assert.ok(timelineIdx >= 0, 'renderDetail must call renderTimeline(...)');
  const selectedIdx = renderDetail.indexOf('state.selectedLane', timelineIdx);
  assert.ok(selectedIdx > timelineIdx, 'state.selectedLane must reach the renderTimeline( call, at an index after it opens');
});

test('clicking a lane selects it, and clicking it again lets go', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const clickListener = detailListener(appJs, 'click');
  assert.match(clickListener, /data-lane/, 'the click handler must recognise a lane row by its data-lane attribute');
  assert.match(
    clickListener,
    /state\.selectedLane\s*=\s*state\.selectedLane\s*===[^?]*\?\s*null\s*:/,
    'selecting the already-selected lane must let go of the selection — a toggle on the current value',
  );
});

test('selecting a lane fetches its context', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const clickListener = detailListener(appJs, 'click');
  const laneIdx = clickListener.indexOf('data-lane');
  assert.ok(laneIdx >= 0, 'the click handler must have a data-lane branch');
  const loadIdx = clickListener.indexOf('loadLaneContext(', laneIdx);
  assert.ok(loadIdx > laneIdx, 'selecting a lane must fetch its context inside that same branch');
});

test('the panel asks the collector for the nearest request at the cursor\'s moment, for that lane only', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const loadLaneContext = functionSource(appJs, 'loadLaneContext');
  assert.match(loadLaneContext, /\/api\/content\/at/, 'loadLaneContext must fetch the nearest-at-or-before content record');
  assert.match(loadLaneContext, /resolveCursor\(/, 'the moment fetched must be the cursor\'s own resolved moment');
  assert.match(loadLaneContext, /\bmain\b/, 'the main lane must be filterable');
  assert.match(loadLaneContext, /\bspan\b/, 'an agent lane must be filterable by its span');
  assert.match(loadLaneContext, /\bagent\b/, 'an agent lane must be filterable by its name as a fallback');
});

test('an answer that arrived after the selection moved on is dropped', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const loadLaneContext = functionSource(appJs, 'loadLaneContext');
  const awaitIdx = loadLaneContext.indexOf('await');
  assert.ok(awaitIdx >= 0, 'loadLaneContext must await its fetch');
  const laneGuardIdx = loadLaneContext.search(/state\.selectedLane\s*!==\s*key/);
  assert.ok(laneGuardIdx >= 0, 'loadLaneContext must guard against a stale lane selection');
  const sessionGuardIdx = loadLaneContext.search(/state\.selectedSessionId\s*!==\s*id/);
  assert.ok(sessionGuardIdx >= 0, 'loadLaneContext must guard against a stale session selection');
  const writeIdx = loadLaneContext.indexOf('state.laneContext =');
  assert.ok(writeIdx >= 0, 'loadLaneContext must still write state.laneContext');
  assert.ok(laneGuardIdx > awaitIdx && sessionGuardIdx > awaitIdx, 'both guards must come after the fetch is awaited');
  assert.ok(laneGuardIdx < writeIdx && sessionGuardIdx < writeIdx, 'both guards must come before state is written');
});

test('the panel repaints in its own container, never by re-rendering the page', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const renderLanePanel = functionSource(appJs, 'renderLanePanel');
  assert.match(renderLanePanel, /lane-panel/, 'renderLanePanel must write into the lane panel container');
  assert.match(renderLanePanel, /renderContextPanel\(/, 'renderLanePanel must delegate to renderContextPanel');
  assert.doesNotMatch(
    renderLanePanel,
    /renderDetail\(/,
    'repainting the panel must never re-render the whole page, or a scrub would replace the slider under the pointer',
  );
});

test('scrubbing moves the context with the cursor', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const scrubTo = functionSource(appJs, 'scrubTo');
  assert.match(scrubTo, /scheduleLaneContext\(/, 'a scrub must schedule a context fetch for the new moment');
  assert.doesNotMatch(
    scrubTo,
    /renderDetail\(/,
    'a full re-render would replace the slider under the pointer and end the drag',
  );
});

test('the scrub-driven fetch is debounced', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const scheduleLaneContext = functionSource(appJs, 'scheduleLaneContext');
  assert.match(scheduleLaneContext, /setTimeout/, 'a drag must not fire one request per pixel');
  assert.match(scheduleLaneContext, /clearTimeout/, 'a trailing debounce must clear the previous timer');
});

test('live mode follows new requests into the panel', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const refresh = functionSource(appJs, 'refresh');
  assert.match(refresh, /loadLaneContext\(/, 'a live refresh must refetch the panel\'s context too');
});

test('returning to live refetches the context', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const clickListener = detailListener(appJs, 'click');
  const liveIdx = clickListener.indexOf('data-cursor-live');
  assert.ok(liveIdx >= 0, 'the click handler must still act on the live control');
  const loadIdx = clickListener.indexOf('loadLaneContext(', liveIdx);
  assert.ok(loadIdx > liveIdx, 'returning to live must refetch the panel\'s context, since the moment moved');
});

test('expanding a block is remembered, so a live refresh does not collapse it', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const clickListener = detailListener(appJs, 'click');
  assert.match(
    clickListener,
    /summary\[data-block\]/,
    'the expansion toggle must be bound to a block\'s summary specifically, never to the whole block',
  );
  assert.match(clickListener, /state\.expanded/, 'the click handler must record which block was opened or closed');
  const renderLanePanel = functionSource(appJs, 'renderLanePanel');
  assert.match(
    renderLanePanel,
    /state\.expanded/,
    'renderLanePanel must pass the remembered expansion state to renderContextPanel',
  );
});

test('selecting a session forgets the lane, its context and its expansions', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const selectSession = functionSource(appJs, 'selectSession');
  assert.match(
    selectSession,
    /state\.selectedLane\s*=\s*null/,
    'a new session must not inherit the previous one\'s lane selection',
  );
  assert.match(selectSession, /state\.laneContext\s*=/, 'a new session must not inherit the previous one\'s context answer');
  assert.match(selectSession, /state\.expanded\s*=/, 'a new session must not inherit the previous one\'s expanded blocks');
});

test('the page opens with no lane selected', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const start = appJs.indexOf('const state = {');
  assert.ok(start >= 0, 'app.js must still declare the state literal');
  const end = appJs.indexOf('\n};', start);
  assert.ok(end >= 0, 'the state literal must still close with `\\n};`');
  const stateSlice = appJs.slice(start, end);
  assert.match(stateSlice, /\bselectedLane:\s*null\b/, 'a freshly opened session must select no lane');
});
