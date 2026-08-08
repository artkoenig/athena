import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const TEST_DIR = fileURLToPath(new URL('./', import.meta.url));
const PROJECT = fileURLToPath(new URL('../', import.meta.url));

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

test('the context panel has a container of its own, below the timeline', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const renderDetail = functionSource(appJs, 'renderDetail');
  assert.ok(renderDetail.includes('id="lane-panel"'), 'renderDetail must render a container for the lane panel');
  const timelineIdx = renderDetail.indexOf('renderTimeline(');
  const panelIdx = renderDetail.indexOf('id="lane-panel"');
  assert.ok(timelineIdx >= 0 && timelineIdx < panelIdx, 'the lane panel must sit after the timeline');
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

// Increment 4 — the six technical tabs go out of the code.

// Criterion 1 — DETAIL_VIEWS and renderDetailViews are gone, and no tab nav is
// rendered anywhere. (the timeline module's own half of this is in timeline.test.mjs)

test('no file under public renders a tab nav', () => {
  const needles = ['data-tab', 'role="tablist"', 'tab-body', 'class="tabs"', 'aria-label="Technical views"'];
  const problems = [];
  for (const file of walk(PUBLIC)) {
    const source = fs.readFileSync(file, 'utf8');
    const relative = path.relative(PUBLIC, file);
    for (const needle of needles) {
      if (source.includes(needle)) problems.push(`${relative} names ${needle}`);
    }
  }
  assert.deepEqual(problems, [], 'no file under public/ may render, style or wire a tab nav that no longer exists');
});

// Criterion 2 — the renderers, helpers, container and state fields are gone
// from app.js.

test('app.js declares none of the tab renderers', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const names = [
    'renderTabBody',
    'renderOverviewTab',
    'renderTodosTab',
    'renderTracesTab',
    'renderWaterfall',
    'renderSpanInspector',
    'renderEventsTab',
    'renderMetricsTab',
    'renderRawTab',
    'loadTabData',
    'kpi',
    'formatValue',
    'spanKind',
    'spanNote',
    'todoStatusChip',
  ];
  const problems = [];
  for (const name of names) {
    if (appJs.includes(`function ${name}(`) || appJs.includes(`async function ${name}(`)) {
      problems.push(`app.js still declares ${name}()`);
    }
  }
  if (/\bSPAN_KINDS\b/.test(appJs)) problems.push('app.js still names SPAN_KINDS');
  assert.deepEqual(problems, [], 'a renderer or helper only the removed tabs used must go with them');
});

test('the page state carries no tab, trace, event or metric field', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const start = appJs.indexOf('const state = {');
  assert.ok(start >= 0, 'app.js must still declare the state literal');
  const end = appJs.indexOf('\n};', start);
  assert.ok(end >= 0, 'the state literal must still close with `\\n};`');
  const stateSlice = appJs.slice(start, end);

  const literalFields = [
    /\btab:/,
    /\btrace:/,
    /\bselectedTraceId:/,
    /\bselectedSpanId:/,
    /\bevents:/,
    /\beventFilters:/,
    /\bmetrics:/,
    /\bfacets:/,
  ];
  for (const re of literalFields) {
    assert.doesNotMatch(stateSlice, re, `the state literal must carry no field matching ${re} — the tabs took it with them`);
  }

  // The whole-file half is what catches a field taken out of the literal but
  // still written to somewhere else — a leak the literal alone cannot see.
  const wholeFileFields = [
    /\bstate\.tab\b/,
    /\bstate\.trace\b/,
    /\bstate\.selectedTraceId\b/,
    /\bstate\.selectedSpanId\b/,
    /\bstate\.events\b/,
    /\bstate\.eventFilters\b/,
    /\bstate\.metrics\b/,
    /\bstate\.facets\b/,
  ];
  for (const re of wholeFileFields) {
    assert.doesNotMatch(appJs, re, `app.js must read or write no field matching ${re} anywhere, not merely in the literal`);
  }

  // The deletion must not take the context filter's own state with it.
  assert.match(stateSlice, /\bcontextHidden:\s*new Set\(\)/, 'the context filter\'s hidden set must survive the deletion');
  assert.match(stateSlice, /\bcontextFilterOpen:\s*false\b/, 'the context filter\'s open flag must survive the deletion');
});

