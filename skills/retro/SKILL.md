---
name: retro
description: Generates a Retrospective for the current issue by analyzing session JSONL log metrics and inserting "Was lief gut", "Was lief nicht gut", and "Wie können wir den Workflow optimieren" into the issue file under docs/issues/. Use this skill whenever the user asks for a retrospective or "retro" on an issue.
user-invocable: true
---

# Retro Skill

Generates an automated Retrospective for an issue based on JSONL session transcripts.

## Procedure

1. **Determine Context**:
   - Get active branch: `git branch --show-current`
   - Locate matching issue file in `docs/issues/` (or accept explicit issue path/ID).

2. **Parse Transcript & Extract Metrics**:
   - Run helper script:
     ```bash
     python3 skills/retro/assets/parse_transcript.py --branch "<branch_name>"
     ```
   - Receive JSON containing:
     - `metrics`: tool calls count, errors, retry loops, duration.
     - `summary`: recent tool events and error messages.

3. **Synthesize Retrospective**:
   Formulate three concrete, empirical sections based on the parsed transcript:
   - `### Was lief gut`: Successful implementations, clean test runs, quick resolutions.
   - `### Was lief nicht gut`: Command failures, retry loops, missing permissions, unexpected errors.
   - `### Wie können wir den Workflow optimieren`: Actionable improvements to processes, skills, rules, or configurations.

4. **Update Issue File**:
   - Read target `issue.md`.
   - Locate or append `## Retro`.
   - Insert/replace content under `## Retro` with the three subsections:

```markdown
## Retro

### Was lief gut
- [Points]

### Was lief nicht gut
- [Points]

### Wie können wir den Workflow optimieren
- [Points]
```

5. **Report**:
   Confirm to the user that the retrospective has been added/updated in the target issue file.
