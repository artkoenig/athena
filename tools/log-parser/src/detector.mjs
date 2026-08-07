import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// How much of a file may be inspected to guess its format. A Claude Code
// session opens with envelope lines (hooks, attachments) that can push the
// first message line several kilobytes in, so a fixed 4 KB window is not
// enough. 1 MB is far more than any opening preamble and still bounded.
const MAX_DETECT_BYTES = 1024 * 1024;

// Line types that only Claude Code writes. They carry no message payload at
// all, so they are the only signal in a transcript whose preamble is long.
// `system` is deliberately absent: too generic a word to key a format on.
const CLAUDE_ENVELOPE_TYPES = new Set(['queue-operation', 'attachment', 'last-prompt', 'mode']);

function claudeProjectsDir(homeDir) {
  return path.join(homeDir, '.claude', 'projects');
}

function geminiLogsDir(homeDir) {
  return path.join(homeDir, '.gemini', 'antigravity', 'brain');
}

function findLatestJsonl(dir) {
  if (!fs.existsSync(dir)) return null;
  let latestFile = null;
  let latestMtime = 0;

  function walk(currentDir) {
    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch (e) {
      // an unreadable directory is skipped, its siblings are not
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      // withFileTypes reports a symlink as neither file nor directory, so
      // symlinked trees are skipped without extra work.
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          const stat = fs.statSync(fullPath);
          if (stat.mtimeMs > latestMtime) {
            latestMtime = stat.mtimeMs;
            latestFile = fullPath;
          }
        } catch (e) {
          // one broken entry must not drop the rest of the directory
        }
      }
    }
  }

  walk(dir);
  return latestFile;
}

/**
 * A session transcript is `~/.claude/projects/<project>/<session-id>.jsonl`.
 * Everything deeper — `subagents/`, `workflows/`, a run's `journal.jsonl` — is
 * a part of a session, not a session, and picking one of those by mtime is how
 * `--latest` ended up pointing at a subagent log.
 */
function findLatestSessionTranscript(projectsDir) {
  let projects;
  try {
    projects = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch (e) {
    return null;
  }

  let latestFile = null;
  let latestMtime = 0;

  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectPath = path.join(projectsDir, project.name);
    let entries;
    try {
      entries = fs.readdirSync(projectPath, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const fullPath = path.join(projectPath, entry.name);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs > latestMtime) {
          latestMtime = stat.mtimeMs;
          latestFile = fullPath;
        }
      } catch (e) {
        // skip this entry only
      }
    }
  }

  return latestFile;
}

/**
 * A workflow run directory is the one that holds a `journal.jsonl`, at
 * `~/.claude/projects/<project>/<session-id>/subagents/workflows/<run-id>/`.
 * This walk is deliberately separate from `--latest`: a session transcript
 * must never resolve to a run directory, nor a run directory to a session.
 */
export function getLatestRunDir(homeDir = os.homedir()) {
  const projectsDir = claudeProjectsDir(homeDir);
  if (!fs.existsSync(projectsDir)) return null;

  let latestDir = null;
  let latestMtime = 0;

  function walk(currentDir) {
    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch (e) {
      // an unreadable directory is skipped, its siblings are not
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name === 'journal.jsonl') {
        try {
          const stat = fs.statSync(fullPath);
          if (stat.mtimeMs > latestMtime) {
            latestMtime = stat.mtimeMs;
            latestDir = currentDir;
          }
        } catch (e) {
          // one broken entry must not drop the rest of the directory
        }
      }
    }
  }

  walk(projectsDir);
  return latestDir;
}

export function getLatestLogPath(provider = 'auto', homeDir = os.homedir()) {
  if (provider === 'claude') {
    return findLatestSessionTranscript(claudeProjectsDir(homeDir));
  } else if (provider === 'gemini') {
    return findLatestJsonl(geminiLogsDir(homeDir));
  } else {
    const claudeLatest = findLatestSessionTranscript(claudeProjectsDir(homeDir));
    const geminiLatest = findLatestJsonl(geminiLogsDir(homeDir));

    if (!claudeLatest && !geminiLatest) return null;
    if (!claudeLatest) return geminiLatest;
    if (!geminiLatest) return claudeLatest;

    const claudeStat = fs.statSync(claudeLatest);
    const geminiStat = fs.statSync(geminiLatest);

    return claudeStat.mtimeMs > geminiStat.mtimeMs ? claudeLatest : geminiLatest;
  }
}

export function detectLogFormat(filePath) {
  const size = fs.statSync(filePath).size;
  const cap = Math.min(size, MAX_DETECT_BYTES);
  const buffer = Buffer.alloc(cap);
  const fd = fs.openSync(filePath, 'r');
  let bytesRead = 0;
  try {
    bytesRead = cap > 0 ? fs.readSync(fd, buffer, 0, cap, 0) : 0;
  } finally {
    fs.closeSync(fd);
  }

  const truncated = bytesRead < size;
  const lines = buffer.toString('utf8', 0, bytesRead).split('\n');
  // the last line of a cut-off read is a fragment, never valid JSON
  if (truncated) lines.pop();

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      // Gemini detection
      if (obj.type === 'USER_INPUT' || obj.type === 'PLANNER_RESPONSE' || obj.step !== undefined || obj.toolCalls !== undefined || obj.usageMetadata) {
        return 'gemini';
      }
      // Claude detection. Claude Code writes the message payload under
      // `message`, and opens a session with envelope lines that carry no
      // message at all.
      if (obj.type === 'message_start' || obj.type === 'message' ||
          obj.type === 'content_block_start' || obj.message?.role ||
          obj.role === 'user' || obj.role === 'assistant' ||
          ((obj.type === 'assistant' || obj.type === 'user') && obj.message) ||
          (CLAUDE_ENVELOPE_TYPES.has(obj.type) && typeof obj.sessionId === 'string')) {
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
