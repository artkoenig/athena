# Subagent-Metriken im Log-Parser aufschlüsseln

## Problem
Derzeit fasst das Skript `bin/parse-agent-log` (implementiert in `tools/log-parser`) alle Metriken von Subagenten unter einem generischen Schlüssel `subagent` im `agentBreakdown` der JSON-Ausgabe zusammen. Das erschwert die Retrospektive, da man nicht mehr erkennen kann, welcher spezifische Subagent (z. B. `dispatcher`, `implementer`, `reviewer`) wie viele Tokens, Tool-Aufrufe oder Fehler produziert hat.

## Akzeptanzkriterien
- [ ] Der Log-Parser extrahiert bei Subagenten-Aufrufen (z.B. aus dem `invoke_subagent` Tool Call oder den Transkript-Metadaten) die spezifische Rolle (z.B. `TypeName` oder `Role`).
- [ ] In der JSON-Ausgabe unter `agentBreakdown` werden die Subagenten nicht mehr nur als `subagent` summiert, sondern separat nach ihrer Rolle gelistet (z. B. `dispatcher`, `implementer`).
- [ ] Die Markdown-Ausgabe (Tabelle "Per-Agent Breakdown") spiegelt diese separate Aufschlüsselung ebenfalls wider.
- [ ] Vorhandene Tests im `tools/log-parser`-Modul sind entsprechend angepasst oder erweitert.

## Handoff Dispatcher
*(Wird vom Dispatcher ausgefüllt)*

### Module Map
- `tools/log-parser/src/claude-parser.mjs`: Parses Claude-format `.jsonl` logs. Entry point for Claude logs. Needs update to locate the original `invoke_subagent` tool call by `tool_use_id` and extract the `TypeName` to pass as the `agentName` when recursively calling `parseClaudeLog`.
- `tools/log-parser/src/gemini-parser.mjs`: Parses Gemini-format `.jsonl` logs. Entry point for Gemini logs. Needs update to add an `agentName` parameter, extract `TypeName` from the `lastCall` if it is `invoke_subagent`, and pass it in recursive calls to identify the subagent role.
- `tools/log-parser/src/metrics.mjs`: Aggregates the metrics. Already supports `turn.agentName`, but relies on the parsers providing the correct role instead of falling back to `'subagent'`.
- `tools/log-parser/test/parser.test.mjs` & fixtures: The test suite. Needs test cases adding a subagent invocation (an `invoke_subagent` tool call followed by a tool result pointing to a `.jsonl` file) to both Claude and Gemini test data to verify the new role-based extraction.

### Technical Specification
1. **Claude Parser (`src/claude-parser.mjs`)**:
   - When handling `tool_result` blocks, iterate backwards through the `turns` array to find the tool call matching `block.tool_use_id`.
   - If the corresponding tool call is `invoke_subagent`, extract the subagent role from `call.input.Subagents[0].TypeName` (or fallback to `'subagent'`).
   - Pass this extracted role as the `agentName` argument when recursively invoking `parseClaudeLog(match[1], visitedPaths, role)`.

2. **Gemini Parser (`src/gemini-parser.mjs`)**:
   - Extend `parseGeminiLog(filePath, visitedPaths = new Set(), agentName = 'main')` to accept an `agentName` parameter. Update `createNewTurn(step, agentName)` to accept and store `agentName` and `isSubagent`.
   - When encountering a subagent log file path in `obj.content` (e.g., during `TOOL_RESPONSE`), check if `lastCall.name === 'invoke_subagent'`.
   - If so, extract the subagent role from `lastCall.input.Subagents[0].TypeName`.
   - Pass this role down into the recursive `parseGeminiLog` call.

3. **Test Updates (`test/`)**:
   - Create mock subagent transcript files (e.g., `claude-subagent.jsonl`, `gemini-subagent.jsonl`) in `test/fixtures/`.
   - Update `claude-sample.jsonl` and `gemini-sample.jsonl` to simulate an `invoke_subagent` tool call (with a specified `TypeName` like `"test-author"`) whose tool response returns `file:///.../-subagent.jsonl`.
   - Update `parser.test.mjs` assertions to check that `metrics.agentBreakdown` keys include the specific subagent roles (e.g., `"test-author"`) rather than just `"subagent"`.
