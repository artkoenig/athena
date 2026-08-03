import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectLogFormat } from '../src/detector.mjs';
import { parseClaudeLog } from '../src/claude-parser.mjs';
import { parseGeminiLog } from '../src/gemini-parser.mjs';
import { normalizeSession } from '../src/metrics.mjs';
import { renderMarkdown, renderJson } from '../src/renderers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('Parser Tests', async (t) => {
  const claudeFixture = path.join(__dirname, 'fixtures', 'claude-sample.jsonl');
  const geminiFixture = path.join(__dirname, 'fixtures', 'gemini-sample.jsonl');

  await t.test('detectLogFormat', () => {
    assert.strictEqual(detectLogFormat(claudeFixture), 'claude');
    assert.strictEqual(detectLogFormat(geminiFixture), 'gemini');
  });

  await t.test('parseClaudeLog', async () => {
    const turns = await parseClaudeLog(claudeFixture);
    assert.strictEqual(turns.length, 2, 'Should parse 2 turns');
    
    assert.strictEqual(turns[0].step, 1);
    assert.strictEqual(turns[0].userPrompt, 'Hello Claude');
    assert.strictEqual(turns[0].thinkingBlocks.length, 1);
    assert.strictEqual(turns[0].thinkingBlocks[0], 'I should say hello.');
    assert.strictEqual(turns[0].toolCalls.length, 1);
    assert.strictEqual(turns[0].toolCalls[0].name, 'get_weather');
    
    assert.strictEqual(turns[1].step, 2);
    assert.strictEqual(turns[1].userPrompt, 'What about tomorrow?');
    assert.strictEqual(turns[1].errors.length, 1);
    assert.strictEqual(turns[1].errors[0].message, 'Some error');
    
    // Check tokens
    assert.strictEqual(turns[0].tokens.inputTokens, 100);
    assert.strictEqual(turns[0].tokens.outputTokens, 50);
  });

  await t.test('parseGeminiLog', async () => {
    const turns = await parseGeminiLog(geminiFixture);
    assert.strictEqual(turns.length, 2, 'Should parse 2 turns');

    assert.strictEqual(turns[0].step, 1);
    assert.strictEqual(turns[0].userPrompt, 'Hello Gemini');
    assert.strictEqual(turns[0].thinkingBlocks.length, 1);
    assert.strictEqual(turns[0].thinkingBlocks[0], 'Thinking about hello');
    assert.strictEqual(turns[0].toolCalls.length, 1);
    assert.strictEqual(turns[0].toolCalls[0].name, 'get_weather');
    assert.strictEqual(turns[0].toolCalls[0].output, 'It is raining');
    
    assert.strictEqual(turns[0].tokens.inputTokens, 120);

    assert.strictEqual(turns[1].step, 2);
    assert.strictEqual(turns[1].userPrompt, 'And Portland?');
    assert.strictEqual(turns[1].errors.length, 1);
    assert.strictEqual(turns[1].errors[0].message, 'Timeout');
  });

  await t.test('normalizeSession and renderers', async () => {
    const turns = await parseGeminiLog(geminiFixture);
    const transcript = normalizeSession(turns, 'gemini', 'gemini');
    
    assert.strictEqual(transcript.metrics.counts.stepCount, 2);
    assert.strictEqual(transcript.metrics.counts.toolCallsTotal, 1);
    assert.strictEqual(transcript.metrics.counts.errorCount, 1);
    assert.strictEqual(transcript.metrics.tokens.inputTokens, 120);

    const md = renderMarkdown(transcript);
    assert.ok(md.includes('# Session Transcript'));
    assert.ok(md.includes('**Provider**: gemini (gemini)'));
    assert.ok(md.includes('Thinking about hello'));
    assert.ok(md.includes('Hello Gemini'));

    const json = JSON.parse(renderJson(transcript));
    assert.strictEqual(json.counts.stepCount, 2);
  });
});
