/**
 * argus-ui — front end.
 *
 * Reads the JSON API of its own server, which forwards to a collector, and
 * keeps itself current from an SSE stream. There is no framework and no build
 * step on purpose: the whole tool has to be runnable with
 * `node bin/argus-ui.mjs` inside a throwaway sandbox.
 */

const TOKEN = new URLSearchParams(location.search).get('token');

const state = {
  sessions: [],
  stats: null,
  config: null,
  selectedSessionId: null,
  session: null,
  tab: 'overview',
  trace: null,
  selectedTraceId: null,
  selectedSpanId: null,
  agents: null,
  capture: null,
  selectedAgentKey: null,
  agentContent: null,
  agentBody: null,
  events: [],
  eventFilters: { event: '', errorsOnly: false, search: '' },
  metrics: [],
  facets: { events: [], metrics: [] },
  search: '',
  authError: false,
};

/* ------------------------------ formatting ------------------------------ */

const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );

function fmtNum(value) {
  const n = Number(value) || 0;
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

function fmtCost(value) {
  const n = Number(value) || 0;
  if (n === 0) return '$0';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 100) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

function fmtDur(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '–';
  if (n < 1) return '<1ms';
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(2)}s`;
  const minutes = Math.floor(n / 60_000);
  const seconds = Math.round((n % 60_000) / 1000);
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

function fmtClock(ms) {
  if (!ms) return '–';
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(
    date.getSeconds(),
  ).padStart(2, '0')}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

function fmtAgo(ms) {
  if (!ms) return 'never';
  const delta = Math.max(0, Date.now() - ms);
  if (delta < 1000) return 'just now';
  if (delta < 60_000) return `${Math.round(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  return `${Math.round(delta / 86_400_000)}d ago`;
}

const isLive = (session) => Date.now() - session.lastSeenMs < 90_000;

function shortId(id, keep = 12) {
  return id && id.length > keep + 3 ? `${id.slice(0, keep)}…` : id ?? '';
}

/* --------------------------------- api ---------------------------------- */

async function api(path, params = {}) {
  const url = new URL(path, location.origin);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== '') url.searchParams.set(key, value);
  }
  if (TOKEN) url.searchParams.set('token', TOKEN);
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  // The status is carried along because 401 is the one failure the page can tell
  // the user how to fix, and "unreachable" would be the wrong thing to say.
  if (!response.ok) {
    throw Object.assign(new Error(`${response.status} ${response.statusText}`), { status: response.status });
  }
  return response.json();
}

/* ------------------------------- top bar -------------------------------- */

function renderStats() {
  const strip = document.getElementById('stat-strip');
  const stats = state.stats;
  if (!stats) {
    strip.innerHTML = '';
    return;
  }
  const t = stats.totals;
  const cards = [
    { label: 'sessions', value: `${t.sessions}${t.activeSessions ? ` · ${t.activeSessions} live` : ''}` },
    { label: 'cost', value: fmtCost(t.costUsd) },
    { label: 'tokens', value: fmtNum(Object.values(t.tokens).reduce((a, b) => a + b, 0)) },
    { label: 'llm calls', value: fmtNum(t.llmRequests) },
    { label: 'tool calls', value: fmtNum(t.toolCalls) },
    {
      label: 'errors',
      value: fmtNum(t.apiErrors + t.toolFailures),
      tone: t.apiErrors + t.toolFailures > 0 ? 'error' : null,
    },
    { label: 'buffered', value: `${fmtNum(stats.buffered.spans)} spans` },
  ];
  strip.innerHTML = cards
    .map(
      (card) => `<div class="stat"${card.tone ? ` data-tone="${card.tone}"` : ''}>
        <span class="stat-value">${esc(card.value)}</span>
        <span class="stat-label">${esc(card.label)}</span>
      </div>`,
    )
    .join('');
}

function setLive(stateName, label) {
  const indicator = document.getElementById('live-indicator');
  indicator.dataset.state = stateName;
  indicator.querySelector('.live-label').textContent = label;
}

/* ----------------------------- session list ----------------------------- */

function renderSessionList() {
  const list = document.getElementById('session-list');
  document.getElementById('session-count').textContent = state.sessions.length;
  if (!state.sessions.length) {
    list.innerHTML = '<li class="placeholder">No sessions yet</li>';
    return;
  }
  list.innerHTML = state.sessions
    .map((session) => {
      const errors = session.counts.apiErrors + session.counts.toolFailures;
      // A named session leads with its name; the id stays on the card because it
      // is what every other view, log line and API path refers to.
      return `<li>
        <button type="button" class="session-card" data-session="${esc(session.id)}"
          aria-current="${session.id === state.selectedSessionId}">
          <span class="session-card-top">
            ${isLive(session) ? '<span class="dot-live" aria-label="live"></span>' : ''}
            <span class="${session.name ? 'session-name' : 'session-id'}" title="${esc(session.id)}">${esc(
              session.name || shortId(session.id, 20),
            )}</span>
          </span>
          ${session.name ? `<span class="session-sub" title="${esc(session.id)}">${esc(shortId(session.id, 20))}</span>` : ''}
          <span class="session-card-meta">
            <span>${esc(fmtAgo(session.lastSeenMs))}</span>
            <span>${esc(fmtCost(session.costUsd))}</span>
            <span>${esc(fmtNum(session.tokensTotal))} tok</span>
            ${errors ? `<span class="err">${errors} err</span>` : ''}
          </span>
        </button>
      </li>`;
    })
    .join('');
}

/* -------------------------------- detail -------------------------------- */

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'agents', label: 'Agents' },
  { id: 'todos', label: 'Tasks' },
  { id: 'traces', label: 'Traces' },
  { id: 'events', label: 'Events' },
  { id: 'metrics', label: 'Metrics' },
  { id: 'raw', label: 'Attributes' },
];

function renderDetail() {
  const detail = document.getElementById('detail');
  const session = state.session;
  if (!session) {
    renderEmptyState();
    return;
  }
  const errors = session.counts.apiErrors + session.counts.toolFailures;
  const counts = {
    // No count badge for the tasks tab: completed/deleted tasks stay in the
    // reconstructed state (see #applyTodo), so a count only ever grows and
    // stops reflecting what currently exists — worse than no number at all.
    agents: session.agentCount,
    traces: session.traceCount,
    events: session.counts.logs,
    metrics: session.counts.metricPoints,
  };

  detail.innerHTML = `
    <div class="detail-head">
      <div>
        <h1 class="detail-title"${session.name ? ' data-named="true"' : ''}>${esc(session.name || session.id)}</h1>
        ${session.name ? `<div class="detail-subtitle">${esc(session.id)}</div>` : ''}
        <div class="chips">
          ${isLive(session) ? '<span class="chip" data-tone="live">live</span>' : ''}
          <span class="chip">service <b>${esc(session.serviceName)}</b></span>
          ${session.attrs['app.entrypoint'] ? `<span class="chip">entrypoint <b>${esc(session.attrs['app.entrypoint'])}</b></span>` : ''}
          ${session.attrs['app.version'] ? `<span class="chip">cli <b>${esc(session.attrs['app.version'])}</b></span>` : ''}
          ${session.startTypes.length ? `<span class="chip">start <b>${esc(session.startTypes.join(', '))}</b></span>` : ''}
          <span class="chip">started <b>${esc(new Date(session.firstSeenMs).toLocaleString())}</b></span>
          <span class="chip">last seen <b>${esc(fmtAgo(session.lastSeenMs))}</b></span>
          ${errors ? `<span class="chip" data-tone="error">${errors} error${errors === 1 ? '' : 's'}</span>` : ''}
        </div>
      </div>
    </div>

    <nav class="tabs" role="tablist">
      ${TABS.map(
        (tab) => `<button type="button" class="tab" role="tab" data-tab="${tab.id}"
          aria-selected="${state.tab === tab.id}">${tab.label}${
            counts[tab.id] !== undefined ? `<span class="count">${fmtNum(counts[tab.id])}</span>` : ''
          }</button>`,
      ).join('')}
    </nav>

    <div id="tab-body"></div>
  `;
  renderTabBody();
}

