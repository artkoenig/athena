import fs from 'node:fs';
import readline from 'node:readline';

export async function parseGeminiLog(filePath, visitedPaths = new Set()) {
  if (visitedPaths.has(filePath)) return [];
  visitedPaths.add(filePath);

  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  const turns = [];
  let currentTurn = createNewTurn(1);
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
          turns.push(currentTurn);
          stepCounter++;
          currentTurn = createNewTurn(stepCounter);
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
        if (typeof obj.content === 'string') {
          const match = obj.content.match(/file:\/\/(.+\/transcript\.jsonl)/);
          if (match && match[1] && fs.existsSync(match[1]) && !visitedPaths.has(match[1])) {
            const subTurns = await parseGeminiLog(match[1], visitedPaths);
            for (const subTurn of subTurns) {
              subTurn.isSubagent = true;
              subTurn.step = stepCounter++;
              turns.push(subTurn);
            }
          }
        }
      }
    } catch (e) {
      // ignore
    }
  }

  if (currentTurn.userPrompt || currentTurn.toolCalls.length > 0 || currentTurn.thinkingBlocks.length > 0) {
    turns.push(currentTurn);
  }

  return turns;
}

function createNewTurn(step) {
  return {
    step,
    timestamp: new Date().toISOString(),
    userPrompt: '',
    thinkingBlocks: [],
    assistantText: '',
    toolCalls: [],
    errors: [],
    tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0 }
  };
}
