import fs from 'node:fs';
import readline from 'node:readline';

export async function parseGeminiLog(filePath, visitedPaths = new Set(), agentName = 'main') {
  if (visitedPaths.has(filePath)) return [];
  visitedPaths.add(filePath);

  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  const turns = [];
  let pendingSubTurns = [];
  let currentTurn = createNewTurn(1, agentName);
  let stepCounter = 1;

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      
      // Token Usage
      if (obj.usageMetadata) {
        currentTurn.tokens.inputTokens += obj.usageMetadata.promptTokenCount || 0;
        currentTurn.tokens.outputTokens += obj.usageMetadata.candidatesTokenCount || 0;
        currentTurn.tokens.cacheReadTokens += obj.usageMetadata.cachedContentTokenCount || 0;
        currentTurn.tokens.totalTokens = obj.usageMetadata.totalTokenCount || 0;
      }

      if (obj.type === 'USER_INPUT') {
        if (currentTurn.userPrompt || currentTurn.toolCalls.length > 0 || currentTurn.thinkingBlocks.length > 0) {
          currentTurn.step = stepCounter++;
          turns.push(currentTurn);
          for (const st of pendingSubTurns) {
            st.step = stepCounter++;
            turns.push(st);
          }
          pendingSubTurns = [];
          currentTurn = createNewTurn(stepCounter, agentName);
        }
        currentTurn.userPrompt = obj.content || obj.message || obj.text || '';
        currentTurn.timestamp = obj.created_at || obj.timestamp || currentTurn.timestamp;
      }
      
      if (obj.type === 'PLANNER_RESPONSE') {
        if (obj.thinking || obj.thought) {
          currentTurn.thinkingBlocks.push(obj.thinking || obj.thought);
        }
        if (obj.content || obj.text) {
          currentTurn.assistantText += (obj.content || obj.text) + '\n';
        }
        const calls = obj.tool_calls || obj.toolCalls;
        if (Array.isArray(calls)) {
          for (const call of calls) {
             currentTurn.toolCalls.push({
                id: call.id || Math.random().toString(36).substring(7),
                name: call.name || call.function,
                input: call.args || call.input || {},
                success: obj.status !== 'ERROR',
                output: ''
             });
          }
        }
        if (obj.error) {
           currentTurn.errors.push(obj.error);
        }
      }

      // Tool responses / execution outputs
      if (obj.type === 'TOOL_RESPONSE' || (obj.type !== 'USER_INPUT' && obj.type !== 'PLANNER_RESPONSE' && obj.content)) {
        const lastCall = currentTurn.toolCalls[currentTurn.toolCalls.length - 1];
        if (lastCall) {
          lastCall.output = obj.content || obj.response || obj.output || '';
          if (obj.status === 'ERROR' || obj.error) {
            lastCall.success = false;
            if (obj.error) currentTurn.errors.push(typeof obj.error === 'string' ? obj.error : JSON.stringify(obj.error));
          }
        }

        // Subagent log discovery
        const outputStr = obj.content || obj.response || obj.output;
        if (typeof outputStr === 'string') {
          const match = outputStr.match(/(?:file:\/\/)?([^\s"']+\.jsonl)/);
          if (match && match[1] && fs.existsSync(match[1]) && !visitedPaths.has(match[1])) {
            let subagentRole = 'subagent';
            if (lastCall && lastCall.name === 'invoke_subagent' && lastCall.input?.Subagents?.[0]?.TypeName) {
              subagentRole = lastCall.input.Subagents[0].TypeName;
            }
            const subTurns = await parseGeminiLog(match[1], visitedPaths, subagentRole);
            for (const subTurn of subTurns) {
              pendingSubTurns.push(subTurn);
            }
          }
        }
      }
    } catch (e) {
      // ignore
    }
  }

  if (currentTurn.userPrompt || currentTurn.toolCalls.length > 0 || currentTurn.thinkingBlocks.length > 0) {
    currentTurn.step = stepCounter++;
    turns.push(currentTurn);
    for (const st of pendingSubTurns) {
      st.step = stepCounter++;
      turns.push(st);
    }
  }

  return turns;
}

function createNewTurn(step, agentName = 'main') {
  return {
    step,
    agentName,
    isSubagent: agentName !== 'main',
    timestamp: new Date().toISOString(),
    userPrompt: '',
    thinkingBlocks: [],
    assistantText: '',
    toolCalls: [],
    errors: [],
    tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0 }
  };
}
