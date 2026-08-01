/**
 * Turns OTLP export requests — protobuf or JSON — into flat records the store
 * understands.
 *
 * Both transports converge on the same intermediate shape (the protobuf decoder
 * emits camelCase field names, which is exactly what OTLP/JSON uses), so a
 * single normaliser handles `http/protobuf` and `http/json` alike. The readers
 * below are deliberately tolerant: they accept snake_case keys, string-encoded
 * 64-bit values, and base64 trace ids, because different SDK versions and proxies
 * all take slightly different liberties with OTLP/JSON.
 */

import { decodeMessage } from './protobuf.mjs';
import {
  EXPORT_TRACE_REQUEST,
  EXPORT_METRICS_REQUEST,
  EXPORT_LOGS_REQUEST,
  SPAN_KIND,
  STATUS_CODE,
  TEMPORALITY,
} from './schema.mjs';

/** Read a field that may be camelCase or snake_case. */
function pick(obj, camel) {
  if (!obj) return undefined;
  if (obj[camel] !== undefined) return obj[camel];
  const snake = camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  return obj[snake];
}

function toBigInt(value) {
  if (value === undefined || value === null || value === '') return 0n;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(Math.round(value));
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

/**
 * Nanoseconds since epoch -> float milliseconds. Values near 1.7e18 exceed
 * Number's integer range, so this rounds to ~0.3µs. That is far below anything
 * a UI renders and keeps ordering intact.
 */
export function nanosToMs(nanos) {
  const n = toBigInt(nanos);
  if (n === 0n) return 0;
  return Number(n) / 1e6;
}

const HEX_RE = /^[0-9a-fA-F]+$/;

/** trace_id/span_id are hex in the OTLP/JSON spec, but base64 shows up in the wild. */
function toHexId(value) {
  if (!value) return '';
  if (typeof value === 'string') {
    if (HEX_RE.test(value) && value.length % 2 === 0) return value.toLowerCase();
    return Buffer.from(value, 'base64').toString('hex');
  }
  if (Buffer.isBuffer(value)) return value.toString('hex');
  if (Array.isArray(value)) return Buffer.from(value).toString('hex');
  return '';
}

/** Unwrap an OTLP AnyValue into a plain JS value. */
export function anyValueToJs(any) {
  if (any === undefined || any === null) return null;
  if (typeof any !== 'object') return any;
  const str = pick(any, 'stringValue');
  if (str !== undefined) return str;
  const bool = pick(any, 'boolValue');
  if (bool !== undefined) return bool;
  const int = pick(any, 'intValue');
  if (int !== undefined) return typeof int === 'string' ? Number(int) : int;
  const dbl = pick(any, 'doubleValue');
  if (dbl !== undefined) return dbl;
  const arr = pick(any, 'arrayValue');
  if (arr !== undefined) return (pick(arr, 'values') ?? []).map(anyValueToJs);
  const kvlist = pick(any, 'kvlistValue');
  if (kvlist !== undefined) return attributesToObject(pick(kvlist, 'values'));
  const bytes = pick(any, 'bytesValue');
  if (bytes !== undefined) {
    return Buffer.isBuffer(bytes) ? bytes.toString('base64') : String(bytes);
  }
  return null;
}

/** Collapse a repeated KeyValue list into a plain object. */
export function attributesToObject(attributes) {
  const out = {};
  for (const kv of attributes ?? []) {
    const key = pick(kv, 'key');
    if (!key) continue;
    out[key] = anyValueToJs(pick(kv, 'value'));
  }
  return out;
}

function scopeOf(scope) {
  if (!scope) return null;
  const name = pick(scope, 'name');
  if (!name) return null;
  const version = pick(scope, 'version');
  return version ? { name, version } : { name };
}

/* -------------------------------- traces -------------------------------- */

export function normalizeTraces(payload) {
  const spans = [];
  for (const rs of pick(payload, 'resourceSpans') ?? []) {
    const resource = attributesToObject(pick(pick(rs, 'resource'), 'attributes'));
    for (const ss of pick(rs, 'scopeSpans') ?? []) {
      const scope = scopeOf(pick(ss, 'scope'));
      for (const span of pick(ss, 'spans') ?? []) {
        const startMs = nanosToMs(pick(span, 'startTimeUnixNano'));
        const endMs = nanosToMs(pick(span, 'endTimeUnixNano'));
        const status = pick(span, 'status');
        spans.push({
          traceId: toHexId(pick(span, 'traceId')),
          spanId: toHexId(pick(span, 'spanId')),
          parentSpanId: toHexId(pick(span, 'parentSpanId')),
          name: pick(span, 'name') ?? '',
          kind: SPAN_KIND[pick(span, 'kind') ?? 0] ?? 'unspecified',
          startMs,
          endMs,
          // Spans still in flight export with endTime 0; treat those as open.
          durationMs: endMs > 0 && startMs > 0 ? endMs - startMs : null,
          status: {
            code: STATUS_CODE[pick(status, 'code') ?? 0] ?? 'unset',
            message: pick(status, 'message') ?? '',
          },
          attrs: attributesToObject(pick(span, 'attributes')),
          events: (pick(span, 'events') ?? []).map((ev) => ({
            timeMs: nanosToMs(pick(ev, 'timeUnixNano')),
            name: pick(ev, 'name') ?? '',
            attrs: attributesToObject(pick(ev, 'attributes')),
          })),
          links: (pick(span, 'links') ?? []).map((link) => ({
            traceId: toHexId(pick(link, 'traceId')),
            spanId: toHexId(pick(link, 'spanId')),
            attrs: attributesToObject(pick(link, 'attributes')),
          })),
          resource,
          scope,
        });
      }
    }
  }
  return spans;
}

/* --------------------------------- logs --------------------------------- */

const SEVERITY_TEXT = {
  1: 'TRACE', 5: 'DEBUG', 9: 'INFO', 13: 'WARN', 17: 'ERROR', 21: 'FATAL',
};

function severityLabel(number, text) {
  if (text) return text;
  if (!number) return 'INFO';
  // Severity numbers come in bands of four (INFO=9..12); round down to the band.
  const base = Math.floor((number - 1) / 4) * 4 + 1;
  return SEVERITY_TEXT[base] ?? 'INFO';
}

export function normalizeLogs(payload) {
  const logs = [];
  for (const rl of pick(payload, 'resourceLogs') ?? []) {
    const resource = attributesToObject(pick(pick(rl, 'resource'), 'attributes'));
    for (const sl of pick(rl, 'scopeLogs') ?? []) {
      const scope = scopeOf(pick(sl, 'scope'));
      for (const record of pick(sl, 'logRecords') ?? []) {
        const attrs = attributesToObject(pick(record, 'attributes'));
        const observedMs = nanosToMs(pick(record, 'observedTimeUnixNano'));
        const timeMs = nanosToMs(pick(record, 'timeUnixNano')) || observedMs;
        const body = anyValueToJs(pick(record, 'body'));
        logs.push({
          timeMs,
          observedMs,
          severityNumber: pick(record, 'severityNumber') ?? 0,
          severity: severityLabel(pick(record, 'severityNumber'), pick(record, 'severityText')),
          // Claude Code names events three different ways depending on version:
          // the LogRecord.event_name field, an `event.name` attribute, or the body.
          eventName:
            pick(record, 'eventName') ||
            attrs['event.name'] ||
            (typeof body === 'string' ? body : '') ||
            'log',
          body,
          attrs,
          traceId: toHexId(pick(record, 'traceId')),
          spanId: toHexId(pick(record, 'spanId')),
          resource,
          scope,
        });
      }
    }
  }
  return logs;
}

/* -------------------------------- metrics ------------------------------- */

function numberValue(point) {
  const asDouble = pick(point, 'asDouble');
  if (asDouble !== undefined) return asDouble;
  const asInt = pick(point, 'asInt');
  if (asInt !== undefined) return typeof asInt === 'bigint' ? Number(asInt) : Number(asInt);
  return 0;
}

function basePoint(metric, point, resource, scope, extra) {
  return {
    name: pick(metric, 'name') ?? '',
    description: pick(metric, 'description') ?? '',
    unit: pick(metric, 'unit') ?? '',
    timeMs: nanosToMs(pick(point, 'timeUnixNano')),
    startMs: nanosToMs(pick(point, 'startTimeUnixNano')),
    attrs: attributesToObject(pick(point, 'attributes')),
    resource,
    scope,
    ...extra,
  };
}

export function normalizeMetrics(payload) {
  const points = [];
  for (const rm of pick(payload, 'resourceMetrics') ?? []) {
    const resource = attributesToObject(pick(pick(rm, 'resource'), 'attributes'));
    for (const sm of pick(rm, 'scopeMetrics') ?? []) {
      const scope = scopeOf(pick(sm, 'scope'));
      for (const metric of pick(sm, 'metrics') ?? []) {
        const sum = pick(metric, 'sum');
        const gauge = pick(metric, 'gauge');
        const histogram = pick(metric, 'histogram');
        if (sum) {
          const temporality = TEMPORALITY[pick(sum, 'aggregationTemporality') ?? 0] ?? 'unspecified';
          const monotonic = Boolean(pick(sum, 'isMonotonic'));
          for (const point of pick(sum, 'dataPoints') ?? []) {
            points.push(
              basePoint(metric, point, resource, scope, {
                kind: 'sum',
                temporality,
                monotonic,
                value: numberValue(point),
              }),
            );
          }
        }
        if (gauge) {
          for (const point of pick(gauge, 'dataPoints') ?? []) {
            points.push(
              basePoint(metric, point, resource, scope, {
                kind: 'gauge',
                temporality: 'unspecified',
                monotonic: false,
                value: numberValue(point),
              }),
            );
          }
        }
        if (histogram) {
          const temporality =
            TEMPORALITY[pick(histogram, 'aggregationTemporality') ?? 0] ?? 'unspecified';
          for (const point of pick(histogram, 'dataPoints') ?? []) {
            const count = Number(pick(point, 'count') ?? 0);
            points.push(
              basePoint(metric, point, resource, scope, {
                kind: 'histogram',
                temporality,
                monotonic: false,
                value: Number(pick(point, 'sum') ?? 0),
                count,
                min: pick(point, 'min'),
                max: pick(point, 'max'),
                buckets: (pick(point, 'bucketCounts') ?? []).map(Number),
                bounds: (pick(point, 'explicitBounds') ?? []).map(Number),
              }),
            );
          }
        }
      }
    }
  }
  return points;
}

/* ------------------------------ entry points ---------------------------- */

const PROTO_SCHEMAS = {
  traces: EXPORT_TRACE_REQUEST,
  metrics: EXPORT_METRICS_REQUEST,
  logs: EXPORT_LOGS_REQUEST,
};

const NORMALIZERS = {
  traces: normalizeTraces,
  metrics: normalizeMetrics,
  logs: normalizeLogs,
};

/**
 * Decode one OTLP export request.
 *
 * @param {'traces'|'metrics'|'logs'} signal
 * @param {Buffer} body raw request body (already gunzipped)
 * @param {string} contentType request Content-Type header
 */
export function decodeExportRequest(signal, body, contentType = '') {
  const normalize = NORMALIZERS[signal];
  if (!normalize) throw new Error(`unknown signal ${signal}`);
  const isJson = contentType.includes('json');
  const payload = isJson
    ? JSON.parse(body.toString('utf8') || '{}')
    : decodeMessage(body, PROTO_SCHEMAS[signal]);
  return normalize(payload);
}