// Criterion 3 — the wiring is gone, and the interval no longer repaints a tab
// body.

test('the click handler acts on no tab, trace, span or event row', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const slice = detailListener(appJs, 'click');
  for (const re of [/data-tab/, /data-trace/, /data-span/, /data-event-seq/, /data-detail-seq/]) {
    assert.doesNotMatch(slice, re, `the click handler must act on no ${re} branch the removed tabs left behind`);
  }
  assert.match(slice, /data-lane/, 'the lane-selection branch must survive the removal, not be taken out with it');
  assert.match(slice, /data-ctx-all/, 'the context filter\'s all on / all off branch must survive the removal');
  assert.match(
    slice,
    /summary\[data-ctx-filter\]/,
    'the context filter\'s dropdown-toggle branch must survive the removal',
  );
});

test('the change handler is the filter\'s alone', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const slice = detailListener(appJs, 'change');
  assert.doesNotMatch(slice, /event-filter/, 'the removed events tab\'s event-name filter must go from the change handler');
  assert.doesNotMatch(slice, /event-errors/, 'the removed events tab\'s errors-only toggle must go from the change handler');
  assert.match(slice, /input\[data-ctx-entry\]/, 'the context filter\'s checkbox branch must survive the removal');
  assert.match(slice, /renderLanePanel\(/, 'the context filter\'s repaint must survive the removal');
});

test('the input handler is the scrub\'s alone', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const slice = detailListener(appJs, 'input');
  assert.doesNotMatch(slice, /event-search/, 'the removed events tab\'s search box must go from the input handler');
  assert.doesNotMatch(slice, /searchTimer/, 'the debounce timer only the events search used must go with it');
  assert.match(slice, /timeline-scrub/, 'the scrub branch must survive the removal');
  assert.match(slice, /scrubTo\(/, 'the scrub branch must survive the removal');
});

test('the slow interval repaints the session list and nothing else', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const boot = functionSource(appJs, 'boot');
  assert.match(boot, /setInterval\(/, 'boot must still schedule the slow repaint');
  assert.match(boot, /renderSessionList\(\)/, 'the slow repaint must still refresh the session list');
  assert.doesNotMatch(boot, /renderTabBody/, 'the slow interval must no longer repaint a tab body that no longer exists');
  assert.doesNotMatch(boot, /state\.tab/, 'the slow interval must no longer branch on a tab that no longer exists');
});

// Criterion 4 — no counts object, and no refresh asks for traces, facets or
// metrics.

test('renderDetail builds no counts object', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const renderDetail = functionSource(appJs, 'renderDetail');
  assert.doesNotMatch(
    renderDetail,
    /\bconst\s+counts\b/,
    'renderDetail must no longer build the counts object only the removed tab nav read',
  );
  assert.match(renderDetail, /renderTimeline\(/, 'renderDetail must still compose the timeline');
  assert.match(renderDetail, /id="lane-panel"/, 'renderDetail must still render the lane panel container');
  assert.match(renderDetail, /renderLanePanel\(/, 'renderDetail must still repaint the lane panel');
});

test('no refresh asks the collector for traces, facets or metrics', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  assert.doesNotMatch(appJs, /\/api\/traces/, 'no refresh may ask the collector for traces any more');
  assert.doesNotMatch(appJs, /\/api\/facets/, 'no refresh may ask the collector for facets any more');
  assert.doesNotMatch(appJs, /\/api\/metrics/, 'no refresh may ask the collector for metrics any more');
});

// Criterion 5 — no unused import and no dead helper is left behind.

test('every name a module under public imports is used below the import', () => {
  const problems = [];
  for (const name of ['app.js', 'timeline.js', 'context.js']) {
    const source = fs.readFileSync(path.join(PUBLIC, name), 'utf8');
    const importStatements = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]+['"];/g)];
    for (const statement of importStatements) {
      const names = statement[1]
        .split(',')
        .map((piece) => piece.trim())
        .filter(Boolean)
        .map((piece) => piece.split(/\s+as\s+/)[0].trim());
      for (const imported of names) {
        const count = (source.match(new RegExp(`\\b${imported}\\b`, 'g')) ?? []).length;
        if (count < 2) problems.push(`${name} imports ${imported} but nothing below the import uses it`);
      }
    }
  }
  assert.deepEqual(problems, [], 'an import used nowhere below it is the ballast the deletion must take with it');
});