function renderTabBody() {
  const body = document.getElementById('tab-body');
  if (!body) return;
  switch (state.tab) {
    case 'agents':
      body.innerHTML = renderAgentsTab();
      break;
    case 'todos':
      body.innerHTML = renderTodosTab();
      break;
    case 'traces':
      body.innerHTML = renderTracesTab();
      break;
    case 'events':
      body.innerHTML = renderEventsTab();
      break;
    case 'metrics':
      body.innerHTML = renderMetricsTab();
      break;
    case 'raw':
      body.innerHTML = renderRawTab();
      break;
    default:
      body.innerHTML = renderOverviewTab();
  }
}

/* ------------------------------- overview ------------------------------- */

function kpi(label, value, { sub = '', tone = null } = {}) {
  return `<div class="kpi"${tone ? ` data-tone="${tone}"` : ''}>
    <div class="kpi-value">${esc(value)}</div>
    <div class="kpi-label">${esc(label)}</div>
    ${sub ? `<div class="kpi-sub">${esc(sub)}</div>` : ''}
  </div>`;
}

function renderOverviewTab() {
  const s = state.session;
  const tokens = s.tokens;
  const cacheHitRate =
    tokens.input + tokens.cacheRead > 0
      ? Math.round((tokens.cacheRead / (tokens.input + tokens.cacheRead)) * 100)
      : null;
  const toolFailures = s.counts.toolFailures + s.toolFailuresFromEvents;

  const kpis = [
    kpi('cost', fmtCost(s.costUsd), { sub: `source: ${s.costSource}`, tone: 'accent' }),
    kpi('tokens', fmtNum(s.tokensTotal), { sub: `source: ${s.tokenSource}` }),
    kpi('input', fmtNum(tokens.input)),
    kpi('output', fmtNum(tokens.output)),
    kpi('cache read', fmtNum(tokens.cacheRead), {
      sub: cacheHitRate === null ? '' : `${cacheHitRate}% of prompt`,
    }),
    kpi('cache write', fmtNum(tokens.cacheCreation)),
    kpi('interactions', fmtNum(s.counts.interactions), { sub: `${fmtNum(s.counts.userPrompts)} prompts` }),
    kpi('llm requests', fmtNum(s.counts.llmRequests)),
    kpi('tool calls', fmtNum(s.counts.toolCalls), {
      sub: toolFailures ? `${toolFailures} failed` : '',
      tone: toolFailures ? 'error' : null,
    }),
    kpi('api errors', fmtNum(s.counts.apiErrors), { tone: s.counts.apiErrors ? 'error' : null }),
    kpi('lines of code', `+${fmtNum(s.linesAdded)} / -${fmtNum(s.linesRemoved)}`),
    kpi('commits / prs', `${fmtNum(s.commits)} / ${fmtNum(s.pullRequests)}`),
    kpi('active time', fmtDur((s.activeTimeSec.user + s.activeTimeSec.cli) * 1000), {
      sub: `wall ${fmtDur(s.durationMs)}`,
    }),
    kpi('edit decisions', `${s.editDecisions.accept} ✓ / ${s.editDecisions.reject} ✕`),
  ].join('');

  const models = s.models.length
    ? `<div class="panel">
        <h3>Models</h3>
        <div class="table-scroll"><table>
          <thead><tr>
            <th>Model</th><th class="num">Requests</th><th class="num">Input</th>
            <th class="num">Output</th><th class="num">Cache read</th><th class="num">Cost</th>
            <th class="num">Avg latency</th><th class="num">Avg TTFT</th><th class="num">Errors</th>
          </tr></thead>
          <tbody>${s.models
            .map(
              (model) => `<tr>
                <td class="name">${esc(model.name)}</td>
                <td class="num">${fmtNum(model.requests)}</td>
                <td class="num">${fmtNum(model.tokens.input)}</td>
                <td class="num">${fmtNum(model.tokens.output)}</td>
                <td class="num">${fmtNum(model.tokens.cacheRead)}</td>
                <td class="num">${esc(fmtCost(model.costUsd))}</td>
                <td class="num">${esc(fmtDur(model.avgDurationMs))}</td>
                <td class="num">${esc(fmtDur(model.avgTtftMs))}</td>
                <td class="num${model.errors ? ' bad' : ''}">${model.errors}</td>
              </tr>`,
            )
            .join('')}</tbody>
        </table></div>
      </div>`
    : '';

  const tools = s.tools.length
    ? `<div class="panel">
        <h3>Tools</h3>
        <div class="table-scroll"><table>
          <thead><tr>
            <th>Tool</th><th class="num">Calls</th><th class="num">Failures</th>
            <th class="num">Rejected</th><th class="num">Avg duration</th><th class="num">Total</th>
            <th class="num">Result tokens</th>
          </tr></thead>
          <tbody>${s.tools
            .map((tool) => {
              const estimated = tool.resultTokensEstimated > 0;
              const resultTokens = estimated
                ? `<span class="muted" title="CLI didn't report result_tokens for these calls; estimated from tool_result_size_bytes (~4 bytes/token)">~${fmtNum(tool.resultTokens)}</span>`
                : fmtNum(tool.resultTokens);
              return `<tr>
                <td class="name">${esc(tool.name)}</td>
                <td class="num">${fmtNum(tool.calls)}</td>
                <td class="num${tool.failures ? ' bad' : ''}">${tool.failures}</td>
                <td class="num">${tool.rejected}</td>
                <td class="num">${esc(fmtDur(tool.avgDurationMs))}</td>
                <td class="num">${esc(fmtDur(tool.durationMsTotal))}</td>
                <td class="num">${resultTokens}</td>
              </tr>`;
            })
            .join('')}</tbody>
        </table></div>
      </div>`
    : '';

  const lastError = s.lastError
    ? `<div class="panel">
        <h3>Last error</h3>
        <table class="attr-table"><tbody>
          <tr><td>kind</td><td>${esc(s.lastError.kind)}</td></tr>
          <tr><td>at</td><td>${esc(fmtClock(s.lastError.at))}</td></tr>
          <tr><td>message</td><td>${esc(s.lastError.message)}</td></tr>
        </tbody></table>
      </div>`
    : '';

  return `<div class="kpi-grid">${kpis}</div>${lastError}${models}${tools}`;
}

/* --------------------------------- agents -------------------------------- */

/**
 * What to set to see the thing that is missing.
 *
 * Every content switch is off by default, so an empty panel means "nobody
 * turned it on" far more often than "nothing happened" — and only the page can
 * tell the difference, because only the page knows how many carrying records
 * arrived without their payload.
 */
function switchHint(html) {
  return `<p class="switch-hint">${html}</p>`;
}

function capturePresent(kind) {
  return Boolean(state.capture?.[kind]?.present);
}

const HINTS = {
  prompts: () =>
    switchHint(
      `Prompt text was not exported. Set <code>OTEL_LOG_USER_PROMPTS=1</code> in the agent environment before the session starts.`,
    ),
  responses: () =>
    switchHint(
      `Response text was not exported. Set <code>OTEL_LOG_ASSISTANT_RESPONSES=1</code> (or <code>OTEL_LOG_USER_PROMPTS=1</code>, which it falls back to) in the agent environment.`,
    ),
  toolArguments: () =>
    switchHint(`Tool arguments were not exported. Set <code>OTEL_LOG_TOOL_DETAILS=1</code> in the agent environment.`),
  toolContent: () =>
    switchHint(
      `Tool output was not exported. Set <code>OTEL_LOG_TOOL_CONTENT=1</code> together with <code>CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1</code> in the agent environment.`,
    ),
  requestBodies: () =>
    switchHint(
      `No request payloads were exported. Set <code>OTEL_LOG_RAW_API_BODIES=1</code> in the agent environment — it captures the entire prompt of every call.`,
    ),
};

