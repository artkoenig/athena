import test from 'node:test';
import assert from 'node:assert/strict';

import { encodeMessage } from '../src/otlp/protobuf.mjs';
import {
  EXPORT_TRACE_REQUEST,
  EXPORT_LOGS_REQUEST,
  EXPORT_METRICS_REQUEST,
} from '../src/otlp/schema.mjs';
import { decodeExportRequest, nanosDurationMs, nanosToMs } from '../src/otlp/decode.mjs';

const attrs = (object) =>
  Object.entries(object).map(([key, value]) => {
    if (typeof value === 'boolean') return { key, value: { boolValue: value } };
    if (typeof value === 'number') {
      return { key, value: Number.isInteger(value) ? { intValue: value } : { doubleValue: value } };
    }
    return { key, value: { stringValue: String(value) } };
  });

const T0 = 1767225600000n * 1000000n;

test('nanosToMs keeps millisecond ordering', () => {
  assert.equal(nanosToMs(1500000n), 1.5);
  assert.equal(nanosToMs(0n), 0);
  assert.ok(nanosToMs(T0 + 1000000n) > nanosToMs(T0));
});

test('a duration stays exact at any point on the clock', () => {
  // Nanoseconds since the epoch are past Number's integer range, so a duration
  // taken as the difference of two converted timestamps drifts — by an amount
  // that depends on the wall clock, which makes it a rare, moving failure.
  for (const epochMs of [1767225600000n, 1785575737865n, BigInt(Date.now())]) {
    const start = epochMs * 1000000n;
    assert.equal(nanosDurationMs(start, start + 1500n * 1000000n), 1500, `at ${epochMs}`);
    assert.equal(nanosDurationMs(start, start + 1n), 0.000001, `at ${epochMs}`);
  }
  // An unfinished span is open, not zero-length.
  assert.equal(nanosDurationMs(T0, 0n), null);
  assert.equal(nanosDurationMs(0n, T0), null);

  // Aggregates elsewhere subtract converted timestamps, so the conversion has to
  // hold whole milliseconds exactly rather than merely close enough to render.
  for (const epochMs of [1767225600000n, 1785575737865n, BigInt(Date.now())]) {
    const start = epochMs * 1000000n;
    assert.equal(nanosToMs(start + 1500n * 1000000n) - nanosToMs(start), 1500, `at ${epochMs}`);
  }
});

test('protobuf traces normalize into flat spans', () => {
  const body = encodeMessage(
    {
      resourceSpans: [
        {
          resource: { attributes: attrs({ 'service.name': 'agent', 'session.id': 's1' }) },
          scopeSpans: [
            {
              scope: { name: 'claude-code' },
              spans: [
                {
                  traceId: 'aa'.repeat(16),
                  spanId: 'bb'.repeat(8),
                  name: 'claude_code.interaction',
                  startTimeUnixNano: T0,
                  endTimeUnixNano: T0 + 2500n * 1000000n,
                  attributes: attrs({ 'session.id': 's1', user_prompt_length: 12 }),
                  status: { code: 1 },
                  events: [{ timeUnixNano: T0, name: 'tool.output', attributes: attrs({ n: 1 }) }],
                },
              ],
            },
          ],
        },
      ],
    },
    EXPORT_TRACE_REQUEST,
  );

  const [span] = decodeExportRequest('traces', body, 'application/x-protobuf');
  assert.equal(span.name, 'claude_code.interaction');
  assert.equal(span.traceId, 'aa'.repeat(16));
  assert.equal(span.durationMs, 2500);
  assert.equal(span.status.code, 'ok');
  assert.equal(span.resource['service.name'], 'agent');
  assert.equal(span.attrs.user_prompt_length, 12);
  assert.equal(span.events[0].name, 'tool.output');
  assert.equal(span.scope.name, 'claude-code');
});

test('a span with no end time is reported as open', () => {
  const body = encodeMessage(
    {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [{ traceId: 'cc'.repeat(16), spanId: 'dd'.repeat(8), name: 'x', startTimeUnixNano: T0 }],
            },
          ],
        },
      ],
    },
    EXPORT_TRACE_REQUEST,
  );
  const [span] = decodeExportRequest('traces', body, 'application/x-protobuf');
  assert.equal(span.durationMs, null);
});

