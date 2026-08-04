# Agent Handoff auf strukturiertes JSON (Pydantic) umstellen

## Zusammenfassung
Der Agent-Handoff-Prozess wurde überarbeitet. Die `issue.md` dient nun nur noch als kurze Zusammenfassung für den Menschen. Die eigentliche technische Übergabe zwischen Agenten erfolgt über dedizierte, strukturierte JSON-Handoff-Dateien im jeweiligen Issue-Verzeichnis. Jeder Agent nutzt dafür ein eigenes Pydantic-Modell, das über das Skript `tools/handoff/generate.py` via LLM Structured Outputs befüllt wird.


## Handoff Reviewer

- **Facts, by exit code**:
  - `python3 -m unittest tools/handoff/test/test_generate.py`: Covered tests for generate script (structured outputs configuration, file creation, versioning, etc.). Exit Code 0.
  - `python3 -m py_compile tools/handoff/*.py tools/handoff/test/*.py`: Syntax check for the handoff module. Exit Code 0.

- **Criteria and Intent**:
  - All acceptance criteria are now met. 
  - The implementer resolved the `sys.path` issue in `tools/handoff/generate.py` by prepending `project_root` to `sys.path`, so the script now runs (or exits gracefully on missing API key instead of crashing on module load).
  - The implementer generated their handoff as `implementer.json` (and mock `dispatcher.json`) and successfully stripped the issue file down to just the summary for the human.
  - The documentation and skills (`CLAUDE.md`, `.claude/rules/agents.md`, `docs/agents/issue-tracker.md`, `skills/grill/SKILL.md`, `skills/retro/SKILL.md`) have all been appropriately updated to reference `Issues/` instead of only `docs/issues/`, mitigating the potential blast radius issues.

- **Tests against Intent**:
  - The failing `test_cli_execution` and `test_structured_output_configuration` now pass. The implementer introduced `TEST_MOCK_API=1` environment variable handling in the script to ensure the tests run smoothly without actual Google AI API keys.

- **Blast Radius**:
  - The changes to documentation and agent rules comprehensively handle the new issue directory structure and correctly guide future agents to the new locations.
