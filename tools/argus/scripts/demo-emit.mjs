#!/usr/bin/env node
/**
 * Emit a synthetic Claude Code session over OTLP so the UI can be exercised
 * without burning tokens on a real agent run.
 *
 * It encodes real protobuf payloads with the same schemas the collector decodes,
 * which makes it a useful end-to-end smoke test of the ingest path as well as a
 * demo fixture.
 *
 *   node scripts/demo-emit.mjs --endpoint http://localhost:4318 --sessions 3
 *   node scripts/demo-emit.mjs --live          # keep appending turns forever
 */

import crypto from 'node:crypto';
import { encodeMessage } from '../src/otlp/protobuf.mjs';
import {
  EXPORT_TRACE_REQUEST,
  EXPORT_METRICS_REQUEST,
  EXPORT_LOGS_REQUEST,
} from '../src/otlp/schema.mjs';
import { parseArgs } from '../src/config.mjs';

const { flags } = parseArgs(process.argv.slice(2));
const ENDPOINT = (flags.endpoint ?? process.env.UROBOROS_OBS_ENDPOINT ?? 'http://localhost:4318').replace(/\/$/, '');
const TOKEN = flags.token ?? process.env.UROBOROS_OBS_TOKEN ?? null;
const SESSIONS = Number(flags.sessions ?? 2);
const LIVE = Boolean(flags.live);

const MODELS = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'];
const TOOLS = ['Read', 'Bash', 'Edit', 'Grep', 'Glob', 'WebFetch'];
const PROMPTS = [
  'Add OpenTelemetry export to the worker service',
  'Why is the nightly job flaking?',
  'Refactor the session store to use a ring buffer',
  'Write tests for the OTLP decoder',
];

const rand = (min, max) => min + Math.random() * (max - min);
const randInt = (min, max) => Math.floor(rand(min, max + 1));
const pick = (list) => list[randInt(0, list.length - 1)];
const hexId = (bytes) => crypto.randomBytes(bytes).toString('hex');
const nanos = (ms) => BigInt(Math.round(ms * 1e6));

/** Build an OTLP KeyValue list from a plain object, inferring AnyValue types. */
function attrs(object) {
  return Object.entries(object)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => {
      let anyValue;
      if (typeof value === 'boolean') anyValue = { boolValue: value };
      else if (typeof value === 'number') {
        anyValue = Number.isInteger(value) ? { intValue: value } : { doubleValue: value };
      } else anyValue = { stringValue: String(value) };
      return { key, value: anyValue };
    });
}

async function post(path, schema, payload) {
  const body = encodeMessage(payload, schema);
  const headers = { 'content-type': 'application/x-protobuf' };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  const response = await fetch(`${ENDPOINT}${path}`, { method: 'POST', headers, body });
  if (!response.ok) throw new Error(`${path} -> ${response.status} ${await response.text()}`);
}

function resource(sessionId) {
  return {
    attributes: attrs({
      'service.name': 'uroboros-demo-agent',
      'service.version': '0.1.0',
      'deployment.environment': 'demo',
      'session.id': sessionId,
    }),
  };
}

const scope = { name: 'argus-demo', version: '0.1.0' };

function span({ traceId, spanId, parentSpanId, name, startMs, durationMs, attributes, error }) {
  return {
    traceId,
    spanId,
    parentSpanId,
    name,
    kind: 1,
    startTimeUnixNano: nanos(startMs),
    endTimeUnixNano: nanos(startMs + durationMs),
    attributes: attrs(attributes),
    status: error ? { code: 2, message: error } : { code: 1 },
  };
}

