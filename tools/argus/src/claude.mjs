/**
 * Claude Code / Agent SDK domain knowledge.
 *
 * The collector itself is signal-generic, but the UI is not: it is built to
 * answer "what did my agent session actually do, and what did it cost". These
 * constants and helpers encode the metric names, event names and span names the
 * CLI emits (see the Monitoring reference in the Claude Code docs) so the rest
 * of the code never has to string-match inline.
 */

export const METRIC = {
  session: 'claude_code.session.count',
  linesOfCode: 'claude_code.lines_of_code.count',
  pullRequest: 'claude_code.pull_request.count',
  commit: 'claude_code.commit.count',
  cost: 'claude_code.cost.usage',
  token: 'claude_code.token.usage',
  codeEditDecision: 'claude_code.code_edit_tool.decision',
  activeTime: 'claude_code.active_time.total',
};

export const SPAN = {
  interaction: 'claude_code.interaction',
  llmRequest: 'claude_code.llm_request',
  tool: 'claude_code.tool',
  toolBlocked: 'claude_code.tool.blocked_on_user',
  toolExecution: 'claude_code.tool.execution',
  hook: 'claude_code.hook',
};

export const EVENT = {
  userPrompt: 'claude_code.user_prompt',
  assistantResponse: 'claude_code.assistant_response',
  toolResult: 'claude_code.tool_result',
  toolDecision: 'claude_code.tool_decision',
  apiRequest: 'claude_code.api_request',
  apiError: 'claude_code.api_error',
  apiRefusal: 'claude_code.api_refusal',
  apiRequestBody: 'claude_code.api_request_body',
  apiResponseBody: 'claude_code.api_response_body',
  permissionModeChanged: 'claude_code.permission_mode_changed',
  auth: 'claude_code.auth',
  mcpServerConnection: 'claude_code.mcp_server_connection',
  internalError: 'claude_code.internal_error',
  pluginInstalled: 'claude_code.plugin_installed',
  pluginLoaded: 'claude_code.plugin_loaded',
};

/** Tool names whose call parameters describe todo/task state (see todo-tracking docs). */
export const TASK_TOOL_NAMES = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate']);

/**
 * The tool_result event carries the call's parameters as a JSON string, only
 * present when `OTEL_LOG_TOOL_DETAILS=1` is set. The attribute has been named
 * `tool_input` since Claude Code 2.1.x; `tool_parameters` is kept as a fallback
 * for older CLI versions still emitting that name. Absent or malformed just
 * means "nothing to show", not an error.
 */
