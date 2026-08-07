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

/**
 * Classify a log record as one of the content-bearing kinds, or as not content
 * at all. This is the one place that knows which attribute of which event holds
 * text, so nothing else has to string-match attribute names.
 *
 * Returns `null` for an event that carries no content, and for a content event
 * that arrived without text and without a reference — which is what a recording
 * made with the content flags off looks like. There is no fallback for that
 * case on purpose: such a recording simply has no content to serve.
 *
 * Careful: a log record has both a top-level `body` (the OTLP LogRecord body,
 * here just the event name) and an `attrs.body` attribute (the payload). Only
 * `attrs` is read here.
 *
 * @param {object} log a normalized log record from otlp/decode.mjs
 * @returns {null | {kind: string, text: string|null, length: number, truncated: boolean, ref: string|null}}
 *   `length` is the untruncated length the CLI reported, which can exceed
 *   `text.length`; `ref` is a path on the *agent's* disk, set only when the CLI
 *   ran with `OTEL_LOG_RAW_API_BODIES=file:<dir>`, and then no text arrives.
 */
export function contentOf(log) {
  const attrs = log?.attrs ?? {};
  switch (log?.eventName) {
    case EVENT.apiRequestBody:
      return bodyContent('request_body', attrs);
    case EVENT.apiResponseBody:
      return bodyContent('response_body', attrs);
    case EVENT.userPrompt:
      return textContent('user_prompt', attrs.prompt, attrs.prompt_length);
    case EVENT.assistantResponse:
      return textContent('assistant_response', attrs.response, attrs.response_length);
    case EVENT.toolResult:
      // Same fallback toolParametersOf documents: `tool_input` since 2.1.x,
      // `tool_parameters` on older CLIs.
      return textContent(
        'tool_input',
        attrs.tool_input ?? attrs.tool_parameters,
        attrs.tool_input_size_bytes,
      );
    default:
      return null;
  }
}

/** `api_request_body` / `api_response_body`: inline text, or a file reference. */
function bodyContent(kind, attrs) {
  const text = typeof attrs.body === 'string' ? attrs.body : null;
  const ref = typeof attrs.body_ref === 'string' && attrs.body_ref ? attrs.body_ref : null;
  if (text === null && ref === null) return null;
  return {
    kind,
    text,
    length: num(attrs.body_length, text === null ? 0 : text.length),
    truncated: bool(attrs.body_truncated),
    ref,
  };
}

/** The events that carry their text in one plain attribute and never a reference. */
function textContent(kind, raw, reportedLength) {
  if (typeof raw !== 'string') return null;
  return { kind, text: raw, length: num(reportedLength, raw.length), truncated: false, ref: null };
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

/**
 * The agent instance a record belongs to, or `null` when it carries no agent
 * identity.
 *
 * Only `claude_code.llm_request` and `claude_code.tool` spans set `agent_id`
 * and `parent_agent_id`, and only while the active agent is *not* the main one:
 * the main agent emits no `agent_id` at all. So `null` means "not a subagent
 * instance" — main-agent work, or a span type that never carries the attribute
 * — never "unknown agent".
 *
 * `agent.name` and `query_source` (e.g. `agent:builtin:researcher`) name only
 * the agent *type*, which two concurrent instances of one subagent share;
 * `agent_id` is the only attribute that tells those two apart.
 */
export function agentRefOf(attrs = {}) {
  const agentId = typeof attrs.agent_id === 'string' ? attrs.agent_id.trim() : '';
  if (!agentId) return null;
  const parentAgentId = typeof attrs.parent_agent_id === 'string' ? attrs.parent_agent_id.trim() : '';
  const agentType = attrs['agent.name'] ?? attrs.query_source ?? null;
  return { agentId, parentAgentId: parentAgentId || null, agentType: agentType || null };
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
    // Content, on by default. Without these four an agent's telemetry is
    // shape-only: how many prompts, how many tool calls, how many tokens, but
    // never what was said. They are deliberately not tied to the `traces`
    // option — OTEL_LOG_TOOL_CONTENT only does anything with spans on, but it is
    // inert otherwise, and making the whole content block depend on an unrelated
    // switch would surprise anyone who turns traces off.
    OTEL_LOG_USER_PROMPTS: '1',
    OTEL_LOG_TOOL_DETAILS: '1',
    OTEL_LOG_TOOL_CONTENT: '1',
    // '1' means inline: the body travels in the event and reaches this
    // collector. The alternative the CLI offers, 'file:<dir>', writes bodies to
    // the *agent's* own disk and sends only a path, which a collector on
    // another machine can never read.
    OTEL_LOG_RAW_API_BODIES: '1',
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
