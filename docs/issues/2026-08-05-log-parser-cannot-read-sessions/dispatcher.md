# Dispatcher handoff — `parse-agent-log` cannot read Claude Code session logs

## 1. What is being built

Three reading defects in `tools/log-parser` are fixed, all of them verified
against a real Claude Code transcript on this machine:

1. `getLatestLogPath` searches `~/.claude/projects/<project>/*.jsonl` instead of
   walking all of `~/.claude`, so `--latest` returns the newest **session
   transcript** and never a plugin file, a workflow `journal.jsonl` or a
   subagent log.
2. `detectLogFormat` no longer decides from a fixed 4096-byte window. It scans
   up to 1 MB of lines and additionally recognises the Claude Code envelope
   line types (`queue-operation`, `attachment`, `last-prompt`, `mode`), so a
   transcript whose first message line sits ~10 KB in is still `claude`.
3. `parseClaudeLog` reads the nested Claude Code shape
   (`{"type":"assistant","message":{"role":…,"usage":…,"content":[…]}}`) as well
   as the old flat shape, counts all four `usage` fields once per unique
   `message.id`, counts `tool_use` blocks per tool name and marks a call failed
   when its `tool_result` carries `is_error`.

The Gemini path is untouched apart from one signature default. Output formats
and CLI flags stay exactly as they are.

## 2. Module map — every file this touches

| Path | What it holds | Role in this change |
| --- | --- | --- |
| `/home/user/uroboros/tools/log-parser/src/detector.mjs` | `CLAUDE_LOGS_DIR` (line 5), `GEMINI_LOGS_DIR` (line 6), `findLatestJsonl` (lines 8–35, recursive walk), `getLatestLogPath` (lines 37–55), `detectLogFormat` (lines 57–87, the 4096-byte read at lines 58–60). | Rewritten search root + testable `homeDir` parameter; detection window and signal set replaced. |
| `/home/user/uroboros/tools/log-parser/src/claude-parser.mjs` | `parseClaudeLog` (lines 4–113): token block 23–30, `obj.role === 'user'` 32–47, `obj.role === 'assistant'` 48–67, subagent discovery from `tool_result` 69–95, `obj.error` 97–100; `createNewTurn` 115–128. | The whole per-line body is reworked around a normalised message view. |
| `/home/user/uroboros/tools/log-parser/src/gemini-parser.mjs` | `parseGeminiLog`, same turn shape. | **Not edited.** Named here so it is clear it must stay untouched. |
| `/home/user/uroboros/tools/log-parser/src/metrics.mjs` | `createEmptyMetrics`, `aggregateMetrics` (lines 31–117) — sums `turn.tokens.*`, counts `turn.toolCalls` per name via `call.success`, `agentBreakdown` keyed by `turn.agentName`, `normalizeSession` (119–130). | **Not edited.** It already produces every number the ACs ask for once the parser fills the turns correctly. |
| `/home/user/uroboros/tools/log-parser/src/renderers.mjs` | `renderMarkdown`, `renderJson` (`JSON.stringify(transcript.metrics)`), `renderSequenceDiagram`. | **Not edited.** |
| `/home/user/uroboros/tools/log-parser/bin/parse-agent-log.mjs` | `parseArgs` (12–23), `--latest` resolution (35–38), `Log file not found` exit 1 (40–43), `Unknown log format` exit 2 (45–49), dispatch to the parsers (51–61), render/write (63–85). | **Not edited.** Verified: a bare `--latest` lands as boolean `true` and falls through to the `auto` branch — that path is fine. |
| `/home/user/uroboros/tools/log-parser/test/parser.test.mjs` | The single existing suite: fixture templating in `t.before`, `detectLogFormat`, `parseClaudeLog`, `parseGeminiLog`, `normalizeSession and renderers`. | Extended by the test author. **The four existing sub-tests and their assertions must stay green unchanged** — they are the regression net for the old flat shape. |
| `/home/user/uroboros/tools/log-parser/test/fixtures/claude-sample.jsonl` | 5 lines, old flat shape (`{"type":"message","usage":{…},"role":"user",…}`), `{{CLAUDE_SUBAGENT_PATH}}` placeholder. | **Not edited.** This *is* the "old shape keeps working" criterion. |
| `/home/user/uroboros/tools/log-parser/test/fixtures/claude-code-session.jsonl` | New fixture, spec in §5.1. | The nested shape + the detection window + the `queue-operation` opening, in one file. |
| `/home/user/uroboros/tools/log-parser/package.json` | `{"type":"module","scripts":{"test":"node --test"}}`, zero dependencies. | **Not edited.** `node --test` picks new `test/*.test.mjs` files up on its own. |
| `/home/user/uroboros/test.sh` | Runs `npm --prefix tools/log-parser test --silent` as one of six suites (lines 38–39). | **Not edited.** |
| `/home/user/uroboros/bin/parse-agent-log` | `exec node "$DIR/../tools/log-parser/bin/parse-agent-log.mjs" "$@"`. | **Not edited.** |
| `/home/user/uroboros/skills/retro/SKILL.md` | Step 1 calls `bin/parse-agent-log --latest`, step 2 calls `bin/parse-agent-log <path> --format all`. | **Not edited.** Both invocations must keep working; they are the reason this issue exists. |

