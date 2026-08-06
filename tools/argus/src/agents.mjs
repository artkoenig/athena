/**
 * Per-agent aggregation: the second axis inside a session.
 *
 * A session is one conversation plus every subagent that ran inside it, and the
 * session totals answer "what did all of that cost" without saying which of them
 * spent it. An agent bucket is the same aggregate narrowed to one of them, plus
 * the one figure the session has no equivalent for: how full that agent's
 * context window was at each model call.
 *
 * The lifetimes here mirror the store's own. Figures (counts, tokens, cost,
 * models, occupancy, body metadata, completions) are cumulative and stay correct
 * after the raw window has rolled over. Content (prompt text, response text, tool
 * arguments, request payloads) is never copied into a bucket: the bucket keeps
 * the record's `seq` and the read path joins back against the raw log and span
 * windows, so captured payloads fall under exactly the retention the raw records
 * already have and no separate cap has to be reasoned about.
 */

import {
  EMPTY_TOKENS,
  EVENT,
  MAIN_AGENT_KEY,
  SPAN,
  agentRefOf,
  bool,
  num,
  toolParametersOf,
} from './claude.mjs';

/** Occupancy entries and request-body index entries kept per agent. */
export const MAX_AGENT_CALLS = 100;
/** Subagent completion records kept per agent. */
const MAX_AGENT_COMPLETIONS = 50;

/** Prefix marking a bucket keyed by an `agent_id` nothing has named yet. */
const ID_PREFIX = 'id:';
/** Bucket key for records that say "a subagent" without saying which one. */
const UNNAMED_SUBAGENT_KEY = 'subagent';
/** Span event carrying tool input/output, gated by OTEL_LOG_TOOL_CONTENT=1. */
const TOOL_OUTPUT_EVENT = 'tool.output';

export function emptyModelStats() {
  return {
    requests: 0,
    errors: 0,
    durationMsTotal: 0,
    ttftMsTotal: 0,
    ttftCount: 0,
    tokensMetric: EMPTY_TOKENS(),
    tokensEvent: EMPTY_TOKENS(),
    costMetric: 0,
    costEvent: 0,
  };
}

export function emptyToolStats() {
  return {
    calls: 0,
    failures: 0,
    rejected: 0,
    durationMsTotal: 0,
    resultTokens: 0,
    // Portion of resultTokens that is an estimate (see store.mjs #applyToolJoin)
    // rather than the CLI's own `result_tokens` attribute.
    resultTokensEstimated: 0,
  };
}

const hasTokens = (tokens) => Object.values(tokens).some((value) => value > 0);

/**
 * Metrics, events and spans all carry overlapping token/cost data. Preferring
 * metrics and falling back to events means the numbers stay right whether the
 * user enabled OTEL_METRICS_EXPORTER, OTEL_LOGS_EXPORTER, or both — without
 * double counting when both are on.
 */
export function mergeUsage(tokensMetric, tokensEvent, costMetric, costEvent) {
  const metricTokens = hasTokens(tokensMetric);
  const tokens = metricTokens ? { ...tokensMetric } : { ...tokensEvent };
  const tokensTotal = Object.values(tokens).reduce((sum, value) => sum + value, 0);
  return {
    tokens,
    tokensTotal,
    tokenSource: metricTokens ? 'metrics' : hasTokens(tokensEvent) ? 'events' : 'none',
    costUsd: costMetric > 0 ? costMetric : costEvent,
    costSource: costMetric > 0 ? 'metrics' : costEvent > 0 ? 'events' : 'none',
  };
}

/** The models table, as both the session summary and an agent summary serve it. */
export function summarizeModels(models) {
  return [...models.entries()]
    .map(([name, stats]) => ({
      name,
      requests: stats.requests,
      errors: stats.errors,
      durationMsTotal: Math.round(stats.durationMsTotal),
      avgDurationMs: stats.requests ? Math.round(stats.durationMsTotal / stats.requests) : 0,
      avgTtftMs: stats.ttftCount ? Math.round(stats.ttftMsTotal / stats.ttftCount) : 0,
      ...mergeUsage(stats.tokensMetric, stats.tokensEvent, stats.costMetric, stats.costEvent),
    }))
    .sort((a, b) => b.tokensTotal - a.tokensTotal || b.requests - a.requests);
}

