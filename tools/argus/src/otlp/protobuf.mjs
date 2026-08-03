/**
 * Minimal protobuf wire-format reader.
 *
 * The OTLP HTTP/protobuf exporter is the default transport recommended by the
 * Claude Agent SDK observability docs, so the collector has to speak it. Rather
 * than pulling in protobufjs we decode the handful of OTLP messages we care
 * about with a schema-driven reader — it keeps this tool dependency-free, which
 * matters because it is meant to be runnable inside ephemeral cloud sandboxes
 * with no npm install step.
 *
 * Schemas are plain objects: { [fieldNumber]: { name, type, repeated?, schema? } }
 * `schema` may be a thunk so recursive messages (AnyValue) can reference
 * themselves.
 */

const WIRE_VARINT = 0;
const WIRE_64BIT = 1;
const WIRE_LEN = 2;
const WIRE_START_GROUP = 3;
const WIRE_END_GROUP = 4;
const WIRE_32BIT = 5;

const TWO_POW_64 = 1n << 64n;
const TWO_POW_63 = 1n << 63n;

/** Numeric types that may appear packed inside a length-delimited field. */
const PACKABLE = new Set([
  'varint',
  'int64',
  'uint32',
  'bool',
  'enum',
  'fixed64',
  'sfixed64',
  'double',
  'fixed32',
  'float',
]);