Entry points, for orientation:

- `bin/parse-agent-log [--latest] [path] [--format all|markdown|json]` — the shim
  the retro skill calls.
- `node tools/log-parser/bin/parse-agent-log.mjs …` — the same thing, direct.
- Library: `detectLogFormat(path)`, `getLatestLogPath(provider)`,
  `parseClaudeLog(path)`, `normalizeSession(turns, format, provider)`.

## 3. Research results that constrain the implementation

All of this was measured on this machine against
`/root/.claude/projects/-home-user-uroboros/7e01c86d-f719-5a7e-b263-14ec8a05c806.jsonl`
(592 KB, 286 lines) and its subagent transcripts. **Do not treat these as
guesses.**

### 3.1 The failures reproduce exactly as the issue describes

```
$ node tools/log-parser/bin/parse-agent-log.mjs <main-transcript>
Error: Unknown log format.

$ node tools/log-parser/bin/parse-agent-log.mjs <subagent-transcript> --format json
… "stepCount": 0, "toolCallsTotal": 0, "totalTokens": 0, "toolBreakdown": {}, "agentBreakdown": {}
```

The subagent file *is* detected as `claude` (its first line is a `user` line
with `message.role`, well inside 4096 bytes) and still parses to all zeros —
so defect 3 is independent of defect 2 and needs its own fix.

### 3.2 Line types in a real transcript

Counted over the 286 lines of the main transcript:

| `type` | count | top-level keys (union) |
| --- | --- | --- |
| `assistant` | 124 | `message`, `type`, `uuid`, `parentUuid`, `sessionId`, `timestamp`, `requestId`, `cwd`, `gitBranch`, `version`, `userType`, `isSidechain`, `effort`, `attributionAgent`, `attributionPlugin`, `attributionSkill` |
| `user` | 78 | `message`, `type`, `uuid`, `parentUuid`, `sessionId`, `timestamp`, `promptId`, `promptSource`, `origin`, `permissionMode`, `isMeta`, `toolUseResult`, … |
| `queue-operation` | 28 | `type`, `operation`, `sessionId`, `timestamp`, `content` |
| `attachment` | 21 | `type`, `attachment`, `sessionId`, `uuid`, `timestamp`, `cwd`, … |
| `last-prompt` | 17 | `type`, `lastPrompt`, `leafUuid`, `sessionId` |
| `system` | 9 | `type`, `subtype`, `level`, `hook*`, `sessionId`, `uuid`, … |
| `mode` | 9 | `type`, `mode`, `sessionId` |

No line carries a top-level `role`, `usage`, `step`, `toolCalls` or
`usageMetadata`. So the existing Gemini signals cannot fire on a Claude Code
line, and the check order in `detectLogFormat` (Gemini first, Claude second)
can stay as it is.

**The first `assistant`/`user` line begins at byte 9814** (line index 4). That
is defect 2, measured.

### 3.3 `message.usage` is repeated across split assistant lines

