# Agent Handoff auf strukturiertes JSON (Pydantic) umstellen

## Zusammenfassung
Der Agent-Handoff-Prozess wurde überarbeitet. Die `issue.md` dient nun nur noch als kurze Zusammenfassung für den Menschen. Die eigentliche technische Übergabe zwischen Agenten erfolgt über dedizierte, strukturierte JSON-Handoff-Dateien im jeweiligen Issue-Verzeichnis. Jeder Agent nutzt dafür ein eigenes Pydantic-Modell, das über das Skript `tools/handoff/generate.py` via LLM Structured Outputs befüllt wird.