/** One agent turn: prompt -> model call -> tools -> model call -> response. */
function buildTurn(sessionId, sequence, startMs) {
  const traceId = hexId(16);
  const interactionId = hexId(8);
  const spans = [];
  const logs = [];
  const metrics = [];
  const prompt = pick(PROMPTS);
  const model = pick(MODELS);
  let cursor = startMs;

  const record = (name, attributes, timeMs = cursor, severity = 9) => {
    logs.push({
      timeUnixNano: nanos(timeMs),
      observedTimeUnixNano: nanos(timeMs),
      severityNumber: severity,
      severityText: severity >= 17 ? 'ERROR' : 'INFO',
      eventName: name,
      body: { stringValue: name.replace('claude_code.', '') },
      traceId,
      spanId: interactionId,
      attributes: attrs({
        'session.id': sessionId,
        'event.name': name.replace('claude_code.', ''),
        'event.timestamp': new Date(timeMs).toISOString(),
        'event.sequence': sequence,
        ...attributes,
      }),
    });
  };

  record('claude_code.user_prompt', { prompt, prompt_length: prompt.length });

  const children = [];
  const toolCount = randInt(1, 3);
  let tokensIn = 0;
  let tokensOut = 0;
  let cacheRead = 0;
  let cacheCreation = 0;
  let cost = 0;

  const emitLlmCall = () => {
    const duration = rand(700, 4200);
    const ttft = rand(180, 900);
    const input = randInt(400, 2500);
    const output = randInt(80, 1400);
    const cached = randInt(2000, 40_000);
    const created = randInt(0, 4000);
    tokensIn += input;
    tokensOut += output;
    cacheRead += cached;
    cacheCreation += created;
    const callCost = input * 3e-6 + output * 1.5e-5 + cached * 3e-7;
    cost += callCost;
    const failed = Math.random() < 0.06;
    children.push(
      span({
        traceId,
        spanId: hexId(8),
        parentSpanId: interactionId,
        name: 'claude_code.llm_request',
        startMs: cursor,
        durationMs: duration,
        error: failed ? 'overloaded_error' : null,
        attributes: {
          'session.id': sessionId,
          'span.type': 'claude_code.llm_request',
          'gen_ai.system': 'anthropic',
          model,
          query_source: 'repl_main_thread',
          llm_request_context: 'interaction',
          duration_ms: Math.round(duration),
          ttft_ms: Math.round(ttft),
          input_tokens: input,
          output_tokens: output,
          cache_read_tokens: cached,
          cache_creation_tokens: created,
          attempt: 1,
          success: !failed,
          stop_reason: failed ? undefined : 'tool_use',
          'response.has_tool_call': !failed,
        },
      }),
    );
    if (failed) {
      record(
        'claude_code.api_error',
        { model, error: 'overloaded_error', status_code: 529, duration_ms: Math.round(duration), attempt: 1 },
        cursor + duration,
        17,
      );
    } else {
      record(
        'claude_code.api_request',
        {
          model,
          duration_ms: Math.round(duration),
          input_tokens: input,
          output_tokens: output,
          cache_read_tokens: cached,
          cache_creation_tokens: created,
          cost_usd_micros: Math.round(callCost * 1e6),
          query_source: 'main',
        },
        cursor + duration,
      );
    }
    cursor += duration;
  };

  emitLlmCall();

  for (let i = 0; i < toolCount; i++) {
    const toolName = pick(TOOLS);
    const toolUseId = `toolu_${hexId(6)}`;
    const blocked = Math.random() < 0.3 ? rand(200, 2600) : 0;
    const execution = rand(30, 2200);
    const failed = Math.random() < 0.12;
    const toolSpanId = hexId(8);
    children.push(
      span({
        traceId,
        spanId: toolSpanId,
        parentSpanId: interactionId,
        name: 'claude_code.tool',
        startMs: cursor,
        durationMs: blocked + execution,
        attributes: {
          'session.id': sessionId,
          'span.type': 'claude_code.tool',
          tool_name: toolName,
          tool_use_id: toolUseId,
          duration_ms: Math.round(blocked + execution),
          result_tokens: randInt(20, 3000),
        },
      }),
    );
    if (blocked) {
      children.push(
        span({
          traceId,
          spanId: hexId(8),
          parentSpanId: toolSpanId,
          name: 'claude_code.tool.blocked_on_user',
          startMs: cursor,
          durationMs: blocked,
          attributes: {
            'session.id': sessionId,
            'span.type': 'claude_code.tool.blocked_on_user',
            tool_name: toolName,
            duration_ms: Math.round(blocked),
            decision: 'accept',
            source: 'user_temporary',
          },
        }),
      );
    }
    children.push(
      span({
        traceId,
        spanId: hexId(8),
        parentSpanId: toolSpanId,
        name: 'claude_code.tool.execution',
        startMs: cursor + blocked,
        durationMs: execution,
        error: failed ? 'Error:ENOENT' : null,
        attributes: {
          'session.id': sessionId,
          'span.type': 'claude_code.tool.execution',
          tool_use_id: toolUseId,
          duration_ms: Math.round(execution),
          success: !failed,
          error: failed ? 'Error:ENOENT' : undefined,
        },
      }),
    );
    record(
      'claude_code.tool_decision',
      { tool_name: toolName, tool_use_id: toolUseId, decision: 'accept', tool_source: 'builtin', source: 'config' },
      cursor,
    );
    record(
      'claude_code.tool_result',
      {
        tool_name: toolName,
        tool_use_id: toolUseId,
        success: !failed,
        duration_ms: Math.round(execution),
        error_type: failed ? 'ENOENT' : undefined,
        tool_result_size_bytes: randInt(120, 90_000),
      },
      cursor + blocked + execution,
      failed ? 17 : 9,
    );
    cursor += blocked + execution;
  }

  emitLlmCall();
  record('claude_code.assistant_response', { model, response_length: randInt(200, 4000) }, cursor);

  const total = cursor - startMs;
  spans.push(
    span({
      traceId,
      spanId: interactionId,
      parentSpanId: undefined,
      name: 'claude_code.interaction',
      startMs,
      durationMs: total,
      attributes: {
        'session.id': sessionId,
        'span.type': 'claude_code.interaction',
        user_prompt: prompt,
        user_prompt_length: prompt.length,
        'interaction.sequence': sequence,
        'interaction.duration_ms': Math.round(total),
      },
    }),
    ...children,
  );

  const counter = (name, unit, points) => ({
    name,
    unit,
    description: '',
    sum: { dataPoints: points, aggregationTemporality: 1, isMonotonic: true },
  });
  const point = (value, attributes, asDouble = false) => ({
    startTimeUnixNano: nanos(startMs),
    timeUnixNano: nanos(cursor),
    ...(asDouble ? { asDouble: value } : { asInt: Math.round(value) }),
    attributes: attrs({ 'session.id': sessionId, ...attributes }),
  });

  metrics.push(
    counter('claude_code.token.usage', 'tokens', [
      point(tokensIn, { type: 'input', model, query_source: 'main' }),
      point(tokensOut, { type: 'output', model, query_source: 'main' }),
      point(cacheRead, { type: 'cacheRead', model, query_source: 'main' }),
      point(cacheCreation, { type: 'cacheCreation', model, query_source: 'main' }),
    ]),
    counter('claude_code.cost.usage', 'USD', [point(cost, { model, query_source: 'main' }, true)]),
    counter('claude_code.active_time.total', 's', [point(total / 1000, { type: 'cli' }, true)]),
  );
  if (Math.random() < 0.5) {
    metrics.push(
      counter('claude_code.lines_of_code.count', '', [
        point(randInt(1, 120), { type: 'added', model }),
        point(randInt(0, 60), { type: 'removed', model }),
      ]),
    );
  }

  return { spans, logs, metrics, endMs: cursor };
}

