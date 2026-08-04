# Externe API-Aufrufe aus Handoff-Generierung entfernen

## Problem
Das Skript `tools/handoff/generate.py` versucht derzeit, einen LLM-API-Aufruf (Gemini) zu nutzen, um aus Text ein strukturiertes JSON-Handoff zu generieren. Da externe API-Aufrufe fehlschlagen, funktioniert dieser Prozess nicht. 

## Akzeptanzkriterien
- [ ] Externe API-Abhängigkeiten (z.B. `google-genai`) und API-Aufrufe werden vollständig aus `tools/handoff/generate.py` und der Code-Basis entfernt.
- [ ] Das Skript `tools/handoff/generate.py` wird so umgebaut, dass es das JSON-Handoff entweder als Kommandozeilenargument oder aus einer Datei entgegennimmt.
- [ ] Das Skript validiert das erhaltene JSON lediglich gegen die Pydantic-Modelle und speichert es mit der korrekten Versionierung im passenden Issue-Ordner.
- [ ] Die Agenten-Prompts (unter `agents/`) werden so angepasst, dass die Agenten das JSON-Handoff selbst strukturieren und es an das angepasste Validierungsskript übergeben.
- [ ] Die Tests für `generate.py` werden entsprechend angepasst, sodass keine API-Aufrufe (auch keine gemockten) mehr vorkommen.

## Handoff Dispatcher
*(Wird vom Dispatcher ausgefüllt)*

**Module Map & Technical Specification**

1. `tools/handoff/generate.py`:
   - Remove `google.genai` import and any external API calls.
   - Update argparse to remove `--context` and add `--json-data` which can either be a raw JSON string or a file path containing JSON.
   - Parse the JSON and validate it using the corresponding Pydantic model (`model_class.model_validate(...)`).
   - Save the validated JSON to the issue directory using the existing versioning logic.

2. `agents/dispatcher.md`, `agents/implementer.md`, `agents/reviewer.md`, `agents/test-author.md`:
   - Modify the instructions to require the agents to structure the handoff as JSON matching the Pydantic models in `tools/handoff/models.py`.
   - Update the example CLI invocation to use `--json-data` with the JSON.

3. `tools/handoff/test/test_generate.py`:
   - Remove `TEST_MOCK_API` and `google.genai` mocks.
   - Refactor `test_cli_execution` and `test_structured_output_configuration` to pass valid JSON strings instead of free-form text.
   - Assert that the validation passes correctly and that invalid JSON or missing fields raise appropriate errors or exit codes.

**Next Steps**
The task requires changes to the test suite (`test_generate.py`). I will dispatch the `test-author`.