/** The tools table, shared the same way. */
export function summarizeTools(tools) {
  return [...tools.entries()]
    .map(([name, stats]) => ({
      name,
      ...stats,
      durationMsTotal: Math.round(stats.durationMsTotal),
      avgDurationMs: stats.calls ? Math.round(stats.durationMsTotal / stats.calls) : 0,
    }))
    .sort((a, b) => b.calls - a.calls);
}

/* --------------------------------- buckets -------------------------------- */

export function newAgent(ref, atMs) {
  return {
    key: ref.key,
    name: ref.name,
    kind: ref.kind,
    agentIds: new Set(),
    querySources: new Set(),
    firstSeenMs: atMs,
    lastSeenMs: atMs,
    counts: {
      apiRequests: 0,
      apiErrors: 0,
      llmRequests: 0,
      userPrompts: 0,
      assistantResponses: 0,
      toolCalls: 0,
      toolFailures: 0,
    },
    tokensMetric: EMPTY_TOKENS(),
    tokensEvent: EMPTY_TOKENS(),
    costMetric: 0,
    costEvent: 0,
    models: new Map(),
    tools: new Map(),
    occupancy: [],
    peakOccupancy: 0,
    lastOccupancy: 0,
    lastCachedPrefixTokens: 0,
    lastFreshTokens: 0,
    bodies: [],
    completions: [],
  };
}

/**
 * The bucket a record belongs to, created on first sight.
 *
 * Spans carry `agent_id` and no name, the events that carry a name carry no id,
 * and the two signals arrive on independent pipelines — so an id-keyed bucket is
 * opened for whichever comes first and folded into the named one as soon as any
 * record carries both. Nothing is guessed: the join is on an identifier the CLI
 * itself put on both records.
 */
export function agentBucketFor(session, record, ref, maxAgentCalls = MAX_AGENT_CALLS) {
  const startMs = record.startMs || record.timeMs || 0;
  const endMs = record.endMs || startMs;

  let key = ref.key;
  if (key.startsWith(ID_PREFIX)) {
    const known = session.agentByAgentId.get(key.slice(ID_PREFIX.length));
    if (known) key = known;
  }

  let agent = session.agents.get(key);
  if (!agent) {
    agent = newAgent({ ...ref, key }, startMs);
    session.agents.set(key, agent);
  }
  if (ref.name && !agent.name) agent.name = ref.name;
  if (startMs > 0) {
    agent.firstSeenMs = agent.firstSeenMs > 0 ? Math.min(agent.firstSeenMs, startMs) : startMs;
    agent.lastSeenMs = Math.max(agent.lastSeenMs, endMs);
  }
  if (ref.agentId) agent.agentIds.add(ref.agentId);
  const source = record.attrs?.query_source;
  if (typeof source === 'string' && source !== '') agent.querySources.add(source);

  if (ref.agentId && key !== `${ID_PREFIX}${ref.agentId}`) {
    session.agentByAgentId.set(ref.agentId, key);
    const orphan = session.agents.get(`${ID_PREFIX}${ref.agentId}`);
    if (orphan && orphan !== agent) {
      mergeAgent(agent, orphan, maxAgentCalls);
      session.agents.delete(`${ID_PREFIX}${ref.agentId}`);
    }
  }
  return agent;
}

function mergeStats(targetMap, sourceMap, empty) {
  for (const [name, stats] of sourceMap) {
    let into = targetMap.get(name);
    if (!into) {
      into = empty();
      targetMap.set(name, into);
    }
    for (const [field, value] of Object.entries(stats)) {
      if (typeof value === 'number') into[field] += value;
      else for (const token of Object.keys(value)) into[field][token] += value[token];
    }
  }
}

const lastAtMs = (ring) => (ring.length ? ring[ring.length - 1].atMs : -1);

