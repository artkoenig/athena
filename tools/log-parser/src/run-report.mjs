import fs from 'node:fs';
import path from 'node:path';
import { parseClaudeLog } from './claude-parser.mjs';
import { aggregateMetrics } from './metrics.mjs';

// A workflow run directory holds, side by side, `journal.jsonl`, one
// `agent-<agentId>.jsonl` transcript per agent and one
// `agent-<agentId>.meta.json` per agent. The journal carries only `type`
// (`started` or `result`), `key`, `agentId` and — on a result — `result`; the
// agent's type lives in its meta file and nowhere else.

const TRANSCRIPT_PATTERN = /^agent-(.+)\.jsonl$/;

function emptyTokens() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0
  };
}

function addTokens(target, source) {
  target.inputTokens += source.inputTokens || 0;
  target.outputTokens += source.outputTokens || 0;
  target.cacheReadTokens += source.cacheReadTokens || 0;
  target.cacheCreationTokens += source.cacheCreationTokens || 0;
  target.totalTokens += source.totalTokens || 0;
}

function addTools(target, source) {
  for (const [name, stats] of Object.entries(source || {})) {
    if (!target[name]) target[name] = { total: 0, success: 0, failed: 0 };
    target[name].total += stats.total || 0;
    target[name].success += stats.success || 0;
    target[name].failed += stats.failed || 0;
  }
}

/**
 * The journal in file order, one row per agentId. A row is created on the
 * first mention of an agentId whatever its type: a resumed run replays a
 * cached `result` whose `started` belongs to an earlier session's journal, and
 * that agent still gets a row. A repeated line updates its row in place.
 */
function readJournal(journalPath) {
  let text;
  try {
    text = fs.readFileSync(journalPath, 'utf8');
  } catch (e) {
    return [];
  }

  const order = [];
  const byId = new Map();

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (e) {
      // an unparseable line is skipped, the journal is not
      continue;
    }
    if (!entry || typeof entry.agentId !== 'string' || !entry.agentId) continue;
    if (entry.type !== 'started' && entry.type !== 'result') continue;

    let row = byId.get(entry.agentId);
    if (!row) {
      row = { agentId: entry.agentId, started: false, returned: false };
      byId.set(entry.agentId, row);
      order.push(row);
    }
    if (entry.type === 'started') row.started = true;
    if (entry.type === 'result') row.returned = true;
  }

  return order;
}

/**
 * The agent type is whatever the platform wrote, `uroboros:` prefix included.
 * A missing, unreadable or typeless meta file gives the literal `unknown`.
 */
function readAgentType(runDir, agentId) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(runDir, `agent-${agentId}.meta.json`), 'utf8'));
    if (meta && typeof meta.agentType === 'string' && meta.agentType) return meta.agentType;
  } catch (e) {
    // fall through to unknown
  }
  return 'unknown';
}

function listTranscriptPaths(runDir) {
  let entries;
  try {
    entries = fs.readdirSync(runDir, { withFileTypes: true });
  } catch (e) {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && TRANSCRIPT_PATTERN.test(entry.name))
    .map((entry) => path.join(runDir, entry.name));
}

export async function collectRunReport(runDir) {
  const resolvedDir = path.resolve(runDir);
  const journalRows = readJournal(path.join(resolvedDir, 'journal.jsonl'));
  const transcriptPaths = listTranscriptPaths(resolvedDir);

  const totals = { tokens: emptyTokens(), counts: { stepCount: 0, toolCallsTotal: 0, toolCallsFailed: 0, errorCount: 0 } };
  const toolTotals = {};
  const agents = [];

  for (const row of journalRows) {
    const agentType = readAgentType(resolvedDir, row.agentId);
    const ownPath = path.join(resolvedDir, `agent-${row.agentId}.jsonl`);

    const agent = {
      agentId: row.agentId,
      agentType,
      started: row.started,
      returned: row.returned,
      transcript: null,
      stepCount: 0,
      toolCallsTotal: 0,
      toolCallsFailed: 0,
      errorCount: 0,
      tokens: emptyTokens()
    };

    if (fs.existsSync(ownPath)) {
      agent.transcript = ownPath;
      // Every other agent's transcript is a sibling here, and an
      // `invoke_subagent` result naming one would make the parser inline that
      // agent's turns into this one — one run's tokens counted twice, under
      // the wrong owner. Pre-seeding the visited set with every sibling gives
      // each transcript exactly one owner: its own row.
      const visited = new Set(transcriptPaths.filter((p) => p !== ownPath));
      let turns = [];
      try {
        turns = await parseClaudeLog(ownPath, visited, agentType);
      } catch (e) {
        turns = [];
      }
      const metrics = aggregateMetrics(turns, 'claude', 'claude');
      agent.stepCount = metrics.counts.stepCount;
      agent.toolCallsTotal = metrics.counts.toolCallsTotal;
      agent.toolCallsFailed = metrics.counts.toolCallsFailed;
      agent.errorCount = metrics.counts.errorCount;
      agent.tokens = { ...metrics.tokens };
      addTools(toolTotals, metrics.toolBreakdown);
    }

    addTokens(totals.tokens, agent.tokens);
    totals.counts.stepCount += agent.stepCount;
    totals.counts.toolCallsTotal += agent.toolCallsTotal;
    totals.counts.toolCallsFailed += agent.toolCallsFailed;
    totals.counts.errorCount += agent.errorCount;

    agents.push(agent);
  }

  const typeTotals = {};
  for (const agent of agents) {
    if (!typeTotals[agent.agentType]) {
      typeTotals[agent.agentType] = {
        agents: 0,
        returned: 0,
        stepCount: 0,
        toolCallsTotal: 0,
        toolCallsFailed: 0,
        errorCount: 0,
        tokens: emptyTokens()
      };
    }
    const stats = typeTotals[agent.agentType];
    stats.agents++;
    if (agent.returned) stats.returned++;
    stats.stepCount += agent.stepCount;
    stats.toolCallsTotal += agent.toolCallsTotal;
    stats.toolCallsFailed += agent.toolCallsFailed;
    stats.errorCount += agent.errorCount;
    addTokens(stats.tokens, agent.tokens);
  }

  const agentTypes = {};
  for (const [name, stats] of Object.entries(typeTotals).sort(
    (a, b) => b[1].tokens.totalTokens - a[1].tokens.totalTokens || a[0].localeCompare(b[0])
  )) {
    agentTypes[name] = stats;
  }

  const toolBreakdown = {};
  for (const [name, stats] of Object.entries(toolTotals).sort(
    (a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0])
  )) {
    toolBreakdown[name] = stats;
  }

  const started = agents.filter((agent) => agent.started);

  return {
    runId: path.basename(resolvedDir),
    runDir: resolvedDir,
    agentsStarted: started.length,
    agentsReturned: started.filter((agent) => agent.returned).length,
    startedWithoutReturning: started
      .filter((agent) => !agent.returned)
      .map((agent) => ({ agentId: agent.agentId, agentType: agent.agentType })),
    totals,
    agentTypes,
    agents,
    toolBreakdown
  };
}

