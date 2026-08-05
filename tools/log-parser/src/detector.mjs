import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CLAUDE_LOGS_DIR = path.join(os.homedir(), '.claude');
const GEMINI_LOGS_DIR = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');

function findLatestJsonl(dir) {
  if (!fs.existsSync(dir)) return null;
  let latestFile = null;
  let latestMtime = 0;
  
  function walk(currentDir) {
    try {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          const stat = fs.statSync(fullPath);
          if (stat.mtimeMs > latestMtime) {
            latestMtime = stat.mtimeMs;
            latestFile = fullPath;
          }
        }
      }
    } catch (e) {
      // ignore access errors
    }
  }
  
  walk(dir);
  return latestFile;
}

export function getLatestLogPath(provider = 'auto') {
  if (provider === 'claude') {
    return findLatestJsonl(CLAUDE_LOGS_DIR);
  } else if (provider === 'gemini') {
    return findLatestJsonl(GEMINI_LOGS_DIR);
  } else {
    const claudeLatest = findLatestJsonl(CLAUDE_LOGS_DIR);
    const geminiLatest = findLatestJsonl(GEMINI_LOGS_DIR);
    
    if (!claudeLatest && !geminiLatest) return null;
    if (!claudeLatest) return geminiLatest;
    if (!geminiLatest) return claudeLatest;
    
    const claudeStat = fs.statSync(claudeLatest);
    const geminiStat = fs.statSync(geminiLatest);
    
    return claudeStat.mtimeMs > geminiStat.mtimeMs ? claudeLatest : geminiLatest;
  }
}

export function detectLogFormat(filePath) {
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(4096);
  const bytesRead = fs.readSync(fd, buffer, 0, 4096, 0);
  fs.closeSync(fd);
  
  const content = buffer.toString('utf8', 0, bytesRead);
  const lines = content.split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      // Gemini detection
      if (obj.type === 'USER_INPUT' || obj.type === 'PLANNER_RESPONSE' || obj.step !== undefined || obj.toolCalls !== undefined || obj.usageMetadata) {
        return 'gemini';
      }
      // Claude detection
      if (obj.type === 'message_start' || obj.type === 'message' || obj.type === 'content_block_start' || obj.message?.role) {
        return 'claude';
      }
      // Often Claude JSONL has arrays of messages
      if (Array.isArray(obj) && obj.length > 0 && obj[0].role) {
          return 'claude';
      }
    } catch (e) {
      // Ignore parse errors on partial lines
    }
  }
  
  return 'unknown';
}
