# Revert Issue-Verzeichnis von Issues/ auf docs/issues/

## Problem
In einem vorherigen Issue wurde die Ordnerstruktur für Issues von `docs/issues/` nach `Issues/` verschoben. Dies war jedoch ein Fehler und entspricht nicht den Wünschen des Nutzers. Die Issues (inklusive `issue.md` und eventueller Handoff-Dateien) sollen wieder unter `docs/issues/` gespeichert werden.

## Akzeptanzkriterien
- [ ] Alle im vorherigen Schritt vorgenommenen Pfad-Änderungen in der Dokumentation (z. B. `CLAUDE.md`, `.claude/rules/agents.md`, `docs/agents/issue-tracker.md`, `skills/grill/SKILL.md`, `skills/retro/SKILL.md`) und im Code/in Skripten, die auf `Issues/` verweisen, müssen zurück auf `docs/issues/` (bzw. `docs/issues/<timestamp>-<slug>/`) geändert werden.
- [ ] Das Skript `tools/handoff/generate.py` (und seine Tests) muss so angepasst werden, dass es Handoff-Dateien wieder unter `docs/issues/` (bzw. dem jeweiligen Issue-Ordner darin) ablegt oder verarbeitet.
- [ ] Bereits nach `Issues/` verschobene oder dort neu erstellte Verzeichnisse (wie `2026-08-04-agent-handoff-pydantic` und `2026-08-04-log-parser-subagent-breakdown`) sollen nach `docs/issues/` verschoben werden. Das Verzeichnis `Issues/` am Root-Level soll gelöscht werden, falls es leer ist.

## Handoff Dispatcher
### Technical Specification
The task requires reverting the project's issue directory convention back to `docs/issues/` from `Issues/`.

**Module Map & Changes**:
- **Documentation (`CLAUDE.md`, `.claude/rules/agents.md`, `docs/agents/issue-tracker.md`)**: Update all mentions of `Issues/` back to `docs/issues/`.
- **Skills (`skills/grill/SKILL.md`, `skills/retro/SKILL.md`)**: Update instructions to reference `docs/issues/`.
- **Agent Prompts (`agents/dispatcher.md`, `agents/implementer.md`, `agents/reviewer.md`, `agents/test-author.md`)**: Change git commands from `git add Issues/` to `git add docs/issues/`.
- **Tools (`tools/handoff/generate.py`)**: Update `get_issue_directory()` to hardcode `docs/issues/` and remove any logic related to the `Issues/` root folder. 
- **Tests (`tools/handoff/test/test_generate.py`)**: While not explicitly testing paths currently due to mocking, ensure no assertions exist asserting `Issues/`.
- **File System Operations**: 
  - Move the following directories from `Issues/` to `docs/issues/`:
    - `Issues/2026-08-04-agent-handoff-pydantic`
    - `Issues/2026-08-04-log-parser-subagent-breakdown`
  - Remove the empty `Issues/` directory at the project root.

### Next Step
Dispatching the `implementer` subagent to apply the changes as there are no new functional tests required beyond standard refactoring.
