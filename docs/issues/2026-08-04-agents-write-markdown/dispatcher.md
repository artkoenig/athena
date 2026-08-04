# Dispatcher Handoff

## Technical Specification
The issue requires us to remove the `tools/handoff/generate.py` script and transition all agents to write their own handoff documents directly in Markdown to the issue directory (e.g. `dispatcher.md`, `implementer.md`, `reviewer.md`). 
While the first iteration successfully removed the script and added instructions for agents to *write* to separate markdown files, it missed crucial references that still tell agents to *read* handoffs from `issue.md` and *append* to it.
We need to update the prompt descriptions and instructions across all agent files in `agents/` to ensure they look for and read separate handoff files (e.g. `reviewer.md`, `test-author.md`, `implementer.md`) instead of expecting them in `issue.md`.

## Module Map
- `agents/dispatcher.md`
- `agents/implementer.md`
- `agents/test-author.md`
- `agents/reviewer.md`

## Next Steps
For the implementer:
1. Update `agents/dispatcher.md` to remove references to writing to/reading from the issue file (e.g., lines 3, 26).
2. Update `agents/implementer.md` to remove references to appending to the issue file and instruct it to read separate handoff files like `test-author.md` (e.g., lines 3, 17).
3. Update `agents/test-author.md` to remove references to appending/reading from the issue file, and instead instruct it to read existing separate handoff files (e.g., lines 3, 14).
4. Update `agents/reviewer.md` to clarify that previous handoffs are in separate markdown files in the issue directory rather than within the issue file itself (e.g., line 16).
5. Ensure that all agents are clearly instructed to read the relevant `.md` files in the issue directory for their context, rather than expecting everything in `issue.md`.
