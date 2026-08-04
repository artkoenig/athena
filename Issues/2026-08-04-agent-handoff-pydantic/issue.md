# Agent Handoff auf strukturiertes JSON (Pydantic) umstellen

## Zusammenfassung
Der Agent-Handoff-Prozess wurde überarbeitet. Die `issue.md` dient nun nur noch als kurze Zusammenfassung für den Menschen. Die eigentliche technische Übergabe zwischen Agenten erfolgt über dedizierte, strukturierte JSON-Handoff-Dateien im jeweiligen Issue-Verzeichnis. Jeder Agent nutzt dafür ein eigenes Pydantic-Modell, das über das Skript `tools/handoff/generate.py` via LLM Structured Outputs befüllt wird.

## Handoff Implementer
- **Geänderte Dateien**:
  - `tools/handoff/models.py`
  - `tools/handoff/generate.py`
  - `agents/dispatcher.md`
  - `agents/implementer.md`
  - `agents/reviewer.md`
  - `agents/test-author.md`
  - `skills/grill/SKILL.md`
  - `skills/retro/SKILL.md`
  - `Issues/2026-08-04-agent-handoff-pydantic/issue.md` (moved from `docs/issues/01-agent-handoff-pydantic/issue.md`)
- **Tests und Statische Codeanalyse**:
  - `python3 -m unittest discover tools/handoff/test`, Exit Code: 0 (10 Tests ran successfully)
- **Anmerkungen**: Das Issue-Verzeichnis wurde dynamisch auf `Issues/<timestamp>-<slug>` aktualisiert.