export function renderRunMarkdown(report) {
  const n = (value) => Number(value || 0).toLocaleString();

  let md = `# Workflow Run Report\n\n`;
  md += `**Run**: \`${report.runId}\`\n`;
  md += `**Run Directory**: ${report.runDir}\n`;
  md += `**Agents**: ${report.agentsStarted} started, ${report.agentsReturned} returned, ${report.startedWithoutReturning.length} without a return\n\n`;

  md += `## Run Totals\n\n`;
  md += `| Metric | Value |\n`;
  md += `| :--- | :--- |\n`;
  md += `| Total Tokens | ${n(report.totals.tokens.totalTokens)} |\n`;
  md += `| Input Tokens | ${n(report.totals.tokens.inputTokens)} |\n`;
  md += `| Output Tokens | ${n(report.totals.tokens.outputTokens)} |\n`;
  md += `| Cache Read Tokens | ${n(report.totals.tokens.cacheReadTokens)} |\n`;
  md += `| Cache Creation Tokens | ${n(report.totals.tokens.cacheCreationTokens)} |\n`;
  md += `| Tool Calls | ${report.totals.counts.toolCallsTotal} (${report.totals.counts.toolCallsFailed} failed) |\n`;
  md += `| Errors | ${report.totals.counts.errorCount} |\n`;
  md += `| Steps | ${report.totals.counts.stepCount} |\n\n`;

  md += `## Per-Agent-Type Totals\n\n`;
  md += `| Agent Type | Agents | Steps | Tool Calls (Failed) | Errors | Total Tokens |\n`;
  md += `| :--- | :--- | :--- | :--- | :--- | :--- |\n`;
  for (const [agentType, stats] of Object.entries(report.agentTypes)) {
    md += `| ${agentType} | ${stats.agents} | ${stats.stepCount} | ${stats.toolCallsTotal} (${stats.toolCallsFailed}) | ${stats.errorCount} | ${n(stats.tokens.totalTokens)} |\n`;
  }
  md += `\n`;

  md += `## Agents\n\n`;
  md += `| # | Agent | Agent Type | Returned | Steps | Tool Calls (Failed) | Errors | Total Tokens |\n`;
  md += `| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n`;
  report.agents.forEach((agent, index) => {
    md += `| ${index + 1} | \`${agent.agentId}\` | ${agent.agentType} | ${agent.returned ? 'yes' : 'no'} | ${agent.stepCount} | ${agent.toolCallsTotal} (${agent.toolCallsFailed}) | ${agent.errorCount} | ${n(agent.tokens.totalTokens)} |\n`;
  });
  md += `\n`;

  md += `## Tool Breakdown\n\n`;
  md += `| Tool | Calls | Success | Failed |\n`;
  md += `| :--- | :--- | :--- | :--- |\n`;
  for (const [toolName, stats] of Object.entries(report.toolBreakdown)) {
    md += `| ${toolName} | ${stats.total} | ${stats.success} | ${stats.failed} |\n`;
  }
  md += `\n`;

  md += `## Started Without Returning\n\n`;
  if (report.startedWithoutReturning.length === 0) {
    md += `None — every agent that started returned.\n`;
  } else {
    for (const straggler of report.startedWithoutReturning) {
      md += `- \`${straggler.agentId}\` (${straggler.agentType})\n`;
    }
  }
  md += `\n`;

  return md;
}

export function renderRunJson(report) {
  return JSON.stringify(report, null, 2);
}