test('every function app.js declares is called somewhere in it', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const names = [...appJs.matchAll(/^(?:async )?function (\w+)\(/gm)].map((match) => match[1]);
  const problems = [];
  for (const name of names) {
    const count = (appJs.match(new RegExp(`\\b${name}\\b`, 'g')) ?? []).length;
    if (count < 2) problems.push(`${name}() is declared but called nowhere`);
  }
  assert.deepEqual(problems, [], 'a function whose only caller left with the tabs is dead weight the deletion must take too');
});

// Criterion 6 — the stylesheet keeps no rule only a removed view could
// produce.

test('the stylesheet has no rule for the removed views', () => {
  const css = fs.readFileSync(path.join(PUBLIC, 'styles.css'), 'utf8');
  const removed = [
    /^\.tabs\b/m,
    /^\.tab\b/m,
    /\.tab .count/,
    /\bkpi/,
    /\.table-scroll/,
    /^table\s*\{/m,
    /^th\s*\{/m,
    /^td\s*\{/m,
    /^tbody\b/m,
    /\.panel > h3/,
    /\.trace-pill/,
    /\.trace-picker/,
    /\.waterfall/,
    /\.axis-tick/,
    /\.span-row/,
    /\.span-bar/,
    /\.span-label/,
    /\.span-track/,
    /\.span-duration/,
    /\.span-inspector/,
    /\.detail-note/,
    /\.filters/,
    /\.event-row/,
    /\.event-time/,
    /\.event-name/,
    /\.event-summary/,
    /\.attr-table/,
    /data-tone="ok"/,
    /data-tone="warn"/,
    /\.mono\b/,
    /\.bad\b/,
    /\.good\b/,
  ];
  const problems = [];
  for (const re of removed) {
    if (re.test(css)) problems.push(`styles.css still matches ${re}`);
  }
  assert.deepEqual(problems, [], 'no rule a removed view alone could produce may survive its deletion');

  for (const needle of ['.panel {', '.timeline', '.lane', '.ctx-filter', '.ctx-block']) {
    assert.ok(css.includes(needle), `styles.css must still carry ${needle} — the deletion must not overshoot into what stays`);
  }
  assert.match(css, /\.chip\[data-tone="live"\]/, 'the live chip rule must survive the deletion — it is not a removed view');
  assert.match(css, /\.chip\[data-tone="error"\]/, 'the error chip rule must survive the deletion — it is not a removed view');
});

test('no class the stylesheet styles is one no source can emit', () => {
  const css = fs.readFileSync(path.join(PUBLIC, 'styles.css'), 'utf8');
  const cssClasses = new Set([...css.matchAll(/\.([A-Za-z][\w-]*)/g)].map((match) => match[1]));

  const emitted = new Set();
  for (const file of walk(PUBLIC)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/class="([^"]*)"/g)) {
      for (const token of match[1].split(/\s+/)) if (token) emitted.add(token);
    }
    // A class emitted through a ternary — `${cond ? 'a' : 'b'}` — never sits
    // inside a class="…" attribute in the source text, so a bare quoted string
    // literal counts too. The two quote kinds are matched separately: a combined
    // alternation lets an outer `"…"` (the class attribute wrapping the ternary)
    // swallow the single-quoted literals inside it before they can be seen.
    for (const match of source.matchAll(/'([^']*)'/g)) {
      if (/^[A-Za-z][\w-]*$/.test(match[1])) emitted.add(match[1]);
    }
    for (const match of source.matchAll(/"([^"]*)"/g)) {
      if (/^[A-Za-z][\w-]*$/.test(match[1])) emitted.add(match[1]);
    }
  }

  const problems = [...cssClasses]
    .filter((cls) => !emitted.has(cls))
    .map((cls) => `styles.css styles .${cls}, which no source under public/ can emit`);
  assert.deepEqual(problems, [], 'a selector no renderer can ever emit is dead weight the deletion must take with it');
});

// Criterion 7 — the documentation stops promising the removed views.

