---
name: retro
description: Generate a structured English session retrospective from Claude Code or Gemini/Antigravity log files and append it to the active issue document (`docs/issues/<timestamp>-<slug>/issue.md`).
user-invocable: true
---

# Retro Skill

Generate a structured English session retrospective for an issue based on Claude Code or Gemini/Antigravity session logs.

## Instructions

When invoked to run a retro for an issue, follow these steps:

1. **Locate the run:**
   Run `bin/parse-agent-log --latest-run` for the workflow run that just finished, or pass the run directory `~/.claude/projects/<project>/<sessionId>/subagents/workflows/<runId>/` explicitly. For a retro of a single session log rather than a workflow run, pass that file's path instead.

2. **Extract data:**
   Execute `bin/parse-agent-log <run-directory> --format all`. The run report carries the run totals, the per-agent-type totals, one row for every agent in the journal's order, a tool breakdown with its failures, and the agents that started without returning. A single session log yields that session's quantitative metrics (tokens, tool calls, errors, thinking blocks) and the transcript markdown.

3. **Synthesize the English Retro:**
   Analyze the parsed data and transcript to synthesize a retrospective answering these 10 core workflow questions across 5 categories in English:

   - **Rulebook & Process Friction**
     - Which process rule or automated hook created disproportionate friction?
     - Where did the agent apply rules too rigidly or incorrectly, causing unnecessary overhead?

   - **Subagent Efficiency & Delegation**
     - Did delegating to subagents conserve context, or was the briefing overhead larger than the gain?
     - Were there redundancies or repeated research between the main conversation and subagent runs?

   A run of either workflow leaves the session log, the issue directory's
   `backlog.json` and the git history, and those are the whole record: no agent
   writes a prose report of its own, so do not go looking for one.

   - **Specification & Planning Quality**
     - Were all critical requirement gaps uncovered upfront during grilling/specifying, or did ambiguities surface late during implementation?
     - Was the architecture plan strictly followed, or were there unauthorized deviations?

   - **Token & Latency Optimization**
     - Where did token spikes, redundant tool loops, or uncompacted outputs occur?
     - How efficient was context cache utilization across steps?

   - **Tooling & Automation Opportunities**
     - Which recurring manual steps should be encapsulated into dedicated CLI tools or scripts?
     - Which errors were caused by missing environment pre-requisites before test execution?

   Take the **Session Metrics Summary** table from the run report's totals and the **Per-Agent Breakdown** table from its agent rows, and add a **Mermaid Sequence Diagram** illustrating the interaction flow between User, Main Agent, Subagents, and Tools/System.

4. **Append the formatted section:**
   Append the formatted Retrospective section directly under the `## Retro` heading in the active issue document (e.g. at `docs/issues/<timestamp>-<slug>/issue.md`).

