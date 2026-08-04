# Agent Handoff auf strukturiertes JSON (Pydantic) umstellen

## Problem
Der aktuelle Agent-Handoff-Prozess muss überarbeitet werden. Handoffs sollen als eigenständige Dateien gespeichert werden. Die Issue-Datei soll künftig nur noch als kurze Zusammenfassung für den Menschen dienen, während die eigentliche technische Übergabe zwischen Agenten über dedizierte, strukturierte Handoff-Dateien erfolgt.

## Akzeptanzkriterien
- [ ] Handoffs und die `issue.md` (für den Menschen) werden gemeinsam im Verzeichnis `Issues/<timestamp>-<slug>/` gespeichert.
- [ ] Handoffs werden als eigenständige JSON-Dateien abgelegt.
- [ ] Die Dateinamen der Handoffs werden nach dem Ersteller-Agenten benannt (z. B. `researcher.json`).
- [ ] Bei mehrfachen Aufrufen (Iterationen) desselben Agenten wird der Dateiname versioniert (z. B. `researcher-v1.json`, `researcher-v2.json`).
- [ ] Die Issue-Datei wird so angepasst, dass sie nur noch eine kurze Zusammenfassung für den Menschen enthält.
- [ ] Jeder Agent erhält ein eigenes, noch zu definierendes Pydantic-Modell für sein spezifisches Handoff-Format.
- [ ] Die LLM-API wird so konfiguriert, dass sie dieses strukturierte Format direkt generiert (Structured Outputs).

## Getroffene Entscheidungen
- **Speicherort**: Issue-Ordnerstruktur nach dem Schema `Issues/<timestamp>-<slug>/`, darin liegen die `issue.md` und die zugehörigen Handoff-Dateien.
- **Dateibenennung**: Die Handoff-Dateien werden nach dem Ersteller-Agenten benannt, bei Iterationen mit Versionierung (v1, v2, usw.).
- **Format-Spezifität**: Jeder Agent bekommt sein eigenes Pydantic-Modell.
- **Generierungsmethode**: Nutzung von direkten LLM-API Structured Outputs anstelle von rein interner Validierung eines zurückgegebenen JSON-Strings.


## Handoff Dispatcher

### Module Map
- **`tools/handoff/models.py`**: New file. Defines the Pydantic models for each agent Handoff: `DispatcherHandoff`, `ImplementerHandoff`, `ReviewerHandoff`, `TestAuthorHandoff`.
- **`tools/handoff/generate.py`**: New Python script that agents use to generate their handoff. It calls the LLM API using Pydantic-based Structured Outputs and writes the JSON to `Issues/<timestamp>-<slug>/<agent>-v<N>.json`.
- **`agents/dispatcher.md`, `agents/implementer.md`, `agents/reviewer.md`, `agents/test-author.md`**: Update agent system prompts to instruct them to use the `generate.py` tool instead of appending technical details to `issue.md`.
- **`docs/issues/01-agent-handoff-pydantic/issue.md`**: Will be transformed into just a short human summary, and moved to `Issues/...` per the new structure.

### Technical Specification
1. **Pydantic Models (`tools/handoff/models.py`)**:
   - Define a BaseHandoff schema.
   - `DispatcherHandoff`: fields for `technical_specification`, `module_map`, `next_steps`.
   - `TestAuthorHandoff`: fields for `test_plan`, `coverage_requirements`.
   - `ImplementerHandoff`: fields for `changes_made`, `files_modified`.
   - `ReviewerHandoff`: fields for `status` (approved/rejected), `findings`.
2. **Handoff Generation Tool (`tools/handoff/generate.py`)**:
   - A CLI script invoked by agents (e.g. `python3 tools/handoff/generate.py --agent dispatcher --context "..."`).
   - Uses the LLM client configured with Structured Outputs (passing the correct Pydantic model schema).
   - Dynamically resolves the issue directory `Issues/<timestamp>-<slug>/` and handles versioning (v1, v2) by checking existing files.
   - Saves the generated JSON output directly to the file.
3. **Agent Prompts (`agents/*.md`)**:
   - Remove instructions that tell agents to modify `issue.md` directly.
   - Add instructions to invoke `tools/handoff/generate.py` with their findings and decisions.
4. **Issue Directory Restructuring**:
   - Update any scripts creating issues to use the new `Issues/<timestamp>-<slug>/` directory instead of `docs/issues/`.
