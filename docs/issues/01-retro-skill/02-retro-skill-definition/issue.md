Status: resolved
Type: feature
Blocked by: 01

## Description
Implement the skill definition file `skills/retro/SKILL.md` that orchestrates the execution of `parse_transcript.py`, prompts for synthesis of retro observations, and updates the `## Retro` section in the target issue file under `docs/issues/` with three required subheaders.

## Acceptance Criteria
- [ ] `skills/retro/SKILL.md` created with valid YAML frontmatter (`name: retro`, `description`, `user-invocable: true`).
- [ ] Executes `parse_transcript.py` to obtain metrics and session summary.
- [ ] Synthesizes `### Was lief gut`, `### Was lief nicht gut`, and `### Wie können wir den Workflow optimieren`.
- [ ] Inserts or updates `## Retro` in `docs/issues/<issue_file>.md` without destroying existing issue content.

## Comments