test('OTLP/JSON produces the same records as protobuf', () => {
  const json = {
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'session.id', value: { stringValue: 's2' } }] },
        scopeSpans: [
          {
            spans: [
              {
                traceId: 'ab'.repeat(16),
                spanId: 'cd'.repeat(8),
                name: 'claude_code.tool',
                // OTLP/JSON encodes 64-bit values as strings.
                startTimeUnixNano: String(T0),
                endTimeUnixNano: String(T0 + 40n * 1000000n),
                attributes: [{ key: 'tool_name', value: { stringValue: 'Bash' } }],
              },
            ],
          },
        ],
      },
    ],
  };
  const [span] = decodeExportRequest('traces', Buffer.from(JSON.stringify(json)), 'application/json');
  assert.equal(span.attrs.tool_name, 'Bash');
  assert.equal(span.durationMs, 40);
  assert.equal(span.resource['session.id'], 's2');
});

test('base64 trace ids in JSON are converted to hex', () => {
  const traceId = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  const json = {
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans: [{ traceId: traceId.toString('base64'), spanId: 'ee'.repeat(8), name: 'x' }],
          },
        ],
      },
    ],
  };
  const [span] = decodeExportRequest('traces', Buffer.from(JSON.stringify(json)), 'application/json');
  assert.equal(span.traceId, '00112233445566778899aabbccddeeff');
});

test('log records resolve their event name from field, attribute or body', () => {
  const body = encodeMessage(
    {
      resourceLogs: [
        {
          resource: { attributes: attrs({ 'session.id': 's1' }) },
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: T0,
                  severityNumber: 9,
                  eventName: 'claude_code.api_request',
                  attributes: attrs({ model: 'claude-opus-5', input_tokens: 100 }),
                },
                {
                  timeUnixNano: T0,
                  severityNumber: 17,
                  // Current Claude Code CLIs (2.1.x) send this attribute unprefixed
                  // ('api_error', not 'claude_code.api_error') — the opposite of what
                  // the LogRecord.event_name field and the body carry. Both forms must
                  // resolve to the same canonical, prefixed name or every EVENT.*
                  // switch downstream silently never matches.
                  attributes: attrs({ 'event.name': 'api_error', error: 'boom' }),
                },
                { timeUnixNano: T0, body: { stringValue: 'claude_code.tool_result' } },
              ],
            },
          ],
        },
      ],
    },
    EXPORT_LOGS_REQUEST,
  );
  const logs = decodeExportRequest('logs', body, 'application/x-protobuf');
  assert.deepEqual(
    logs.map((log) => log.eventName),
    ['claude_code.api_request', 'claude_code.api_error', 'claude_code.tool_result'],
  );
  assert.equal(logs[0].severity, 'INFO');
  assert.equal(logs[1].severity, 'ERROR');
  assert.equal(logs[0].attrs.model, 'claude-opus-5');
});

test('sums, gauges and histograms all normalize into points', () => {
  const body = encodeMessage(
    {
      resourceMetrics: [
        {
          resource: { attributes: attrs({ 'session.id': 's1' }) },
          scopeMetrics: [
            {
              metrics: [
                {
                  name: 'claude_code.token.usage',
                  unit: 'tokens',
                  sum: {
                    aggregationTemporality: 1,
                    isMonotonic: true,
                    dataPoints: [
                      { timeUnixNano: T0, asInt: 1234, attributes: attrs({ type: 'input' }) },
                    ],
                  },
                },
                {
                  name: 'claude_code.cost.usage',
                  unit: 'USD',
                  gauge: { dataPoints: [{ timeUnixNano: T0, asDouble: 0.25 }] },
                },
                {
                  name: 'demo.latency',
                  unit: 'ms',
                  histogram: {
                    aggregationTemporality: 2,
                    dataPoints: [
                      {
                        timeUnixNano: T0,
                        count: 3n,
                        sum: 90,
                        min: 10,
                        max: 50,
                        bucketCounts: [1n, 2n],
                        explicitBounds: [25],
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    },
    EXPORT_METRICS_REQUEST,
  );
  const points = decodeExportRequest('metrics', body, 'application/x-protobuf');
  assert.equal(points.length, 3);
  assert.deepEqual(
    points.map((point) => point.kind),
    ['sum', 'gauge', 'histogram'],
  );
  assert.equal(points[0].value, 1234);
  assert.equal(points[0].temporality, 'delta');
  assert.equal(points[1].value, 0.25);
  assert.equal(points[2].count, 3);
  assert.deepEqual(points[2].buckets, [1, 2]);
  assert.deepEqual(points[2].bounds, [25]);
});

test('an empty export request decodes to no records', () => {
  assert.deepEqual(decodeExportRequest('traces', Buffer.alloc(0), 'application/x-protobuf'), []);
  assert.deepEqual(decodeExportRequest('logs', Buffer.from('{}'), 'application/json'), []);
});
