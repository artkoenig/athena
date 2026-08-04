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
