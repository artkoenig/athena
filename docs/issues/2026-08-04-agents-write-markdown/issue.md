# Direct Markdown Handoffs by Agents

## Kontext
Die Zwischengenerierung von Handoffs via JSON und Hilfsskripten (`tools/handoff/generate.py`) soll komplett entfallen. Die KI-Agenten sollen künftig in der Lage sein, ihre eigenen Handoff-Dateien direkt im Markdown-Format zu erstellen und abzulegen.

## Akzeptanzkriterien
1. Die Skripte und Modelle zur JSON-Generierung (z.B. in `tools/handoff/`) werden vollständig entfernt.
2. Die Prompts aller Agenten in `agents/` (bzw. `.agents/plugins/uroboros/agents/`) werden so angepasst, dass sie direkt Markdown-Handoff-Dateien (z.B. `dispatcher.md`, `dispatcher-v1.md`) in das aktuelle Issue-Verzeichnis schreiben.
3. Eventuell bestehende Unittests, die noch das alte `generate.py`-Skript testen, werden gelöscht oder durch Tests ersetzt, die den neuen Workflow unterstützen.