function renderAgentsTab() {
  const agents = state.agents;
  if (!agents) return '<div class="placeholder">Loading agents…</div>';
  if (!agents.length) {
    return `<div class="placeholder">
      Nothing has been attributed to an agent yet. Agents are split out of the same records the
      Overview counts, so this fills in as soon as the session exports anything.
    </div>`;
  }
  const selected = agents.find((agent) => agent.key === state.selectedAgentKey) ?? agents[0];

  const picker = agents
    .map(
      (agent) => `<button type="button" class="trace-pill" data-agent="${esc(agent.key)}"
        aria-current="${agent.key === selected.key}">
        <span class="title">${esc(agent.label)}<span class="chip">${esc(agent.kind)}</span></span>
        <span class="meta">${esc(fmtNum(agent.tokensTotal))} tok · ${esc(fmtCost(agent.costUsd))} · ${
          agent.context.series.length
        } model call${agent.context.series.length === 1 ? '' : 's'}</span>
      </button>`,
    )
    .join('');

  return `<div class="trace-picker">${picker}</div>${renderAgentDetail(selected)}`;
}

function renderAgentDetail(agent) {
  const context = agent.context;
  const ratio = context.lastCachedPrefixRatio;
  const kpis = [
    kpi('tokens', fmtNum(agent.tokensTotal), { sub: `source: ${agent.tokenSource}` }),
    kpi('cost', fmtCost(agent.costUsd), { sub: `source: ${agent.costSource}`, tone: 'accent' }),
    kpi('model calls', fmtNum(agent.counts.apiRequests), { sub: `${fmtNum(agent.counts.llmRequests)} spans` }),
    kpi('tool calls', fmtNum(agent.counts.toolCalls), {
      sub: agent.counts.toolFailures ? `${agent.counts.toolFailures} failed` : '',
      tone: agent.counts.toolFailures ? 'error' : null,
    }),
    kpi('peak context', fmtNum(context.peakOccupancy)),
    kpi('last context', fmtNum(context.lastOccupancy)),
    kpi('cached prefix', fmtNum(context.lastCachedPrefixTokens), {
      sub: ratio === null ? '–' : `${Math.round(ratio * 100)}% of last prompt`,
    }),
    kpi('wall time', fmtDur(agent.durationMs), { sub: `${fmtNum(agent.counts.userPrompts)} prompts` }),
  ].join('');

  const nameHint =
    agent.name === 'custom'
      ? switchHint(
          `This agent reports its name as <code>custom</code>, which is what the CLI sends for user-defined agents and plugins. Set <code>OTEL_LOG_TOOL_DETAILS=1</code> to see its real name.`,
        )
      : '';

  return `<div class="kpi-grid">${kpis}</div>
    ${nameHint}
    ${renderContextCurve(agent)}
    ${renderAgentModels(agent)}
    ${renderAgentTools(agent)}
    ${renderCompletions(agent)}
    ${renderBodiesPanel(agent)}
    ${renderContentPanel()}`;
}

/**
 * One stacked bar per model call: what the agent handed the model that time,
 * split into the prefix it read from cache, the fresh input, and the prefix it
 * wrote to cache. Output is not part of the bar — it is what came back, not what
 * was held.
 */
function renderContextCurve(agent) {
  const series = agent.context.series;
  if (!series.length) {
    return `<div class="panel"><h3>Context occupancy</h3>${switchHint(
      `The curve is built from <code>claude_code.api_request</code> events and this agent exported none. Set <code>OTEL_LOGS_EXPORTER=otlp</code> in the agent environment.`,
    )}</div>`;
  }
  const peak = Math.max(agent.context.peakOccupancy, 1);
  const width = 1000;
  const height = 220;
  const slot = width / series.length;
  const barWidth = Math.max(slot - Math.min(slot * 0.2, 3), 0.5);

  const bars = series
    .map((entry, index) => {
      const x = index * slot;
      let y = height;
      const segments = [
        ['cache-read', entry.cacheReadTokens],
        ['input', entry.inputTokens],
        ['cache-write', entry.cacheCreationTokens],
      ];
      const rects = segments
        .map(([kind, value]) => {
          const barHeight = (value / peak) * height;
          if (barHeight <= 0) return '';
          y -= barHeight;
          return `<rect data-segment="${kind}" x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barWidth.toFixed(
            2,
          )}" height="${barHeight.toFixed(2)}"></rect>`;
        })
        .join('');
      const title = `${fmtClock(entry.atMs)} · ${fmtNum(entry.occupancy)} tokens in context — cache read ${fmtNum(
        entry.cacheReadTokens,
      )}, input ${fmtNum(entry.inputTokens)}, cache write ${fmtNum(entry.cacheCreationTokens)}, output ${fmtNum(
        entry.outputTokens,
      )}${entry.model ? ` · ${entry.model}` : ''}`;
      return `<g><title>${esc(title)}</title>${rects}</g>`;
    })
    .join('');

  return `<div class="panel">
    <h3>Context occupancy <span class="muted">${series.length} model call${
      series.length === 1 ? '' : 's'
    }, peak ${esc(fmtNum(agent.context.peakOccupancy))} tokens</span></h3>
    <div class="context-curve">
      <div class="curve-axis"><span>${esc(fmtNum(peak))}</span><span>0</span></div>
      <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img"
        aria-label="context occupancy per model call">${bars}</svg>
    </div>
    <div class="curve-legend">
      <span data-segment="cache-read">cache read</span>
      <span data-segment="input">input</span>
      <span data-segment="cache-write">cache write</span>
    </div>
  </div>`;
}

function renderAgentModels(agent) {
  if (!agent.models.length) return '';
  return `<div class="panel">
    <h3>Models</h3>
    <div class="table-scroll"><table>
      <thead><tr>
        <th>Model</th><th class="num">Requests</th><th class="num">Input</th><th class="num">Output</th>
        <th class="num">Cache read</th><th class="num">Cost</th><th class="num">Avg latency</th>
        <th class="num">Errors</th>
      </tr></thead>
      <tbody>${agent.models
        .map(
          (model) => `<tr>
            <td class="name">${esc(model.name)}</td>
            <td class="num">${fmtNum(model.requests)}</td>
            <td class="num">${fmtNum(model.tokens.input)}</td>
            <td class="num">${fmtNum(model.tokens.output)}</td>
            <td class="num">${fmtNum(model.tokens.cacheRead)}</td>
            <td class="num">${esc(fmtCost(model.costUsd))}</td>
            <td class="num">${esc(fmtDur(model.avgDurationMs))}</td>
            <td class="num${model.errors ? ' bad' : ''}">${model.errors}</td>
          </tr>`,
        )
        .join('')}</tbody>
    </table></div>
  </div>`;
}

function renderAgentTools(agent) {
  if (!agent.tools.length) {
    return `<div class="panel"><h3>Tools</h3>${switchHint(
      `Tool calls are attributed from <code>claude_code.tool</code> spans, so without traces they all count as the main session. Set <code>CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1</code> and <code>OTEL_TRACES_EXPORTER=otlp</code>.`,
    )}</div>`;
  }
  return `<div class="panel">
    <h3>Tools</h3>
    <div class="table-scroll"><table>
      <thead><tr>
        <th>Tool</th><th class="num">Calls</th><th class="num">Failures</th>
        <th class="num">Avg duration</th><th class="num">Total</th>
      </tr></thead>
      <tbody>${agent.tools
        .map(
          (tool) => `<tr>
            <td class="name">${esc(tool.name)}</td>
            <td class="num">${fmtNum(tool.calls)}</td>
            <td class="num${tool.failures ? ' bad' : ''}">${tool.failures}</td>
            <td class="num">${esc(fmtDur(tool.avgDurationMs))}</td>
            <td class="num">${esc(fmtDur(tool.durationMsTotal))}</td>
          </tr>`,
        )
        .join('')}</tbody>
    </table></div>
  </div>`;
}

