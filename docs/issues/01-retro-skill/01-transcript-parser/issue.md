Status: resolved
Type: feature
Blocked by: None

## Description
Implement the Python CLI script `skills/retro/assets/parse_transcript.py` that parses JSONL transcript log files from Antigravity/Claude session directories. It must filter entries by the given Git branch / issue context, aggregate metrics (tool call counts, errors, duration, retry loops), truncate large payloads, and output clean JSON.

## Acceptance Criteria
- [ ] `skills/retro/assets/parse_transcript.py` accepts optional `--transcript <path>` and `--branch <slug>`.
- [ ] Automatically discovers transcript location if `--transcript` is omitted.
- [ ] Streams JSONL lines with error tolerance (skips malformed lines).
- [ ] Filters logs for the requested branch context.
- [ ] Outputs JSON with `metrics` and `summary` (payloads truncated).

## Comments