126 assistant lines carry only 76 distinct `message.id`s. Claude Code splits one
API response over several lines (one per content block) and **repeats the
identical `usage` object on every one of them**:

```
('msg_011CdjQVFPyvm6nXgNXFvzLT', ['thinking'],  {input:2, output:692, cache_read:0, cache_creation:46880})
('msg_011CdjQVFPyvm6nXgNXFvzLT', ['tool_use'],  {input:2, output:692, cache_read:0, cache_creation:46880})
```

Summing `usage` per line therefore inflates every token number by ~65 %.
**Count `usage` once per distinct `message.id`.** The content blocks themselves
are *not* duplicated: 66 `tool_use` blocks, 66 distinct `id`s, so tool calls are
counted per block with no dedup.

`usage` also carries `server_tool_use`, `service_tier`, `cache_creation`,
`iterations`, `speed`, `inference_geo`. Read the four named fields and ignore
the rest; do **not** sum `usage.iterations[]` on top (it repeats the same
numbers).

### 3.4 `tool_result` shape

66 `tool_result` blocks, 66 distinct `tool_use_id`, every one of them matching a
`tool_use` in the same file; 3 carry `is_error: true`. Example:

```json
{"type":"tool_result","tool_use_id":"toolu_01SE6h…","is_error":true,
 "content":"Exit code 1\nError: Log file not found.\n…"}
```

`content` is a string in the common case and an array of blocks for some tools.
Successful results carry `is_error: false` explicitly in most cases, and omit
the key in others — so test `!!block.is_error`, never `block.is_error === false`.

### 3.5 What a `user` line actually is