function renderCompletions(agent) {
  if (!agent.completions.length) return '';
  return `<div class="panel">
    <h3>Runs</h3>
    <div class="table-scroll"><table>
      <thead><tr>
        <th>Finished</th><th>Type</th><th>Source</th><th>Model</th><th>Final model</th>
        <th class="num">Tokens</th><th class="num">Tool uses</th><th class="num">Duration</th>
      </tr></thead>
      <tbody>${agent.completions
        .map(
          (run) => `<tr>
            <td>${esc(fmtClock(run.atMs))}</td>
            <td class="name">${esc(run.agentType ?? '—')}${run.isBuiltIn ? ' <span class="chip">built-in</span>' : ''}${
              run.isAsync ? ' <span class="chip">async</span>' : ''
            }</td>
            <td>${esc(run.source ?? '—')}</td>
            <td>${esc(run.model ?? '—')}</td>
            <td>${esc(run.finalModel ?? '—')}${run.modelSwapped ? ' <span class="chip" data-tone="warn">swapped</span>' : ''}</td>
            <td class="num">${fmtNum(run.totalTokens)}</td>
            <td class="num">${fmtNum(run.totalToolUses)}</td>
            <td class="num">${esc(fmtDur(run.durationMs))}</td>
          </tr>`,
        )
        .join('')}</tbody>
    </table></div>
  </div>`;
}

function renderBodiesPanel(agent) {
  if (!agent.bodies.length) {
    return `<div class="panel"><h3>Request bodies</h3>${HINTS.requestBodies()}</div>`;
  }
  const rows = agent.bodies
    .map(
      (entry) => `<button type="button" class="body-row" data-body-seq="${entry.seq}"
        aria-current="${state.agentBody?.seq === entry.seq}">
        <span>${esc(fmtClock(entry.atMs))}</span>
        <span class="name">${esc(entry.model ?? 'unknown model')}</span>
        <span class="num">${esc(fmtNum(entry.bodyLength))} B</span>
        ${entry.truncated ? '<span class="chip" data-tone="warn">truncated</span>' : ''}
      </button>`,
    )
    .join('');
  return `<div class="panel">
    <h3>Request bodies <span class="muted">the whole prompt of each call</span></h3>
    <div class="body-list">${rows}</div>
    ${renderBodyDetail()}
  </div>`;
}

function renderBodyDetail() {
  const body = state.agentBody;
  if (!body) return '<div class="placeholder">Select a request to see what was sent</div>';
  if (body.available === false) {
    return `<div class="placeholder">
      This payload was ${esc(fmtNum(body.bodyLength))} bytes, but its record has rolled out of the raw
      log buffer — the figures above survive, the payload does not. Start the collector with a smaller
      <code>--max-logs</code> window if you need payloads to stay inspectable for longer.
    </div>`;
  }
  if (body.error) {
    return `<div class="placeholder">${esc(body.error)}</div>`;
  }
  if (body.bodyRef) {
    return `<div class="placeholder">
      <code>OTEL_LOG_RAW_API_BODIES=file:…</code> wrote this payload to
      <code>${esc(body.bodyRef)}</code> on the exporting machine and sent only the path. The collector
      never reads that file.
    </div>`;
  }
  const banner = body.truncated
    ? `<p class="switch-hint">The CLI cut this payload at ${esc(fmtNum(body.deliveredBytes))} of
       ${esc(fmtNum(body.bodyLength))} bytes, so it is shown raw and not parsed.</p>`
    : '';
  if (!body.parsed) {
    return `<div class="body-detail">
      ${banner}
      ${body.parseError ? `<p class="switch-hint">This payload did not parse as JSON: ${esc(body.parseError)}</p>` : ''}
      <pre class="body-raw">${esc(body.body ?? '')}</pre>
    </div>`;
  }
  return `<div class="body-detail">${renderParsedBody(body.parsed)}</div>`;
}

/** Text out of one Anthropic content block, whatever shape it arrived in. */
function blockText(block) {
  if (typeof block === 'string') return block;
  if (!block || typeof block !== 'object') return '';
  if (typeof block.text === 'string') return block.text;
  if (typeof block.content === 'string') return block.content;
  return JSON.stringify(block, null, 2);
}

function renderParsedBody(parsed) {
  const system = Array.isArray(parsed.system) ? parsed.system : parsed.system ? [parsed.system] : [];
  const tools = Array.isArray(parsed.tools) ? parsed.tools : [];
  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];

  const systemHtml = system.length
    ? `<h4>System (${system.length} block${system.length === 1 ? '' : 's'})</h4>
       ${system.map((block) => `<pre class="body-block">${esc(blockText(block))}</pre>`).join('')}`
    : '';
  const toolsHtml = tools.length
    ? `<h4>Tools (${tools.length})</h4>
       <table class="attr-table"><tbody>${tools
         .map(
           (tool) => `<tr><td>${esc(tool?.name ?? '—')}</td><td>${esc(
             String(tool?.description ?? '').slice(0, 400),
           )}</td></tr>`,
         )
         .join('')}</tbody></table>`
    : '';
  const messagesHtml = messages.length
    ? `<h4>Messages (${messages.length})</h4>
       ${messages
         .map((message) => {
           const content = Array.isArray(message?.content) ? message.content : [message?.content];
           return `<div class="body-message">
             <span class="chip">${esc(message?.role ?? 'unknown')}</span>
             ${content.map((block) => `<pre class="body-block">${esc(blockText(block))}</pre>`).join('')}
           </div>`;
         })
         .join('')}`
    : '';
  return `${systemHtml}${toolsHtml}${messagesHtml}` || '<div class="placeholder">Nothing recognisable in this payload</div>';
}

function renderContentPanel() {
  const content = state.agentContent;
  if (!content) return '';
  if (!content.items.length) {
    return `<div class="panel"><h3>Context content</h3>
      <div class="placeholder">No prompts, responses or tool calls of this agent are still buffered.</div>
    </div>`;
  }
  const items = content.items.map((item) => renderContentItem(item)).join('');
  return `<div class="panel">
    <h3>Context content <span class="muted">${content.items.length} item${
      content.items.length === 1 ? '' : 's'
    }, from the raw window</span></h3>
    ${content.truncated ? '<p class="muted">Older items were cut to the requested limit.</p>' : ''}
    <div class="content-list">${items}</div>
  </div>`;
}

