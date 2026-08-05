import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

import { detectLogFormat } from '../src/detector.mjs';
import { parseClaudeLog } from '../src/claude-parser.mjs';
import { parseGeminiLog } from '../src/gemini-parser.mjs';
import { normalizeSession } from '../src/metrics.mjs';
import { renderMarkdown, renderJson } from '../src/renderers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('Parser Tests', async (t) => {
  const claudeFixtureTmpl = path.join(__dirname, 'fixtures', 'claude-sample.jsonl');
  const geminiFixtureTmpl = path.join(__dirname, 'fixtures', 'gemini-sample.jsonl');
  const claudeSubPath = path.join(__dirname, 'fixtures', 'claude-subagent.jsonl');
  const geminiSubPath = path.join(__dirname, 'fixtures', 'gemini-subagent.jsonl');

  const claudeFixture = path.join(__dirname, 'fixtures', 'claude-sample.tmp.jsonl');
  const geminiFixture = path.join(__dirname, 'fixtures', 'gemini-sample.tmp.jsonl');

  t.before(() => {
    const claudeTmpl = fs.readFileSync(claudeFixtureTmpl, 'utf8');
    const geminiTmpl = fs.readFileSync(geminiFixtureTmpl, 'utf8');
    fs.writeFileSync(claudeFixture, claudeTmpl.replace('{{CLAUDE_SUBAGENT_PATH}}', claudeSubPath));
    fs.writeFileSync(geminiFixture, geminiTmpl.replace('{{GEMINI_SUBAGENT_PATH}}', geminiSubPath));
  });

  t.after(() => {
    if (fs.existsSync(claudeFixture)) fs.unlinkSync(claudeFixture);
    if (fs.existsSync(geminiFixture)) fs.unlinkSync(geminiFixture);
  });

  await t.test('detectLogFormat', () => {
    assert.strictEqual(detectLogFormat(claudeFixture), 'claude');
    assert.strictEqual(detectLogFormat(geminiFixture), 'gemini');
  });

  await t.test('parseClaudeLog', async () => {
    const turns = await parseClaudeLog(claudeFixture);
    assert.strictEqual(turns.length, 3, 'Should parse 3 turns (2 main + 1 subagent)');
    
    assert.strictEqual(turns[0].step, 1);
    assert.strictEqual(turns[0].userPrompt, 'Hello Claude');
    assert.strictEqual(turns[0].toolCalls.length, 2);
    assert.strictEqual(turns[0].toolCalls[0].name, 'get_weather');
    assert.strictEqual(turns[0].toolCalls[1].name, 'invoke_subagent');

    // Subagent turn
    assert.strictEqual(turns[1].step, 2);
    assert.strictEqual(turns[1].isSubagent, true);
    assert.strictEqual(turns[1].agentName, 'test-author', 'Should extract subagent role');
    assert.strictEqual(turns[1].userPrompt, 'Subagent Hello');
    
    // Turn 2
    assert.strictEqual(turns[2].step, 3);
    assert.strictEqual(turns[2].userPrompt, 'What about tomorrow?');
  });

  await t.test('parseGeminiLog', async () => {
    const turns = await parseGeminiLog(geminiFixture);
    assert.strictEqual(turns.length, 3, 'Should parse 3 turns');

    assert.strictEqual(turns[0].step, 1);
    assert.strictEqual(turns[0].userPrompt, 'Hello Gemini');
    assert.strictEqual(turns[0].toolCalls.length, 2);
    
    // Subagent turn
    assert.strictEqual(turns[1].step, 2);
    assert.strictEqual(turns[1].isSubagent, true);
    assert.strictEqual(turns[1].agentName, 'test-author', 'Should extract subagent role');
    
    // Turn 2
    assert.strictEqual(turns[2].step, 3);
    assert.strictEqual(turns[2].userPrompt, 'And Portland?');
  });

  await t.test('normalizeSession and renderers', async () => {
    const turns = await parseClaudeLog(claudeFixture);
    const transcript = normalizeSession(turns, 'claude', 'claude');
    
    assert.strictEqual(transcript.metrics.counts.stepCount, 3);
    assert.ok(transcript.metrics.agentBreakdown['test-author'], 'Should have breakdown for test-author');
    assert.strictEqual(transcript.metrics.agentBreakdown['test-author'].stepCount, 1);
    assert.strictEqual(transcript.metrics.agentBreakdown['main'].stepCount, 2);

    const md = renderMarkdown(transcript);
    assert.ok(md.includes('test-author'), 'Markdown should include test-author stats');

    const json = JSON.parse(renderJson(transcript));
    assert.ok(json.agentBreakdown['test-author'], 'JSON should include test-author breakdown');
  });
});