test('no page under tools/argus-ui promises a removed view', () => {
  const files = fs
    .readdirSync(PROJECT, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name);
  const patterns = [
    /- \*\*Overview\*\*/,
    /- \*\*Tasks\*\*/,
    /- \*\*Traces\*\*/,
    /- \*\*Events\*\*/,
    /- \*\*Metrics\*\*/,
    /- \*\*Attributes\*\*/,
    /\btabs?\b/i,
    /the views below it/,
  ];
  const problems = [];
  for (const name of files) {
    const raw = fs.readFileSync(path.join(PROJECT, name), 'utf8');
    // Normalised so a reworded but still-promising sentence cannot slip past
    // this guard by being wrapped onto a different line than the pattern
    // expects. This is a hardening, not a new red: every pattern below was
    // checked against tools/argus-ui/README.md and tools/argus-ui/CLAUDE.md
    // as they stand, normalised or not, and none of them matches either file
    // — this test was green before this change and stays green after it.
    const source = raw.replace(/\s+/g, ' ');
    for (const pattern of patterns) {
      if (pattern.test(source)) problems.push(`${name} matches ${pattern}`);
    }
  }
  assert.deepEqual(
    problems,
    [],
    'no page under tools/argus-ui may still promise a technical view the deletion removed, or call the timeline a tab',
  );
});

// Criterion 8 — the listeners the rest of the page needs survive the removal.

