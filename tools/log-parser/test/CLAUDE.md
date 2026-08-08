# tools/log-parser/test

`node:test` suite for the transcript parser: two test files, each one top-level `test(...)` with `await t.test(...)` subtests, plus hand-written fixture transcripts under `fixtures/`.

## What each file covers

- `parser.test.mjs` — the original end-to-end pass on flat-shape fixtures: `detectLogFormat` for both formats, `parseClaudeLog` and `parseGeminiLog` incl. following an `invoke_subagent` result to a subagent transcript, `normalizeSession` plus both renderers.
- `claude-code.test.mjs` — the real Claude Code transcript shape: envelope lines (`queue-operation`, `attachment`), payloads nested under `message`, one API response split over lines sharing a `message.id` and `usage` (counted once), detection past byte 4096, `is_error` tool failures, the flat-shape regression, `getLatestLogPath` against a fake home dir, and the CLI (`--format json` / `--format all`).

## Fixtures and helpers

- `fixtures/claude-sample.jsonl` — flat-shape Claude transcript template; `{{CLAUDE_SUBAGENT_PATH}}` is filled in `t.before` into a temp copy before use.
- `fixtures/claude-subagent.jsonl` — two-line flat subagent transcript both suites link to via `file://` from an `invoke_subagent` tool_result.
- `fixtures/gemini-sample.jsonl`, `fixtures/gemini-subagent.jsonl` — the same pair in Gemini shape (`USER_INPUT` / `PLANNER_RESPONSE` / `TOOL_RESPONSE`), placeholder `{{GEMINI_SUBAGENT_PATH}}`.
- `fixtures/claude-code-session.jsonl` — the realistic nested transcript: opens with `queue-operation` and a huge `attachment` line pushing the first `"role"` past byte 4096 (a fixture-guard subtest enforces this), 2 turns, 3 tool calls (one `is_error:true`), `msg_1`/`msg_3` each split over two lines. Usage sums to 111/222/333/444, total 1110 — the constants `TOTAL_TOKENS_RAW`, `TOTAL_TOKENS_RENDERED` (via `toLocaleString()`, matching the renderer), `TOTAL_TOKENS_ROW`, and `JSON_SEPARATOR` in `claude-code.test.mjs` encode this.
- `fixtures/claude-code-toolpath.jsonl` — nested transcript whose Read tool_result mentions an existing `.jsonl` path (`{{EXISTING_JSONL_PATH}}`); proves only `invoke_subagent` results are followed as subagent transcripts.
- `writeLines(filePath, lines)` in `claude-code.test.mjs` — writes an array of objects/strings as a jsonl file.
- Scratch files: `claude-code.test.mjs` builds a `mkdtempSync` scratch dir in `t.before` and removes it in `t.after`; `parser.test.mjs` writes `*.tmp.jsonl` next to the fixtures and unlinks them in `t.after`. `getLatestLogPath` tests build a throwaway home tree (`.claude/projects/...`) with `fs.utimesSync`-controlled mtimes and pass it as the `homeDir` argument.

## Where a new case goes

- Gemini or cross-format basics → `parser.test.mjs`.
- Anything about the real Claude Code shape, detection, `--latest`, or the CLI → `claude-code.test.mjs`, under the matching `// AC:` banner section. Sections follow the pipeline: fixture guard, detection, nested parsing/metrics, flat-shape regression, `getLatestLogPath`, CLI, renderers. Add the subtest inside the section it belongs to, templating any fixture in `t.before`.

## Naming

- `claude-code.test.mjs`: `'<subject>: <behavior as a prose claim>'` — e.g. `'detectLogFormat: an empty file is unknown and does not throw'`, `'metrics: all four usage fields, counted once per message id'`. Special prefixes in use: `fixture guard:`, `regression:`, `CLI:`.
- `parser.test.mjs`: bare function names — `'detectLogFormat'`, `'parseClaudeLog'`, `'normalizeSession and renderers'`.

## Real vs. faked

No mocks or stubs. All transcripts are synthetic, hand-written jsonl on disk; the modules in `../src/` are imported and run for real, and the CLI tests spawn `bin/parse-agent-log.mjs` as a child process with `execFileSync(process.execPath, ...)` — a non-zero exit fails the test by throwing. Only the home directory is faked, via `getLatestLogPath`'s explicit `homeDir` parameter; nothing touches the real `~/.claude`.

## Running

From the repository root: `npm --prefix tools/log-parser test` (runs `node --test`, which picks up both `test/*.test.mjs` files).
