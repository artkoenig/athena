/**
 * In-memory telemetry store.
 *
 * Two things live here with deliberately different lifetimes:
 *
 *  - **Raw records** (spans, log events, metric points) are kept in bounded
 *    windows. They back the waterfall, the event tail and the raw inspectors,
 *    and they are evicted by age and by count so a long-running collector has a
 *    flat memory profile.
 *  - **Session aggregates** are cumulative for the life of the session entry.
 *    They keep being correct after the raw window has rolled over, which is what
 *    makes "what did this session cost" answerable hours later.
 *
 * Nothing is written to disk from here; persistence subscribes to the change
 * stream instead (see persist.mjs).
 */

import {
  EVENT,
  ERROR_EVENTS,
  METRIC,
  SPAN,
  TASK_TOOL_NAMES,
  TOKEN_TYPES,
  EMPTY_TOKENS,
  bool,
  num,
  serviceNameOf,
  sessionIdOf,
  toolParametersOf,
} from './claude.mjs';

/** Bound on how many stray TaskCreate calls a session keeps (see #applyTodo). */
const MAX_UNLINKED_CREATES = 200;
/** Bound on the per-task status history kept for the Todos tab. */
const MAX_TASK_HISTORY = 50;

const DEFAULTS = {
  maxSpans: 50_000,
  maxLogs: 50_000,
  maxMetricPoints: 50_000,
  maxSessions: 500,
  retentionMs: 24 * 60 * 60 * 1000,
};

/** Standard attributes worth pinning to the session card. */
const STICKY_ATTRS = [
  'app.version',
  'app.entrypoint',
  'organization.id',
  'user.account_uuid',
  'user.email',
  'user.id',
  'terminal.type',
  'identity.source',
];