export function toolParametersOf(attrs) {
  const raw = attrs?.tool_input ?? attrs?.tool_parameters;
  if (typeof raw !== 'string') return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/** Events worth surfacing as an audit trail (see "Audit security events"). */
export const SECURITY_EVENTS = new Set([
  EVENT.toolDecision,
  EVENT.toolResult,
  EVENT.mcpServerConnection,
  EVENT.permissionModeChanged,
  EVENT.auth,
]);

/** Events that always mean something went wrong. */
export const ERROR_EVENTS = new Set([EVENT.apiError, EVENT.apiRefusal, EVENT.internalError]);

/** `claude_code.token.usage` `type` attribute -> our aggregate key. */
export const TOKEN_TYPES = {
  input: 'input',
  output: 'output',
  cacheRead: 'cacheRead',
  cacheread: 'cacheRead',
  cache_read: 'cacheRead',
  cacheCreation: 'cacheCreation',
  cachecreation: 'cacheCreation',
  cache_creation: 'cacheCreation',
};

export const EMPTY_TOKENS = () => ({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });

const UNKNOWN_SESSION = 'unknown-session';

/**
 * Resolve the session a record belongs to.
 *
 * `session.id` is a standard attribute on metrics, events and spans, but users
 * can switch it off with OTEL_METRICS_INCLUDE_SESSION_ID=false, and it may also
 * be promoted to a resource attribute. Fall back through both before giving up.
 */
export function sessionIdOf(record) {
  return (
    record.attrs?.['session.id'] ||
    record.resource?.['session.id'] ||
    record.attrs?.['session_id'] ||
    UNKNOWN_SESSION
  );
}

export function serviceNameOf(record) {
  return record.resource?.['service.name'] || 'claude-code';
}

/** Longest label kept; anything beyond this is a paste accident, not a name. */
const MAX_SESSION_NAME_LENGTH = 120;

/**
 * Values in OTEL_RESOURCE_ATTRIBUTES are `key=value` pairs separated by commas
 * and restricted to US-ASCII, so a label with a space, a comma or an umlaut has
 * to be percent-encoded (the W3C Baggage rules the OTel spec points at). SDKs
 * decode before export, but not every exporter in the chain does, so a value
 * that still looks encoded on arrival is decoded here rather than shown raw.
 */
function decodePercent(value) {
  if (!value.includes('%')) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Trim, decode and cap a label from any source into what the UI will show. */
export function normalizeSessionName(value) {
  if (typeof value !== 'string') return null;
  const name = decodePercent(value).trim();
  return name ? name.slice(0, MAX_SESSION_NAME_LENGTH) : null;
}

/**
 * Human-readable label a session carried in its own telemetry.
 *
 * Claude Code exports no name of its own: `session.id` is a UUID, and nothing in
 * the standard attribute set carries a title, a workspace or a cwd. What it does
 * forward is OTEL_RESOURCE_ATTRIBUTES, so a session started with
 * `OTEL_RESOURCE_ATTRIBUTES=session.name=<label>` in its environment carries that
 * label on every record it exports — as a resource attribute, and (unless
 * OTEL_METRICS_INCLUDE_RESOURCE_ATTRIBUTES=false) on metric attributes too, which
 * is why both are checked.
 *
 * It has to be set before the process starts, because the OTel resource is built
 * once at init. Nothing running *inside* a session can add the attribute after
 * the fact, so this is the only way a session arrives under a label rather than
 * a UUID — and an unnamed session is still tracked, by its id.
 */
export function sessionNameOf(record) {
  return normalizeSessionName(
    record?.resource?.['session.name'] ??
      record?.attrs?.['session.name'] ??
      record?.resource?.['session_name'] ??
      record?.attrs?.['session_name'],
  );
}

/**
 * Events that carry a full API body. "Content-bearing" means exactly that:
 * user prompts, assistant responses and tool results already flow through the
 * ordinary event tail and now carry their text because the flags are on, so
 * they need no plumbing of their own.
 */
export const CONTENT_EVENTS = new Set([EVENT.apiRequestBody, EVENT.apiResponseBody]);

/**
 * Which subagent a record belongs to, read off `query_source`.
 *
 * The grammar is `agent:<source>:<name>` (`agent:custom:probe-bot`,
 * `agent:builtin:general-purpose`); main-session traffic uses plain values like
 * `sdk`, `repl_main_thread` or `compact` and gets `null`. `OTEL_LOG_TOOL_DETAILS=1`
 * is what un-redacts the name segment, and current CLI builds redact it
 * inconsistently — `agent:custom` arrives with no name at all. Falling back to the
 * source segment keeps such a record from being mistaken for main traffic. A name
 * containing a colon keeps everything after the second one.
 */
export function agentOf(attrs = {}) {
  const source = attrs?.query_source;
  if (typeof source !== 'string' || !source.startsWith('agent:')) return null;
  const rest = source.slice('agent:'.length);
  const colon = rest.indexOf(':');
  if (colon === -1) return rest || null;
  return rest.slice(colon + 1) || rest.slice(0, colon) || null;
}

/** True when the record came from a subagent rather than the main session. */
export function isSubagentSource(attrs = {}) {
  return typeof attrs?.query_source === 'string' && attrs.query_source.startsWith('agent:');
}

/**
 * The metadata projection of a content record — everything but the body, which
 * is what makes it cheap enough to list. `body_length` and `body_truncated`
 * arrive as strings on the wire, hence num()/bool() rather than Number()/truthiness.
 * `bodyLength` is the untruncated size the CLI reported; `bodyChars` is what
 * actually arrived. `body_ref` only appears in `file:<dir>` mode, which
 * `otelEnvFor` never sets: it is carried through opaquely and no file is read.
 */
export function contentMetaOf(log) {
  const attrs = log?.attrs ?? {};
  return {
    seq: log?.seq ?? 0,
    timeMs: log?.timeMs ?? 0,
    sessionId: log?.sessionId ?? null,
    traceId: log?.traceId ?? '',
    spanId: log?.spanId ?? '',
    eventName: log?.eventName ?? '',
    querySource: attrs.query_source ?? null,
    agent: agentOf(attrs),
    isSubagent: isSubagentSource(attrs),
    model: attrs.model ?? null,
    requestId: attrs.request_id ?? null,
    promptId: attrs['prompt.id'] ?? null,
    eventSequence: num(attrs['event.sequence'], 0),
    bodyLength: num(attrs.body_length, 0),
    bodyChars: typeof attrs.body === 'string' ? attrs.body.length : 0,
    truncated: bool(attrs.body_truncated),
    bodyRef: attrs.body_ref ?? null,
  };
}

/** Attribution attributes that answer "which agent/skill/tool spent this". */
export function attributionOf(attrs = {}) {
  const out = {};
  for (const key of [
    'agent.name',
    'skill.name',
    'plugin.name',
    'marketplace.name',
    'mcp_server.name',
    'mcp_tool.name',
    'query_source',
    'workflow.name',
    'workflow.run_id',
    'model',
    'speed',
    'effort',
  ]) {
    if (attrs[key] !== undefined && attrs[key] !== null && attrs[key] !== '') out[key] = attrs[key];
  }
  return out;
}

const NUMERIC_RE = /^-?\d+(\.\d+)?$/;

/** Attributes arrive as strings surprisingly often; coerce defensively. */
export function num(value, fallback = 0) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'string' && NUMERIC_RE.test(value)) return Number(value);
  return fallback;
}

