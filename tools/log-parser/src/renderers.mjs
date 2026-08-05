export function renderMarkdown(sessionTranscript) {
  const { metadata, metrics, turns } = sessionTranscript;
  
  let md = `# Session Transcript\n\n`;
  md += `**Session ID**: \`${metadata.sessionId}\`\n`;
  md += `**Provider**: ${metadata.provider} (${metadata.format})\n`;
  md += `**Start Time**: ${metrics.session.startTime}\n`;
  md += `**Duration**: ${metrics.session.durationMs}ms\n\n`;

  md += `## Metrics Summary\n\n`;
  md += `| Metric | Value |\n`;
  md += `| :--- | :--- |\n`;
  md += `| Total Tokens | ${metrics.tokens.totalTokens.toLocaleString()} |\n`;
  md += `| Input Tokens | ${metrics.tokens.inputTokens.toLocaleString()} |\n`;
  md += `| Output Tokens | ${metrics.tokens.outputTokens.toLocaleString()} |\n`;
  md += `| Cache Read Tokens | ${metrics.tokens.cacheReadTokens.toLocaleString()} |\n`;
  md += `| Cache Creation Tokens | ${metrics.tokens.cacheCreationTokens.toLocaleString()} |\n`;
  md += `| Tool Calls | ${metrics.counts.toolCallsTotal} (${metrics.counts.toolCallsFailed} failed) |\n`;
  md += `| Errors | ${metrics.counts.errorCount} |\n`;
  md += `| Step Count | ${metrics.counts.stepCount} |\n\n`;

  md += `### Per-Agent Breakdown\n\n`;
  md += `| Agent / Subagent | Steps | Tool Calls (Failed) | Errors | Total Tokens |\n`;
  md += `| :--- | :--- | :--- | :--- | :--- |\n`;
  for (const [agentName, stats] of Object.entries(metrics.agentBreakdown || {})) {
    md += `| **${agentName}** | ${stats.stepCount} | ${stats.toolCallsTotal} (${stats.toolCallsFailed}) | ${stats.errorCount} | ${stats.tokens.totalTokens.toLocaleString()} |\n`;
  }
  md += `\n`;

  md += `### Sequence Diagram\n\n`;
  md += renderSequenceDiagram(sessionTranscript);
  md += `\n`;

  md += `### Tool Breakdown\n\n`;
  for (const [toolName, stats] of Object.entries(metrics.toolBreakdown)) {
    md += `- **${toolName}**: ${stats.total} calls (${stats.success} success, ${stats.failed} failed)\n`;
  }
  md += `\n---\n\n`;

  md += `## Transcript\n\n`;

  for (const turn of turns) {
    md += `### Step ${turn.step}\n\n`;
    
    if (turn.userPrompt) {
      md += `#### User Prompt\n${turn.userPrompt}\n\n`;
    }

    for (const block of turn.thinkingBlocks) {
      md += `<details><summary>Thinking...</summary>\n\n\`\`\`\n${block}\n\`\`\`\n</details>\n\n`;
    }

    if (turn.assistantText) {
      md += `#### Assistant Response\n${turn.assistantText}\n\n`;
    }

    if (turn.toolCalls.length > 0) {
      md += `#### Tool Calls\n\n`;
      for (const call of turn.toolCalls) {
        md += `<details><summary><code>${call.name}</code> (${call.success ? 'Success' : 'Failed'})</summary>\n\n`;
        md += `**Input**:\n\`\`\`json\n${JSON.stringify(call.input, null, 2)}\n\`\`\`\n\n`;
        if (call.output) {
          md += `**Output**:\n\`\`\`\n${call.output}\n\`\`\`\n\n`;
        }
        md += `</details>\n\n`;
      }
    }

    if (turn.errors.length > 0) {
      md += `#### Errors\n\n`;
      for (const err of turn.errors) {
        md += `- \`${err.errorType || 'Error'}\`: ${err.message || err}\n`;
      }
      md += `\n`;
    }
    
    md += `---\n\n`;
  }

  return md;
}

export function renderJson(sessionTranscript) {
  return JSON.stringify(sessionTranscript.metrics, null, 2);
}

export function renderSequenceDiagram(sessionTranscript) {
  const { turns } = sessionTranscript;
  let diagram = "```mermaid\nsequenceDiagram\n    autonumber\n    actor User\n    participant Main as Main Agent\n    participant Tools as Tools & System\n";

  const subagents = new Set();
  for (const turn of turns) {
    if (turn.isSubagent && turn.agentName && turn.agentName !== 'main') {
      subagents.add(turn.agentName);
    }
  }

  for (const sub of subagents) {
    const safeId = sub.replace(/[^a-zA-Z0-9]/g, '_');
    diagram += `    participant Sub_${safeId} as Subagent: ${sub}\n`;
  }

  for (const turn of turns) {
    const actor = turn.isSubagent ? `Sub_${(turn.agentName || 'subagent').replace(/[^a-zA-Z0-9]/g, '_')}` : 'Main';

    if (turn.userPrompt && !turn.isSubagent) {
      const cleanPrompt = turn.userPrompt.replace(/[\r\n\t]/g, ' ').substring(0, 40).replace(/[^a-zA-Z0-9 _-]/g, '');
      if (cleanPrompt) {
        diagram += `    User->>Main: ${cleanPrompt}...\n`;
      }
    }

    if (turn.toolCalls && turn.toolCalls.length > 0) {
      for (const call of turn.toolCalls) {
        if (call.name === 'invoke_subagent') {
          const role = (call.input && call.input.Subagents && call.input.Subagents[0] && call.input.Subagents[0].Role) || 'Subagent';
          const typeName = (call.input && call.input.Subagents && call.input.Subagents[0] && call.input.Subagents[0].TypeName) || 'subagent';
          const subTarget = `Sub_${typeName.replace(/[^a-zA-Z0-9]/g, '_')}`;
          diagram += `    Main->>${subagents.has(typeName) ? subTarget : 'Tools'}: invoke_subagent (${role})\n`;
        } else if (call.name === 'run_command') {
          const cmd = (call.input && (call.input.CommandLine || call.input.command)) || 'shell command';
          const cleanCmd = String(cmd).replace(/[\r\n\t]/g, ' ').substring(0, 35).replace(/[^a-zA-Z0-9 _-]/g, '');
          diagram += `    ${actor}->>Tools: run_command (${cleanCmd})\n`;
        } else if (call.name === 'replace_file_content' || call.name === 'write_to_file') {
          const target = (call.input && (call.input.TargetFile || call.input.file)) || 'file';
          const baseName = String(target).split('/').pop();
          diagram += `    ${actor}->>Tools: edit (${baseName})\n`;
        }
      }
    }
  }

  diagram += "```\n";
  return diagram;
}