function emptyModelStats() {
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

function emptyToolStats() {
  return { calls: 0, failures: 0, rejected: 0, durationMsTotal: 0, resultTokens: 0 };
}

function newSession(id, now) {
  return {
    id,
    serviceName: 'claude-code',
    resource: {},
    attrs: {},
    firstSeenMs: now,
    lastSeenMs: now,
    counts: {
      spans: 0,
      logs: 0,
      metricPoints: 0,
      interactions: 0,
      llmRequests: 0,
      toolCalls: 0,
      toolFailures: 0,
      hooks: 0,
      userPrompts: 0,
      apiRequests: 0,
      apiErrors: 0,
    },
    tokensMetric: EMPTY_TOKENS(),
    tokensEvent: EMPTY_TOKENS(),
    costMetric: 0,
    costEvent: 0,
    linesAdded: 0,
    linesRemoved: 0,
    commits: 0,
    pullRequests: 0,
    editDecisions: { accept: 0, reject: 0 },
    activeTimeSec: { user: 0, cli: 0 },
    startTypes: new Set(),
    models: new Map(),
    tools: new Map(),
    traceIds: new Set(),
    lastError: null,
    // Todo/task state reconstructed from TodoWrite/TaskCreate/TaskUpdate
    // tool_parameters — see #applyTodo.
    todos: {
      callsSeen: 0,
      legacy: null,
      legacyAtMs: 0,
      tasks: new Map(),
      unlinked: [],
    },
    // Per-series cursors used to fold cumulative counters into running totals.
    _cumulative: new Map(),
    _gauges: new Map(),
  };
}

/** Stable identity for one metric time series (metric name + attribute set). */
function seriesKey(point) {
  const attrs = Object.entries(point.attrs ?? {})
    .filter(([key]) => key !== 'session.id')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join(',');
  return `${point.name}|${attrs}`;
}

export class TelemetryStore {
  constructor(options = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.spans = [];
    this.logs = [];
    this.metricPoints = [];
    this.spansByTrace = new Map();
    this.sessions = new Map();
    this.traces = new Map();
    this.listeners = new Set();
    this.seq = 0;
    this.startedAt = Date.now();
    this.received = { traces: 0, metrics: 0, logs: 0 };
  }

  /** Drop everything but keep subscribers attached. */
  clear() {
    this.spans = [];
    this.logs = [];
    this.metricPoints = [];
    this.spansByTrace.clear();
    this.sessions.clear();
    this.traces.clear();
    this.received = { traces: 0, metrics: 0, logs: 0 };
  }

  /* ------------------------------ pub/sub ------------------------------ */

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  #emit(change) {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch {
        // A broken subscriber must never break ingest.
      }
    }
  }

  /* ------------------------------- ingest ------------------------------ */

  /**
   * @param {'traces'|'metrics'|'logs'} signal
   * @param {object[]} records normalized records from otlp/decode.mjs
   * @param {{replay?: boolean}} opts `replay` suppresses re-persisting on hydrate
   */
  ingest(signal, records, opts = {}) {
    if (!records?.length) return { count: 0, sessionIds: [] };
    const touched = new Set();
    for (const record of records) {
      record.seq = ++this.seq;
      const sessionId = sessionIdOf(record);
      record.sessionId = sessionId;
      const session = this.#session(sessionId, record);
      touched.add(sessionId);
      if (signal === 'traces') this.#applySpan(session, record);
      else if (signal === 'logs') this.#applyLog(session, record);
      else this.#applyMetric(session, record);
    }
    this.received[signal] += records.length;
    this.#evict();
    const change = {
      signal,
      records,
      sessionIds: [...touched],
      seq: this.seq,
      replay: Boolean(opts.replay),
    };
    this.#emit(change);
    return { count: records.length, sessionIds: change.sessionIds };
  }

  #session(id, record) {
    let session = this.sessions.get(id);
    const timeMs = record.startMs || record.timeMs || Date.now();
    if (!session) {
      session = newSession(id, timeMs);
      this.sessions.set(id, session);
    }
    if (timeMs > 0) {
      session.firstSeenMs = Math.min(session.firstSeenMs, timeMs);
      session.lastSeenMs = Math.max(session.lastSeenMs, record.endMs || timeMs);
    }
    if (record.resource && Object.keys(record.resource).length) {
      Object.assign(session.resource, record.resource);
      session.serviceName = serviceNameOf(record);
    }
    for (const key of STICKY_ATTRS) {
      const value = record.attrs?.[key] ?? record.resource?.[key];
      if (value !== undefined && value !== null && value !== '') session.attrs[key] = value;
    }
    return session;
  }

  #model(session, name) {
    const key = name || 'unknown';
    let stats = session.models.get(key);
    if (!stats) {
      stats = emptyModelStats();
      session.models.set(key, stats);
    }
    return stats;
  }

  #tool(session, name) {
    const key = name || 'unknown';
    let stats = session.tools.get(key);
    if (!stats) {
      stats = emptyToolStats();
      session.tools.set(key, stats);
    }
    return stats;
  }

  /* --------------------------------- spans ----------------------------- */

  #applySpan(session, span) {
    session.counts.spans++;
    this.spans.push(span);
    if (span.traceId) {
      session.traceIds.add(span.traceId);
      let bucket = this.spansByTrace.get(span.traceId);
      if (!bucket) {
        bucket = [];
        this.spansByTrace.set(span.traceId, bucket);
      }
      bucket.push(span);
      this.#applyTrace(session, span);
    }

    const attrs = span.attrs ?? {};
    switch (span.name) {
      case SPAN.interaction:
        session.counts.interactions++;
        break;
      case SPAN.llmRequest: {
        session.counts.llmRequests++;
        const stats = this.#model(session, attrs.model);
        stats.requests++;
        stats.durationMsTotal += num(attrs.duration_ms, span.durationMs ?? 0);
        const ttft = num(attrs.ttft_ms, 0);
        if (ttft > 0) {
          stats.ttftMsTotal += ttft;
          stats.ttftCount++;
        }
        if (attrs.success !== undefined && !bool(attrs.success)) {
          stats.errors++;
          session.lastError = {
            at: span.endMs || span.startMs,
            kind: 'llm_request',
            message: attrs.error ? String(attrs.error) : `status ${attrs.status_code ?? '?'}`,
          };
        }
        break;
      }
      case SPAN.tool: {
        session.counts.toolCalls++;
        const stats = this.#tool(session, attrs.tool_name);
        stats.calls++;
        stats.durationMsTotal += num(attrs.duration_ms, span.durationMs ?? 0);
        stats.resultTokens += num(attrs.result_tokens, 0);
        break;
      }
      case SPAN.toolExecution:
        if (attrs.success !== undefined && !bool(attrs.success)) {
          session.counts.toolFailures++;
          session.lastError = {
            at: span.endMs || span.startMs,
            kind: 'tool',
            message: attrs.error ? String(attrs.error) : 'tool execution failed',
          };
        }
        break;
      case SPAN.toolBlocked:
        if (attrs.decision === 'reject') this.#tool(session, attrs.tool_name).rejected++;
        break;
      case SPAN.hook:
        session.counts.hooks++;
        break;
      default:
        break;
    }
  }

  #applyTrace(session, span) {
    let trace = this.traces.get(span.traceId);
    if (!trace) {
      trace = {
        traceId: span.traceId,
        sessionId: session.id,
        rootName: '',
        rootSpanId: '',
        firstMs: span.startMs,
        lastMs: span.endMs || span.startMs,
        spanCount: 0,
        errorCount: 0,
        toolNames: new Set(),
      };
      this.traces.set(span.traceId, trace);
    }
    trace.spanCount++;
    if (span.startMs > 0) trace.firstMs = Math.min(trace.firstMs || span.startMs, span.startMs);
    trace.lastMs = Math.max(trace.lastMs, span.endMs || span.startMs);
    if (span.status?.code === 'error') trace.errorCount++;
    if (span.name === SPAN.tool && span.attrs?.tool_name) trace.toolNames.add(span.attrs.tool_name);
    // The interaction span is the documented root; fall back to any parentless span.
    if (span.name === SPAN.interaction || (!trace.rootSpanId && !span.parentSpanId)) {
      trace.rootSpanId = span.spanId;
      trace.rootName = span.name;
      if (span.attrs?.user_prompt) trace.prompt = String(span.attrs.user_prompt);
    }
  }

  /* --------------------------------- logs ------------------------------ */

  #applyLog(session, log) {
    session.counts.logs++;
    this.logs.push(log);
    const attrs = log.attrs ?? {};
    log.isError = ERROR_EVENTS.has(log.eventName) || log.severity === 'ERROR' || log.severity === 'FATAL';

    switch (log.eventName) {
      case EVENT.userPrompt:
        session.counts.userPrompts++;
        break;
      case EVENT.apiRequest: {
        session.counts.apiRequests++;
        const stats = this.#model(session, attrs.model);
        const tokens = {
          input: num(attrs.input_tokens),
          output: num(attrs.output_tokens),
          cacheRead: num(attrs.cache_read_tokens),
          cacheCreation: num(attrs.cache_creation_tokens),
        };
        for (const [key, value] of Object.entries(tokens)) {
          session.tokensEvent[key] += value;
          stats.tokensEvent[key] += value;
        }
        // cost_usd_micros is the integer-safe form; prefer it when present.
        const cost =
          attrs.cost_usd_micros !== undefined
            ? num(attrs.cost_usd_micros) / 1e6
            : num(attrs.cost_usd);
        session.costEvent += cost;
        stats.costEvent += cost;
        break;
      }
      case EVENT.apiError:
      case EVENT.apiRefusal:
        session.counts.apiErrors++;
        this.#model(session, attrs.model).errors++;
        session.lastError = {
          at: log.timeMs,
          kind: log.eventName === EVENT.apiRefusal ? 'api_refusal' : 'api_error',
          message: String(attrs.error ?? attrs.category ?? 'refused'),
        };
        break;
      case EVENT.toolResult: {
        const stats = this.#tool(session, attrs.tool_name);
        if (TASK_TOOL_NAMES.has(attrs.tool_name)) session.todos.callsSeen++;
        if (!bool(attrs.success)) {
          stats.failures++;
          session.lastError = {
            at: log.timeMs,
            kind: 'tool',
            message: String(attrs.error ?? attrs.error_type ?? `${attrs.tool_name} failed`),
          };
        } else {
          this.#applyTodo(session, log);
        }
        break;
      }
      case EVENT.toolDecision:
        if (attrs.decision === 'reject') this.#tool(session, attrs.tool_name).rejected++;
        break;
      case EVENT.internalError:
        session.lastError = {
          at: log.timeMs,
          kind: 'internal',
          message: String(attrs.error_name ?? 'internal error'),
        };
        break;
      default:
        break;
    }
  }

  /**
   * Reconstruct todo/task state from a successful TodoWrite/TaskCreate/TaskUpdate
   * call. Requires `OTEL_LOG_TOOL_DETAILS=1` — without it `tool_parameters` is
   * absent and this is a no-op.
   *
   * TaskCreate's assigned task id is not part of its own call — the CLI only
   * returns it in the tool result, which telemetry does not carry without the
   * separate (and much more sensitive) `OTEL_LOG_TOOL_CONTENT=1`. So created
   * tasks are kept in an unlinked list by creation time instead of being
   * (possibly wrongly) merged into the id-keyed map that TaskUpdate calls build.
   */
  #applyTodo(session, log) {
    const attrs = log.attrs ?? {};
    const toolName = attrs.tool_name;
    if (!TASK_TOOL_NAMES.has(toolName)) return;
    const params = toolParametersOf(attrs);
    if (!params) return;
    const atMs = log.timeMs;
    const todos = session.todos;

    if (toolName === 'TodoWrite') {
      const list = Array.isArray(params.todos) ? params.todos : [];
      todos.legacy = list.map((todo) => ({
        content: String(todo?.content ?? ''),
        status: String(todo?.status ?? 'pending'),
        activeForm: todo?.activeForm ? String(todo.activeForm) : '',
      }));
      todos.legacyAtMs = atMs;
      return;
    }

    if (toolName === 'TaskCreate') {
      todos.unlinked.push({
        toolUseId: attrs.tool_use_id ?? '',
        subject: params.subject ? String(params.subject) : '',
        description: params.description ? String(params.description) : '',
        activeForm: params.activeForm ? String(params.activeForm) : '',
        createdAtMs: atMs,
      });
      if (todos.unlinked.length > MAX_UNLINKED_CREATES) todos.unlinked.shift();
      return;
    }

    // TaskUpdate. The model repairs `id`/`task_id` to `taskId` before execution,
    // but that repair is not reflected in the streamed tool_use input — read
    // defensively (see the Task tools migration notes in the SDK docs).
    const taskId = params.taskId ?? params.id ?? params.task_id;
    if (!taskId) return;
    let task = todos.tasks.get(taskId);
    if (!task) {
      task = {
        taskId: String(taskId),
        subject: '',
        description: '',
        activeForm: '',
        status: 'pending',
        owner: '',
        createdAtMs: atMs,
        updatedAtMs: atMs,
        history: [],
      };
      todos.tasks.set(taskId, task);
    }
    if (params.subject) task.subject = String(params.subject);
    if (params.description) task.description = String(params.description);
    if (params.activeForm) task.activeForm = String(params.activeForm);
    if (params.owner) task.owner = String(params.owner);
    if (params.status) task.status = String(params.status);
    task.updatedAtMs = atMs;
    task.history.push({ atMs, status: params.status ? String(params.status) : null });
    if (task.history.length > MAX_TASK_HISTORY) task.history.shift();
  }

  /* -------------------------------- metrics ---------------------------- */

  /**
   * Fold a data point into a running total.
   *
   * Claude Code defaults to delta temporality but honours
   * OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=cumulative, so both have to
   * work. Cumulative series are differenced against their previous value, with a
   * counter reset (value going backwards) treated as a fresh start.
   */
  #delta(session, point) {
    if (point.kind === 'gauge') {
      const key = seriesKey(point);
      const previous = session._gauges.get(key) ?? 0;
      session._gauges.set(key, point.value);
      return point.value - previous;
    }
    if (point.temporality !== 'cumulative') return point.value;
    const key = seriesKey(point);
    const previous = session._cumulative.get(key) ?? 0;
    session._cumulative.set(key, point.value);
    return point.value >= previous ? point.value - previous : point.value;
  }

  #applyMetric(session, point) {
    session.counts.metricPoints++;
    this.metricPoints.push(point);
    const attrs = point.attrs ?? {};
    const delta = this.#delta(session, point);

    switch (point.name) {
      case METRIC.token: {
        const type = TOKEN_TYPES[attrs.type] ?? null;
        if (!type) break;
        session.tokensMetric[type] += delta;
        this.#model(session, attrs.model).tokensMetric[type] += delta;
        break;
      }
      case METRIC.cost:
        session.costMetric += delta;
        this.#model(session, attrs.model).costMetric += delta;
        break;
      case METRIC.linesOfCode:
        if (attrs.type === 'removed') session.linesRemoved += delta;
        else session.linesAdded += delta;
        break;
      case METRIC.commit:
        session.commits += delta;
        break;
      case METRIC.pullRequest:
        session.pullRequests += delta;
        break;
      case METRIC.session:
        if (attrs.start_type) session.startTypes.add(attrs.start_type);
        break;
      case METRIC.codeEditDecision:
        if (attrs.decision === 'reject') session.editDecisions.reject += delta;
        else session.editDecisions.accept += delta;
        break;
      case METRIC.activeTime:
        if (attrs.type === 'cli') session.activeTimeSec.cli += delta;
        else session.activeTimeSec.user += delta;
        break;
      default:
        break;
    }
  }

  /* ------------------------------- eviction ---------------------------- */

  #evict() {
    const cutoff = Date.now() - this.options.retentionMs;
    this.#trim('spans', this.options.maxSpans, cutoff, (span) => span.startMs);
    this.#trim('logs', this.options.maxLogs, cutoff, (log) => log.timeMs);
    this.#trim('metricPoints', this.options.maxMetricPoints, cutoff, (point) => point.timeMs);
    this.#evictSessions(cutoff);
  }

  #trim(field, max, cutoff, timeOf) {
    const list = this[field];
    let drop = 0;
    while (drop < list.length && timeOf(list[drop]) > 0 && timeOf(list[drop]) < cutoff) drop++;
    if (list.length - drop > max) drop = list.length - max;
    if (drop <= 0) return;
    const removed = list.splice(0, drop);
    if (field === 'spans') this.#unindexSpans(removed);
  }

  #unindexSpans(removed) {
    const byTrace = new Map();
    for (const span of removed) {
      if (!span.traceId) continue;
      let ids = byTrace.get(span.traceId);
      if (!ids) {
        ids = new Set();
        byTrace.set(span.traceId, ids);
      }
      ids.add(span.spanId);
    }
    for (const [traceId, ids] of byTrace) {
      const bucket = this.spansByTrace.get(traceId);
      if (!bucket) continue;
      const kept = bucket.filter((span) => !ids.has(span.spanId));
      if (kept.length) this.spansByTrace.set(traceId, kept);
      else {
        this.spansByTrace.delete(traceId);
        this.traces.delete(traceId);
      }
    }
  }

  #evictSessions(cutoff) {
    for (const [id, session] of this.sessions) {
      if (session.lastSeenMs > 0 && session.lastSeenMs < cutoff) this.#dropSession(id);
    }
    const overflow = this.sessions.size - this.options.maxSessions;
    if (overflow <= 0) return;
    const oldest = [...this.sessions.values()]
      .sort((a, b) => a.lastSeenMs - b.lastSeenMs)
      .slice(0, overflow);
    for (const session of oldest) this.#dropSession(session.id);
  }

  #dropSession(id) {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    for (const traceId of session.traceIds) {
      this.traces.delete(traceId);
      this.spansByTrace.delete(traceId);
    }
    this.spans = this.spans.filter((span) => span.sessionId !== id);
    this.logs = this.logs.filter((log) => log.sessionId !== id);
    this.metricPoints = this.metricPoints.filter((point) => point.sessionId !== id);
  }

  /* -------------------------------- queries ---------------------------- */

  listSessions({ search = '', limit = 100, offset = 0 } = {}) {
    const needle = search.trim().toLowerCase();
    let sessions = [...this.sessions.values()];
    if (needle) {
      sessions = sessions.filter((session) => {
        const haystack = [
          session.id,
          session.serviceName,
          session.attrs['user.email'],
          ...Object.values(session.resource ?? {}),
          ...session.models.keys(),
          ...session.tools.keys(),
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return haystack.includes(needle);
      });
    }
    sessions.sort((a, b) => b.lastSeenMs - a.lastSeenMs);
    return {
      total: sessions.length,
      items: sessions.slice(offset, offset + limit).map((session) => summarizeSession(session)),
    };
  }

  getSession(id) {
    const session = this.sessions.get(id);
    if (!session) return null;
    const traces = [...session.traceIds]
      .map((traceId) => this.traces.get(traceId))
      .filter(Boolean)
      .map((trace) => ({
        ...trace,
        toolNames: [...trace.toolNames],
        durationMs: Math.max(0, trace.lastMs - trace.firstMs),
      }))
      .sort((a, b) => b.firstMs - a.firstMs);
    return { ...summarizeSession(session), traces };
  }

  /** All spans of a trace, arranged into the parent/child tree OTLP implies. */
  getTrace(traceId) {
    const spans = this.spansByTrace.get(traceId);
    if (!spans?.length) return null;
    const byId = new Map(spans.map((span) => [span.spanId, span]));
    const nodes = new Map(
      spans.map((span) => [span.spanId, { ...span, children: [], depth: 0 }]),
    );
    const roots = [];
    for (const node of nodes.values()) {
      const parent = node.parentSpanId ? nodes.get(node.parentSpanId) : null;
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    const order = [];
    const walk = (node, depth) => {
      node.depth = depth;
      order.push(node);
      node.children.sort((a, b) => a.startMs - b.startMs);
      for (const child of node.children) walk(child, depth + 1);
    };
    roots.sort((a, b) => a.startMs - b.startMs);
    for (const root of roots) walk(root, 0);

    const starts = spans.map((span) => span.startMs).filter((value) => value > 0);
    const ends = spans.map((span) => span.endMs || span.startMs);
    const firstMs = starts.length ? Math.min(...starts) : 0;
    const lastMs = ends.length ? Math.max(...ends) : 0;
    // Strip child references before serialising; the flat, depth-tagged list is
    // what the waterfall renders and it avoids a cyclic JSON structure.
    const flat = order.map(({ children, ...span }) => span);
    const missingParents = flat.filter(
      (span) => span.parentSpanId && !byId.has(span.parentSpanId),
    ).length;
    return {
      traceId,
      sessionId: spans[0].sessionId,
      firstMs,
      lastMs,
      durationMs: Math.max(0, lastMs - firstMs),
      spanCount: flat.length,
      orphanCount: missingParents,
      spans: flat,
    };
  }

  queryEvents({
    sessionId = null,
    eventName = null,
    traceId = null,
    search = '',
    errorsOnly = false,
    sinceSeq = 0,
    limit = 200,
  } = {}) {
    const needle = search.trim().toLowerCase();
    const matches = [];
    // Walk newest-first so `limit` keeps the most recent events.
    for (let i = this.logs.length - 1; i >= 0 && matches.length < limit; i--) {
      const log = this.logs[i];
      if (log.seq <= sinceSeq) break;
      if (sessionId && log.sessionId !== sessionId) continue;
      if (eventName && log.eventName !== eventName) continue;
      if (traceId && log.traceId !== traceId) continue;
      if (errorsOnly && !log.isError) continue;
      if (needle) {
        const haystack = `${log.eventName} ${JSON.stringify(log.attrs)}`.toLowerCase();
        if (!haystack.includes(needle)) continue;
      }
      matches.push(log);
    }
    matches.reverse();
    return matches;
  }

  queryMetrics({ sessionId = null, name = null, limit = 500 } = {}) {
    const matches = [];
    for (let i = this.metricPoints.length - 1; i >= 0 && matches.length < limit; i--) {
      const point = this.metricPoints[i];
      if (sessionId && point.sessionId !== sessionId) continue;
      if (name && point.name !== name) continue;
      matches.push(point);
    }
    matches.reverse();
    return matches;
  }

  /** Names seen so far, for populating filter dropdowns. */
  facets() {
    const events = new Map();
    for (const log of this.logs) events.set(log.eventName, (events.get(log.eventName) ?? 0) + 1);
    const metrics = new Map();
    for (const point of this.metricPoints) {
      metrics.set(point.name, (metrics.get(point.name) ?? 0) + 1);
    }
    return {
      events: [...events].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
      metrics: [...metrics].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    };
  }

  stats() {
    const totals = {
      sessions: this.sessions.size,
      activeSessions: 0,
      tokens: EMPTY_TOKENS(),
      costUsd: 0,
      interactions: 0,
      llmRequests: 0,
      toolCalls: 0,
      toolFailures: 0,
      apiErrors: 0,
      linesAdded: 0,
      linesRemoved: 0,
      commits: 0,
      pullRequests: 0,
    };
    const models = new Map();
    const tools = new Map();
    const activeCutoff = Date.now() - 90_000;
    for (const session of this.sessions.values()) {
      const summary = summarizeSession(session);
      if (session.lastSeenMs >= activeCutoff) totals.activeSessions++;
      for (const key of Object.keys(totals.tokens)) totals.tokens[key] += summary.tokens[key];
      totals.costUsd += summary.costUsd;
      totals.interactions += summary.counts.interactions;
      totals.llmRequests += summary.counts.llmRequests;
      totals.toolCalls += summary.counts.toolCalls;
      totals.toolFailures += summary.counts.toolFailures + summary.toolFailuresFromEvents;
      totals.apiErrors += summary.counts.apiErrors;
      totals.linesAdded += summary.linesAdded;
      totals.linesRemoved += summary.linesRemoved;
      totals.commits += summary.commits;
      totals.pullRequests += summary.pullRequests;
      for (const model of summary.models) {
        const entry = models.get(model.name) ?? { name: model.name, requests: 0, costUsd: 0, tokens: 0 };
        entry.requests += model.requests;
        entry.costUsd += model.costUsd;
        entry.tokens += model.tokensTotal;
        models.set(model.name, entry);
      }
      for (const tool of summary.tools) {
        const entry = tools.get(tool.name) ?? { name: tool.name, calls: 0, failures: 0, durationMsTotal: 0 };
        entry.calls += tool.calls;
        entry.failures += tool.failures;
        entry.durationMsTotal += tool.durationMsTotal;
        tools.set(tool.name, entry);
      }
    }
    return {
      uptimeMs: Date.now() - this.startedAt,
      received: { ...this.received },
      buffered: {
        spans: this.spans.length,
        logs: this.logs.length,
        metricPoints: this.metricPoints.length,
        traces: this.traces.size,
      },
      totals,
      topModels: [...models.values()].sort((a, b) => b.costUsd - a.costUsd || b.requests - a.requests),
      topTools: [...tools.values()].sort((a, b) => b.calls - a.calls).slice(0, 15),
    };
  }
}

const hasTokens = (tokens) => Object.values(tokens).some((value) => value > 0);

/**
 * Metrics, events and spans all carry overlapping token/cost data. Preferring
 * metrics and falling back to events means the numbers stay right whether the
 * user enabled OTEL_METRICS_EXPORTER, OTEL_LOGS_EXPORTER, or both — without
 * double counting when both are on.
 */
function mergeUsage(tokensMetric, tokensEvent, costMetric, costEvent) {
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

function summarizeTodos(session) {
  return {
    callsSeen: session.todos.callsSeen,
    legacy: session.todos.legacy,
    legacyAtMs: session.todos.legacyAtMs || null,
    tasks: [...session.todos.tasks.values()].sort((a, b) => b.updatedAtMs - a.updatedAtMs),
    unlinkedCreates: [...session.todos.unlinked].sort((a, b) => b.createdAtMs - a.createdAtMs),
  };
}

export function summarizeSession(session) {
  const usage = mergeUsage(
    session.tokensMetric,
    session.tokensEvent,
    session.costMetric,
    session.costEvent,
  );
  const models = [...session.models.entries()]
    .map(([name, stats]) => {
      const merged = mergeUsage(
        stats.tokensMetric,
        stats.tokensEvent,
        stats.costMetric,
        stats.costEvent,
      );
      return {
        name,
        requests: stats.requests,
        errors: stats.errors,
        durationMsTotal: Math.round(stats.durationMsTotal),
        avgDurationMs: stats.requests ? Math.round(stats.durationMsTotal / stats.requests) : 0,
        avgTtftMs: stats.ttftCount ? Math.round(stats.ttftMsTotal / stats.ttftCount) : 0,
        ...merged,
      };
    })
    .sort((a, b) => b.tokensTotal - a.tokensTotal || b.requests - a.requests);
  const tools = [...session.tools.entries()]
    .map(([name, stats]) => ({
      name,
      ...stats,
      durationMsTotal: Math.round(stats.durationMsTotal),
      avgDurationMs: stats.calls ? Math.round(stats.durationMsTotal / stats.calls) : 0,
    }))
    .sort((a, b) => b.calls - a.calls);

  return {
    id: session.id,
    serviceName: session.serviceName,
    resource: session.resource,
    attrs: session.attrs,
    firstSeenMs: session.firstSeenMs,
    lastSeenMs: session.lastSeenMs,
    durationMs: Math.max(0, session.lastSeenMs - session.firstSeenMs),
    counts: { ...session.counts },
    ...usage,
    linesAdded: session.linesAdded,
    linesRemoved: session.linesRemoved,
    commits: session.commits,
    pullRequests: session.pullRequests,
    editDecisions: { ...session.editDecisions },
    activeTimeSec: { ...session.activeTimeSec },
    startTypes: [...session.startTypes],
    models,
    tools,
    todos: summarizeTodos(session),
    toolFailuresFromEvents: tools.reduce((sum, tool) => sum + tool.failures, 0),
    traceCount: session.traceIds.size,
    lastError: session.lastError,
  };
}