async function emitTurn(sessionId, sequence, startMs) {
  const { spans, logs, metrics, endMs } = buildTurn(sessionId, sequence, startMs);
  const res = resource(sessionId);
  await post('/v1/traces', EXPORT_TRACE_REQUEST, {
    resourceSpans: [{ resource: res, scopeSpans: [{ scope, spans }] }],
  });
  await post('/v1/logs', EXPORT_LOGS_REQUEST, {
    resourceLogs: [{ resource: res, scopeLogs: [{ scope, logRecords: logs }] }],
  });
  await post('/v1/metrics', EXPORT_METRICS_REQUEST, {
    resourceMetrics: [{ resource: res, scopeMetrics: [{ scope, metrics }] }],
  });
  return endMs;
}

async function emitSessionStart(sessionId, startMs) {
  await post('/v1/metrics', EXPORT_METRICS_REQUEST, {
    resourceMetrics: [
      {
        resource: resource(sessionId),
        scopeMetrics: [
          {
            scope,
            metrics: [
              {
                name: 'claude_code.session.count',
                unit: '',
                sum: {
                  aggregationTemporality: 1,
                  isMonotonic: true,
                  dataPoints: [
                    {
                      startTimeUnixNano: nanos(startMs),
                      timeUnixNano: nanos(startMs),
                      asInt: 1,
                      attributes: attrs({
                        'session.id': sessionId,
                        start_type: 'fresh',
                        'app.entrypoint': 'sdk-ts',
                        'app.version': '2.1.220',
                      }),
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  });
}

async function main() {
  const now = Date.now();
  const sessionIds = [];
  for (let i = 0; i < SESSIONS; i++) {
    const sessionId = crypto.randomUUID();
    sessionIds.push(sessionId);
    let cursor = now - (SESSIONS - i) * rand(60_000, 900_000);
    await emitSessionStart(sessionId, cursor);
    const turns = randInt(2, 5);
    for (let turn = 1; turn <= turns; turn++) {
      cursor = (await emitTurn(sessionId, turn, cursor)) + rand(500, 8000);
    }
    console.log(`emitted session ${sessionId} (${turns} turns)`);
  }

  if (!LIVE) {
    console.log(`\ndone — open ${ENDPOINT}`);
    return;
  }

  const liveSession = sessionIds[sessionIds.length - 1];
  let sequence = 100;
  console.log(`\nlive mode: appending turns to ${liveSession} every few seconds (ctrl-c to stop)`);
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, rand(3000, 9000)));
    await emitTurn(liveSession, sequence++, Date.now());
    console.log(`  turn ${sequence - 1}`);
  }
}

main().catch((error) => {
  console.error(`demo-emit: ${error.message}`);
  process.exit(1);
});
