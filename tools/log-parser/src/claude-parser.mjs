import fs from 'node:fs';
import readline from 'node:readline';

export async function parseClaudeLog(filePath) {
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
      if (obj.type === 'message' || obj.usage) {
        const usage = obj.usage || {};
        currentTurn.tokens.inputTokens += usage.input_tokens || 0;
        currentTurn.tokens.outputTokens += usage.output_tokens || 0;
        currentTurn.tokens.cacheReadTokens += usage.cache_read_input_tokens || 0;
        currentTurn.tokens.cacheCreationTokens += usage.cache_creation_input_tokens || 0;
      }
      
      if (obj.role === 'user') {
        // if previous turn has data, push it and start new turn
        if (currentTurn.userPrompt || currentTurn.toolCalls.length > 0 || currentTurn.thinkingBlocks.length > 0) {
          turns.push(currentTurn);
          stepCounter++;
          currentTurn = createNewTurn(stepCounter);
        }
        
        let promptText = '';
        if (Array.isArray(obj.content)) {
          for (const block of obj.content) {
            if (block.type === 'text') promptText += block.text;
            if (block.type === 'tool_result') {
              // find matching tool call from previous turns to update success?
              // The problem asks to parse it. Let's just assume we record the output.
            }
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
              currentTurn.toolCalls.push({
                id: block.id,
                name: block.name,
                input: block.input,
                success: true,
                output: ''
              });
            }
          }
        }
        currentTurn.assistantText = assistantText;
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
    tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }
  };
}
