---
name: retro
description: Generate a structured English session retrospective from Claude Code or Gemini/Antigravity log files and append it to the active issue document (docs/issues/<issue>/issue.md).
user-invocable: true
---

# Retro Skill

Generate a structured English session retrospective for an issue based on Claude Code or Gemini/Antigravity session logs.

## Instructions

When invoked to run a retro for an issue, follow these steps:

1. **Locate the session log file:**
   Identify the log file to parse (either via an explicit path parameter or by running `bin/parse-agent-log --latest`).

2. **Extract data:**
   Execute `bin/parse-agent-log <path> --format all` to extract quantitative metrics (tokens, tool calls, errors, thinking blocks) and the transcript markdown.

3. **Synthesize the English Retro:**
   Analyze the parsed data and transcript to synthesize a retrospective answering:
   - **What went well**
   - **What didn't go well** (e.g., high token usage, unnecessary tool calls, errors, loops)
   - **What can be optimized**
   Include a **Session Metrics Summary** table presenting the extracted metrics.

4. **Append the formatted section:**
   Append the formatted Retrospective section directly under the `## Retro` heading in the active issue document at `docs/issues/<issue>/issue.md`.

