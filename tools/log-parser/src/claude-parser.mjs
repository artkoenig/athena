import fs from 'node:fs';
import readline from 'node:readline';

export async function parseClaudeLog(filePath, visitedPaths = new Set(), agentName = 'main') {
  if (visitedPaths.has(filePath)) return [];
  visitedPaths.add(filePath);

  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  const turns = [];
  let currentTurn = createNewTurn(1, agentName);
  let stepCounter = 1;

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      
      // Token Usage
      if (obj.type === 'message' || obj.usage) {
        const usage = obj.usage || {};
        currentTurn.tokens.inputTokens += usage.input_tokens || 0;
        currentTurn.tokens.outputTokens += usage.output_tokens || 0;
        currentTurn.tokens.cacheReadTokens += usage.cache_read_input_tokens || 0;
        currentTurn.tokens.cacheCreationTokens += usage.cache_creation_input_tokens || 0;
      }
      
      if (obj.role === 'user') {
        if (currentTurn.userPrompt || currentTurn.toolCalls.length > 0 || currentTurn.thinkingBlocks.length > 0) {
          currentTurn.step = stepCounter++;
          turns.push(currentTurn);
          currentTurn = createNewTurn(stepCounter, agentName);
        }
        
        let promptText = '';
        if (Array.isArray(obj.content)) {
          for (const block of obj.content) {
            if (block.type === 'text') promptText += block.text;
          }
        } else if (typeof obj.content === 'string') {
          promptText = obj.content;
        }
        currentTurn.userPrompt = promptText;
      } else if (obj.role === 'assistant') {
        let assistantText = '';
        if (Array.isArray(obj.content)) {
          for (const block of obj.content) {
            if (block.type === 'text') assistantText += block.text;
            if (block.type === 'thinking') currentTurn.thinkingBlocks.push(block.thinking);
            if (block.type === 'tool_use') {
              const call = {
                id: block.id,
                name: block.name,
                input: block.input,
                success: true,
                output: ''
              };
              currentTurn.toolCalls.push(call);
            }
          }
        }
        currentTurn.assistantText = assistantText;
      }
      
      // Check tool_result blocks for subagent log file paths
      if (Array.isArray(obj.content)) {
        for (const block of obj.content) {
          if (block.type === 'tool_result' && typeof block.content === 'string') {
            const match = block.content.match(/(?:file:\/\/)?([^\s"']+\.jsonl)/);
            if (match && match[1] && fs.existsSync(match[1]) && !visitedPaths.has(match[1])) {
              let subagentRole = 'subagent';
              if (block.tool_use_id) {
                for (let i = turns.length - 1; i >= 0; i--) {
                  const call = turns[i].toolCalls.find(c => c.id === block.tool_use_id);
                  if (call) {
                    if (call.name === 'invoke_subagent' && call.input?.Subagents?.[0]?.TypeName) {
                      subagentRole = call.input.Subagents[0].TypeName;
                    }
                    break;
                  }
                }
              }
              const subTurns = await parseClaudeLog(match[1], visitedPaths, subagentRole);
              for (const subTurn of subTurns) {
                subTurn.step = stepCounter++;
                turns.push(subTurn);
              }
            }
          }
        }
      }

      // API errors
      if (obj.error) {
        currentTurn.errors.push({ errorType: obj.error.type, message: obj.error.message });
      }
      
    } catch (e) {
      // ignore unparseable lines
    }
  }

  if (currentTurn.userPrompt || currentTurn.toolCalls.length > 0 || currentTurn.thinkingBlocks.length > 0) {
    currentTurn.step = stepCounter++;
    turns.push(currentTurn);
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
    tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }
  };
}
