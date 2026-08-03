#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { detectLogFormat, getLatestLogPath } from '../src/detector.mjs';
import { parseClaudeLog } from '../src/claude-parser.mjs';
import { parseGeminiLog } from '../src/gemini-parser.mjs';
import { normalizeSession } from '../src/metrics.mjs';
import { renderMarkdown, renderJson } from '../src/renderers.mjs';

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      latest: { type: 'string' },
      format: { type: 'string', default: 'all' },
      out: { type: 'string' },
      'metrics-out': { type: 'string' },
      quiet: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false }
    },
    allowPositionals: true,
    strict: false
  });

  if (values.help) {
    console.log(`Usage: parse-agent-log [options] [log-file-path]
    --latest [claude|gemini|auto]   Auto-detect latest session
    --format <markdown|json|all>    Output format
    --out <path>                    Write markdown to file
    --metrics-out <path>            Write JSON metrics to file
    --quiet                         Suppress warnings`);
    process.exit(0);
  }

  let logPath = positionals[0];
  if (!logPath && values.latest) {
    logPath = getLatestLogPath(values.latest === '' || values.latest === 'true' ? 'auto' : values.latest);
  }

  if (!logPath || !fs.existsSync(logPath)) {
    console.error('Error: Log file not found.');
    process.exit(1);
  }

  const format = detectLogFormat(logPath);
  if (format === 'unknown') {
    console.error('Error: Unknown log format.');
    process.exit(2);
  }

  let turns = [];
  try {
    if (format === 'claude') {
      turns = await parseClaudeLog(logPath);
    } else if (format === 'gemini') {
      turns = await parseGeminiLog(logPath);
    }
  } catch (err) {
    console.error('Error parsing log:', err);
    process.exit(2);
  }

  const transcript = normalizeSession(turns, format, format);
  
  const md = renderMarkdown(transcript);
  const json = renderJson(transcript);

  if (values.out) {
    fs.writeFileSync(values.out, md, 'utf8');
  }
  if (values['metrics-out']) {
    fs.writeFileSync(values['metrics-out'], json, 'utf8');
  }

  if (values.format === 'markdown') {
    if (!values.out) console.log(md);
  } else if (values.format === 'json') {
    if (!values['metrics-out']) console.log(json);
  } else {
    if (!values.out && !values['metrics-out']) {
      console.log(md);
      console.log('\n\n=== JSON Metrics ===\n\n');
      console.log(json);
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(2);
});
