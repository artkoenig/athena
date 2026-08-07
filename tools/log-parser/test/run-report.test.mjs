import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

// The run-report mode is new with this increment. `collectRunReport` reads a
// workflow run directory (journal.jsonl plus per-agent transcripts and meta
// files) and returns one report object for the whole run; `renderRunMarkdown`
// turns that report into the run's markdown page. `getLatestRunDir` finds the
// newest such directory under a home, the way `getLatestLogPath` already
// finds the newest session transcript, and lives beside it in detector.mjs.
import { collectRunReport, renderRunMarkdown } from '../src/run-report.mjs';
import { getLatestRunDir } from '../src/detector.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, 'fixtures');
const binPath = path.join(__dirname, '..', 'bin', 'parse-agent-log.mjs');

function writeLines(filePath, lines) {
  fs.writeFileSync(filePath, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
}

// One agent's transcript in the nested Claude Code shape: one user prompt
// line (opens the one turn each fixture agent gets), one assistant line
// carrying `usage` and every `tool_use` block, and — when there are tool
// calls — a following user line carrying the matching `tool_result` blocks.
// Every tool_use shares the one assistant message id, so the usage is
// counted once regardless of how many tool calls ride along with it.
function writeAgentLog(file, { promptText, msgId, usage, tools = [] }) {
  const toolUseBlocks = tools.map((t) => ({ type: 'tool_use', id: t.id, name: t.name, input: t.input || {} }));
  const lines = [
    { type: 'user', message: { role: 'user', content: promptText } },
    {
      type: 'assistant',
      message: {
        id: msgId,
        role: 'assistant',
        usage,
        content: toolUseBlocks.length ? toolUseBlocks : [{ type: 'text', text: 'done' }]
      }
    }
  ];
  if (tools.length) {
    const resultBlocks = tools.map((t) => ({
      type: 'tool_result',
      tool_use_id: t.id,
      is_error: !!t.isError,
      content: t.resultContent || 'ok'
    }));
    lines.push({ type: 'user', message: { role: 'user', content: resultBlocks } });
  }
  writeLines(file, lines);
}

// Writes the base fixture's four agent transcripts and meta files (ddd4 gets
// no meta file, on purpose) into `dir`. Shared by every variant that needs
// the same agents, so each variant only has to touch what makes it different.
function writeBaseAgents(dir) {
  writeAgentLog(path.join(dir, 'agent-aaa1.jsonl'), {
    promptText: 'aaa1 prompt',
    msgId: 'aaa1-msg',
    usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 },
    tools: [
      { id: 'a1', name: 'Bash', input: { command: 'ls' }, resultContent: 'ok', isError: false },
      { id: 'a2', name: 'Read', input: { file_path: '/nope' }, resultContent: 'no such file', isError: true }
    ]
  });
  writeAgentLog(path.join(dir, 'agent-bbb2.jsonl'), {
    promptText: 'bbb2 prompt',
    msgId: 'bbb2-msg',
    usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
    tools: [{ id: 'b1', name: 'Bash', input: { command: 'pwd' }, resultContent: '/tmp', isError: false }]
  });
  writeAgentLog(path.join(dir, 'agent-ccc3.jsonl'), {
    promptText: 'ccc3 prompt',
    msgId: 'ccc3-msg',
    usage: { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 300, cache_creation_input_tokens: 400 },
    tools: [{ id: 'c1', name: 'Grep', input: { pattern: 'foo' }, resultContent: 'match', isError: false }]
  });
  writeAgentLog(path.join(dir, 'agent-ddd4.jsonl'), {
    promptText: 'ddd4 prompt',
    msgId: 'ddd4-msg',
    usage: { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 5, cache_creation_input_tokens: 5 },
    tools: []
  });

  fs.writeFileSync(path.join(dir, 'agent-aaa1.meta.json'), JSON.stringify({ agentType: 'uroboros:researcher', spawnDepth: 1 }));
  fs.writeFileSync(path.join(dir, 'agent-bbb2.meta.json'), JSON.stringify({ agentType: 'uroboros:researcher', spawnDepth: 1 }));
  fs.writeFileSync(path.join(dir, 'agent-ccc3.meta.json'), JSON.stringify({ agentType: 'uroboros:reviewer', spawnDepth: 1 }));
  // agent-ddd4.meta.json is deliberately absent — its agentType is unknown.
}