export function bool(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

/** One-line description of an event for the live tail. */
export function describeEvent(log) {
  const a = log.attrs ?? {};
  switch (log.eventName) {
    case EVENT.userPrompt:
      return a.prompt ? String(a.prompt) : `prompt (${num(a.prompt_length)} chars)`;
    case EVENT.assistantResponse:
      return a.response ? String(a.response) : `response (${num(a.response_length)} chars)`;
    case EVENT.toolResult:
      return `${a.tool_name ?? 'tool'} ${bool(a.success) ? 'ok' : `failed${a.error_type ? `: ${a.error_type}` : ''}`} in ${num(a.duration_ms)}ms`;
    case EVENT.toolDecision:
      return `${a.decision ?? '?'} ${a.tool_name ?? 'tool'} (${a.source ?? 'unknown source'})`;
    case EVENT.apiRequest:
      return `${a.model ?? 'model'} · ${num(a.input_tokens)} in / ${num(a.output_tokens)} out · ${num(a.duration_ms)}ms`;
    // The body events carry a whole conversation. The tail says how big it was
    // and where it came from; the text itself is served by /api/content/at only.
    case EVENT.apiRequestBody:
      return `${a.model ?? 'model'} request body · ${num(a.body_length)} chars${bool(a.body_truncated) ? ' (truncated)' : ''} · ${a.query_source ?? 'unknown source'}`;
    case EVENT.apiResponseBody:
      return `${a.model ?? 'model'} response body · ${num(a.body_length)} chars${bool(a.body_truncated) ? ' (truncated)' : ''} · ${a.query_source ?? 'unknown source'}`;
    case EVENT.apiError:
      return `${a.model ?? 'model'} ${a.status_code ?? ''} ${a.error ?? 'error'}`.trim();
    case EVENT.apiRefusal:
      return `${a.model ?? 'model'} refused${a.category ? ` (${a.category})` : ''}`;
    case EVENT.mcpServerConnection:
      return `${a.server_name ?? 'mcp server'} ${a.status ?? ''} via ${a.transport_type ?? '?'}`;
    case EVENT.permissionModeChanged:
      return `${a.from_mode ?? '?'} -> ${a.to_mode ?? '?'}${a.trigger ? ` (${a.trigger})` : ''}`;
    case EVENT.auth:
      return `${a.action ?? 'auth'} ${bool(a.success) ? 'ok' : `failed (${a.error_category ?? '?'})`}`;
    case EVENT.internalError:
      return `${a.error_name ?? 'error'}${a.error_code ? ` (${a.error_code})` : ''}`;
    default:
      return typeof log.body === 'string' ? log.body : log.eventName;
  }
}

/**
 * Environment block that points a Claude Agent SDK / Claude Code run at this
 * collector. Rendered by `argus env` and shown in the UI so the whole
 * setup is copy-pasteable.
 */
export function otelEnvFor(endpoint, { traces = true, token = null, fastFlush = true } = {}) {
  const env = {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
    OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
    // Content, on by default: argus is a local measurement tool and the text
    // *is* the measurement — prompts, tool arguments and whole API bodies.
    // OTEL_LOG_TOOL_CONTENT rides on span events, so it only takes effect while
    // tracing is on; it is set unconditionally and is simply inert otherwise.
    // The CLI truncates content at 61,440 chars by default, which cuts the first
    // request of even a trivial session in half — hence the raised ceiling.
    OTEL_LOG_USER_PROMPTS: '1',
    OTEL_LOG_TOOL_DETAILS: '1',
    OTEL_LOG_TOOL_CONTENT: '1',
    OTEL_LOG_RAW_API_BODIES: '1',
    CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH: '2000000',
  };
  if (traces) {
    // Spans are the beta signal and need their own opt-in flag.
    env.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA = '1';
    env.OTEL_TRACES_EXPORTER = 'otlp';
  }
  if (token) env.OTEL_EXPORTER_OTLP_HEADERS = `Authorization=Bearer ${token}`;
  // The same address and secret once more, under the stable names this tool's
  // own commands read. The OTEL_* variables belong to the exporter and say where
  // an agent *sends* telemetry; UROBOROS_OBS_* say where the collector is, which is
  // the question anything talking to it has to answer. resolveConfig already
  // reads UROBOROS_OBS_TOKEN, so exporting this block also configures a collector
  // started in the same shell.
  env.UROBOROS_OBS_URL = endpoint;
  if (token) env.UROBOROS_OBS_TOKEN = token;
  if (fastFlush) {
    // Defaults are 60s for metrics and 5s for logs/traces, which loses data on
    // short-lived SDK calls. Flushing every second keeps the UI close to live.
    env.OTEL_METRIC_EXPORT_INTERVAL = '1000';
    env.OTEL_LOGS_EXPORT_INTERVAL = '1000';
    env.OTEL_TRACES_EXPORT_INTERVAL = '1000';
  }
  return env;
}
