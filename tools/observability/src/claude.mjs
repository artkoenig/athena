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

/**
 * Human-readable label for a session, when the run supplied one.
 *
 * Claude Code exports no name of its own: `session.id` is a UUID, and nothing in
 * the standard attribute set carries a title, a workspace or a cwd. What it does
 * forward is OTEL_RESOURCE_ATTRIBUTES, so a session started with
 * `OTEL_RESOURCE_ATTRIBUTES=session.name=<label>` in its environment carries that
 * label on every record it exports — as a resource attribute, and (unless
 * OTEL_METRICS_INCLUDE_RESOURCE_ATTRIBUTES=false) on metric attributes too, which
 * is why both are checked. It has to be set before the process starts: the OTel
 * resource is built once at init, so neither a hook nor anything else inside the
 * session can add it afterwards.
 */
export function sessionNameOf(record) {
  const raw =
    record?.resource?.['session.name'] ??
    record?.attrs?.['session.name'] ??
    record?.resource?.['session_name'] ??
    record?.attrs?.['session_name'];
  if (typeof raw !== 'string') return null;
  const name = decodePercent(raw).trim();
  return name ? name.slice(0, MAX_SESSION_NAME_LENGTH) : null;
}

/** Percent-encode a label so it survives OTEL_RESOURCE_ATTRIBUTES intact. */
export function encodeResourceAttrValue(value) {
  return encodeURIComponent(String(value).trim());
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
 * collector. Rendered by `athena-observe env` and shown in the UI so the whole
 * setup is copy-pasteable.
 */
export function otelEnvFor(
  endpoint,
  { traces = true, token = null, fastFlush = true, sessionName = null } = {},
) {
  const env = {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
    OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
  };
  // The only way to give a session a name the UI can show instead of its UUID
  // (see sessionNameOf). Left out entirely when unset, so the block stays a
  // block anyone can paste into any session.
  if (sessionName) {
    env.OTEL_RESOURCE_ATTRIBUTES = `session.name=${encodeResourceAttrValue(sessionName)}`;
  }
  if (traces) {
    // Spans are the beta signal and need their own opt-in flag.
    env.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA = '1';
    env.OTEL_TRACES_EXPORTER = 'otlp';
  }
  if (token) env.OTEL_EXPORTER_OTLP_HEADERS = `Authorization=Bearer ${token}`;
  if (fastFlush) {
    // Defaults are 60s for metrics and 5s for logs/traces, which loses data on
    // short-lived SDK calls. Flushing every second keeps the UI close to live.
    env.OTEL_METRIC_EXPORT_INTERVAL = '1000';
    env.OTEL_LOGS_EXPORT_INTERVAL = '1000';
    env.OTEL_TRACES_EXPORT_INTERVAL = '1000';
  }
  return env;
}