test('a live refresh still repaints the timeline and the lane panel, dropdown left open', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const refresh = functionSource(appJs, 'refresh');
  assert.match(refresh, /renderDetail\(\)/, 'a live refresh must still repaint the whole detail pane');

  const renderDetail = functionSource(appJs, 'renderDetail');
  assert.match(renderDetail, /renderTimeline\(/, 'renderDetail must still compose the timeline');
  assert.match(renderDetail, /renderLanePanel\(/, 'renderDetail must still repaint the lane panel');

  const renderLanePanel = functionSource(appJs, 'renderLanePanel');
  assert.match(
    renderLanePanel,
    /filterOpen:\s*state\.contextFilterOpen\b/,
    'renderLanePanel must still pass the remembered open state, or a live refresh would snap the dropdown shut',
  );
});

// Increment ui — the run view beside the session view.

// Criterion 1 and 5 — the shell exists beside the session view's, which is untouched.

test('index.html carries the run view\'s shell, beside the session view\'s, which stays', () => {
  const indexHtml = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  for (const needle of [
    'id="run-sidebar"',
    'id="run-list"',
    'id="run-count"',
    'id="run-detail"',
    'data-view="sessions"',
    'data-view="runs"',
  ]) {
    assert.ok(indexHtml.includes(needle), `index.html must carry ${needle}`);
  }
  assert.match(indexHtml, /<body[^>]*data-view=/, 'the body must carry the data-view flag the stylesheet switches on');

  for (const needle of ['id="session-list"', 'id="session-count"', 'id="detail"', 'id="session-search"', 'id="setup-modal"']) {
    assert.ok(indexHtml.includes(needle), `the new shell must not arrive by displacing the existing one: ${needle}`);
  }
});

test('app.js imports the run module, and index.html still loads app.js as a module', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  assert.match(
    appJs,
    /from\s+['"]\.\/run\.js['"]/,
    'app.js must import run.js so the run view is reached by the page, not tested as an island',
  );

  const indexHtml = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const scriptTags = indexHtml.match(/<script\b[^>]*>/gi) ?? [];
  const loadsAppAsModule = scriptTags.some(
    (tag) => /src=["']\/app\.js["']/.test(tag) && /type=["']module["']/.test(tag),
  );
  assert.ok(loadsAppAsModule, 'index.html must still load /app.js as a module');
});

// Criterion 3 — the data comes from the run endpoints and nowhere else.

test('the run loaders ask the collector\'s run endpoints, and nowhere else', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const loadRuns = functionSource(appJs, 'loadRuns');
  assert.match(loadRuns, /\/api\/runs\b/, 'loadRuns must ask the collector\'s run-list endpoint');

  const loadRun = functionSource(appJs, 'loadRun');
  assert.match(loadRun, /\/api\/runs\//, 'loadRun must ask the one-run endpoint');
  assert.match(loadRun, /encodeURIComponent\(/, 'the selected run\'s id must be encoded into the path');

  for (const [name, source] of [['loadRuns', loadRuns], ['loadRun', loadRun]]) {
    assert.doesNotMatch(source, /\bfetch\(/, `${name} must go through the page's own api() helper, never a bare fetch — this is how "from no other source" is provable as text`);
    assert.match(source, /\bapi\(/, `${name} must call the page's own api() helper`);
  }
});

test('the state literal carries the run view\'s own fields', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const start = appJs.indexOf('const state = {');
  assert.ok(start >= 0, 'app.js must still declare the state literal');
  const end = appJs.indexOf('\n};', start);
  assert.ok(end >= 0, 'the state literal must still close with `\\n};`');
  const stateSlice = appJs.slice(start, end);

  assert.match(stateSlice, /\bruns:\s*\[\]/, 'the page must hold the runs list it fetched');
  assert.match(stateSlice, /\bselectedRunId:\s*null\b/, 'no run is selected until one is picked or the collector answers');
  assert.match(stateSlice, /\brun:\s*null\b/, 'no run state is held until it is fetched');
  assert.match(stateSlice, /\bview:\s*['"]sessions['"]/, 'the page must open on the session view');
});

test('pickRunId decides what is shown, from the page\'s own runs and selection', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const loadRuns = functionSource(appJs, 'loadRuns');
  const slice = callArguments(loadRuns, 'pickRunId');
  assert.match(slice, /state\.runs\b/, 'pickRunId must be handed the page\'s own list of runs');
  assert.match(slice, /state\.selectedRunId\b/, 'pickRunId must be handed the page\'s own current selection');
});

test('clicking a run in the picker switches to it', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const anchor = "document.getElementById('run-list').addEventListener('click'";
  const start = appJs.indexOf(anchor);
  assert.ok(start >= 0, 'app.js must delegate a click listener on #run-list');
  const rest = appJs.slice(start + anchor.length);
  const next = rest.indexOf('.addEventListener(');
  const slice = next === -1 ? rest : rest.slice(0, next);
  assert.match(slice, /\[data-run\]/, 'the run-list click handler must recognise a run row by its data-run attribute');
  assert.match(slice, /selectRun\(/, 'clicking a run row must select it');
});

test('the page fetches and paints run state as it opens', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const start = functionSource(appJs, 'start');
  assert.match(start, /refreshRuns\(/, 'start() must fetch and paint the run view as the page opens, or it would not open on the latest run');
  assert.match(
    appJs,
    /^start\(\);\s*$/m,
    'start() must actually be invoked at load, not merely declared, or nothing runs it',
  );
});

test('switching to a run fetches that run\'s state and repaints the picker and the pane', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const selectRun = functionSource(appJs, 'selectRun');
  assert.match(selectRun, /state\.selectedRunId\s*=/, 'selectRun must record which run is now selected');
  assert.match(selectRun, /loadRun\(/, 'selectRun must fetch the newly chosen run\'s state');
  assert.match(selectRun, /renderRunPicker\(/, 'selectRun must repaint the picker so it marks the new current row');
  assert.match(selectRun, /renderRunView\(/, 'selectRun must repaint the pane with the newly chosen run\'s state');
});

test('the view switch is wired to setView, which writes both the state and the body flag', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const wireEvents = functionSource(appJs, 'wireEvents');
  const viewIdx = wireEvents.indexOf('data-view');
  assert.ok(viewIdx >= 0, 'wireEvents must wire a listener on [data-view]');
  const setViewIdx = wireEvents.indexOf('setView(', viewIdx);
  assert.ok(setViewIdx > viewIdx, 'the [data-view] branch must call setView(...)');

  const setView = functionSource(appJs, 'setView');
  assert.match(setView, /state\.view\s*=/, 'setView must write the page\'s own view state');
  assert.match(
    setView,
    /document\.body\.dataset\.view\s*=/,
    'setView must write the body\'s data-view flag the stylesheet switches on',
  );
});

// Criterion 4 — live, and not by polling.

test('connectStream reacts to the run frame, and the existing listeners stay', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const connectStream = functionSource(appJs, 'connectStream');
  assert.match(connectStream, /addEventListener\(\s*['"]hello['"]/, 'the hello listener must still be there');
  assert.match(connectStream, /addEventListener\(\s*['"]ingest['"]/, 'the ingest listener must still be there');

  const runIdx = connectStream.search(/addEventListener\(\s*['"]run['"]/);
  assert.ok(runIdx >= 0, 'connectStream must register a run listener');
  const runListenerTail = connectStream.slice(runIdx);
  const endIdx = runListenerTail.indexOf(');\n');
  const runListener = endIdx === -1 ? runListenerTail : runListenerTail.slice(0, endIdx);
  assert.match(runListener, /runFrame\(/, 'the run listener must parse the frame with runFrame');
  assert.match(runListener, /refreshRuns\(/, 'the run listener must refresh the run view');
});

test('refreshRuns loads the runs, the shown run\'s state, and repaints both halves of the view', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const refreshRuns = functionSource(appJs, 'refreshRuns');
  assert.match(refreshRuns, /loadRuns\(/, 'without loadRuns the picker never learns which runs exist');
  assert.match(refreshRuns, /loadRun\(/, 'without loadRun the pane never gets the shown run\'s state');
  assert.match(refreshRuns, /renderRunPicker\(/, 'without renderRunPicker a run frame changes nothing in the picker');
  assert.match(refreshRuns, /renderRunView\(/, 'without renderRunView a run frame changes nothing in the pane');
});

test('no timer fetches run state', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const refresh = functionSource(appJs, 'refresh');
  assert.doesNotMatch(refresh, /loadRuns\(/, 'the ingest-driven refresh must never touch loadRuns');
  assert.doesNotMatch(refresh, /loadRun\(/, 'the ingest-driven refresh must never touch loadRun');
  assert.doesNotMatch(refresh, /refreshRuns\(/, 'the ingest-driven refresh must never touch refreshRuns');

  const boot = functionSource(appJs, 'boot');
  assert.match(boot, /setInterval\(/, 'boot must still schedule the slow repaint');
  assert.match(boot, /renderSessionList\(\)/, 'the slow repaint must still refresh the session list');
  for (const name of ['loadRuns', 'loadRun', 'refreshRuns']) {
    assert.doesNotMatch(boot, new RegExp(`${name}\\(`), `boot's own setInterval body must name no run function: ${name}`);
  }

  for (const match of appJs.matchAll(/setInterval\(([\s\S]*?)\n\s*\},/g)) {
    const body = match[1];
    for (const name of ['loadRuns', 'loadRun', 'refreshRuns']) {
      assert.doesNotMatch(body, new RegExp(`${name}\\(`), `no setInterval anywhere in app.js may name a run loader: ${name}`);
    }
  }
});

// Criterion 5 — the session view keeps working: the run view paints only in
// its own containers.

test('the run view paints only in its own containers, and renderDetail is untouched by it', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const renderRunPicker = functionSource(appJs, 'renderRunPicker');
  assert.match(renderRunPicker, /run-list/, 'renderRunPicker must paint the run list container');
  assert.match(renderRunPicker, /run-count/, 'renderRunPicker must paint the run count');

  const renderRunView = functionSource(appJs, 'renderRunView');
  assert.match(renderRunView, /run-detail/, 'renderRunView must paint the run detail container');

  const renderDetail = functionSource(appJs, 'renderDetail');
  for (const needle of ['run-list', 'run-count', 'run-detail']) {
    assert.doesNotMatch(
      renderDetail,
      new RegExp(needle),
      `renderDetail must name none of the run view's own containers: ${needle} — the session view stays untouched`,
    );
  }
});

// Criterion 7 — the documentation.

test('README.md describes the run view: the runs list, the increments with status, and the codemap', () => {
  const readme = fs.readFileSync(path.join(PROJECT, 'README.md'), 'utf8');
  assert.match(readme, /\brun/i, 'README must describe the run view at all');
  assert.match(readme, /increment/i, 'README must name the increments the run view shows');
  assert.match(readme, /status/i, 'README must say the increments show their status');
  assert.match(readme, /codemap/i, 'README must name the codemap the run view shows');
});

// Correction round 2 — refreshRuns delegates the re-fetch decision, and reads the shown run before the picker moves it.

test('refreshRuns delegates the re-fetch decision to shouldLoadRun, and reads the shown run before the picker moves it', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  assert.match(
    appJs,
    /import\s*\{[^}]*\bshouldLoadRun\b[^}]*\}\s*from\s*['"]\.\/run\.js['"]/,
    'app.js must import shouldLoadRun from run.js, or the name in refreshRuns resolves to nothing',
  );

  const refreshRuns = functionSource(appJs, 'refreshRuns');
  const slice = callArguments(refreshRuns, 'shouldLoadRun');
  assert.match(slice, /\bchangedId\b/, 'shouldLoadRun must be handed the frame\'s changedId');
  assert.match(slice, /\bshown\b/, 'shouldLoadRun must be handed the selection as it stood before the picker moved it');
  assert.match(slice, /state\.selectedRunId\b/, 'shouldLoadRun must be handed the selection the picker settled on');

  assert.match(
    refreshRuns,
    /shouldLoadRun\([\s\S]*?\)\)\s*await loadRun\(/,
    'the one call to loadRun must be the one shouldLoadRun guards',
  );
  assert.doesNotMatch(
    refreshRuns,
    /changedId\s*===\s*state\.selectedRunId/,
    'the decision must not be spelled a second time inside app.js — this is the mutation the review reproduced',
  );

  const shownIdx = refreshRuns.indexOf('const shown');
  const loadRunsIdx = refreshRuns.indexOf('loadRuns(');
  assert.ok(shownIdx > -1, 'refreshRuns must read the shown run into a variable of its own');
  assert.ok(
    shownIdx < loadRunsIdx,
    'shown must be read before loadRuns() moves the picker\'s selection, or a shown read afterward is always equal to state.selectedRunId and collapses the rule',
  );
});

// Increment ui-steps — the pane repaints wholesale, the stylesheet carries the
// step rules, the README says what is shown.

test('the run pane is repainted wholesale from the state the page holds', () => {
  const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const renderRunView = functionSource(appJs, 'renderRunView');
  assert.match(
    renderRunView,
    /container\.innerHTML\s*=\s*renderRun\(state\.run\)/,
    'renderRunView must replace the pane\'s whole markup from state.run — a replacement rather than an append is what leaves no step of the previous state on the page after a switch or a live write',
  );

  const selectRun = functionSource(appJs, 'selectRun');
  assert.match(selectRun, /renderRunView\(/, 'selectRun must still call renderRunView( — this is a guard, already green');
  const refreshRuns = functionSource(appJs, 'refreshRuns');
  assert.match(refreshRuns, /renderRunView\(/, 'refreshRuns must still call renderRunView( — this is a guard, already green');
});

test('the stylesheet styles a step collapsed to a line and expanded to its whole return', () => {
  const css = fs.readFileSync(path.join(PUBLIC, 'styles.css'), 'utf8');
  for (const cls of ['.run-steps', '.run-step-label', '.run-step-preview', '.run-step-time', '.run-step-return']) {
    assert.ok(css.includes(cls), `styles.css must style ${cls}`);
  }

  const returnRuleMatch = css.match(/\.run-step-return\s*\{([^}]*)\}/);
  assert.ok(returnRuleMatch, '.run-step-return must have a rule of its own');
  const returnRule = returnRuleMatch[1];
  assert.match(
    returnRule,
    /max-height/,
    'the return\'s own rule must cap its height, or one enormous return can bury the increments',
  );
  assert.match(returnRule, /overflow/, 'the return\'s own rule must scroll rather than overflow the page');

  const runJs = fs.readFileSync(path.join(PUBLIC, 'run.js'), 'utf8');
  for (const cls of ['run-steps', 'run-step-label', 'run-step-preview', 'run-step-time', 'run-step-return']) {
    const re = new RegExp(`class="[^"]*\\b${cls}\\b[^"]*"`);
    assert.match(runJs, re, `public/run.js must emit ${cls} in a class="…" attribute, or the stylesheet rule styles nothing`);
  }
});

test('README.md\'s opening description names the runs the interface shows', () => {
  const readme = fs.readFileSync(path.join(PROJECT, 'README.md'), 'utf8');
  const start = readme.indexOf('# argus-ui');
  assert.ok(start >= 0, 'README.md must open with the # argus-ui heading');
  const nextHeading = readme.indexOf('\n## ', start);
  assert.ok(nextHeading >= 0, 'README.md must carry a first ## heading after the opening description');
  const opening = readme.slice(start, nextHeading);
  assert.match(
    opening,
    /\bruns\b/i,
    'the opening description must name the runs the interface shows, in the plural, not only the sessions',
  );
});

test('README.md says the run view shows each step, collapsed and expandable', () => {
  const readme = fs.readFileSync(path.join(PROJECT, 'README.md'), 'utf8');
  assert.match(readme, /\bsteps?\b/i, 'README must say the run view shows steps');
  assert.match(readme, /expand/i, 'README must say a step expands to its whole return');
});
