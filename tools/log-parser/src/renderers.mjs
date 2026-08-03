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
