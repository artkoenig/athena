/**
 * Field descriptors for the subset of OTLP v1 we ingest.
 *
 * Field numbers follow opentelemetry-proto v1 (common/resource/trace/metrics/
 * logs .proto). They are part of the stable wire contract, so hardcoding them
 * is safe; unknown fields added by future revisions are skipped by the decoder.
 */

export const ARRAY_VALUE = {
  1: { name: 'values', type: 'msg', repeated: true, schema: () => ANY_VALUE },
};

export const KVLIST_VALUE = {
  1: { name: 'values', type: 'msg', repeated: true, schema: () => KEY_VALUE },
};

export const ANY_VALUE = {
  1: { name: 'stringValue', type: 'string' },
  2: { name: 'boolValue', type: 'bool' },
  3: { name: 'intValue', type: 'int64' },
  4: { name: 'doubleValue', type: 'double' },
  5: { name: 'arrayValue', type: 'msg', schema: () => ARRAY_VALUE },
  6: { name: 'kvlistValue', type: 'msg', schema: () => KVLIST_VALUE },
  7: { name: 'bytesValue', type: 'bytes' },
};

export const KEY_VALUE = {
  1: { name: 'key', type: 'string' },
  2: { name: 'value', type: 'msg', schema: () => ANY_VALUE },
};

const ATTRIBUTES = { name: 'attributes', type: 'msg', repeated: true, schema: () => KEY_VALUE };

export const INSTRUMENTATION_SCOPE = {
  1: { name: 'name', type: 'string' },
  2: { name: 'version', type: 'string' },
  3: ATTRIBUTES,
};

export const RESOURCE = {
  1: ATTRIBUTES,
  2: { name: 'droppedAttributesCount', type: 'uint32' },
};

/* ------------------------------- traces --------------------------------- */

export const SPAN_EVENT = {
  1: { name: 'timeUnixNano', type: 'fixed64' },
  2: { name: 'name', type: 'string' },
  3: ATTRIBUTES,
};

export const SPAN_LINK = {
  1: { name: 'traceId', type: 'hex' },
  2: { name: 'spanId', type: 'hex' },
  3: { name: 'traceState', type: 'string' },
  4: ATTRIBUTES,
};

export const STATUS = {
  2: { name: 'message', type: 'string' },
  3: { name: 'code', type: 'enum' },
};

export const SPAN = {
  1: { name: 'traceId', type: 'hex' },
  2: { name: 'spanId', type: 'hex' },
  3: { name: 'traceState', type: 'string' },
  4: { name: 'parentSpanId', type: 'hex' },
  5: { name: 'name', type: 'string' },
  6: { name: 'kind', type: 'enum' },
  7: { name: 'startTimeUnixNano', type: 'fixed64' },
  8: { name: 'endTimeUnixNano', type: 'fixed64' },
  9: ATTRIBUTES,
  11: { name: 'events', type: 'msg', repeated: true, schema: () => SPAN_EVENT },
  13: { name: 'links', type: 'msg', repeated: true, schema: () => SPAN_LINK },
  15: { name: 'status', type: 'msg', schema: () => STATUS },
  16: { name: 'flags', type: 'fixed32' },
};

export const SCOPE_SPANS = {
  1: { name: 'scope', type: 'msg', schema: () => INSTRUMENTATION_SCOPE },
  2: { name: 'spans', type: 'msg', repeated: true, schema: () => SPAN },
  3: { name: 'schemaUrl', type: 'string' },
};

export const RESOURCE_SPANS = {
  1: { name: 'resource', type: 'msg', schema: () => RESOURCE },
  2: { name: 'scopeSpans', type: 'msg', repeated: true, schema: () => SCOPE_SPANS },
  3: { name: 'schemaUrl', type: 'string' },
};

export const EXPORT_TRACE_REQUEST = {
  1: { name: 'resourceSpans', type: 'msg', repeated: true, schema: () => RESOURCE_SPANS },
};

/* -------------------------------- logs ---------------------------------- */

export const LOG_RECORD = {
  1: { name: 'timeUnixNano', type: 'fixed64' },
  2: { name: 'severityNumber', type: 'enum' },
  3: { name: 'severityText', type: 'string' },
  5: { name: 'body', type: 'msg', schema: () => ANY_VALUE },
  6: ATTRIBUTES,
  8: { name: 'flags', type: 'fixed32' },
  9: { name: 'traceId', type: 'hex' },
  10: { name: 'spanId', type: 'hex' },
  11: { name: 'observedTimeUnixNano', type: 'fixed64' },
  12: { name: 'eventName', type: 'string' },
};