function renderContentItem(item) {
  if (item.kind === 'prompt' || item.kind === 'response') {
    const captured = item.kind === 'prompt' ? capturePresent('prompts') : capturePresent('responses');
    const bodyHtml = item.text
      ? `<pre class="body-block">${esc(item.text)}</pre>`
      : captured
        ? `<p class="muted">${esc(fmtNum(item.length))} characters, not carried on this record.</p>`
        : item.kind === 'prompt'
          ? HINTS.prompts()
          : HINTS.responses();
    return `<div class="content-item" data-kind="${item.kind}">
      <div class="content-head"><span class="chip">${item.kind}</span>
        <span class="muted">${esc(fmtClock(item.atMs))}${
          item.length ? ` · ${esc(fmtNum(item.length))} chars` : ''
        }</span></div>
      ${bodyHtml}
    </div>`;
  }
  const args = item.arguments
    ? `<pre class="body-block">${esc(JSON.stringify(item.arguments, null, 2))}</pre>`
    : capturePresent('toolArguments')
      ? '<p class="muted">This call carried no arguments.</p>'
      : HINTS.toolArguments();
  const output = item.output
    ? `<pre class="body-block">${esc(
        Object.entries(item.output)
          .map(([key, value]) => `${key}: ${formatValue(value)}`)
          .join('\n'),
      )}</pre>`
    : capturePresent('toolContent')
      ? '<p class="muted">This call recorded no output.</p>'
      : HINTS.toolContent();
  return `<div class="content-item" data-kind="tool">
    <div class="content-head">
      <span class="chip"${item.success === false ? ' data-tone="error"' : ''}>${esc(item.toolName ?? 'tool')}</span>
      <span class="muted">${esc(fmtClock(item.atMs))} · ${esc(fmtDur(item.durationMs))}${
        item.resultBytes ? ` · ${esc(fmtNum(item.resultBytes))} B result` : ''
      }</span>
      ${item.detail ? `<span class="detail-note" title="${esc(item.detail)}">${esc(item.detail)}</span>` : ''}
    </div>
    ${args}
    ${output}
  </div>`;
}

/* --------------------------------- todos --------------------------------- */

function todoStatusChip(status) {
  const tone = { completed: 'ok', in_progress: 'warn', deleted: 'error' }[status];
  return `<span class="chip"${tone ? ` data-tone="${tone}"` : ''}>${esc(status || 'pending')}</span>`;
}

function renderTodosTab() {
  const todos = state.session.todos;
  const legacy = todos.legacy;
  const tasks = todos.tasks;
  const unlinked = todos.unlinkedCreates;

  if (!legacy && !tasks.length && !unlinked.length) {
    if (todos.callsSeen > 0) {
      return `<div class="placeholder">
        ${todos.callsSeen} TodoWrite/TaskCreate/TaskUpdate call(s) seen, but no parameters were
        captured. Set <code>OTEL_LOG_TOOL_DETAILS=1</code> in the agent environment to see task
        content and status here.
      </div>`;
    }
    return '<div class="placeholder">No tasks recorded for this session.</div>';
  }

  const sections = [];

  if (legacy) {
    sections.push(`<div class="panel">
      <h3>Todos (TodoWrite) · last write ${esc(fmtAgo(todos.legacyAtMs))}</h3>
      <div class="table-scroll"><table>
        <thead><tr><th>Status</th><th>Content</th></tr></thead>
        <tbody>${legacy
          .map(
            (todo) => `<tr>
              <td>${todoStatusChip(todo.status)}</td>
              <td>${esc(todo.status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content)}</td>
            </tr>`,
          )
          .join('')}</tbody>
      </table></div>
    </div>`);
  }

  if (tasks.length) {
    sections.push(`<div class="panel">
      <h3>Tasks by id (TaskUpdate)</h3>
      <div class="table-scroll"><table>
        <thead><tr><th>Id</th><th>Status</th><th>Subject</th><th>Description</th><th class="num">Updated</th></tr></thead>
        <tbody>${tasks
          .map(
            (task) => `<tr>
              <td class="name" title="${esc(task.taskId)}">${esc(shortId(task.taskId, 10))}</td>
              <td>${todoStatusChip(task.status)}</td>
              <td>${esc(task.subject || '—')}</td>
              <td>${esc(task.description || '—')}</td>
              <td class="num">${esc(fmtAgo(task.updatedAtMs))}</td>
            </tr>`,
          )
          .join('')}</tbody>
      </table></div>
    </div>`);
  }

  if (unlinked.length) {
    sections.push(`<div class="panel">
      <h3>Created (id not yet known)</h3>
      <p class="muted" style="padding: 0 12px 10px">
        Claude Code assigns the task id after <code>TaskCreate</code> runs and only reports it in
        the tool result, which this telemetry does not carry. These are the raw
        <code>TaskCreate</code> calls — match them to the table above by time and subject.
      </p>
      <div class="table-scroll"><table>
        <thead><tr><th>Subject</th><th>Description</th><th class="num">Created</th></tr></thead>
        <tbody>${unlinked
          .map(
            (item) => `<tr>
              <td>${esc(item.subject || '—')}</td>
              <td>${esc(item.description || '—')}</td>
              <td class="num">${esc(fmtAgo(item.createdAtMs))}</td>
            </tr>`,
          )
          .join('')}</tbody>
      </table></div>
    </div>`);
  }

  return sections.join('');
}

/* -------------------------------- traces -------------------------------- */

const SPAN_KINDS = [
  ['claude_code.interaction', 'interaction'],
  ['claude_code.llm_request', 'llm'],
  ['claude_code.tool.blocked_on_user', 'blocked'],
  ['claude_code.tool.execution', 'execution'],
  ['claude_code.tool', 'tool'],
  ['claude_code.hook', 'hook'],
];

function spanKind(name) {
  for (const [prefix, kind] of SPAN_KINDS) if (name === prefix) return kind;
  return 'other';
}

function spanNote(span) {
  const a = span.attrs ?? {};
  if (span.name === 'claude_code.llm_request') {
    const tokens = [a.input_tokens, a.output_tokens].filter((value) => value !== undefined);
    return [a.model, tokens.length ? `${fmtNum(a.input_tokens)}→${fmtNum(a.output_tokens)}` : '', a.stop_reason]
      .filter(Boolean)
      .join(' · ');
  }
  if (span.name === 'claude_code.tool') return [a.tool_name, a.file_path ?? a.full_command].filter(Boolean).join(' · ');
  if (span.name === 'claude_code.hook') return a.hook_name ?? a.hook_event ?? '';
  if (span.name === 'claude_code.tool.blocked_on_user') return a.decision ?? '';
  if (span.name === 'claude_code.interaction') return a.user_prompt ? String(a.user_prompt).slice(0, 90) : '';
  return '';
}

function renderTracesTab() {
  const traces = state.session.traces ?? [];
  if (!traces.length) {
    return `<div class="placeholder">
      No spans for this session. Traces are the beta signal — set
      <code>CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1</code> and <code>OTEL_TRACES_EXPORTER=otlp</code>.
    </div>`;
  }
  const picker = traces
    .map(
      (trace) => `<button type="button" class="trace-pill" data-trace="${esc(trace.traceId)}"
        aria-current="${trace.traceId === state.selectedTraceId}">
        <span class="title">${esc(trace.prompt || trace.rootName || trace.traceId)}</span>
        <span class="meta">${esc(fmtDur(trace.durationMs))} · ${trace.spanCount} spans${
          trace.errorCount ? ` · ${trace.errorCount} err` : ''
        }</span>
      </button>`,
    )
    .join('');

  return `<div class="trace-picker">${picker}</div>${renderWaterfall()}`;
}

