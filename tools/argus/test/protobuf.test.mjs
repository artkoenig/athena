import test from 'node:test';
import assert from 'node:assert/strict';

import { decodeMessage, encodeMessage, readVarint } from '../src/otlp/protobuf.mjs';
import { ANY_VALUE, KEY_VALUE, SPAN, EXPORT_TRACE_REQUEST } from '../src/otlp/schema.mjs';

test('readVarint decodes multi-byte values', () => {
  assert.equal(readVarint(Buffer.from([0x01]), 0)[0], 1n);
  assert.equal(readVarint(Buffer.from([0xac, 0x02]), 0)[0], 300n);
  assert.equal(readVarint(Buffer.from([0xff, 0xff, 0xff, 0xff, 0x0f]), 0)[0], 4294967295n);
});

test('readVarint rejects truncated and overlong input', () => {
  assert.throws(() => readVarint(Buffer.from([0x80]), 0), /truncated/);
  assert.throws(() => readVarint(Buffer.alloc(12, 0x80), 0), /longer than 10 bytes/);
});

test('AnyValue round-trips every scalar shape', () => {
  for (const value of [
    { stringValue: 'hello' },
    { boolValue: true },
    { intValue: 4096 },
    { doubleValue: 1.5 },
  ]) {
    const decoded = decodeMessage(encodeMessage(value, ANY_VALUE), ANY_VALUE);
    assert.deepEqual(decoded, value);
  }
});

test('int64 fields survive negative values', () => {
  const decoded = decodeMessage(encodeMessage({ intValue: -7 }, ANY_VALUE), ANY_VALUE);
  assert.equal(decoded.intValue, -7);
});

test('nanosecond timestamps stay exact as BigInt', () => {
  const ts = 1767225600123456789n;
  const buf = encodeMessage({ startTimeUnixNano: ts, name: 'x' }, SPAN);
  assert.equal(decodeMessage(buf, SPAN).startTimeUnixNano, ts);
});

test('hex ids round-trip through bytes fields', () => {
  const traceId = '0123456789abcdef0123456789abcdef';
  const spanId = 'fedcba9876543210';
  const decoded = decodeMessage(encodeMessage({ traceId, spanId }, SPAN), SPAN);
  assert.equal(decoded.traceId, traceId);
  assert.equal(decoded.spanId, spanId);
});

test('unknown fields are skipped rather than failing the message', () => {
  // Field 999, wire type 2 — nothing in our schema claims it.
  const known = encodeMessage({ name: 'span-name' }, SPAN);
  const unknownKey = Buffer.from([0xba, 0x3e, 0x03]); // tag(999,LEN) + length 3
  const buf = Buffer.concat([unknownKey, Buffer.from('abc'), known]);
  assert.equal(decodeMessage(buf, SPAN).name, 'span-name');
});

test('nested repeated messages decode in order', () => {
  const payload = {
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'agent' } }] },
        scopeSpans: [
          {
            scope: { name: 'test' },
            spans: [
              { name: 'a', spanId: 'aa'.repeat(8) },
              { name: 'b', spanId: 'bb'.repeat(8) },
            ],
          },
        ],
      },
    ],
  };
  const decoded = decodeMessage(encodeMessage(payload, EXPORT_TRACE_REQUEST), EXPORT_TRACE_REQUEST);
  const spans = decoded.resourceSpans[0].scopeSpans[0].spans;
  assert.deepEqual(
    spans.map((span) => span.name),
    ['a', 'b'],
  );
  assert.equal(decoded.resourceSpans[0].resource.attributes[0].key, 'service.name');
});

test('KeyValue with a missing value decodes to an empty message', () => {
  const decoded = decodeMessage(encodeMessage({ key: 'k' }, KEY_VALUE), KEY_VALUE);
  assert.equal(decoded.key, 'k');
  assert.equal(decoded.value, undefined);
});
