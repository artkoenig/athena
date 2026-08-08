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
const SUBAGENT_TYPES = ['general-purpose', 'code-reviewer', 'test-runner'];
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

/**
 * A Messages-API request body, in the shape `OTEL_LOG_RAW_API_BODIES=1` puts on
 * `claude_code.api_request_body`: the whole conversation as it stood when the
 * call was made. Small here — a real one runs to hundreds of kilobytes — but the
 * same structure, so a message list rendered from it renders from the real one.
 */
function requestBodyOf(model, prompt, turnSequence) {
  const messages = [{ role: 'user', content: [{ type: 'text', text: prompt }] }];
  for (let i = 1; i < turnSequence; i++) {
    messages.push({ role: 'assistant', content: [{ type: 'text', text: `Working on it (turn ${i}).` }] });
    messages.push({ role: 'user', content: [{ type: 'text', text: 'Carry on.' }] });
  }
  return JSON.stringify({
    model,
    max_tokens: 8192,
    system: [{ type: 'text', text: 'You are Claude Code, running in a demo session.' }],
    messages,
  });
}

/** The matching response body: what the model sent back. */
function responseBodyOf(model, outputTokens) {
  return JSON.stringify({
    id: `msg_${hexId(8)}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: 'Here is what I found.' }],
    stop_reason: 'tool_use',
    usage: { input_tokens: 0, output_tokens: outputTokens },
  });
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

  // `spanId` is what attributes a log to a lane: a subagent's events sit on the
  // execution span of the Agent call that dispatched it, not on the interaction.
  const record = (name, attributes, timeMs = cursor, severity = 9, spanId = interactionId) => {
    logs.push({
      timeUnixNano: nanos(timeMs),
      observedTimeUnixNano: nanos(timeMs),
      severityNumber: severity,
      severityText: severity >= 17 ? 'ERROR' : 'INFO',
      eventName: name,
      body: { stringValue: name.replace('claude_code.', '') },
      traceId,
      spanId,
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

  const emitLlmCall = ({
    parentSpanId = interactionId,
    logSpanId = interactionId,
    querySource = 'sdk',
    agentId = null,
  } = {}) => {
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
        parentSpanId,
        name: 'claude_code.llm_request',
        startMs: cursor,
        durationMs: duration,
        error: failed ? 'overloaded_error' : null,
        attributes: {
          'session.id': sessionId,
          'span.type': 'claude_code.llm_request',
          'gen_ai.system': 'anthropic',
          model,
          agent_id: agentId ?? undefined,
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
    // What the call was sent, with the context it carried — the pair
    // OTEL_LOG_RAW_API_BODIES=1 produces, and what a timeline scrub reads back.
    const requestBody = requestBodyOf(model, prompt, sequence);
    record(
      'claude_code.api_request_body',
      {
        model,
        body: requestBody,
        body_length: requestBody.length,
        body_truncated: false,
        query_source: querySource,
        'prompt.id': `prompt_${hexId(4)}`,
      },
      cursor,
      9,
      logSpanId,
    );
    if (failed) {
      record(
        'claude_code.api_error',
        { model, error: 'overloaded_error', status_code: 529, duration_ms: Math.round(duration), attempt: 1 },
        cursor + duration,
        17,
        logSpanId,
      );
    } else {
      const responseBody = responseBodyOf(model, output);
      record(
        'claude_code.api_response_body',
        {
          model,
          body: responseBody,
          body_length: responseBody.length,
          body_truncated: false,
          query_source: querySource,
          request_id: `req_${hexId(6)}`,
        },
        cursor + duration,
        9,
        logSpanId,
      );
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
          'agent.name': agentId ? querySource.slice(querySource.lastIndexOf(':') + 1) : undefined,
        },
        cursor + duration,
        9,
        logSpanId,
      );
    }
    cursor += duration;
  };

  /**
   * One dispatched subagent: the `Agent` tool call, the execution span every one
   * of its records hangs beneath, its own model calls, and the completion event
   * that closes it. Without this the generator produces a single lane and the
   * lane view has nothing to show without a live agent.
   */
  const emitSubagent = () => {
    const agentType = pick(SUBAGENT_TYPES);
    const toolUseId = `toolu_${hexId(6)}`;
    const agentId = hexId(8);
    const toolSpanId = hexId(8);
    const execSpanId = hexId(8);
    const startedAt = cursor;

    record(
      'claude_code.tool_decision',
      { tool_name: 'Agent', tool_use_id: toolUseId, decision: 'accept', tool_source: 'builtin', source: 'config' },
      cursor,
    );
    for (let i = 0; i < 2; i++) {
      emitLlmCall({
        parentSpanId: execSpanId,
        logSpanId: execSpanId,
        querySource: `agent:builtin:${agentType}`,
        agentId,
      });
    }
    const duration = cursor - startedAt;

    children.push(
      span({
        traceId,
        spanId: toolSpanId,
        parentSpanId: interactionId,
        name: 'claude_code.tool',
        startMs: startedAt,
        durationMs: duration,
        attributes: {
          'session.id': sessionId,
          'span.type': 'claude_code.tool',
          tool_name: 'Agent',
          tool_use_id: toolUseId,
          subagent_type: agentType,
          duration_ms: Math.round(duration),
        },
      }),
      span({
        traceId,
        spanId: execSpanId,
        parentSpanId: toolSpanId,
        name: 'claude_code.tool.execution',
        startMs: startedAt,
        durationMs: duration,
        attributes: {
          'session.id': sessionId,
          'span.type': 'claude_code.tool.execution',
          tool_use_id: toolUseId,
          duration_ms: Math.round(duration),
          success: true,
        },
      }),
    );
    record(
      'claude_code.subagent_completed',
      {
        agent_type: agentType,
        'agent.source': 'builtin',
        is_built_in: true,
        is_async: false,
        duration_ms: Math.round(duration),
        total_tokens: randInt(2000, 40_000),
        total_tool_uses: randInt(1, 6),
      },
      cursor,
      9,
      execSpanId,
    );
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

  // One subagent per session, in its first turn: enough for a second lane to
  // exist everywhere, without every turn sprouting one.
  if (sequence === 1) emitSubagent();

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
