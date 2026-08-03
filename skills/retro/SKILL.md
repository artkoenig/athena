---
name: retro
description: Generates a Retrospective for the current issue by analyzing session JSONL log metrics (including subagents) and inserting "What went well", "What didn't go well", and "How can we optimize the workflow" into the issue file under docs/issues/. Use this skill whenever the user asks for a retrospective or "retro" on an issue.
user-invocable: true
---

# Retro Skill

Generates an automated Retrospective for an issue based on main and subagent JSONL session transcripts.

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
     - `metrics`: total tool calls (main + subagents), total errors, retry loops, subagent count.
     - `summary`: recent tool events (labeled by source) and error messages.

3. **Synthesize Retrospective**:
   Formulate three concrete, empirical sections based on the parsed transcript:
   - `### What went well`: Successful implementations, clean test runs, quick resolutions.
   - `### What didn't go well`: Command failures, retry loops, missing permissions, unexpected errors.
   - `### How can we optimize the workflow`: Actionable improvements to processes, skills, rules, or configurations.

4. **Update Issue File**:
   - Read target `issue.md`.
   - Locate or append `## Retro`.
   - Insert/replace content under `## Retro` with the three English subsections:

```markdown
## Retro

### What went well
- [Points]

### What didn't go well
- [Points]

### How can we optimize the workflow
- [Points]
```

5. **Report**:
   Confirm to the user that the retrospective has been added/updated in the target issue file.
