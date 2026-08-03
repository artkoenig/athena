Status: resolved
Type: feature
Blocked by: None

## Description
# PRD: Skill `retro` for Automated Issue Retrospectives

## Overview
The `retro` skill analyzes Claude/Antigravity JSONL session transcripts (inspired by `claude-JSONL-browser`) for a given Git branch / issue context. It evaluates tool executions, errors, retries, and timing, and generates a structured Retrospective in the corresponding issue file under `docs/issues/`.

## Domain Model & Seams
- **Transcript Parser (`skills/retro/assets/parse_transcript.py`)**: Locates current JSONL session log, filters entries relevant to the active branch, and aggregates execution metrics (tool counts, errors, loop detections, durations).
- **Skill Engine (`skills/retro/SKILL.md`)**: Invokes parser, feeds metrics and transcript summaries into retro generation, and updates `## Retro` section in the target issue file.
- **Target Issue**: Identified via active Git branch (`issue/<slug>`) or explicit issue ID.

## Requirements
1. **JSONL Transcript Parsing**:
   - Locate active conversation transcript from Antigravity/Claude storage.
   - Filter transcript events based on the target branch context (handling multi-issue sessions).
   - Aggregate key metrics: total tool calls, failed commands/edits, recurring errors, session duration.
2. **Retrospective Generation**:
   - Synthesize qualitative and quantitative findings into three mandatory sections:
     - `### Was lief gut`
     - `### Was lief nicht gut`
     - `### Wie können wir den Workflow optimieren`
3. **Issue Integration**:
   - Locate issue file in `docs/issues/`.
   - Update or append the `## Retro` section cleanly without overwriting other issue content.

## Acceptance Criteria
- [x] Skill created in `skills/retro/SKILL.md` with required frontmatter (`name: retro`, `description`, `user-invocable: true`).
- [x] Python script `skills/retro/assets/parse_transcript.py` parses JSONL logs and filters by branch/issue context.
- [x] Skill identifies active issue from current Git branch or argument.
- [x] Skill updates/inserts `## Retro` section in target issue file with the three required subsections.

## Comments
- Implemented retro skill and parse_transcript.py. Tested parse_transcript.py script successfully.

## Retro

### Was lief gut
- Präzise Anforderungen durch den `grill-me-for-spec`-Workflow definiert und durch `solution-architect` + `clean-room-reviewer` abgesichert.
- Der Python-Parser (`parse_transcript.py`) verarbeitet JSONL-Transkripte streaming-basiert, fehlertolerant und filtert Events/Metriken nach Git-Branch.
- Der Skill `skills/retro/SKILL.md` wurde erfolgreich angelegt und die Issue-Struktur wurde eingehalten.

### Was lief nicht gut
- `git status` schlug in der Standard-Sandbox fehl und erforderte `BypassSandbox: true`.
- Der Befehl `tracker.py claim` existiert nicht als eigener CLI-Subcommand (wurde durch `tracker.py set-status ... claimed` ersetzt).

### Wie können wir den Workflow optimieren
- Dokumentation in `issue-tracker` bezüglich `claim` vs. `set-status <id> claimed` schärfen.
- CLI-Handling für `parse_transcript.py` bei Multi-Branch-Sessions weiter feintunen.
