import fs from 'node:fs';
import readline from 'node:readline';

function findToolCall(toolUseId, currentTurn, turns) {
  if (!toolUseId) return null;
  // The call for a result usually sits in the turn that is still open.
  const open = currentTurn.toolCalls.find(c => c.id === toolUseId);
  if (open) return open;
  for (let i = turns.length - 1; i >= 0; i--) {
    const call = turns[i].toolCalls.find(c => c.id === toolUseId);
    if (call) return call;
  }
  return null;
}

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
  let turnHasLogTimestamp = false;
  // Claude Code splits one API response over several lines and repeats the
  // identical `usage` object on every one of them. Count it once per message.
  const countedUsageIds = new Set();

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);

      // Claude Code nests the payload:
      // {"type":"assistant","message":{role,usage,content}}.
      // Older logs put role/usage/content at the top level. Nested wins.
      const msg = obj.message && typeof obj.message === 'object' ? obj.message : obj;
      const role = msg.role ?? obj.role;
      const usage = msg.usage ?? obj.usage;
      const content = msg.content ?? obj.content;
      const messageId = typeof msg.id === 'string' ? msg.id : null;

      // Timestamps: the first log timestamp seen inside a turn wins, so the
      // session start/end times are the log's, not the parse run's.
      if (!turnHasLogTimestamp && typeof obj.timestamp === 'string') {
        currentTurn.timestamp = obj.timestamp;
        turnHasLogTimestamp = true;
      }

      // Token usage, once per distinct message id. A flat log carries usage
      // without an id — count that unconditionally.
      if (usage && (!messageId || !countedUsageIds.has(messageId))) {
        if (messageId) countedUsageIds.add(messageId);
        currentTurn.tokens.inputTokens += usage.input_tokens || 0;
        currentTurn.tokens.outputTokens += usage.output_tokens || 0;
        currentTurn.tokens.cacheReadTokens += usage.cache_read_input_tokens || 0;
        currentTurn.tokens.cacheCreationTokens += usage.cache_creation_input_tokens || 0;
      }

      if (role === 'user') {
        let promptText = '';
        if (typeof content === 'string') {
          promptText = content;
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text') promptText += block.text;
          }
        }
        // Most user lines in a real transcript carry only tool_result blocks.
        // They belong to the turn that is running, they do not open a new one.
        if (promptText) {
          if (currentTurn.userPrompt || currentTurn.toolCalls.length > 0 || currentTurn.thinkingBlocks.length > 0) {
            currentTurn.step = stepCounter++;
            turns.push(currentTurn);
            currentTurn = createNewTurn(stepCounter, agentName);
            turnHasLogTimestamp = false;
            if (typeof obj.timestamp === 'string') {
              currentTurn.timestamp = obj.timestamp;
              turnHasLogTimestamp = true;
            }
          }
          currentTurn.userPrompt = promptText;
        }
      } else if (role === 'assistant') {
        let assistantText = '';
        if (Array.isArray(content)) {
          for (const block of content) {
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
        // Append: one response arrives split over several lines, and an
        // assignment would let a later tool_use-only line blank the text.
        currentTurn.assistantText += assistantText;
      }

      // Tool results: failures, and subagent transcripts
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type !== 'tool_result') continue;
          const call = findToolCall(block.tool_use_id, currentTurn, turns);
          // `is_error` is absent on many successful results, so never test
          // `=== false`. Failures stay out of `turn.errors`: `errorCount` and
          // `toolCallsFailed` are separate columns.
          if (call && block.is_error) call.success = false;

          // Only an invoke_subagent result names a subagent transcript. Any
          // other tool output that happens to mention a .jsonl path is a path
          // in a message, not a log.
          if (call && call.name === 'invoke_subagent' && typeof block.content === 'string') {
            const match = block.content.match(/(?:file:\/\/)?([^\s"']+\.jsonl)/);
            if (match && match[1] && fs.existsSync(match[1]) && !visitedPaths.has(match[1])) {
              const subagentRole = call.input?.Subagents?.[0]?.TypeName || 'subagent';
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