export const SCOPE_LOGS = {
  1: { name: 'scope', type: 'msg', schema: () => INSTRUMENTATION_SCOPE },
  2: { name: 'logRecords', type: 'msg', repeated: true, schema: () => LOG_RECORD },
  3: { name: 'schemaUrl', type: 'string' },
};

export const RESOURCE_LOGS = {
  1: { name: 'resource', type: 'msg', schema: () => RESOURCE },
  2: { name: 'scopeLogs', type: 'msg', repeated: true, schema: () => SCOPE_LOGS },
  3: { name: 'schemaUrl', type: 'string' },
};

export const EXPORT_LOGS_REQUEST = {
  1: { name: 'resourceLogs', type: 'msg', repeated: true, schema: () => RESOURCE_LOGS },
};

/* ------------------------------- metrics -------------------------------- */

export const NUMBER_DATA_POINT = {
  2: { name: 'startTimeUnixNano', type: 'fixed64' },
  3: { name: 'timeUnixNano', type: 'fixed64' },
  4: { name: 'asDouble', type: 'double' },
  6: { name: 'asInt', type: 'sfixed64' },
  7: ATTRIBUTES,
  8: { name: 'flags', type: 'uint32' },
};

export const HISTOGRAM_DATA_POINT = {
  2: { name: 'startTimeUnixNano', type: 'fixed64' },
  3: { name: 'timeUnixNano', type: 'fixed64' },
  4: { name: 'count', type: 'fixed64' },
  5: { name: 'sum', type: 'double' },
  6: { name: 'bucketCounts', type: 'fixed64', repeated: true },
  7: { name: 'explicitBounds', type: 'double', repeated: true },
  9: ATTRIBUTES,
  10: { name: 'flags', type: 'uint32' },
  11: { name: 'min', type: 'double' },
  12: { name: 'max', type: 'double' },
};

export const GAUGE = {
  1: { name: 'dataPoints', type: 'msg', repeated: true, schema: () => NUMBER_DATA_POINT },
};

export const SUM = {
  1: { name: 'dataPoints', type: 'msg', repeated: true, schema: () => NUMBER_DATA_POINT },
  2: { name: 'aggregationTemporality', type: 'enum' },
  3: { name: 'isMonotonic', type: 'bool' },
};

export const HISTOGRAM = {
  1: { name: 'dataPoints', type: 'msg', repeated: true, schema: () => HISTOGRAM_DATA_POINT },
  2: { name: 'aggregationTemporality', type: 'enum' },
};

export const METRIC = {
  1: { name: 'name', type: 'string' },
  2: { name: 'description', type: 'string' },
  3: { name: 'unit', type: 'string' },
  5: { name: 'gauge', type: 'msg', schema: () => GAUGE },
  7: { name: 'sum', type: 'msg', schema: () => SUM },
  9: { name: 'histogram', type: 'msg', schema: () => HISTOGRAM },
};

export const SCOPE_METRICS = {
  1: { name: 'scope', type: 'msg', schema: () => INSTRUMENTATION_SCOPE },
  2: { name: 'metrics', type: 'msg', repeated: true, schema: () => METRIC },
  3: { name: 'schemaUrl', type: 'string' },
};

export const RESOURCE_METRICS = {
  1: { name: 'resource', type: 'msg', schema: () => RESOURCE },
  2: { name: 'scopeMetrics', type: 'msg', repeated: true, schema: () => SCOPE_METRICS },
  3: { name: 'schemaUrl', type: 'string' },
};

export const EXPORT_METRICS_REQUEST = {
  1: { name: 'resourceMetrics', type: 'msg', repeated: true, schema: () => RESOURCE_METRICS },
};

/** AggregationTemporality enum values. */
export const TEMPORALITY = { 0: 'unspecified', 1: 'delta', 2: 'cumulative' };

/** Status.StatusCode enum values. */
export const STATUS_CODE = { 0: 'unset', 1: 'ok', 2: 'error' };

/** Span.SpanKind enum values. */
export const SPAN_KIND = {
  0: 'unspecified',
  1: 'internal',
  2: 'server',
  3: 'client',
  4: 'producer',
  5: 'consumer',
};