function renderWaterfall() {
  const trace = state.trace;
  if (!trace) return '<div class="placeholder">Select a trace</div>';
  const total = Math.max(trace.durationMs, 1);

  const ticks = [0, 0.25, 0.5, 0.75, 1]
    .map(
      (fraction) =>
        `<span class="axis-tick" style="left:${(fraction * 100).toFixed(2)}%">${esc(
          fmtDur(total * fraction) === '–' ? '0' : fmtDur(total * fraction),
        )}</span>`,
    )
    .join('');

  const rows = trace.spans
    .map((span) => {
      const start = Math.max(0, span.startMs - trace.firstMs);
      const open = span.durationMs === null || span.durationMs === undefined;
      const duration = open ? Math.max(0, trace.lastMs - span.startMs) : span.durationMs;
      const left = (start / total) * 100;
      const width = Math.max((duration / total) * 100, 0.4);
      const isError = span.status?.code === 'error' || span.attrs?.success === false || span.attrs?.success === 'false';
      const note = spanNote(span);
      // Bars that reach the right edge get their duration label flipped to the
      // inside, otherwise it would be clipped or sit on top of the bar.
      const flip = left + width > 80;
      const labelStyle = flip
        ? `right:${(100 - left - width).toFixed(3)}%;text-align:right`
        : `left:${(left + width).toFixed(3)}%`;
      return `<button type="button" class="span-row" data-span="${esc(span.spanId)}"
          aria-current="${span.spanId === state.selectedSpanId}">
        <span class="span-label" style="padding-left:${span.depth * 12}px">
          <span class="name">${esc(span.name.replace('claude_code.', ''))}</span>
          ${note ? `<span class="detail-note" title="${esc(note)}">${esc(note)}</span>` : ''}
        </span>
        <span class="span-track">
          <span class="span-bar" data-kind="${spanKind(span.name)}" data-error="${isError}"
            style="left:${left.toFixed(3)}%;width:${width.toFixed(3)}%"></span>
          <span class="span-duration" data-flip="${flip}" style="${labelStyle}">${esc(
            open ? 'open' : fmtDur(duration),
          )}</span>
        </span>
      </button>`;
    })
    .join('');

  return `<div class="panel" style="padding:12px">
      <div class="waterfall">
        <div class="waterfall-axis"><span></span><span class="axis-ticks">${ticks}</span></div>
        ${rows}
      </div>
    </div>
    ${trace.orphanCount ? `<p class="muted">${trace.orphanCount} span(s) reference a parent that is not in the buffer.</p>` : ''}
    <div class="span-inspector" id="span-inspector">${renderSpanInspector()}</div>`;
}

function renderSpanInspector() {
  const span = state.trace?.spans.find((item) => item.spanId === state.selectedSpanId);
  if (!span) return '<div class="placeholder">Select a span to inspect its attributes</div>';
  const rows = Object.entries(span.attrs ?? {})
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, value]) => `<tr><td>${esc(key)}</td><td>${esc(formatValue(value))}</td></tr>`)
    .join('');
  const events = (span.events ?? [])
    .map(
      (event) => `<tr><td>${esc(fmtClock(event.timeMs))}</td><td>${esc(event.name)} ${esc(
        JSON.stringify(event.attrs ?? {}),
      )}</td></tr>`,
    )
    .join('');
  return `<div class="panel">
    <h3>${esc(span.name)} · ${esc(fmtDur(span.durationMs))}</h3>
    <table class="attr-table"><tbody>
      <tr><td>span_id</td><td>${esc(span.spanId)}</td></tr>
      <tr><td>parent_span_id</td><td>${esc(span.parentSpanId || '—')}</td></tr>
      <tr><td>start</td><td>${esc(fmtClock(span.startMs))}</td></tr>
      <tr><td>status</td><td>${esc(span.status?.code ?? 'unset')}${
        span.status?.message ? ` — ${esc(span.status.message)}` : ''
      }</td></tr>
      ${rows}
    </tbody></table>
    ${events ? `<h3>Span events</h3><table class="attr-table"><tbody>${events}</tbody></table>` : ''}
  </div>`;
}

function formatValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

/* -------------------------------- events -------------------------------- */

function renderEventsTab() {
  const options = ['<option value="">all events</option>']
    .concat(
      state.facets.events.map(
        (facet) =>
          `<option value="${esc(facet.name)}"${facet.name === state.eventFilters.event ? ' selected' : ''}>${esc(
            facet.name.replace('claude_code.', ''),
          )} (${facet.count})</option>`,
      ),
    )
    .join('');

  const rows = state.events.length
    ? state.events
        .slice()
        .reverse()
        .map(
          (event) => `<tr class="event-row" data-event-seq="${event.seq}" data-error="${event.isError}">
            <td class="event-time">${esc(fmtClock(event.timeMs))}</td>
            <td class="event-name">${esc(event.eventName.replace('claude_code.', ''))}</td>
            <td class="event-summary">${esc(event.summary ?? '')}</td>
          </tr>
          <tr class="event-detail" data-detail-seq="${event.seq}" hidden>
            <td colspan="3">
              <table class="attr-table"><tbody>${Object.entries(event.attrs ?? {})
                .sort(([a], [b]) => (a < b ? -1 : 1))
                .map(([key, value]) => `<tr><td>${esc(key)}</td><td>${esc(formatValue(value))}</td></tr>`)
                .join('')}</tbody></table>
            </td>
          </tr>`,
        )
        .join('')
    : '<tr><td colspan="3"><div class="placeholder">No events match</div></td></tr>';

  return `
    <div class="filters">
      <select id="event-filter">${options}</select>
      <input id="event-search" type="search" placeholder="Search attributes…" value="${esc(
        state.eventFilters.search,
      )}" />
      <label class="toggle">
        <input type="checkbox" id="event-errors" ${state.eventFilters.errorsOnly ? 'checked' : ''} />
        errors only
      </label>
      <span class="muted">${state.events.length} shown · newest first</span>
    </div>
    <div class="panel"><div class="table-scroll"><table>
      <thead><tr><th>Time</th><th>Event</th><th>Summary</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div></div>`;
}

/* -------------------------------- metrics ------------------------------- */

function renderMetricsTab() {
  if (!state.metrics.length) {
    return '<div class="placeholder">No metric points buffered for this session.</div>';
  }
  const byName = new Map();
  for (const point of state.metrics) {
    let group = byName.get(point.name);
    if (!group) {
      group = { name: point.name, unit: point.unit, kind: point.kind, temporality: point.temporality, series: new Map() };
      byName.set(point.name, group);
    }
    const attrs = Object.entries(point.attrs ?? {})
      .filter(([key]) => key !== 'session.id')
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, value]) => `${key}=${value}`)
      .join(' ');
    const series = group.series.get(attrs) ?? { attrs, points: 0, total: 0, last: 0, lastTimeMs: 0 };
    series.points++;
    series.total += Number(point.value) || 0;
    series.last = Number(point.value) || 0;
    series.lastTimeMs = Math.max(series.lastTimeMs, point.timeMs);
    group.series.set(attrs, series);
  }

  return [...byName.values()]
    .map(
      (group) => `<div class="panel">
        <h3>${esc(group.name)} · ${esc(group.kind)}${group.unit ? ` · ${esc(group.unit)}` : ''}${
          group.temporality && group.temporality !== 'unspecified' ? ` · ${esc(group.temporality)}` : ''
        }</h3>
        <div class="table-scroll"><table>
          <thead><tr><th>Attributes</th><th class="num">Points</th><th class="num">Window sum</th><th class="num">Last</th><th class="num">Last seen</th></tr></thead>
          <tbody>${[...group.series.values()]
            .sort((a, b) => b.total - a.total)
            .map(
              (series) => `<tr>
                <td class="name">${esc(series.attrs || '(no attributes)')}</td>
                <td class="num">${series.points}</td>
                <td class="num">${esc(
                  group.name === 'claude_code.cost.usage' ? fmtCost(series.total) : fmtNum(series.total),
                )}</td>
                <td class="num">${esc(
                  group.name === 'claude_code.cost.usage' ? fmtCost(series.last) : fmtNum(series.last),
                )}</td>
                <td class="num">${esc(fmtAgo(series.lastTimeMs))}</td>
              </tr>`,
            )
            .join('')}</tbody>
        </table></div>
      </div>`,
    )
    .join('');
}

/* --------------------------------- raw ---------------------------------- */