function baseJournalLines() {
  return [
    { type: 'started', key: 'k-a', agentId: 'aaa1' },
    { type: 'result', key: 'k-a', agentId: 'aaa1', result: { summary: 'a' } },
    { type: 'started', key: 'k-b', agentId: 'bbb2' },
    { type: 'result', key: 'k-b', agentId: 'bbb2', result: { summary: 'b' } },
    { type: 'started', key: 'k-c', agentId: 'ccc3' },
    { type: 'started', key: 'k-d', agentId: 'ddd4' },
    { type: 'result', key: 'k-d', agentId: 'ddd4', result: { summary: 'd' } }
  ];
}

test('workflow run reports', async (t) => {
  let scratch;
  // The base fixture: 4 agents (aaa1, bbb2 uroboros:researcher; ccc3
  // uroboros:reviewer, never returns; ddd4 unknown type), journal-ordered.
  let runDir;
  // Same journal shuffled to `started c, started a, result a, result c` —
  // proves agent order comes from the journal, not the directory listing.
  let shuffledDir;
  // Identical to runDir, minus agent-bbb2.jsonl.
  let missingTranscriptDir;
  // Identical to runDir, but aaa1's transcript carries an extra
  // invoke_subagent tool call whose result names bbb2's own transcript path.
  let doubleCountDir;
  // An empty journal and nothing else.
  let emptyDir;
  // Identical to runDir, but ccc3 also returned.
  let everyoneReturnedDir;
  // A throwaway home whose only workflow run is a copy of the base fixture,
  // for the CLI's --latest-run discovery.
  let fakeHome;

  t.before(() => {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'log-parser-run-')));

    runDir = path.join(scratch, 'run-base');
    fs.mkdirSync(runDir);
    writeBaseAgents(runDir);
    writeLines(path.join(runDir, 'journal.jsonl'), baseJournalLines());

    shuffledDir = path.join(scratch, 'run-shuffled');
    fs.mkdirSync(shuffledDir);
    fs.copyFileSync(path.join(runDir, 'agent-aaa1.jsonl'), path.join(shuffledDir, 'agent-aaa1.jsonl'));
    fs.copyFileSync(path.join(runDir, 'agent-aaa1.meta.json'), path.join(shuffledDir, 'agent-aaa1.meta.json'));
    fs.copyFileSync(path.join(runDir, 'agent-ccc3.jsonl'), path.join(shuffledDir, 'agent-ccc3.jsonl'));
    fs.copyFileSync(path.join(runDir, 'agent-ccc3.meta.json'), path.join(shuffledDir, 'agent-ccc3.meta.json'));
    writeLines(path.join(shuffledDir, 'journal.jsonl'), [
      { type: 'started', key: 'k-c', agentId: 'ccc3' },
      { type: 'started', key: 'k-a', agentId: 'aaa1' },
      { type: 'result', key: 'k-a', agentId: 'aaa1', result: { summary: 'a' } },
      { type: 'result', key: 'k-c', agentId: 'ccc3', result: { summary: 'c' } }
    ]);

    missingTranscriptDir = path.join(scratch, 'run-missing-transcript');
    fs.cpSync(runDir, missingTranscriptDir, { recursive: true });
    fs.rmSync(path.join(missingTranscriptDir, 'agent-bbb2.jsonl'));

    doubleCountDir = path.join(scratch, 'run-double-count');
    fs.cpSync(runDir, doubleCountDir, { recursive: true });
    writeAgentLog(path.join(doubleCountDir, 'agent-aaa1.jsonl'), {
      promptText: 'aaa1 prompt',
      msgId: 'aaa1-msg',
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 },
      tools: [
        { id: 'a1', name: 'Bash', input: { command: 'ls' }, resultContent: 'ok', isError: false },
        { id: 'a2', name: 'Read', input: { file_path: '/nope' }, resultContent: 'no such file', isError: true },
        {
          id: 'a3',
          name: 'invoke_subagent',
          input: { agentId: 'bbb2' },
          resultContent: path.join(doubleCountDir, 'agent-bbb2.jsonl'),
          isError: false
        }
      ]
    });

    emptyDir = path.join(scratch, 'run-empty');
    fs.mkdirSync(emptyDir);
    fs.writeFileSync(path.join(emptyDir, 'journal.jsonl'), '');

    everyoneReturnedDir = path.join(scratch, 'run-everyone-returned');
    fs.cpSync(runDir, everyoneReturnedDir, { recursive: true });
    writeLines(path.join(everyoneReturnedDir, 'journal.jsonl'), [
      { type: 'started', key: 'k-a', agentId: 'aaa1' },
      { type: 'result', key: 'k-a', agentId: 'aaa1', result: { summary: 'a' } },
      { type: 'started', key: 'k-b', agentId: 'bbb2' },
      { type: 'result', key: 'k-b', agentId: 'bbb2', result: { summary: 'b' } },
      { type: 'started', key: 'k-c', agentId: 'ccc3' },
      { type: 'result', key: 'k-c', agentId: 'ccc3', result: { summary: 'c' } },
      { type: 'started', key: 'k-d', agentId: 'ddd4' },
      { type: 'result', key: 'k-d', agentId: 'ddd4', result: { summary: 'd' } }
    ]);

    fakeHome = path.join(scratch, 'fake-home');
    const wfDir = path.join(fakeHome, '.claude/projects/proj/sess/subagents/workflows/wf_x');
    fs.mkdirSync(wfDir, { recursive: true });
    fs.cpSync(runDir, wfDir, { recursive: true });
  });

  t.after(() => {
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------
  // Criterion 1: the run directory is reported as one thing.
  // ---------------------------------------------------------------------

  await t.test("collectRunReport: the run totals sum every agent's transcript", async () => {
    const report = await collectRunReport(runDir);
    assert.deepStrictEqual(report.totals.tokens, {
      inputTokens: 116,
      outputTokens: 227,
      cacheReadTokens: 338,
      cacheCreationTokens: 449,
      totalTokens: 1130
    });
    assert.deepStrictEqual(report.totals.counts, {
      stepCount: 4,
      toolCallsTotal: 4,
      toolCallsFailed: 1,
      errorCount: 0
    });
    assert.strictEqual(report.runId, path.basename(runDir));
  });

  await t.test('collectRunReport: an agent whose transcript is missing is a row of zeros, not a crash', async () => {
    const report = await collectRunReport(missingTranscriptDir);
    assert.strictEqual(report.agents.length, 4);
    const bbb2 = report.agents.find((a) => a.agentId === 'bbb2');
    assert.strictEqual(bbb2.transcript, null);
    assert.strictEqual(bbb2.stepCount, 0);
    assert.strictEqual(bbb2.toolCallsTotal, 0);
    assert.strictEqual(bbb2.tokens.totalTokens, 0);
    assert.strictEqual(report.totals.tokens.totalTokens, 1120);
    assert.strictEqual(report.totals.counts.stepCount, 3);
    assert.strictEqual(report.totals.counts.toolCallsTotal, 3);
  });

  await t.test('collectRunReport: an empty journal is an empty report', async () => {
    const report = await collectRunReport(emptyDir);
    assert.deepStrictEqual(report.agents, []);
    assert.deepStrictEqual(report.agentTypes, {});
    assert.deepStrictEqual(report.toolBreakdown, {});
    assert.deepStrictEqual(report.startedWithoutReturning, []);
    assert.strictEqual(report.agentsStarted, 0);
    assert.strictEqual(report.totals.tokens.totalTokens, 0);
  });

  // ---------------------------------------------------------------------
  // Criterion 2: per-agent-type totals, per-agent rows in the journal's
  // order, a tool breakdown with failures, and who started without
  // returning.
  // ---------------------------------------------------------------------

  await t.test('collectRunReport: two agents of one type fold into one per-agent-type row, and a missing meta file is unknown', async () => {
    const report = await collectRunReport(runDir);
    // Order is totalTokens descending: reviewer 1000, researcher 110, unknown 20.
    assert.deepStrictEqual(Object.keys(report.agentTypes), ['uroboros:reviewer', 'uroboros:researcher', 'unknown']);
    assert.deepStrictEqual(report.agentTypes['uroboros:researcher'], {
      agents: 2,
      returned: 2,
      stepCount: 2,
      toolCallsTotal: 3,
      toolCallsFailed: 1,
      errorCount: 0,
      tokens: { inputTokens: 11, outputTokens: 22, cacheReadTokens: 33, cacheCreationTokens: 44, totalTokens: 110 }
    });
  });

  await t.test("collectRunReport: per-agent rows follow the journal's order", async () => {
    const report = await collectRunReport(runDir);
    assert.deepStrictEqual(report.agents.map((a) => a.agentId), ['aaa1', 'bbb2', 'ccc3', 'ddd4']);
    assert.strictEqual(report.agents[0].agentType, 'uroboros:researcher');
    assert.strictEqual(report.agents[0].stepCount, 1);
    assert.strictEqual(report.agents[0].toolCallsTotal, 2);
    assert.strictEqual(report.agents[0].toolCallsFailed, 1);
    assert.strictEqual(report.agents[0].tokens.totalTokens, 100);
    assert.strictEqual(report.agents[3].agentType, 'unknown');

    const shuffled = await collectRunReport(shuffledDir);
    assert.deepStrictEqual(
      shuffled.agents.map((a) => a.agentId),
      ['ccc3', 'aaa1'],
      'agent order must come from the journal, not the directory listing or an agentId sort'
    );
  });

  await t.test('collectRunReport: an agent that started without a result is named', async () => {
    const report = await collectRunReport(runDir);
    assert.deepStrictEqual(report.startedWithoutReturning, [{ agentId: 'ccc3', agentType: 'uroboros:reviewer' }]);
    assert.strictEqual(report.agentsStarted, 4);
    assert.strictEqual(report.agentsReturned, 3);
    assert.strictEqual(report.agents.find((a) => a.agentId === 'ccc3').returned, false);
    for (const agent of report.agents) {
      if (agent.agentId === 'ccc3') continue;
      assert.strictEqual(agent.returned, true, `${agent.agentId} should be marked returned`);
    }
  });

  await t.test('collectRunReport: the tool breakdown shows the failures', async () => {
    const report = await collectRunReport(runDir);
    assert.deepStrictEqual(report.toolBreakdown, {
      Bash: { total: 2, success: 2, failed: 0 },
      Grep: { total: 1, success: 1, failed: 0 },
      Read: { total: 1, success: 0, failed: 1 }
    });
    // total descending, name ascending on a tie (Grep and Read both total 1).
    assert.deepStrictEqual(Object.keys(report.toolBreakdown), ['Bash', 'Grep', 'Read']);
  });

  await t.test("collectRunReport: a transcript another agent's log names is still counted once", async () => {
    const report = await collectRunReport(doubleCountDir);
    assert.strictEqual(report.totals.tokens.totalTokens, 1130, "bbb2's tokens must not be double-counted through aaa1's tool result");
    const aaa1 = report.agents.find((a) => a.agentId === 'aaa1');
    const bbb2 = report.agents.find((a) => a.agentId === 'bbb2');
    assert.strictEqual(aaa1.tokens.totalTokens, 100);
    assert.strictEqual(bbb2.tokens.totalTokens, 10);
    assert.strictEqual(report.totals.counts.toolCallsTotal, 5);
    assert.strictEqual(report.toolBreakdown.invoke_subagent.total, 1);
  });

  // ---------------------------------------------------------------------
  // The go-red guards for a dropped section or a miscount on the page.
  // ---------------------------------------------------------------------

  await t.test('renderRunMarkdown: every section of the report is on the page', async () => {
    const sections = [
      '# Workflow Run Report',
      '## Run Totals',
      '## Per-Agent-Type Totals',
      '## Agents',
      '## Tool Breakdown',
      '## Started Without Returning'
    ];

    const report = await collectRunReport(runDir);
    const md = renderRunMarkdown(report);
    for (const section of sections) {
      assert.ok(md.includes(section), `markdown is missing ${section}`);
    }

    // A section that only appears when it has rows is a dropped section —
    // the empty report must carry the same six headings.
    const emptyReport = await collectRunReport(emptyDir);
    const emptyMd = renderRunMarkdown(emptyReport);
    for (const section of sections) {
      assert.ok(emptyMd.includes(section), `empty-report markdown is missing ${section}`);
    }
  });

  await t.test('renderRunMarkdown: the numbers reach the page', async () => {
    const report = await collectRunReport(runDir);
    const md = renderRunMarkdown(report);

    assert.ok(md.includes(`| Total Tokens | ${(1130).toLocaleString()} |`));
    assert.ok(md.includes('| Tool Calls | 4 (1 failed) |'));

    const researcherLine = md.split('\n').find((line) => line.startsWith('| uroboros:researcher | 2 | 2 |'));
    assert.ok(researcherLine, 'markdown must have a per-agent-type row starting "| uroboros:researcher | 2 | 2 |"');
    assert.ok(researcherLine.includes((110).toLocaleString()), "the researcher row must carry the type's total tokens");

    assert.ok(md.includes('| Read | 1 | 0 | 1 |'));
    assert.ok(/- `ccc3` \(uroboros:reviewer\)/.test(md));

    assert.ok(
      md.indexOf('aaa1') < md.indexOf('bbb2') && md.indexOf('bbb2') < md.indexOf('ccc3') && md.indexOf('ccc3') < md.indexOf('ddd4'),
      "the Agents table must keep the journal's order on the page"
    );
  });

  await t.test('renderRunMarkdown: a run where everyone returned says so', async () => {
    const report = await collectRunReport(everyoneReturnedDir);
    const md = renderRunMarkdown(report);
    assert.ok(md.includes('## Started Without Returning'));
    assert.ok(md.includes('None — every agent that started returned.'));
    assert.ok(!md.includes('`ccc3` ('), 'no straggler bullet must remain once every agent returned');
  });

  // ---------------------------------------------------------------------
  // The CLI surface, run mode and discovery.
  // ---------------------------------------------------------------------

  await t.test('CLI: a run directory prints the run report', () => {
    // execFileSync throwing on a non-zero exit is the exit-0 assertion.
    const stdout = execFileSync(process.execPath, [binPath, runDir, '--format', 'markdown'], { encoding: 'utf8' });
    assert.ok(stdout.includes('# Workflow Run Report'));
    assert.ok(stdout.includes(`| Total Tokens | ${(1130).toLocaleString()} |`));
  });

  await t.test('CLI: --format json prints the run report object', () => {
    const stdout = execFileSync(process.execPath, [binPath, runDir, '--format', 'json'], { encoding: 'utf8' });
    const report = JSON.parse(stdout);
    assert.strictEqual(report.totals.tokens.totalTokens, 1130);
    assert.strictEqual(report.agents.length, 4);
    assert.strictEqual(report.startedWithoutReturning.length, 1);
    assert.strictEqual(Object.keys(report.toolBreakdown).length, 3);
  });

  await t.test('CLI: a directory with no journal exits 1 and says why', () => {
    // `scratch` itself holds only the fixture subdirectories, so its own
    // root carries no journal.jsonl — the bare scratch directory.
    const result = spawnSync(process.execPath, [binPath, scratch, '--format', 'json'], { encoding: 'utf8' });
    assert.strictEqual(result.status, 1);
    assert.ok(result.stderr.includes('journal.jsonl'));
  });

  // ---------------------------------------------------------------------
  // Criterion 3: the existing single-transcript behaviour still works.
  // ---------------------------------------------------------------------

  await t.test('CLI: a single transcript still reports one session', () => {
    const sessionFixture = path.join(fixturesDir, 'claude-code-session.jsonl');
    const stdout = execFileSync(process.execPath, [binPath, sessionFixture, '--format', 'json'], { encoding: 'utf8' });
    const metrics = JSON.parse(stdout);
    assert.strictEqual(metrics.tokens.totalTokens, 1110);
    assert.strictEqual(metrics.counts.stepCount, 2);
    assert.strictEqual(metrics.counts.toolCallsFailed, 1);
    assert.ok(!('agents' in metrics), "a single-transcript report is the session shape, not the run shape — it must carry no 'agents' key");
  });

  // ---------------------------------------------------------------------
  // Run-directory discovery.
  // ---------------------------------------------------------------------

  await t.test('getLatestRunDir: the newest run directory wins, and a session transcript is not one', () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'log-parser-run-home-')));
    const emptyHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'log-parser-run-empty-home-')));
    const T = Math.floor(Date.now() / 1000) - 10_000;

    const oldRun = path.join(home, '.claude/projects/proj/sess/subagents/workflows/wf_old');
    const newRun = path.join(home, '.claude/projects/proj/sess/subagents/workflows/wf_new');
    fs.mkdirSync(oldRun, { recursive: true });
    fs.mkdirSync(newRun, { recursive: true });
    fs.writeFileSync(path.join(oldRun, 'journal.jsonl'), '{"type":"started","key":"k","agentId":"x"}\n');
    fs.writeFileSync(path.join(newRun, 'journal.jsonl'), '{"type":"started","key":"k","agentId":"x"}\n');
    fs.utimesSync(path.join(oldRun, 'journal.jsonl'), T + 10, T + 10);
    fs.utimesSync(path.join(newRun, 'journal.jsonl'), T + 50, T + 50);

    const sessionFile = path.join(home, '.claude/projects/proj/session.jsonl');
    fs.writeFileSync(sessionFile, '{"type":"user","message":{"role":"user","content":"hi"}}\n');
    fs.utimesSync(sessionFile, T + 90, T + 90);

    try {
      assert.strictEqual(getLatestRunDir(home), newRun);
      assert.strictEqual(getLatestRunDir(emptyHome), null);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(emptyHome, { recursive: true, force: true });
    }
  });

  await t.test('CLI: --latest-run reports the newest run', () => {
    // `os.homedir()` reads $HOME on this platform, which is what makes the
    // override work.
    const stdout = execFileSync(process.execPath, [binPath, '--latest-run', '--format', 'json'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: fakeHome }
    });
    const report = JSON.parse(stdout);
    assert.strictEqual(report.totals.tokens.totalTokens, 1130);
  });
});
