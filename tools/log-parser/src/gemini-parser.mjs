import fs from 'node:fs';
import readline from 'node:readline';

export async function parseGeminiLog(filePath) {
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
        currentTurn.userPrompt = obj.message || obj.text || '';
        currentTurn.timestamp = obj.timestamp || currentTurn.timestamp;
      }
      
      if (obj.type === 'PLANNER_RESPONSE') {
        if (obj.thought) {
          currentTurn.thinkingBlocks.push(obj.thought);
        }
        if (obj.text) {
          currentTurn.assistantText += obj.text + '\n';
        }
        if (obj.toolCalls) {
          for (const call of obj.toolCalls) {
             currentTurn.toolCalls.push({
                id: call.id || Math.random().toString(36).substring(7),
                name: call.name || call.function,
                input: call.args || call.input || {},
                success: true,
                output: ''
             });
          }
        }
        if (obj.error) {
           currentTurn.errors.push(obj.error);
        }
      }

      if (obj.type === 'TOOL_RESPONSE') {
        // Find matching tool call
        const matchingCall = currentTurn.toolCalls.find(tc => tc.name === (obj.name || obj.function));
        if (matchingCall) {
           matchingCall.output = obj.response || obj.output || '';
           if (obj.error) {
              matchingCall.success = false;
              currentTurn.errors.push(obj.error);
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
