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
