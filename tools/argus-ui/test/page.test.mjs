import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const TEST_DIR = fileURLToPath(new URL('./', import.meta.url));

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

/** The argument text of one call, from its `(` to the parenthesis that closes it. */
function callArguments(source, name) {
  const open = source.indexOf(`${name}(`);
  assert.ok(open >= 0, `the source must still call ${name}()`);
  let depth = 0;
  for (let i = open + name.length; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1;
    else if (source[i] === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(open + name.length + 1, i);
    }
  }
  return assert.fail(`the ${name}( call must be closed by a matching )`);
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
  for (const name of ['renderContextPanel', 'fetchLaneContext', 'lanePanelInput']) {
    const re = new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*['"]\\./context\\.js['"]`);
    assert.match(appJs, re, `app.js must import ${name} from context.js, so the tested function is the one the page runs`);
  }
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

test('selecting a lane repaints the panel once its own fetch resolves, without waiting for an ingest', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const clickListener = detailListener(appJs, 'click');
  const laneIdx = clickListener.indexOf('data-lane');
  const loadIdx = clickListener.indexOf('loadLaneContext(', laneIdx);
  const endIdx = clickListener.indexOf(';', loadIdx);
  const slice = clickListener.slice(loadIdx, endIdx);
  assert.ok(laneIdx >= 0);
  assert.ok(loadIdx > laneIdx, 'the lane branch must fetch the context it is about to show');
  assert.ok(endIdx > loadIdx);
  assert.match(
    slice,
    /\.then\(\s*(?:renderLanePanel\b|\(\s*\)\s*=>\s*renderLanePanel\s*\()/,
    'the fetch the click started must repaint the panel when it resolves — a finished session receives no further ingest, so nothing else ever repaints it and the panel keeps its pending line forever',
  );
});

test('the panel asks the collector for the nearest request at the cursor\'s moment, for that lane only', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const loadLaneContext = functionSource(appJs, 'loadLaneContext');
  const callIdx = loadLaneContext.indexOf('fetchLaneContext(');
  assert.ok(callIdx >= 0, 'loadLaneContext must call fetchLaneContext');
  const endIdx = loadLaneContext.indexOf(';', callIdx);
  assert.ok(endIdx >= 0, 'the fetchLaneContext( call must end with a statement-terminating ;');
  const slice = loadLaneContext.slice(callIdx, endIdx);
  assert.match(slice, /\bapi\b/, 'loadLaneContext must hand its own api function to fetchLaneContext');
  assert.match(slice, /session:\s*id\b/, 'the page\'s own session id must reach the function whose request is pinned by value');
  assert.match(slice, /\bkey\b/, 'the selected lane\'s key must reach fetchLaneContext');
  assert.match(slice, /view:\s*laneView\(\)/, 'the page\'s own lane view must reach fetchLaneContext');
  assert.match(slice, /cursor:\s*state\.cursor\b/, 'the page\'s own cursor must reach fetchLaneContext');
});

test('the fetched context is what the panel state holds', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const loadLaneContext = functionSource(appJs, 'loadLaneContext');
  const nameMatch = loadLaneContext.match(/const\s+(\w+)\s*=\s*await\s+fetchLaneContext\(/);
  assert.ok(nameMatch, 'loadLaneContext must await fetchLaneContext into a variable it names');
  const writeIdx = loadLaneContext.indexOf('state.laneContext =');
  assert.ok(writeIdx >= 0, 'loadLaneContext must still write state.laneContext');
  const endIdx = loadLaneContext.indexOf(';', writeIdx);
  assert.ok(endIdx >= 0, 'the state.laneContext = assignment must end with a statement-terminating ;');
  const slice = loadLaneContext.slice(writeIdx, endIdx);
  assert.match(
    slice,
    new RegExp('state\\.laneContext\\s*=\\s*' + nameMatch[1] + '\\b'),
    'state.laneContext must be written from the value fetchLaneContext returned — a literal written there instead shows a different context than the one fetched',
  );
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

test('the panel is drawn from the lane the reader selected and the answer held for it', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const renderLanePanel = functionSource(appJs, 'renderLanePanel');
  const slice = callArguments(renderLanePanel, 'renderContextPanel');
  assert.match(slice, /lanePanelInput\(/, 'the panel\'s whole input must come from lanePanelInput');
  assert.match(
    renderLanePanel,
    /const view = laneView\(\);/,
    'the page must build its lane view once before handing it to the panel',
  );
  assert.match(slice, /\bview,/, 'the page\'s own lane view must reach the panel');
  assert.match(
    slice,
    /key:\s*state\.selectedLane\b/,
    'without it the panel paints empty for every lane',
  );
  assert.match(slice, /held:\s*state\.laneContext\b/, 'the answer held for the selection must reach the panel');
  assert.match(slice, /expanded:\s*state\.expanded\b/, 'the remembered expansion state must still reach the panel');
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

// Increment 3 — the tools box goes, its tick marks stay: renderLanePanel()
// paints only the context panel, and tools.js and its test are gone.

test('the tool panel is gone from the page, module and all', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  assert.ok(!fs.existsSync(path.join(PUBLIC, 'tools.js')), 'public/tools.js must be deleted, not merely unused');
  assert.ok(
    !fs.existsSync(path.join(TEST_DIR, 'tools.test.mjs')),
    'test/tools.test.mjs must be deleted along with the module it tested',
  );
  assert.doesNotMatch(
    appJs,
    /from\s*['"]\.\/tools\.js['"]/,
    'app.js must import nothing from tools.js — the module no longer exists',
  );
  assert.doesNotMatch(appJs, /\blaneToolInput\b/, 'app.js must name laneToolInput nowhere, imported or otherwise');
  assert.doesNotMatch(appJs, /\brenderToolPanel\b/, 'app.js must name renderToolPanel nowhere, imported or otherwise');
});

test('the markup the context panel renders is the whole of what reaches the container', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const renderLanePanel = functionSource(appJs, 'renderLanePanel');
  assert.match(
    renderLanePanel,
    /container\.innerHTML\s*=\s*renderContextPanel\(/,
    'a panel computed and then thrown away paints an empty box for every lane',
  );
  assert.deepEqual(
    renderLanePanel.match(/render(?:Context|Tool)Panel\(/g),
    ['renderContextPanel('],
    'renderLanePanel must paint the context panel and only the context panel — a tool panel concatenated back on must fail this',
  );
});

// Increment 1 — the block filter's wiring: the click paints the panel again,
// and never fetches.

test('the block filter\'s selection is page-wide state that starts empty, and is never persisted', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const start = appJs.indexOf('const state = {');
  assert.ok(start >= 0, 'app.js must still declare the state literal');
  const end = appJs.indexOf('\n};', start);
  assert.ok(end >= 0, 'the state literal must still close with `\\n};`');
  const stateSlice = appJs.slice(start, end);

  assert.match(
    stateSlice,
    /\bcontextHidden:\s*new Set\(\)/,
    'the hidden set must start empty, or a page load would open with something already hidden',
  );
  assert.match(stateSlice, /\bcontextFilterOpen:\s*false\b/, 'the dropdown must start closed');
  assert.doesNotMatch(
    appJs,
    /localStorage/,
    'the filter is not persisted — a page reload must start with everything visible, which localStorage would defeat',
  );
});

test('the derivation the filter uses comes from the pure module', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  for (const name of ['contextEntryIds', 'hiddenAfterAll']) {
    const re = new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*['"]\\./context\\.js['"]`);
    assert.match(appJs, re, `app.js must import ${name} from context.js, so the tested function is the one the page runs`);
  }
});

test('the panel is drawn with the hidden set and the open flag', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const renderLanePanel = functionSource(appJs, 'renderLanePanel');
  const slice = callArguments(renderLanePanel, 'renderContextPanel');
  assert.match(slice, /hidden:\s*state\.contextHidden\b/, 'without it the panel filters nothing, whatever the reader unchecked');
  assert.match(
    slice,
    /filterOpen:\s*state\.contextFilterOpen\b/,
    'without it a live refresh would always render the dropdown closed',
  );
});

test('unchecking an entry repaints and fetches nothing', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const change = detailListener(appJs, 'change');
  assert.match(change, /input\[data-ctx-entry\]/, 'the change handler must catch a filter checkbox being toggled');
  assert.match(change, /state\.contextHidden/, 'the toggle must update the page-wide hidden set');
  assert.match(change, /renderLanePanel\(/, 'the panel must repaint so the list reflects the new selection');
  assert.doesNotMatch(
    change,
    /loadLaneContext\(/,
    'the filter acts on the record already held — unchecking an entry must never fetch',
  );
  assert.doesNotMatch(change, /scheduleLaneContext\(/, 'unchecking an entry must never schedule a fetch either');
  assert.doesNotMatch(change, /\bapi\(/, 'unchecking an entry must never call the api function directly');
});

test('all on and all off go through the pure helper against the held record, and fetch nothing', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const click = detailListener(appJs, 'click');
  const allIdx = click.indexOf('data-ctx-all');
  assert.ok(allIdx >= 0, 'the click handler must catch the all on / all off buttons');
  const tail = click.slice(allIdx);

  assert.match(tail, /hiddenAfterAll\(/, 'the branch must delegate the union/clear logic to the pure helper');
  assert.match(tail, /contextEntryIds\(/, 'the branch must derive the current request\'s own ids, not a fixed list');
  assert.match(
    tail,
    /state\.laneContext\.item/,
    'the ids must be derived from the record the panel already holds, not a fresh fetch',
  );
  assert.match(tail, /renderLanePanel\(/, 'the panel must repaint so the list reflects the new selection');
  assert.doesNotMatch(tail, /loadLaneContext\(/, 'all on / all off must never fetch — the branch after data-lane already fetches, this one must not');
  assert.doesNotMatch(tail, /scheduleLaneContext\(/, 'all on / all off must never schedule a fetch either');
});

test('an open dropdown survives a repaint', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const click = detailListener(appJs, 'click');
  assert.match(
    click,
    /summary\[data-ctx-filter\]/,
    'the click handler must catch the dropdown\'s own summary being clicked',
  );
  assert.match(
    click,
    /state\.contextFilterOpen\s*=\s*!\s*state\.contextFilterOpen/,
    'the open state must be remembered and toggled, the same way state.expanded remembers an opened block',
  );
  const renderLanePanel = functionSource(appJs, 'renderLanePanel');
  assert.match(
    renderLanePanel,
    /state\.contextFilterOpen/,
    'renderLanePanel must pass the remembered open state back in, or a live refresh snaps the dropdown shut',
  );
});

test('the selection survives a lane change and a session change', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const selectSession = functionSource(appJs, 'selectSession');
  assert.doesNotMatch(
    selectSession,
    /contextHidden/,
    'a new session must inherit the reader\'s filter, unlike its lane and expansions',
  );
  assert.doesNotMatch(
    selectSession,
    /contextFilterOpen/,
    'a new session must inherit the reader\'s filter, unlike its lane and expansions',
  );

  const click = detailListener(appJs, 'click');
  assert.doesNotMatch(
    click,
    /state\.contextHidden\s*=\s*new Set\(\)/,
    'the lane-change branch resets state.expanded and must leave the filter selection alone',
  );
});