export function readVarint(buf, pos) {
  let result = 0n;
  let shift = 0n;
  let byte;
  do {
    if (pos >= buf.length) throw new Error('protobuf: truncated varint');
    byte = buf[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    shift += 7n;
    if (shift > 70n) throw new Error('protobuf: varint longer than 10 bytes');
  } while (byte & 0x80);
  return [result, pos];
}

function skipField(buf, pos, wireType) {
  switch (wireType) {
    case WIRE_VARINT:
      return readVarint(buf, pos)[1];
    case WIRE_64BIT:
      return pos + 8;
    case WIRE_32BIT:
      return pos + 4;
    case WIRE_LEN: {
      const [len, next] = readVarint(buf, pos);
      return next + Number(len);
    }
    case WIRE_START_GROUP: {
      let depth = 1;
      while (depth > 0) {
        if (pos >= buf.length) throw new Error('protobuf: unterminated group');
        const [key, next] = readVarint(buf, pos);
        pos = next;
        const wt = Number(key & 7n);
        if (wt === WIRE_START_GROUP) depth++;
        else if (wt === WIRE_END_GROUP) depth--;
        else pos = skipField(buf, pos, wt);
      }
      return pos;
    }
    case WIRE_END_GROUP:
      return pos;
    default:
      throw new Error(`protobuf: unknown wire type ${wireType}`);
  }
}

/** int64/int32 arrive as two's-complement varints, not zigzag. */
function toSigned64(value) {
  return value >= TWO_POW_63 ? value - TWO_POW_64 : value;
}

/** Keep exactness where it matters (nanosecond clocks) but stay ergonomic. */
function bigToJs(value) {
  if (value >= -9007199254740991n && value <= 9007199254740991n) return Number(value);
  return value;
}

function resolveSchema(field) {
  const schema = field.schema;
  return typeof schema === 'function' ? schema() : schema;
}

function readScalar(buf, pos, wireType, field) {
  switch (field.type) {
    case 'string': {
      const [len, next] = readVarint(buf, pos);
      const end = next + Number(len);
      return [buf.toString('utf8', next, end), end];
    }
    case 'bytes': {
      const [len, next] = readVarint(buf, pos);
      const end = next + Number(len);
      return [buf.subarray(next, end), end];
    }
    case 'hex': {
      const [len, next] = readVarint(buf, pos);
      const end = next + Number(len);
      return [buf.toString('hex', next, end), end];
    }
    case 'varint':
    case 'uint32': {
      const [value, next] = readVarint(buf, pos);
      return [bigToJs(value), next];
    }
    case 'int64': {
      const [value, next] = readVarint(buf, pos);
      return [bigToJs(toSigned64(value)), next];
    }
    case 'bool': {
      const [value, next] = readVarint(buf, pos);
      return [value !== 0n, next];
    }
    case 'enum': {
      const [value, next] = readVarint(buf, pos);
      return [Number(value), next];
    }
    case 'fixed64':
      // Nanosecond timestamps live here; keep them as BigInt.
      return [buf.readBigUInt64LE(pos), pos + 8];
    case 'sfixed64':
      return [bigToJs(buf.readBigInt64LE(pos)), pos + 8];
    case 'double':
      return [buf.readDoubleLE(pos), pos + 8];
    case 'float':
      return [buf.readFloatLE(pos), pos + 4];
    case 'fixed32':
      return [buf.readUInt32LE(pos), pos + 4];
    case 'msg': {
      const [len, next] = readVarint(buf, pos);
      const end = next + Number(len);
      return [decodeMessage(buf, resolveSchema(field), next, end), end];
    }
    default:
      throw new Error(`protobuf: unsupported field type ${field.type}`);
  }
}

function readPacked(buf, pos, field) {
  const [len, next] = readVarint(buf, pos);
  const end = next + Number(len);
  const values = [];
  let cursor = next;
  while (cursor < end) {
    let value;
    // Packed entries carry no wire type of their own; the field type decides.
    [value, cursor] = readScalar(buf, cursor, null, field);
    values.push(value);
  }
  if (cursor !== end) throw new Error('protobuf: packed field overran its length');
  return [values, end];
}

/**
 * Decode a protobuf message into a plain object using `schema`.
 * Unknown fields are skipped, which is what makes this forward-compatible with
 * newer OTLP revisions.
 */
export function decodeMessage(buf, schema, start = 0, end = buf.length) {
  const out = {};
  let pos = start;
  while (pos < end) {
    const [key, afterKey] = readVarint(buf, pos);
    pos = afterKey;
    const fieldNo = Number(key >> 3n);
    const wireType = Number(key & 7n);
    const field = schema[fieldNo];
    if (!field) {
      pos = skipField(buf, pos, wireType);
      continue;
    }
    if (field.repeated && wireType === WIRE_LEN && PACKABLE.has(field.type)) {
      const [values, next] = readPacked(buf, pos, field);
      pos = next;
      (out[field.name] ??= []).push(...values);
      continue;
    }
    const [value, next] = readScalar(buf, pos, wireType, field);
    pos = next;
    if (field.repeated) (out[field.name] ??= []).push(value);
    else out[field.name] = value;
  }
  if (pos !== end) throw new Error('protobuf: message overran its length');
  return out;
}

/* --------------------------------------------------------------------------
 * Encoder — only used by the test suite and the demo emitter, which need to
 * produce protobuf payloads to prove the decoder round-trips.
 * ------------------------------------------------------------------------ */

function encodeVarint(value) {
  let v = BigInt(value);
  if (v < 0n) v += TWO_POW_64;
  const bytes = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (v > 0n);
  return Buffer.from(bytes);
}

function encodeKey(fieldNo, wireType) {
  return encodeVarint((BigInt(fieldNo) << 3n) | BigInt(wireType));
}

function encodeScalar(field, value) {
  switch (field.type) {
    case 'string':
      return Buffer.from(String(value), 'utf8');
    case 'bytes':
      return Buffer.from(value);
    case 'hex':
      return Buffer.from(String(value), 'hex');
    case 'msg':
      return encodeMessage(value, resolveSchema(field));
    default:
      throw new Error(`protobuf: cannot length-encode ${field.type}`);
  }
}

/** Mirror of {@link decodeMessage}; supports the same schema descriptors. */
export function encodeMessage(obj, schema) {
  const chunks = [];
  for (const [fieldNoRaw, field] of Object.entries(schema)) {
    const value = obj?.[field.name];
    if (value === undefined || value === null) continue;
    const fieldNo = Number(fieldNoRaw);
    const values = field.repeated ? value : [value];
    for (const item of values) {
      if (item === undefined || item === null) continue;
      switch (field.type) {
        case 'varint':
        case 'int64':
        case 'uint32':
        case 'enum':
          chunks.push(encodeKey(fieldNo, WIRE_VARINT), encodeVarint(item));
          break;
        case 'bool':
          chunks.push(encodeKey(fieldNo, WIRE_VARINT), encodeVarint(item ? 1 : 0));
          break;
        case 'fixed64': {
          const b = Buffer.allocUnsafe(8);
          b.writeBigUInt64LE(BigInt(item));
          chunks.push(encodeKey(fieldNo, WIRE_64BIT), b);
          break;
        }
        case 'sfixed64': {
          const b = Buffer.allocUnsafe(8);
          b.writeBigInt64LE(BigInt(item));
          chunks.push(encodeKey(fieldNo, WIRE_64BIT), b);
          break;
        }
        case 'double': {
          const b = Buffer.allocUnsafe(8);
          b.writeDoubleLE(item);
          chunks.push(encodeKey(fieldNo, WIRE_64BIT), b);
          break;
        }
        case 'fixed32': {
          const b = Buffer.allocUnsafe(4);
          b.writeUInt32LE(item);
          chunks.push(encodeKey(fieldNo, WIRE_32BIT), b);
          break;
        }
        default: {
          const payload = encodeScalar(field, item);
          chunks.push(encodeKey(fieldNo, WIRE_LEN), encodeVarint(payload.length), payload);
        }
      }
    }
  }
  return Buffer.concat(chunks);
}