function renderRawTab() {
  const s = state.session;
  const rows = (obj) =>
    Object.entries(obj ?? {})
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, value]) => `<tr><td>${esc(key)}</td><td>${esc(formatValue(value))}</td></tr>`)
      .join('') || '<tr><td colspan="2" class="muted">none</td></tr>';
  return `
    <div class="panel"><h3>Resource attributes</h3>
      <table class="attr-table"><tbody>${rows(s.resource)}</tbody></table></div>
    <div class="panel"><h3>Standard attributes</h3>
      <table class="attr-table"><tbody>${rows(s.attrs)}</tbody></table></div>`;
}

/* ------------------------------ empty state ----------------------------- */

// Submitting reloads with the token in the query, which is the one request that
// carries it: the server trades it for a cookie and redirects back here without
// it. So the address bar never keeps the secret and nothing has to be retyped.
const TOKEN_PROMPT = `
  <form class="token-form">
    <input name="token" type="password" autocomplete="current-password"
      placeholder="access token" aria-label="Access token" />
    <button type="submit" class="ghost-button">Unlock</button>
  </form>`;

function renderEmptyState() {
  const detail = document.getElementById('detail');
  const env = state.config?.env ?? {};
  const block = Object.entries(env)
    .map(([key, value]) => `export ${key}="${value}"`)
    .join('\n');

  // Without the config there is no env block to show, and printing the promise
  // above an empty box tells the reader nothing about what went wrong.
  if (!block) {
    detail.innerHTML = `
      <div class="empty">
        <h1>${state.authError ? 'Token required' : 'Collector unreachable'}</h1>
        <p>${
          state.authError
            ? 'This interface is protected. Enter the token it was started with — the value ' +
              'of --token, which it also prints on startup. It is stored in a cookie, so this ' +
              'is asked once per browser.'
            : 'The page loaded but the collector did not answer. It may have stopped, or this ' +
              'interface may be pointed at a different address than the one it runs on.'
        }</p>
        ${state.authError ? TOKEN_PROMPT : ''}
      </div>`;
    return;
  }

  detail.innerHTML = `
    <div class="empty">
      <h1>Waiting for telemetry</h1>
      <p>
        Nothing has been exported to this collector yet. Start a Claude Agent SDK or Claude Code
        run with the environment below and sessions will appear here.
      </p>
      <div class="env-block">
        <div class="env-block-head"><span>Agent environment</span>
          <button type="button" class="ghost-button" data-copy="setup-env">Copy</button></div>
        <pre id="setup-env">${esc(block)}</pre>
      </div>
      <p class="muted">
        Metrics and events work on their own; spans additionally need
        <code>CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1</code>, which the block above sets. Export
        intervals are lowered to 1s so short runs flush before the process exits.
      </p>
    </div>`;
}

function renderSetupModal() {
  const env = state.config?.env ?? {};
  // Same reason as the empty state: every block in here is built from the
  // config, so without it the dialog is three headings over three empty boxes.
  if (!Object.keys(env).length) {
    document.getElementById('setup-modal-body').innerHTML = `
      <p>${
        state.authError
          ? 'The environment block cannot be shown because this page is not authorized. ' +
            'Enter the token this interface was started with and it will be included below.'
          : 'The collector did not answer, so there is no endpoint to point an agent at yet.'
      }</p>
      ${state.authError ? TOKEN_PROMPT : ''}`;
    return;
  }
  const shell = Object.entries(env)
    .map(([key, value]) => `export ${key}="${value}"`)
    .join('\n');
  const ts = `const otelEnv = ${JSON.stringify(env, null, 2)};

for await (const message of query({
  prompt: "…",
  options: { env: { ...process.env, ...otelEnv } },
})) {
  console.log(message);
}`;
  const py = `OTEL_ENV = ${JSON.stringify(env, null, 4)}

options = ClaudeAgentOptions(env=OTEL_ENV)`;

  document.getElementById('setup-modal-body').innerHTML = `
    <h3>Shell / container</h3>
    <div class="env-block">
      <div class="env-block-head"><span>export</span>
        <button type="button" class="ghost-button" data-copy="env-shell">Copy</button></div>
      <pre id="env-shell">${esc(shell)}</pre>
    </div>
    <p class="muted">
      Claude Code exports no session name of its own. To give a session one, add
      <code>OTEL_RESOURCE_ATTRIBUTES="session.name=…"</code> to the block above <em>before</em>
      starting it — the OTel resource is built once at process start, so it cannot be set
      afterwards. Without it, sessions are listed by their id.
    </p>
    <h3>TypeScript SDK</h3>
    <div class="env-block">
      <div class="env-block-head"><span>options.env replaces the inherited environment</span>
        <button type="button" class="ghost-button" data-copy="env-ts">Copy</button></div>
      <pre id="env-ts">${esc(ts)}</pre>
    </div>
    <h3>Python SDK</h3>
    <div class="env-block">
      <div class="env-block-head"><span>env is merged onto the inherited environment</span>
        <button type="button" class="ghost-button" data-copy="env-py">Copy</button></div>
      <pre id="env-py">${esc(py)}</pre>
    </div>
    <p class="muted">
      Do not use the <code>console</code> exporter with the SDK — stdout is the SDK's message
      channel. Set <code>CLAUDE_CODE_OTEL_DIAG_STDERR=1</code> if exports appear to go missing;
      the CLI drops telemetry silently otherwise.
    </p>`;
}

/* ------------------------------ data loading ---------------------------- */

async function loadSessions() {
  const data = await api('/api/sessions', { search: state.search, limit: 200 });
  state.sessions = data.items;
  if (!state.selectedSessionId && state.sessions.length) {
    selectSession(state.sessions[0].id, { render: false });
  }
  renderSessionList();
}

async function loadStats() {
  state.stats = await api('/api/stats');
  renderStats();
}

async function loadSession() {
  if (!state.selectedSessionId) {
    state.session = null;
    return;
  }
  try {
    state.session = await api(`/api/sessions/${encodeURIComponent(state.selectedSessionId)}`);
  } catch {
    state.session = null;
    state.selectedSessionId = null;
  }
}

async function loadTabData() {
  if (!state.session) return;
  if (state.tab === 'traces') {
    const traces = state.session.traces ?? [];
    if (!traces.some((trace) => trace.traceId === state.selectedTraceId)) {
      state.selectedTraceId = traces[0]?.traceId ?? null;
      state.selectedSpanId = null;
    }
    state.trace = state.selectedTraceId
      ? await api(`/api/traces/${encodeURIComponent(state.selectedTraceId)}`).catch(() => null)
      : null;
  } else if (state.tab === 'agents') {
    const path = `/api/sessions/${encodeURIComponent(state.selectedSessionId)}/agents`;
    const data = await api(path).catch(() => null);
    state.agents = data?.agents ?? [];
    state.capture = data?.capture ?? null;
    if (!state.agents.some((agent) => agent.key === state.selectedAgentKey)) {
      state.selectedAgentKey = state.agents[0]?.key ?? null;
      state.agentBody = null;
    }
    state.agentContent = state.selectedAgentKey
      ? await api(`${path}/${encodeURIComponent(state.selectedAgentKey)}/content`, { limit: 200 }).catch(() => null)
      : null;
  } else if (state.tab === 'events') {
    const [events, facets] = await Promise.all([
      api('/api/events', {
        session: state.selectedSessionId,
        event: state.eventFilters.event,
        search: state.eventFilters.search,
        errors: state.eventFilters.errorsOnly ? '1' : '',
        limit: 300,
      }),
      api('/api/facets'),
    ]);
    state.events = events.items;
    state.facets = facets;
  } else if (state.tab === 'metrics') {
    const metrics = await api('/api/metrics', { session: state.selectedSessionId, limit: 2000 });
    state.metrics = metrics.items;
  }
}

/**
 * One captured payload, fetched only when it is clicked: a single body can be
 * 60 KB, so the tab loads the index and never the payloads.
 *
 * A 404 here is an answer, not a failure — the collector returns the metadata it
 * still has along with it, and that is what says the payload rolled out of the
 * buffer rather than never having been captured.
 */
