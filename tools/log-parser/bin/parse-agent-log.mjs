#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { detectLogFormat, getLatestLogPath, getLatestRunDir } from '../src/detector.mjs';
import { parseClaudeLog } from '../src/claude-parser.mjs';
import { parseGeminiLog } from '../src/gemini-parser.mjs';
import { normalizeSession } from '../src/metrics.mjs';
import { renderMarkdown, renderJson } from '../src/renderers.mjs';
import { collectRunReport, renderRunMarkdown, renderRunJson } from '../src/run-report.mjs';

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      latest: { type: 'string' },
      'latest-run': { type: 'boolean', default: false },
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
    console.log(`Usage: parse-agent-log [options] [log-file-path | run-directory]
    <run-directory>                 A workflow run directory (holds journal.jsonl),
                                    reported as one run
    --latest [claude|gemini|auto]   Auto-detect latest session
    --latest-run                    Auto-detect the latest workflow run directory
    --format <markdown|json|all>    Output format
    --out <path>                    Write markdown to file
    --metrics-out <path>            Write JSON metrics to file
    --quiet                         Suppress warnings`);
    process.exit(0);
  }

  let logPath = positionals[0];
  if (values['latest-run']) {
    logPath = getLatestRunDir();
    if (!logPath) {
      console.error('Error: No workflow run directory found.');
      process.exit(1);
    }
  } else if (!logPath && values.latest) {
    logPath = getLatestLogPath(values.latest === '' || values.latest === 'true' ? 'auto' : values.latest);
  }

  if (!logPath || !fs.existsSync(logPath)) {
    console.error('Error: Log file not found.');
    process.exit(1);
  }

  let md;
  let json;

  // A directory is a workflow run, reported as one thing; a file is a single
  // session transcript, reported exactly as it always was.
  if (fs.statSync(logPath).isDirectory()) {
    if (!fs.existsSync(path.join(logPath, 'journal.jsonl'))) {
      console.error(`Error: Not a workflow run directory (no journal.jsonl): ${logPath}`);
      process.exit(1);
    }
    const report = await collectRunReport(logPath);
    md = renderRunMarkdown(report);
    json = renderRunJson(report);
  } else {
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

    md = renderMarkdown(transcript);
    json = renderJson(transcript);
  }

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
