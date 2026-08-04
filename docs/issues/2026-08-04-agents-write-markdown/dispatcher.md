# Dispatcher Handoff

## Technical Specification
The goal is to eliminate the intermediate JSON generation and the `tools/handoff/generate.py` script for agent handoffs. Instead, agents will write their handoffs directly as Markdown files into the respective issue directory.

1. **Remove Old Tools and Tests**:
   - Delete `tools/handoff/generate.py`.
   - Delete `tools/handoff/models.py`.
   - Delete the entire `tools/handoff/test/` directory, removing all unit tests related to the JSON generation and models.

2. **Update Agent Prompts**:
   - `agents/dispatcher.md`: Update instructions to write a `dispatcher.md` (or `dispatcher-v<X>.md`) file directly into the issue directory. The file should include a Technical Specification, Module Map, and Next Steps. Remove all references to JSON and `tools/handoff/generate.py`. Update git commit instructions to commit the new markdown file.
   - `agents/implementer.md`: Update instructions to write an `implementer.md` file directly into the issue directory. The file should include Changes Made, Files Modified, and Test Results. Remove references to JSON and the python script. Update commit instructions.
   - `agents/reviewer.md`: Update instructions to write a `reviewer.md` file directly into the issue directory. The file should include Review Status and Findings. Remove references to JSON and the python script. Update commit instructions.
   - `agents/test-author.md`: Update instructions to write a `test-author.md` file directly into the issue directory. The file should include Test Plan and Coverage Requirements. Remove references to JSON and the python script. Update commit instructions.

## Module Map
- **Files to be deleted**:
  - `tools/handoff/generate.py`: The script that generates handoff files from JSON.
  - `tools/handoff/models.py`: Pydantic models for handoff schemas.
  - `tools/handoff/test/test_generate.py`: Tests for `generate.py`.
  - `tools/handoff/test/test_models.py`: Tests for `models.py`.
  - `tools/handoff/test/test_prompts.py`: Tests related to agent prompts and handoffs.

- **Files to be modified**:
  - `agents/dispatcher.md`: Dispatcher agent prompt.
  - `agents/implementer.md`: Implementer agent prompt.
  - `agents/reviewer.md`: Reviewer agent prompt.
  - `agents/test-author.md`: Test-Author agent prompt.

## Next Steps
Dispatch the **implementer** subagent to execute the changes. The implementer should first delete the `tools/handoff` scripts and tests, then update the 4 agent prompt markdown files in `agents/` to reflect the new direct-markdown workflow.