/** Fold an id-keyed bucket into the named bucket it turned out to be. */
export function mergeAgent(target, source, maxAgentCalls = MAX_AGENT_CALLS) {
  for (const field of Object.keys(target.counts)) target.counts[field] += source.counts[field];
  for (const field of Object.keys(target.tokensMetric)) {
    target.tokensMetric[field] += source.tokensMetric[field];
    target.tokensEvent[field] += source.tokensEvent[field];
  }
  target.costMetric += source.costMetric;
  target.costEvent += source.costEvent;
  mergeStats(target.models, source.models, emptyModelStats);
  mergeStats(target.tools, source.tools, emptyToolStats);

  // The later of the two last model calls is the one whose prompt shape still
  // describes the agent's context, so read the `last*` fields off that side
  // before the two series are interleaved.
  const takeSourceLast = source.occupancy.length > 0 && lastAtMs(source.occupancy) >= lastAtMs(target.occupancy);
  if (takeSourceLast) {
    target.lastOccupancy = source.lastOccupancy;
    target.lastCachedPrefixTokens = source.lastCachedPrefixTokens;
    target.lastFreshTokens = source.lastFreshTokens;
  }
  target.peakOccupancy = Math.max(target.peakOccupancy, source.peakOccupancy);

  target.occupancy = trimRing([...target.occupancy, ...source.occupancy], maxAgentCalls);
  target.bodies = trimRing([...target.bodies, ...source.bodies], maxAgentCalls);
  target.completions = trimRing([...target.completions, ...source.completions], MAX_AGENT_COMPLETIONS);

  if (source.firstSeenMs > 0) {
    target.firstSeenMs = target.firstSeenMs > 0 ? Math.min(target.firstSeenMs, source.firstSeenMs) : source.firstSeenMs;
  }
  target.lastSeenMs = Math.max(target.lastSeenMs, source.lastSeenMs);
  for (const id of source.agentIds) target.agentIds.add(id);
  for (const value of source.querySources) target.querySources.add(value);
  return target;
}

function trimRing(entries, max) {
  entries.sort((a, b) => a.atMs - b.atMs);
  return entries.length > max ? entries.slice(entries.length - max) : entries;
}

/** Append to a bounded ring, dropping the oldest entry once it is full. */
export function pushRing(ring, entry, max) {
  ring.push(entry);
  while (ring.length > max) ring.shift();
}

export { MAX_AGENT_COMPLETIONS };

/* -------------------------------- summaries ------------------------------- */

const KIND_ORDER = { main: 0, subagent: 1, system: 2 };

/** What the UI puts at the head of an agent card. */
function labelOf(agent) {
  if (agent.kind === 'main') return 'main session';
  if (agent.key === UNNAMED_SUBAGENT_KEY) return 'subagent (name not exported)';
  if (agent.key.startsWith(ID_PREFIX)) {
    return `subagent ${agent.key.slice(ID_PREFIX.length, ID_PREFIX.length + 8)}`;
  }
  return agent.name ?? agent.key;
}

function summarizeAgent(agent) {
  const usage = mergeUsage(agent.tokensMetric, agent.tokensEvent, agent.costMetric, agent.costEvent);
  return {
    key: agent.key,
    name: agent.name,
    label: labelOf(agent),
    kind: agent.kind,
    agentIds: [...agent.agentIds],
    querySources: [...agent.querySources],
    firstSeenMs: agent.firstSeenMs,
    lastSeenMs: agent.lastSeenMs,
    durationMs: Math.max(0, agent.lastSeenMs - agent.firstSeenMs),
    counts: { ...agent.counts },
    ...usage,
    models: summarizeModels(agent.models),
    tools: summarizeTools(agent.tools),
    context: {
      series: agent.occupancy.map((entry) => ({ ...entry })),
      peakOccupancy: agent.peakOccupancy,
      lastOccupancy: agent.lastOccupancy,
      lastCachedPrefixTokens: agent.lastCachedPrefixTokens,
      lastFreshTokens: agent.lastFreshTokens,
      // Undefined rather than zero when the agent never made a model call:
      // "no cached prefix" and "no prompt to have one" are different answers.
      lastCachedPrefixRatio: agent.lastOccupancy > 0
        ? agent.lastCachedPrefixTokens / agent.lastOccupancy
        : null,
    },
    bodies: agent.bodies.map((entry) => ({ ...entry })),
    completions: agent.completions.map((entry) => ({ ...entry })),
  };
}