async function loadAgentBody(seq) {
  if (state.agentBody?.seq === seq) {
    state.agentBody = null;
    return;
  }
  const path = `/api/sessions/${encodeURIComponent(state.selectedSessionId)}/agents/${encodeURIComponent(
    state.selectedAgentKey,
  )}/body/${seq}`;
  const url = new URL(path, location.origin);
  if (TOKEN) url.searchParams.set('token', TOKEN);
  try {
    const response = await fetch(url, { headers: { accept: 'application/json' } });
    state.agentBody = await response.json();
  } catch {
    state.agentBody = null;
  }
}

/** Full refresh, preserving scroll position and any focused filter input. */
async function refresh({ sessions = true } = {}) {
  const detail = document.getElementById('detail');
  const scrollTop = detail.scrollTop;
  const active = document.activeElement;
  const focusId = active?.id;
  const selection = typeof active?.selectionStart === 'number' ? active.selectionStart : null;

  // The session list may pick the default selection, so it has to settle before
  // the session detail is fetched.
  try {
    await Promise.all([loadStats(), sessions ? loadSessions() : Promise.resolve()]);
    await loadSession();
    await loadTabData();
  } catch (error) {
    // A failed load must not skip the render. The empty state is the only thing
    // that can explain the failure, so throwing past it leaves the untouched
    // markup from index.html on screen — which promises data and shows none.
    if (error.status === 401) state.authError = true;
    setLive('offline', state.authError ? 'token required' : 'unreachable');
  }
  renderDetail();

  detail.scrollTop = scrollTop;
  if (focusId && focusId !== 'session-search') {
    const restored = document.getElementById(focusId);
    if (restored) {
      restored.focus();
      if (selection !== null && typeof restored.setSelectionRange === 'function') {
        restored.setSelectionRange(selection, selection);
      }
    }
  }
}

function selectSession(id, { render = true } = {}) {
  if (state.selectedSessionId === id) return;
  state.selectedSessionId = id;
  state.selectedTraceId = null;
  state.selectedSpanId = null;
  state.trace = null;
  state.agents = null;
  state.capture = null;
  state.selectedAgentKey = null;
  state.agentContent = null;
  state.agentBody = null;
  state.events = [];
  state.metrics = [];
  location.hash = `#/session/${encodeURIComponent(id)}`;
  if (render) refresh({ sessions: false }).then(renderSessionList);
}

/* --------------------------------- wiring -------------------------------- */

function copyFrom(id) {
  const node = document.getElementById(id);
  if (!node) return;
  navigator.clipboard?.writeText(node.textContent ?? '').then(() => {
    const button = document.querySelector(`[data-copy="${id}"]`);
    if (!button) return;
    const original = button.textContent;
    button.textContent = 'Copied';
    setTimeout(() => {
      button.textContent = original;
    }, 1200);
  });
}

let refreshTimer = null;
function scheduleRefresh(delay = 400) {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refresh().catch(() => setLive('offline', 'error'));
  }, delay);
}

function connectStream() {
  const url = TOKEN ? `/api/stream?token=${encodeURIComponent(TOKEN)}` : '/api/stream';
  const source = new EventSource(url);
  source.addEventListener('hello', () => setLive('live', 'live'));
  source.addEventListener('ingest', () => {
    setLive('live', 'live');
    scheduleRefresh();
  });
  source.onerror = () => {
    setLive('offline', 'reconnecting');
    // EventSource reconnects on its own; nothing to do but reflect the state.
  };
}

function wireEvents() {
  document.getElementById('session-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-session]');
    if (button) selectSession(button.dataset.session);
  });

  document.getElementById('detail').addEventListener('click', (event) => {
    const copy = event.target.closest('[data-copy]');
    if (copy) {
      copyFrom(copy.dataset.copy);
      return;
    }
    const tab = event.target.closest('[data-tab]');
    if (tab) {
      state.tab = tab.dataset.tab;
      loadTabData().then(renderDetail);
      return;
    }
    const trace = event.target.closest('[data-trace]');
    if (trace) {
      state.selectedTraceId = trace.dataset.trace;
      state.selectedSpanId = null;
      loadTabData().then(renderDetail);
      return;
    }
    const agent = event.target.closest('[data-agent]');
    if (agent) {
      state.selectedAgentKey = agent.dataset.agent;
      state.agentBody = null;
      loadTabData().then(renderTabBody);
      return;
    }
    const bodySeq = event.target.closest('[data-body-seq]');
    if (bodySeq) {
      loadAgentBody(Number(bodySeq.dataset.bodySeq)).then(renderTabBody);
      return;
    }
    const span = event.target.closest('[data-span]');
    if (span) {
      state.selectedSpanId = state.selectedSpanId === span.dataset.span ? null : span.dataset.span;
      renderTabBody();
      return;
    }
    const row = event.target.closest('[data-event-seq]');
    if (row) {
      const detailRow = document.querySelector(`[data-detail-seq="${row.dataset.eventSeq}"]`);
      if (detailRow) detailRow.hidden = !detailRow.hidden;
    }
  });

  document.getElementById('detail').addEventListener('change', (event) => {
    if (event.target.id === 'event-filter') {
      state.eventFilters.event = event.target.value;
      loadTabData().then(renderTabBody);
    }
    if (event.target.id === 'event-errors') {
      state.eventFilters.errorsOnly = event.target.checked;
      loadTabData().then(renderTabBody);
    }
  });

  let searchTimer = null;
  document.getElementById('detail').addEventListener('input', (event) => {
    if (event.target.id !== 'event-search') return;
    state.eventFilters.search = event.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadTabData().then(renderTabBody), 250);
  });

  let sessionSearchTimer = null;
  document.getElementById('session-search').addEventListener('input', (event) => {
    state.search = event.target.value;
    clearTimeout(sessionSearchTimer);
    sessionSearchTimer = setTimeout(() => loadSessions(), 200);
  });

  const modal = document.getElementById('setup-modal');
  document.getElementById('setup-button').addEventListener('click', () => {
    renderSetupModal();
    modal.showModal();
  });
  modal.addEventListener('click', (event) => {
    const copy = event.target.closest('[data-copy]');
    if (copy) {
      event.preventDefault();
      copyFrom(copy.dataset.copy);
    }
  });

  // Delegated: the prompt is rendered into both the detail pane and the dialog,
  // and both get replaced wholesale on every render.
  document.addEventListener('submit', (event) => {
    const form = event.target.closest('.token-form');
    if (!form) return;
    event.preventDefault();
    const value = form.elements.token.value.trim();
    if (value) location.search = `?token=${encodeURIComponent(value)}`;
  });

  window.addEventListener('hashchange', () => {
    const match = location.hash.match(/^#\/session\/(.+)$/);
    if (match) selectSession(decodeURIComponent(match[1]));
  });
}

async function boot() {
  wireEvents();
  try {
    state.config = await api('/api/config');
  } catch (error) {
    state.authError = error.status === 401;
    setLive('offline', state.authError ? 'token required' : 'unreachable');
  }
  const match = location.hash.match(/^#\/session\/(.+)$/);
  if (match) state.selectedSessionId = decodeURIComponent(match[1]);
  await refresh();
  // EventSource reconnects on its own forever, which for a rejected token means
  // a request every few seconds that can never succeed. The page has already
  // said what to do about it; retrying adds noise, not a recovery.
  if (!state.authError) connectStream();
  // Sessions age out of "live" and relative timestamps drift; repaint slowly.
  setInterval(() => {
    renderSessionList();
    if (state.session && state.tab === 'overview') renderTabBody();
  }, 15_000);
}

boot();
