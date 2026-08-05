# `parse-agent-log` cannot read Claude Code session logs

## Problem
The retro tool cannot read the logs it exists for. Running the retro for
`docs/issues/2026-08-05-argus-version-flag` failed three times in a row, and
every number in that retro had to be produced by a throwaway script instead.

Three independent defects, all reproducible against a real Claude Code
transcript at `~/.claude/projects/<project-dir>/<session-id>.jsonl`:

1. `--latest` reported `Log file not found`. `getLatestLogPath` in
   `tools/log-parser/src/detector.mjs` walks `~/.claude`, and the transcript is
   inside it, so the search itself is the thing to check.
2. Given the path explicitly, `detectLogFormat` returned `unknown`, so the run
   died with `Unknown log format`. It inspects only the first 4096 bytes
   (`detector.mjs:59-60`), and a real transcript opens with `queue-operation`
   and `attachment` lines — no message line falls inside that window.
3. Forced past detection, `parseClaudeLog` extracted zeros: zero tokens, zero
   tool calls, zero turns. It reads `obj.role` and `obj.usage`
   (`claude-parser.mjs:24-48`), but Claude Code nests both under `obj.message`
   (`{"type":"assistant","message":{"role":...,"usage":...,"content":[...]}}`).

Subagent transcripts under `<project-dir>/subagents/` and
`<project-dir>/subagents/workflows/<run-id>/` use the same nested shape and are
the per-agent breakdown a retro needs.

## Acceptance criteria
- [ ] `bin/parse-agent-log <path-to-a-claude-code-transcript>` exits 0 and reports non-zero token counts, tool calls and turns for a transcript that contains them.
- [ ] Token counts come from `message.usage` and cover all four fields: `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`.
- [ ] Tool calls are counted per tool name from `tool_use` blocks; failed calls are counted from `tool_result` blocks carrying `is_error`.
- [ ] The log format is detected correctly even when no message line appears in the first 4096 bytes — a transcript starting with `queue-operation` and `attachment` lines must be detected as `claude`.
- [ ] `--latest` finds the newest Claude Code session transcript under `~/.claude/projects/`.
- [ ] The old top-level shape (`obj.role` / `obj.usage`) keeps working — whichever shape a line uses, it is counted.
- [ ] The Gemini/Antigravity path is not broken by these changes.
- [ ] Tests in `tools/log-parser` cover: the nested shape, the detection window, and a transcript whose first lines are `queue-operation`. Fixtures are checked in, small, and contain no real session content beyond what the test needs.
- [ ] `./test.sh` is green.

## Out of scope
- Per-agent aggregation across a workflow's subagent directory. Worth having, but it is its own issue.
- The shape or wording of the retro document.

## Assumptions taken as defaults (no answer from the human)
- Existing CLI flags and output formats stay as they are; this issue fixes reading, not reporting.
- Where the two shapes disagree, the nested `message` shape wins.