export function summarizeAgents(session) {
  return [...session.agents.values()]
    .map((agent) => summarizeAgent(agent))
    .sort(
      (a, b) =>
        KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
        a.firstSeenMs - b.firstSeenMs ||
        (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );
}

/**
 * Which content the session actually exported, and the switch behind each kind.
 *
 * Every one of these is off by default, and an empty panel is indistinguishable
 * from a quiet agent unless the interface can say which variable would have
 * filled it. `seen` is how many records of the carrying kind arrived, so "0 of
 * 40 prompts carried their text" reads as a setting rather than as no data.
 */
export function summarizeCapture(session) {
  const c = session.capture;
  return {
    prompts: { switch: 'OTEL_LOG_USER_PROMPTS', present: c.promptText, seen: c.promptEvents },
    responses: {
      switch: 'OTEL_LOG_ASSISTANT_RESPONSES',
      fallbackSwitch: 'OTEL_LOG_USER_PROMPTS',
      present: c.responseText,
      seen: c.responseEvents,
    },
    toolArguments: {
      switch: 'OTEL_LOG_TOOL_DETAILS',
      present: c.toolArguments,
      seen: c.toolResultEvents,
    },
    toolContent: {
      switch: 'OTEL_LOG_TOOL_CONTENT',
      requires: 'CLAUDE_CODE_ENHANCED_TELEMETRY_BETA',
      present: c.toolOutputContent,
      seen: c.toolResultEvents,
    },
    requestBodies: {
      switch: 'OTEL_LOG_RAW_API_BODIES',
      present: c.requestBodies,
      seen: c.requestBodyEvents,
    },
  };
}

/* ------------------------------- read paths ------------------------------- */

/** The bucket key a record resolves to, after any learned id/name join. */
export function agentKeyOf(session, attrs) {
  const ref = agentRefOf(attrs);
  if (ref.key.startsWith(ID_PREFIX)) {
    const known = session.agentByAgentId.get(ref.key.slice(ID_PREFIX.length));
    if (known) return known;
  }
  return ref.key;
}

/**
 * What one agent had in front of it, in the order it entered that context.
 *
 * Nothing is read from the bucket: this walks the raw windows, so it returns
 * exactly what is still buffered and nothing that has been evicted. Tool calls
 * come from `claude_code.tool` spans, which are the only records carrying an
 * agent — a `tool_result` event that matched no span is emitted on the main
 * session, because without traces there is no attribution to place it anywhere
 * else.
 */
export function collectAgentContent(store, session, agentKey, { limit = 200 } = {}) {
  const items = [];
  const toolResultByUseId = new Map();
  const sessionLogs = [];
  for (const log of store.logs) {
    if (log.sessionId !== session.id) continue;
    sessionLogs.push(log);
    if (log.eventName === EVENT.toolResult && log.attrs?.tool_use_id) {
      toolResultByUseId.set(log.attrs.tool_use_id, log);
    }
  }

  for (const log of sessionLogs) {
    const attrs = log.attrs ?? {};
    const isPrompt = log.eventName === EVENT.userPrompt;
    const isResponse = log.eventName === EVENT.assistantResponse;
    if (!isPrompt && !isResponse) continue;
    if (agentKeyOf(session, attrs) !== agentKey) continue;
    items.push({
      kind: isPrompt ? 'prompt' : 'response',
      seq: log.seq,
      atMs: log.timeMs,
      text: (isPrompt ? attrs.prompt : attrs.response) ?? null,
      length: num(isPrompt ? attrs.prompt_length : attrs.response_length),
    });
  }

  const spannedUseIds = new Set();
  for (const span of store.spans) {
    if (span.sessionId !== session.id || span.name !== SPAN.tool) continue;
    const attrs = span.attrs ?? {};
    if (attrs.tool_use_id) spannedUseIds.add(attrs.tool_use_id);
    if (agentKeyOf(session, attrs) !== agentKey) continue;
    const result = attrs.tool_use_id ? toolResultByUseId.get(attrs.tool_use_id) : null;
    items.push({
      ...toolItem(attrs, result?.attrs ?? null),
      seq: span.seq,
      atMs: span.startMs,
      durationMs: num(attrs.duration_ms, span.durationMs ?? 0),
      output: outputOf(span),
    });
  }

  if (agentKey === MAIN_AGENT_KEY) {
    for (const log of sessionLogs) {
      if (log.eventName !== EVENT.toolResult) continue;
      const attrs = log.attrs ?? {};
      if (attrs.tool_use_id && spannedUseIds.has(attrs.tool_use_id)) continue;
      items.push({
        ...toolItem(attrs, attrs),
        seq: log.seq,
        atMs: log.timeMs,
        durationMs: num(attrs.duration_ms),
        output: null,
      });
    }
  }

  items.sort((a, b) => a.atMs - b.atMs || a.seq - b.seq);
  const truncated = items.length > limit;
  return { items: truncated ? items.slice(items.length - limit) : items, truncated, windowed: true };
}

/** The `tool.output` span event, present only with OTEL_LOG_TOOL_CONTENT=1. */
function outputOf(span) {
  const event = (span.events ?? []).find((entry) => entry.name === TOOL_OUTPUT_EVENT);
  return event ? { ...(event.attrs ?? {}) } : null;
}

function toolItem(spanAttrs, resultAttrs) {
  const item = {
    kind: 'tool',
    toolName: spanAttrs.tool_name ?? resultAttrs?.tool_name ?? null,
    toolUseId: spanAttrs.tool_use_id ?? null,
    detail: spanAttrs.file_path ?? spanAttrs.full_command ?? null,
    success: null,
    arguments: null,
    inputBytes: 0,
    resultBytes: 0,
    resultAvailable: false,
  };
  if (!resultAttrs) return item;
  item.success = bool(resultAttrs.success);
  item.arguments = toolParametersOf(resultAttrs);
  item.inputBytes = num(resultAttrs.tool_input_size_bytes);
  item.resultBytes = num(resultAttrs.tool_result_size_bytes);
  item.resultAvailable = true;
  return item;
}

/**
 * One captured request payload, joined from the agent's index back to the raw
 * log window. The index outlives the record, so a payload whose event has rolled
 * out is reported as gone with its size intact rather than as never having been.
 */
export function readAgentBody(store, session, agent, seq) {
  const entry = agent.bodies.find((candidate) => candidate.seq === seq);
  if (!entry) return null;
  const log = store.logs.find((candidate) => candidate.seq === seq && candidate.sessionId === session.id);
  if (!log) return { ...entry, available: false };

  const attrs = log.attrs ?? {};
  // OTEL_LOG_RAW_API_BODIES=file:<dir> writes the payload to disk and sends a
  // path instead. That path is the exporting machine's, not this one's, and
  // reading it would take the collector outside its own telemetry — report where
  // the payload went and stop there.
  const bodyRef = typeof attrs.body_ref === 'string' && attrs.body_ref !== '' ? attrs.body_ref : null;
  const body = typeof attrs.body === 'string' ? attrs.body : null;
  const deliveredBytes = Buffer.byteLength(body ?? '');
  const bodyLength = num(attrs.body_length, deliveredBytes);
  const truncated = bool(attrs.body_truncated) || bodyLength > deliveredBytes;

  let parsed = null;
  let parseError = null;
  if (body !== null && !truncated) {
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      parseError = error.message;
    }
  }
  return {
    ...entry,
    available: true,
    bodyRef,
    body,
    deliveredBytes,
    bodyLength,
    truncated,
    parsed,
    parseError,
  };
}