Of the 78 `user` lines: 12 have string `content` (real prompts, 3 of them
`isMeta` stop-hook feedback), 2 have a `text` block array (`isMeta`, the
workflow's agent prompt), **66 are pure `tool_result` carriers**.

Consequence for turn segmentation: the current rule "a `role === 'user'` line
starts a new turn" would cut a new turn at every tool result, i.e. ~66 turns of
noise for 14 prompts. The rule must be: **a user line starts a new turn only
when it carries prompt text** (string `content`, or at least one `text` block).
A user line whose blocks are only `tool_result` attaches to the current turn.

This rule keeps the existing fixture green: `claude-sample.jsonl` line 3 mixes
`tool_result` blocks *and* a `text` block `"What about tomorrow?"`, and the
existing test asserts that this line opens turn 3.

### 3.6 Subagent transcripts

They live at `~/.claude/projects/<project>/<session-id>/subagents/agent-<id>.jsonl`
and `…/subagents/workflows/<run-id>/agent-<id>.jsonl`, use the **same nested
shape**, and carry `agentId` plus `attributionAgent` (e.g. `"uroboros:dispatcher"`).
Per-agent aggregation across that directory is **out of scope** (the issue says
so). Do not build it. It is named here only so the fix does not accidentally
foreclose it.

### 3.7 The subagent-path recursion is a live hazard on real Claude logs

`claude-parser.mjs:69–95` scans **every** `tool_result` string for
`/([^\s"']+\.jsonl)/`, and recurses into the path if it exists on disk. In a
real transcript, tool output routinely mentions `.jsonl` paths (this very
research run printed several). Left as is, the parser would recurse into
unrelated session logs and journal files and pollute every number.

The feature exists for the Gemini/Antigravity `invoke_subagent` tool call
(issue `2026-08-04-log-parser-subagent-breakdown`). Tighten it: recurse **only**
when the `tool_use_id` of the result resolves to a tool call named
`invoke_subagent`. The existing fixture's `tool_sub_1` is exactly that, so the
existing assertions stay green.

### 3.8 `~/.claude` is full of non-transcript `.jsonl`

`~/.claude` also holds `plugins/`, `backups/`, `shell-snapshots/`,
`session-env/`, and inside a project dir there are
`subagents/workflows/<run>/journal.jsonl` files. Right now `getLatestLogPath`
walks all of it by mtime; on this machine it returns
`…/subagents/workflows/wf_9aab2946-d01/agent-a1188f3100cc9aa3f.jsonl` — a
subagent log, not the session. The acceptance criterion names the search root:
`~/.claude/projects/`.

Also: `findLatestJsonl`'s `try` wraps the whole `readdir` loop, so one
`statSync` failure (a broken symlink, a permission bite) silently drops the rest
of that directory. Per-entry error handling instead.

### 3.9 `parseArgs` behaviour, verified

| argv | `values.latest` |
| --- | --- |
| `--latest` | `true` (boolean) |
| `--latest claude` | `'claude'` |
| `--latest=claude` | `'claude'` |

`bin/parse-agent-log.mjs:37` maps `''`/`'true'` to `'auto'` and passes anything
else through; boolean `true` reaches `getLatestLogPath` and falls into the
`else` (auto) branch. That works. **Do not change the bin's argument handling.**

### 3.10 Environment facts

Node ESM, zero dependencies, `node --test`, no build step. `.gitignore` does not
cover `test/fixtures/*.jsonl`, so a new fixture is committed normally; the
existing suite writes `*.tmp.jsonl` beside the fixtures and deletes them in
`t.after`.

## 4. Implementation plan

### 4.1 `src/detector.mjs` — the search root

Replace `findLatestJsonl` usage for Claude with a projects-scoped search. Keep
the recursive walk for Gemini, whose logs really are a tree.

```js
const MAX_DETECT_BYTES = 1024 * 1024;

function claudeProjectsDir(homeDir) {
  return path.join(homeDir, '.claude', 'projects');
}

function geminiLogsDir(homeDir) {
  return path.join(homeDir, '.gemini', 'antigravity', 'brain');
}
```

- Delete the module-level `CLAUDE_LOGS_DIR` / `GEMINI_LOGS_DIR` constants, or
  keep them only as the defaults these helpers build from. The directories must
  be derived from the `homeDir` argument, not from a constant frozen at import
  time — the test cannot fake a home otherwise.
- Harden `findLatestJsonl`: move the `try`/`catch` **inside** the entry loop so a
  single unreadable entry does not abandon the rest of a directory, and skip
  symlinked directories (`entry.isDirectory()` is already false for symlinks
  with `withFileTypes`, so nothing extra is needed — just do not add
  `followSymlinks`).

New function, a session transcript being a `.jsonl` file lying **directly**
inside a project directory:

```js
/**
 * A session transcript is `~/.claude/projects/<project>/<session-id>.jsonl`.
 * Everything deeper — `subagents/`, `workflows/`, a run's `journal.jsonl` — is
 * a part of a session, not a session, and picking one of those by mtime is how
 * `--latest` ended up pointing at a subagent log.
 */
function findLatestSessionTranscript(projectsDir) { … }
```

Implementation: `readdirSync(projectsDir, { withFileTypes: true })`, for each
directory entry `readdirSync` that one level, consider only `entry.isFile() &&
entry.name.endsWith('.jsonl')`, `statSync` each, keep the largest `mtimeMs`.
Wrap each `readdirSync`/`statSync` in its own `try`/`catch`. Return `null` when
nothing matches or the root does not exist.

Signature change:

```js
export function getLatestLogPath(provider = 'auto', homeDir = os.homedir()) {
  if (provider === 'claude') return findLatestSessionTranscript(claudeProjectsDir(homeDir));
  if (provider === 'gemini') return findLatestJsonl(geminiLogsDir(homeDir));
  // auto: newest of the two, by mtime — unchanged logic
}
```

The `auto` branch keeps its existing structure (both nulls → `null`, one null →
the other, otherwise compare `mtimeMs`). `bin/parse-agent-log.mjs` keeps calling
it with one argument.

### 4.2 `src/detector.mjs` — the detection window

Replace lines 58–63 (the 4096-byte read) with a bounded read of at most
`MAX_DETECT_BYTES`:

```js
export function detectLogFormat(filePath) {
  const size = fs.statSync(filePath).size;
  const cap = Math.min(size, MAX_DETECT_BYTES);
  const buffer = Buffer.alloc(cap);
  const fd = fs.openSync(filePath, 'r');
  let bytesRead = 0;
  try {
    bytesRead = fs.readSync(fd, buffer, 0, cap, 0);
  } finally {
    fs.closeSync(fd);
  }
  const truncated = bytesRead < size;
  const lines = buffer.toString('utf8', 0, bytesRead).split('\n');
  if (truncated) lines.pop(); // the last line of a cut-off read is a fragment
  …
}
```

Keep it **synchronous** — `bin/parse-agent-log.mjs:45` and the existing test call
it without `await`, and making it async would ripple through both.
`fs.closeSync` must run even when the read throws (hence `finally`; today a
throw leaks the descriptor).

Then, per line, unchanged order — Gemini first, Claude second — with the Claude
branch extended:

```js
// Claude Code writes the message payload under `message`, and opens a session
// with envelope lines that carry no message at all.
if (obj.type === 'message_start' || obj.type === 'message' ||
    obj.type === 'content_block_start' || obj.message?.role ||
    obj.role === 'user' || obj.role === 'assistant' ||
    ((obj.type === 'assistant' || obj.type === 'user') && obj.message) ||
    (CLAUDE_ENVELOPE_TYPES.has(obj.type) && typeof obj.sessionId === 'string')) {
  return 'claude';
}
```

with

```js
const CLAUDE_ENVELOPE_TYPES = new Set(['queue-operation', 'attachment', 'last-prompt', 'mode']);
```

`system` is deliberately **not** in that set — it is a generic word and the
`sessionId` guard is weaker protection there than the payoff is worth; the four
listed types all carry `sessionId` in real logs (§3.2) and are unmistakably
Claude Code.

The Gemini branch and the array-of-messages branch stay byte-for-byte as they
are. `return 'unknown'` at the end stays.

### 4.3 `src/claude-parser.mjs` — a normalised view per line

At the top of the `for await` body, right after `JSON.parse`:

```js
// Claude Code nests the payload: {"type":"assistant","message":{role,usage,content}}.
// Older logs put role/usage/content at the top level. Nested wins where both exist.
const msg = obj.message && typeof obj.message === 'object' ? obj.message : obj;
const role = msg.role ?? obj.role;
const usage = msg.usage ?? obj.usage;
const content = msg.content ?? obj.content;
const messageId = typeof msg.id === 'string' ? msg.id : null;
```

Every later reference to `obj.role` / `obj.usage` / `obj.content` in this
function becomes `role` / `usage` / `content`. Do not leave a single `obj.content`
behind — the `tool_result` scan at lines 69–95 reads it too.

### 4.4 Tokens, counted once per message

Replace lines 23–30:

```js
const countedUsageIds = new Set(); // per parseClaudeLog call, before the loop

if (usage) {
  if (!messageId || !countedUsageIds.has(messageId)) {
    if (messageId) countedUsageIds.add(messageId);
    currentTurn.tokens.inputTokens         += usage.input_tokens || 0;
    currentTurn.tokens.outputTokens        += usage.output_tokens || 0;
    currentTurn.tokens.cacheReadTokens     += usage.cache_read_input_tokens || 0;
    currentTurn.tokens.cacheCreationTokens += usage.cache_creation_input_tokens || 0;
  }
}
```

Rationale for the `!messageId` fallback: the old flat fixture has `usage` with no
`id`, and dropping it would break the old shape. The `Set` is per invocation, so
the recursion into a subagent log starts with a clean one — ids are per file.

The old `obj.type === 'message' || obj.usage` condition collapses to `if (usage)`;
a `type: 'message'` line without `usage` only ever added zeros.

### 4.5 User lines, turn segmentation, timestamps

```js
if (role === 'user') {
  let promptText = '';
  if (typeof content === 'string') {
    promptText = content;
  } else if (Array.isArray(content)) {
    for (const block of content) if (block.type === 'text') promptText += block.text;
  }
  // 66 of 78 user lines in a real transcript are pure tool_result carriers.
  // They belong to the turn that is running, they do not open a new one.
  if (promptText) {
    if (currentTurn.userPrompt || currentTurn.toolCalls.length > 0 || currentTurn.thinkingBlocks.length > 0) {
      currentTurn.step = stepCounter++;
      turns.push(currentTurn);
      currentTurn = createNewTurn(stepCounter, agentName);
      turnHasLogTimestamp = false;
    }
    currentTurn.userPrompt = promptText;
  }
}
```

Timestamps: keep a `let turnHasLogTimestamp = false;` next to `currentTurn`,
reset it wherever a new turn is created, and near the top of the line body:

```js
if (!turnHasLogTimestamp && typeof obj.timestamp === 'string') {
  currentTurn.timestamp = obj.timestamp;
  turnHasLogTimestamp = true;
}
```

This makes `metrics.session.startTime`/`endTime`/`durationMs` real instead of
"now". `createNewTurn` keeps `new Date().toISOString()` as the fallback for logs
without timestamps, so the old fixture is unaffected. Do **not** add a field to
the turn object for this — the flag is a parser local.

### 4.6 Assistant lines

Same as today (lines 48–67) with two changes:

- read from `content`, not `obj.content`;
- **append** the text: `currentTurn.assistantText += assistantText;` — Claude
  Code splits one response over several lines, and today's `=` lets a later
  `tool_use`-only line blank the text a previous line collected.

`thinking` blocks and `tool_use` blocks are pushed exactly as today
(`{ id, name, input, success: true, output: '' }`).

### 4.7 Tool results: failures, and a much narrower subagent recursion

Replace the block at lines 69–95. Iterate `content` when it is an array, and for
each `tool_result` block:

```js
const call = findToolCall(block.tool_use_id, currentTurn, turns);
if (call && block.is_error) call.success = false;
```

`findToolCall(id, currentTurn, turns)` looks in `currentTurn.toolCalls` first,
then walks `turns` backwards — the call usually sits in the turn that is still
open, which the current code (which only searches `turns`) cannot see.

Do **not** set `call.output` for Claude logs. Today's Claude parser never fills
it, `renderMarkdown` prints `**Output**` blocks verbatim, and piping real tool
output into the retro markdown would change the document this issue explicitly
does not touch. Recorded as a decision, not an oversight.

Do **not** push tool failures into `currentTurn.errors` — `errorCount` and
`toolCallsFailed` are separate columns in the metrics and the renderer, and
mixing them would double-report. The `obj.error` branch (lines 97–100) stays as
it is.

Subagent recursion, now guarded (see §3.7):

```js
// Only an invoke_subagent result names a subagent transcript. Any other tool
// output that happens to mention a .jsonl path is a path in a message, not a log.
if (call && call.name === 'invoke_subagent' && typeof block.content === 'string') {
  const match = block.content.match(/(?:file:\/\/)?([^\s"']+\.jsonl)/);
  if (match?.[1] && fs.existsSync(match[1]) && !visitedPaths.has(match[1])) {
    const subagentRole = call.input?.Subagents?.[0]?.TypeName || 'subagent';
    const subTurns = await parseClaudeLog(match[1], visitedPaths, subagentRole);
    for (const subTurn of subTurns) { subTurn.step = stepCounter++; turns.push(subTurn); }
  }
}
```

**Ordering inside the line body is load-bearing** and must stay: timestamp →
tokens → user-line handling → assistant-line handling → `tool_result` handling →
`obj.error`. The existing test asserts that the subagent turns land *after* the
turn that was closed by the same line (`turns[1]` is the subagent, `turns[2]` is
`"What about tomorrow?"` at step 3), and that only holds if the user-line branch
runs before the `tool_result` branch.

### 4.8 What is explicitly not changed

- `bin/parse-agent-log.mjs` — no flag, no message, no exit code moves.
- `src/metrics.mjs`, `src/renderers.mjs`, `src/gemini-parser.mjs` — untouched.
- `metrics.session.id` stays `"unknown"` and `model` stays `"unknown"`. Real
  logs carry `sessionId` and `message.model`, and filling them would be an
  output change; this issue fixes reading.
- No per-agent aggregation over `subagents/` (out of scope, own issue).
- No new dependency, no async `detectLogFormat`, no new module file.

## 5. Test plan — for the test author

Everything lands in `tools/log-parser/test/`. `node:test` + `node:assert`, the
style of the existing `parser.test.mjs`. **The four existing sub-tests keep their
current assertions** — if one of them has to be weakened, the implementation is
wrong.

### 5.1 New fixture `test/fixtures/claude-code-session.jsonl`

Synthetic, no real session content. Nested shape throughout, opening with the
Claude Code envelope. Exact contents:

1. `{"type":"queue-operation","operation":"enqueue","timestamp":"2026-08-05T09:00:00.000Z","sessionId":"test-session","content":"do the thing"}`
2. `{"type":"attachment","sessionId":"test-session","uuid":"u-1","timestamp":"2026-08-05T09:00:00.100Z","attachment":{"type":"hook_success","hookName":"SessionStart:startup","content":"<PAD>"}}`
   — `<PAD>` is a run of at least 4300 `x` characters, so that the first line
   carrying a `role` starts **beyond byte 4096**. Nothing else in the fixture
   needs to be long; total size stays around 5 KB.
3. `{"type":"user","sessionId":"test-session","uuid":"u-2","timestamp":"2026-08-05T09:00:01.000Z","message":{"role":"user","content":"do the thing"}}`
4. `{"type":"assistant","sessionId":"test-session","uuid":"u-3","timestamp":"2026-08-05T09:00:02.000Z","message":{"id":"msg_1","role":"assistant","usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":30,"cache_creation_input_tokens":40},"content":[{"type":"thinking","thinking":"planning"}]}}`
5. **Same `"id":"msg_1"`, same `usage` object**, `content` = two `tool_use`
   blocks: `{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}`
   and `{"type":"tool_use","id":"t2","name":"Read","input":{"file_path":"/nope"}}`.
6. `{"type":"user",…,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","is_error":false,"content":"ok"},{"type":"tool_result","tool_use_id":"t2","is_error":true,"content":"No such file"}]}}`
7. `{"type":"assistant",…,"message":{"id":"msg_2","role":"assistant","usage":{"input_tokens":1,"output_tokens":2,"cache_read_input_tokens":3,"cache_creation_input_tokens":4},"content":[{"type":"text","text":"done"}]}}`
8. `{"type":"user",…,"message":{"role":"user","content":"and now the second thing"}}`
9. `{"type":"assistant",…,"message":{"id":"msg_3","role":"assistant","usage":{"input_tokens":100,"output_tokens":200,"cache_read_input_tokens":300,"cache_creation_input_tokens":400},"content":[{"type":"tool_use","id":"t3","name":"Bash","input":{"command":"pwd"}}]}}`
10. `{"type":"user",…,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t3","content":"/tmp"}]}}` — no `is_error` key at all.

No `{{…}}` placeholder, so this fixture is read directly, not templated.

The numbers this pins:

| | expected |
| --- | --- |
| `tokens.inputTokens` | 111 |
| `tokens.outputTokens` | 222 |
| `tokens.cacheReadTokens` | 333 |
| `tokens.cacheCreationTokens` | 444 |
| `tokens.totalTokens` | 1110 |
| `counts.toolCallsTotal` | 3 |
| `counts.toolCallsFailed` | 1 |
| `toolBreakdown.Bash` | `{total:2, success:2, failed:0}` |
| `toolBreakdown.Read` | `{total:1, success:0, failed:1}` |
| `counts.stepCount` (turns) | 2 |

The round numbers are chosen so a dedup regression is unmissable: counting
`msg_1` twice gives 121/242/363/484 instead.

### 5.2 The detection window (`detectLogFormat`)

- `detectLogFormat(claudeCodeFixture) === 'claude'`.
- **Guard the fixture itself**: in the test, read the fixture and assert that the
  byte offset of the first line containing `"role"` is greater than 4096. Without
  that assertion a later edit could shorten the padding and the test would keep
  passing while proving nothing.
- The existing assertions `detectLogFormat(claudeFixture) === 'claude'` and
  `detectLogFormat(geminiFixture) === 'gemini'` stay.
- Negative case: write a temp file of two lines of `{"hello":"world"}` and assert
  `'unknown'` — the format guess must not have become a coin flip.

### 5.3 The nested shape (`parseClaudeLog` + `normalizeSession`)

Parse `claude-code-session.jsonl`, run `normalizeSession(turns, 'claude', 'claude')`,
assert every row of the table in §5.1 exactly (`assert.strictEqual`, not
"greater than zero" — the ACs name the four token fields and the per-tool
counts, so pin them).

Additionally:

- `turns.length === 2`, `turns[0].userPrompt === 'do the thing'`,
  `turns[1].userPrompt === 'and now the second thing'` — the tool-result lines
  did not open turns.
- `turns[0].toolCalls.map(c => c.name)` is `['Bash', 'Read']`, and the `Read`
  call has `success === false`.
- `turns[0].thinkingBlocks.length === 1` and `turns[0].assistantText` contains
  `'done'` — the split assistant lines were merged, not overwritten.
- `metrics.session.startTime === '2026-08-05T09:00:01.000Z'` (the first line that
  contributes to a turn), and `metrics.session.durationMs > 0`.

### 5.4 The old flat shape still works

The existing `parseClaudeLog` and `normalizeSession and renderers` sub-tests
cover it and must stay untouched. Add one assertion to the existing
`normalizeSession` sub-test: `transcript.metrics.tokens.inputTokens === 100` and
`cacheReadTokens === 10`, from `claude-sample.jsonl` line 1 — the flat
`obj.usage` path is now explicitly pinned, since the parser no longer reads
`obj.usage` first.

### 5.5 `--latest` (`getLatestLogPath`)

Build a fake home with `fs.mkdtempSync(path.join(os.tmpdir(), 'log-parser-home-'))`
and `fs.realpathSync` it (macOS `/var` → `/private/var`), then create:

```
<home>/.claude/projects/proj-a/session-a.jsonl              mtime T+10
<home>/.claude/projects/proj-a/subagents/agent-x.jsonl      mtime T+40
<home>/.claude/projects/proj-a/subagents/workflows/w1/journal.jsonl  mtime T+50
<home>/.claude/projects/proj-b/session-b.jsonl              mtime T+20
<home>/.claude/plugins/some-cache.jsonl                     mtime T+60
```

Set every mtime explicitly with `fs.utimesSync` — never rely on write order.
Assertions:

- `getLatestLogPath('claude', home)` === `<home>/.claude/projects/proj-b/session-b.jsonl`.
  This is the whole point: the two newest files on disk are a plugin cache and a
  subagent log, and neither may win.
- `getLatestLogPath('claude', emptyTempHome)` === `null`.
- Gemini stays recursive: add `<home>/.gemini/antigravity/brain/x/y/z.jsonl` with
  mtime `T+30` and assert `getLatestLogPath('gemini', home)` returns it, and that
  `getLatestLogPath('auto', home)` returns that same Gemini file (T+30 beats the
  Claude session at T+20) — one assertion that proves both the Gemini path and
  the `auto` comparison survived.

Clean the temp home up in `t.after` with `fs.rmSync(dir, { recursive: true, force: true })`.

### 5.6 End to end through the CLI

`execFileSync(process.execPath, [binPath, fixturePath, '--format', 'json'], { encoding: 'utf8' })`
with `binPath = fileURLToPath(new URL('../bin/parse-agent-log.mjs', import.meta.url))`.
Assert it does not throw (that is exit 0), `JSON.parse` the stdout, and check
`tokens.totalTokens === 1110`, `counts.toolCallsTotal === 3`,
`counts.stepCount === 2`. This is acceptance criterion 1, end to end, and it is
the one test that would have caught all three defects at once.

Optionally also run it with `--format all` and assert the run exits 0 and the
markdown mentions `Total Tokens` — cheap proof that the renderers still take
what the parser now produces.

### 5.7 Green bar

`npm --prefix tools/log-parser test` and then `./test.sh` from the repository
root. `./test.sh` is the fact.

## 6. Manual check the implementer should run once (not a test)

Against a real transcript on the machine, to confirm the fix outside the
fixtures — this is a smoke check, and nothing about the machine's own logs may
end up in a test or a fixture:

```
node tools/log-parser/bin/parse-agent-log.mjs --latest --format json
```

Expect exit 0, a path under `~/.claude/projects/<project>/` having been chosen,
and non-zero `totalTokens`, `toolCallsTotal` and `stepCount`.
