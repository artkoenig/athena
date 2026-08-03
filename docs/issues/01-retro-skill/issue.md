Status: resolved
Type: feature
Blocked by: None

## Description
# PRD: Skill `retro` for Automated Issue Retrospectives

## Overview
The `retro` skill analyzes Claude/Antigravity JSONL session transcripts (inspired by `claude-JSONL-browser`) for a given Git branch / issue context. It evaluates tool executions, errors, retries, and timing, and generates a structured Retrospective in the corresponding issue file under `docs/issues/`.

## Domain Model & Seams
- **Transcript Parser (`skills/retro/assets/parse_transcript.py`)**: Locates current JSONL session log and subagent logs, filters entries relevant to the active branch, and aggregates execution metrics (tool counts, errors, loop detections, durations).
- **Skill Engine (`skills/retro/SKILL.md`)**: Invokes parser, feeds metrics and transcript summaries into retro generation, and updates `## Retro` section in the target issue file.
- **Target Issue**: Identified via active Git branch (`issue/<slug>`) or explicit issue ID.

## Requirements
1. **JSONL Transcript Parsing**:
   - Locate active conversation transcript and subagent transcripts from Antigravity/Claude storage.
   - Filter transcript events based on the target branch context (handling multi-issue sessions).
   - Aggregate key metrics: total tool calls, failed commands/edits, recurring errors, session duration.
2. **Retrospective Generation**:
   - Synthesize qualitative and quantitative findings into three mandatory English sections:
     - `### What went well`
     - `### What didn't go well`
     - `### How can we optimize the workflow`
3. **Issue Integration**:
   - Locate issue file in `docs/issues/`.
   - Update or append the `## Retro` section cleanly without overwriting other issue content.

## Acceptance Criteria
- [x] Skill created in `skills/retro/SKILL.md` with required frontmatter (`name: retro`, `description`, `user-invocable: true`).
- [x] Python script `skills/retro/assets/parse_transcript.py` parses main and subagent JSONL logs and filters by branch/issue context.
- [x] Skill identifies active issue from current Git branch or argument.
- [x] Skill updates/inserts `## Retro` section in target issue file with the three required English subsections.

## Comments
- Implemented retro skill and parse_transcript.py with subagent log support. Tested script successfully.

## Retro

### What went well
- Precise requirements defined via `grill-me-for-spec` and verified by `solution-architect` and `clean-room-reviewer`.
- `parse_transcript.py` now parses both main session JSONL logs and spawned subagent transcripts recursively.
- The `retro` skill generates English section titles as requested (`What went well`, `What didn't go well`, `How can we optimize the workflow`).

### What didn't go well
- `git status` required sandbox bypass (`BypassSandbox: true`) in early command calls.
- `tracker.py claim` is not a direct CLI subcommand (handled via `tracker.py set-status ... claimed`).

### How can we optimize the workflow
- Update documentation around `tracker.py` CLI status commands.
- Fine-tune subagent ID discovery logic for long-running multi-subagent sessions.
