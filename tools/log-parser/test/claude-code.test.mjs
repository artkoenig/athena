import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { detectLogFormat, getLatestLogPath } from '../src/detector.mjs';
import { parseClaudeLog } from '../src/claude-parser.mjs';
import { normalizeSession } from '../src/metrics.mjs';
import { renderMarkdown } from '../src/renderers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, 'fixtures');

// A real Claude Code transcript: envelope lines first, every payload nested
// under `message`, one API response split over several lines that repeat the
// same `message.id` and the same `usage` object.
const sessionFixture = path.join(fixturesDir, 'claude-code-session.jsonl');

const binPath = path.join(__dirname, '..', 'bin', 'parse-agent-log.mjs');

function writeLines(filePath, lines) {
  fs.writeFileSync(filePath, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
}

test('Claude Code session transcripts', async (t) => {
  let scratch;
  // The old flat-shape fixture, templated the way the existing suite does it.
  let flatFixture;
  // A nested transcript whose Read tool result mentions an existing .jsonl path.
  let toolPathFixture;

  t.before(() => {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'log-parser-cc-')));

    flatFixture = path.join(scratch, 'claude-flat.jsonl');
    fs.writeFileSync(
      flatFixture,
      fs
        .readFileSync(path.join(fixturesDir, 'claude-sample.jsonl'), 'utf8')
        .replace('{{CLAUDE_SUBAGENT_PATH}}', path.join(fixturesDir, 'claude-subagent.jsonl'))
    );

    toolPathFixture = path.join(scratch, 'claude-code-toolpath.jsonl');
    fs.writeFileSync(
      toolPathFixture,
      fs
        .readFileSync(path.join(fixturesDir, 'claude-code-toolpath.jsonl'), 'utf8')
        .replaceAll('{{EXISTING_JSONL_PATH}}', path.join(fixturesDir, 'claude-subagent.jsonl'))
    );
  });

  t.after(() => {
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------
  // The fixture itself must keep proving what it claims to prove.
  // ---------------------------------------------------------------------

  await t.test('fixture guard: the first line carrying a role starts beyond byte 4096', () => {
    const text = fs.readFileSync(sessionFixture, 'utf8');
    let offset = 0;
    let roleOffset = -1;
    for (const line of text.split('\n')) {
      if (line.includes('"role"')) {
        roleOffset = offset;
        break;
      }
      offset += Buffer.byteLength(line, 'utf8') + 1;
    }
    assert.ok(roleOffset > 0, 'fixture must contain a line with a role');
    assert.ok(
      roleOffset > 4096,
      `first role line must sit beyond the old 4096-byte window, was at byte ${roleOffset}`
    );
    const first = JSON.parse(text.split('\n')[0]);
    assert.strictEqual(first.type, 'queue-operation', 'fixture must open with a queue-operation line');
  });

  // ---------------------------------------------------------------------
  // AC: format detection without a message line in the first 4096 bytes
  // ---------------------------------------------------------------------

  await t.test('detectLogFormat: queue-operation opening, first message line past 4096 bytes', () => {
    assert.strictEqual(detectLogFormat(sessionFixture), 'claude');
  });

  await t.test('detectLogFormat: nested-shape transcript without envelope lines', () => {
    assert.strictEqual(detectLogFormat(toolPathFixture), 'claude');
  });

  await t.test('detectLogFormat: a transcript of envelope lines only is still claude', () => {
    const file = path.join(scratch, 'envelope-only.jsonl');
    writeLines(file, [
      { type: 'queue-operation', operation: 'enqueue', sessionId: 's-1', timestamp: '2026-08-05T09:00:00.000Z', content: 'hi' },
      { type: 'mode', mode: 'default', sessionId: 's-1' },
      { type: 'last-prompt', lastPrompt: 'hi', leafUuid: 'u-1', sessionId: 's-1' }
    ]);
    assert.strictEqual(detectLogFormat(file), 'claude');
  });

  await t.test('detectLogFormat: unrelated jsonl stays unknown', () => {
    const file = path.join(scratch, 'unrelated.jsonl');
    writeLines(file, [{ hello: 'world' }, { hello: 'world' }]);
    assert.strictEqual(detectLogFormat(file), 'unknown');
  });

  await t.test('detectLogFormat: an empty file is unknown and does not throw', () => {
    const file = path.join(scratch, 'empty.jsonl');
    fs.writeFileSync(file, '');
    assert.strictEqual(detectLogFormat(file), 'unknown');
  });

  // ---------------------------------------------------------------------
  // AC: the nested shape parses — turns, tokens, tool calls
  // ---------------------------------------------------------------------

  await t.test('parseClaudeLog: nested shape yields turns, prompts, thinking and text', async () => {
    const turns = await parseClaudeLog(sessionFixture);

    assert.strictEqual(turns.length, 2, 'a user line carrying only tool_result blocks must not open a turn');
    assert.strictEqual(turns[0].userPrompt, 'do the thing');
    assert.strictEqual(turns[1].userPrompt, 'and now the second thing');

    assert.deepStrictEqual(turns[0].thinkingBlocks, ['planning']);
    assert.ok(
      turns[0].assistantText.includes('done'),
      `turn 1 assistant text should contain "done", was ${JSON.stringify(turns[0].assistantText)}`
    );
    assert.ok(
      turns[1].assistantText.includes('finished'),
      'text from a split assistant response must not be blanked by a later tool_use-only line'
    );

    assert.strictEqual(turns[0].isSubagent, false);
    assert.strictEqual(turns[0].agentName, 'main');
  });

  await t.test('parseClaudeLog: tool calls per turn, failure marked from is_error', async () => {
    const turns = await parseClaudeLog(sessionFixture);

    assert.deepStrictEqual(turns[0].toolCalls.map((c) => c.name), ['Bash', 'Read']);
    assert.strictEqual(turns[0].toolCalls[0].success, true, 'is_error:false is a success');
    assert.strictEqual(turns[0].toolCalls[1].success, false, 'is_error:true is a failure');

    assert.deepStrictEqual(turns[1].toolCalls.map((c) => c.name), ['Bash']);
    assert.strictEqual(turns[1].toolCalls[0].success, true, 'a tool_result without is_error is a success');
  });

  await t.test('metrics: all four usage fields, counted once per message id', async () => {
    const turns = await parseClaudeLog(sessionFixture);
    const { metrics } = normalizeSession(turns, 'claude', 'claude');

    assert.strictEqual(metrics.tokens.inputTokens, 111);
    assert.strictEqual(metrics.tokens.outputTokens, 222);
    assert.strictEqual(metrics.tokens.cacheReadTokens, 333);
    assert.strictEqual(metrics.tokens.cacheCreationTokens, 444);
    assert.strictEqual(metrics.tokens.totalTokens, 1110);
  });

  await t.test('metrics: counts and per-tool breakdown', async () => {
    const turns = await parseClaudeLog(sessionFixture);
    const { metrics } = normalizeSession(turns, 'claude', 'claude');

    assert.strictEqual(metrics.counts.stepCount, 2);
    assert.strictEqual(metrics.counts.toolCallsTotal, 3);
    assert.strictEqual(metrics.counts.toolCallsFailed, 1);
    assert.strictEqual(metrics.counts.errorCount, 0);

    assert.deepStrictEqual(metrics.toolBreakdown.Bash, { total: 2, success: 2, failed: 0 });
    assert.deepStrictEqual(metrics.toolBreakdown.Read, { total: 1, success: 0, failed: 1 });
    assert.deepStrictEqual(Object.keys(metrics.toolBreakdown).sort(), ['Bash', 'Read']);

    assert.strictEqual(metrics.agentBreakdown.main.stepCount, 2);
    assert.deepStrictEqual(Object.keys(metrics.agentBreakdown), ['main']);
  });

  await t.test('parseClaudeLog: a .jsonl path mentioned by an ordinary tool is not a transcript', async () => {
    const turns = await parseClaudeLog(toolPathFixture);
    const { metrics } = normalizeSession(turns, 'claude', 'claude');

    assert.strictEqual(turns.length, 1, 'the Read result names an existing .jsonl — it must not be parsed as a session');
    assert.deepStrictEqual(Object.keys(metrics.agentBreakdown), ['main']);
    assert.strictEqual(metrics.counts.toolCallsTotal, 1);
    assert.strictEqual(metrics.tokens.inputTokens, 5);
    assert.strictEqual(metrics.tokens.outputTokens, 5);
    assert.strictEqual(metrics.tokens.totalTokens, 10);
  });

  // ---------------------------------------------------------------------
  // AC: the old flat shape keeps working
  // ---------------------------------------------------------------------

  await t.test('regression: the old flat shape (obj.role / obj.usage) still counts', async () => {
    const turns = await parseClaudeLog(flatFixture);
    const { metrics } = normalizeSession(turns, 'claude', 'claude');

    assert.strictEqual(metrics.counts.stepCount, 3);
    assert.strictEqual(metrics.counts.toolCallsTotal, 2);
    assert.strictEqual(metrics.counts.errorCount, 1);

    assert.strictEqual(metrics.tokens.inputTokens, 110);
    assert.strictEqual(metrics.tokens.outputTokens, 55);
    assert.strictEqual(metrics.tokens.cacheReadTokens, 10);
    assert.strictEqual(metrics.tokens.cacheCreationTokens, 0);
    assert.strictEqual(metrics.tokens.totalTokens, 175);

    assert.strictEqual(metrics.agentBreakdown['test-author'].stepCount, 1);
    assert.strictEqual(metrics.agentBreakdown['test-author'].tokens.inputTokens, 10);
    assert.strictEqual(metrics.agentBreakdown.main.tokens.inputTokens, 100);
  });

  // ---------------------------------------------------------------------
  // AC: --latest finds the newest session transcript under ~/.claude/projects
  // ---------------------------------------------------------------------

  await t.test('getLatestLogPath: picks the newest session transcript, never a subagent or plugin file', () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'log-parser-home-')));
    const T = Math.floor(Date.now() / 1000) - 10_000;

    const make = (relPath, mtimeOffset) => {
      const full = path.join(home, relPath);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, '{"type":"user","message":{"role":"user","content":"hi"}}\n');
      fs.utimesSync(full, T + mtimeOffset, T + mtimeOffset);
      return full;
    };

    const sessionA = make('.claude/projects/proj-a/session-a.jsonl', 10);
    make('.claude/projects/proj-a/subagents/agent-x.jsonl', 40);
    make('.claude/projects/proj-a/subagents/workflows/w1/journal.jsonl', 50);
    const sessionB = make('.claude/projects/proj-b/session-b.jsonl', 20);
    make('.claude/plugins/some-cache.jsonl', 60);
    const geminiLog = make('.gemini/antigravity/brain/x/y/z.jsonl', 30);

    try {
      assert.strictEqual(
        getLatestLogPath('claude', home),
        sessionB,
        'the newest file directly inside a project directory wins'
      );
      assert.notStrictEqual(getLatestLogPath('claude', home), sessionA);

      // Gemini keeps its recursive search, and auto still compares the two.
      assert.strictEqual(getLatestLogPath('gemini', home), geminiLog);
      assert.strictEqual(getLatestLogPath('auto', home), geminiLog);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  await t.test('getLatestLogPath: nothing to find yields null', () => {
    const emptyHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'log-parser-empty-')));
    const subOnlyHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'log-parser-subonly-')));

    const subLog = path.join(subOnlyHome, '.claude/projects/proj-a/subagents/agent-x.jsonl');
    fs.mkdirSync(path.dirname(subLog), { recursive: true });
    fs.writeFileSync(subLog, '{"type":"user","message":{"role":"user","content":"hi"}}\n');

    try {
      assert.strictEqual(getLatestLogPath('claude', emptyHome), null, 'no ~/.claude at all');
      assert.strictEqual(getLatestLogPath('auto', emptyHome), null);
      assert.strictEqual(
        getLatestLogPath('claude', subOnlyHome),
        null,
        'a subagent log is not a session transcript'
      );
    } finally {
      fs.rmSync(emptyHome, { recursive: true, force: true });
      fs.rmSync(subOnlyHome, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------
  // AC: the CLI reports non-zero numbers for a real-shaped transcript
  // ---------------------------------------------------------------------

  await t.test('CLI: --format json exits 0 and reports the numbers', () => {
    const stdout = execFileSync(process.execPath, [binPath, sessionFixture, '--format', 'json'], {
      encoding: 'utf8'
    });
    const metrics = JSON.parse(stdout);

    assert.strictEqual(metrics.tokens.totalTokens, 1110);
    assert.strictEqual(metrics.tokens.inputTokens, 111);
    assert.strictEqual(metrics.tokens.outputTokens, 222);
    assert.strictEqual(metrics.tokens.cacheReadTokens, 333);
    assert.strictEqual(metrics.tokens.cacheCreationTokens, 444);
    assert.strictEqual(metrics.counts.toolCallsTotal, 3);
    assert.strictEqual(metrics.counts.toolCallsFailed, 1);
    assert.strictEqual(metrics.counts.stepCount, 2);
  });

  await t.test('CLI: --format all exits 0 and renders the summary', () => {
    const stdout = execFileSync(process.execPath, [binPath, sessionFixture, '--format', 'all'], {
      encoding: 'utf8'
    });
    assert.ok(stdout.includes('Total Tokens'), 'markdown summary must be rendered');
    assert.ok(stdout.includes('1110'), 'markdown must carry the token total');
  });

  await t.test('renderers still take what the parser produces', async () => {
    const turns = await parseClaudeLog(sessionFixture);
    const md = renderMarkdown(normalizeSession(turns, 'claude', 'claude'));
    assert.ok(md.includes('Total Tokens'));
    assert.ok(md.includes('1110'));
  });
});
