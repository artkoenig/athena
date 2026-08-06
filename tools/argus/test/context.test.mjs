import test from 'node:test';
import assert from 'node:assert/strict';

import { parseRequestBody } from '../src/context.mjs';

test('a full request body parses into blocks in source order, with role, type, name, toolUseId and chars', () => {
  const body = {
    system: 'You are a careful assistant.',
    tools: [
      { name: 'Read', description: 'Read a file', input_schema: { type: 'object' } },
      { name: 'Write', description: 'Write a file', input_schema: { type: 'object' } },
    ],
    messages: [
      { role: 'user', content: 'What is in this repo?' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check.' },
          { type: 'tool_use', id: 'tu-1', name: 'Read', input: { file_path: 'README.md' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'file contents here' }],
      },
    ],
  };
  const result = parseRequestBody({ body: JSON.stringify(body), model: 'claude-opus-5' });
  assert.equal(result.parsed, true);
  assert.equal(result.blocks.length, 6);

  assert.equal(result.blocks[0].role, 'system');
  assert.equal(result.blocks[0].type, 'text');
  assert.equal(result.blocks[0].chars, 'You are a careful assistant.'.length);

  assert.equal(result.blocks[1].role, 'system');
  assert.equal(result.blocks[1].type, 'tools');
  assert.equal(result.blocks[1].name, 'tools (2)');

  assert.equal(result.blocks[2].role, 'user');
  assert.equal(result.blocks[2].type, 'text');
  assert.equal(result.blocks[2].chars, 'What is in this repo?'.length);

  assert.equal(result.blocks[3].role, 'assistant');
  assert.equal(result.blocks[3].type, 'text');
  assert.equal(result.blocks[3].chars, 'Let me check.'.length);

  assert.equal(result.blocks[4].role, 'assistant');
  assert.equal(result.blocks[4].type, 'tool_use');
  assert.equal(result.blocks[4].name, 'Read');
  assert.equal(result.blocks[4].toolUseId, 'tu-1');

  assert.equal(result.blocks[5].role, 'user');
  assert.equal(result.blocks[5].type, 'tool_result');
  assert.equal(result.blocks[5].toolUseId, 'tu-1');
  assert.equal(result.blocks[5].chars, 'file contents here'.length);
});

test('a system array yields one block per entry', () => {
  const body = {
    system: [
      { type: 'text', text: 'first instruction' },
      { type: 'text', text: 'second instruction' },
    ],
    messages: [],
  };
  const result = parseRequestBody({ body: JSON.stringify(body) });
  const systemBlocks = result.blocks.filter((block) => block.role === 'system' && block.type === 'text');
  assert.equal(systemBlocks.length, 2);
  assert.equal(systemBlocks[0].chars, 'first instruction'.length);
  assert.equal(systemBlocks[1].chars, 'second instruction'.length);
});

test('a thinking block survives verbatim as type thinking', () => {
  const body = {
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: '[redacted]' }],
      },
    ],
  };
  const result = parseRequestBody({ body: JSON.stringify(body) });
  const thinking = result.blocks.find((block) => block.type === 'thinking');
  assert.ok(thinking, 'a thinking block must be represented, never dropped');
  assert.equal(thinking.role, 'assistant');
  assert.equal(thinking.text, '[redacted]', 'nothing here may pretend to recover what the CLI already redacted');
});

test('an image block never inlines its payload into text, but chars still reflects the original size', () => {
  const base64Payload = 'A'.repeat(5000);
  const body = {
    messages: [
      {
        role: 'user',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64Payload } }],
      },
    ],
  };
  const result = parseRequestBody({ body: JSON.stringify(body) });
  const image = result.blocks.find((block) => block.type === 'image');
  assert.ok(image, 'an image block must be represented');
  assert.ok(!image.text.includes(base64Payload), 'the base64 payload must never be inlined into text');
  assert.equal(image.chars, base64Payload.length, 'the size accounting stays honest even though the text is a placeholder');
});

test('a truncated body returns one raw block holding the exact text', () => {
  const truncatedBody = '{"system":"you are","messages":[{"role":"user","content":"do the th';
  const result = parseRequestBody({ body: truncatedBody, body_truncated: 'true' });
  assert.equal(result.parsed, false);
  assert.equal(result.truncated, true);
  assert.equal(result.blocks.length, 1);
  assert.equal(result.blocks[0].role, 'raw');
  assert.equal(result.blocks[0].type, 'raw');
  assert.equal(result.blocks[0].text, truncatedBody, 'the exact text stays reachable, byte for byte');
});

test('file mode reports the bodyRef path and never reads the file', () => {
  const bodyRef = '/nonexistent/path/that/would/throw/if/read/req.json';
  const result = parseRequestBody({ body_ref: bodyRef });
  assert.equal(result.parsed, false);
  assert.deepEqual(result.blocks, []);
  assert.equal(result.bodyRef, bodyRef);
});

test('a body with neither body nor body_ref returns an empty result rather than throwing', () => {
  assert.doesNotThrow(() => {
    const result = parseRequestBody({});
    assert.equal(result.parsed, false);
    assert.deepEqual(result.blocks, []);
  });
});
