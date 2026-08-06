# argus shows what the session and each agent hold in their context

## Problem
argus answers what a session cost. It cannot answer what the session was
carrying when it cost that — and it cannot separate the main session from the
subagents that ran inside it at all.

Today every record of a session is folded into one set of totals, split by model
and by tool and by nothing else. A run in which four subagents each carried
their own context looks like a single number. The two questions a human actually
asks in front of that number — "how full was the context when this happened" and
"which agent was carrying what" — have no answer in the interface, although the
CLI exports everything needed to give one.

The attributes are already arriving and are already being dropped. `agent.name`
is collected by `attributionOf` in `tools/argus/src/claude.mjs` and displayed
nowhere. `claude_code.api_request_body`, which carries the entire payload sent to
the model, is listed in `EVENT` and aggregated by nothing. Per-model-call token
figures, from which context occupancy follows directly, are summed away into
session totals.

## What the telemetry carries (measured)
Measured against Claude Code 2.1.223 on a real run with one built-in subagent,
with all four content switches on. These are facts to build on, not guesses to
verify.

**Which agent a record belongs to**

| Signal | Attribute | Main session | Subagent |
| --- | --- | --- | --- |
| `claude_code.api_request` event | `agent.name` | absent | `Explore` |
| `claude_code.api_request` event | `query_source` | `sdk` | `agent:builtin:Explore` |
| `claude_code.token.usage` / `cost.usage` metric | `agent.name`, `query_source` | absent, `main` | `Explore`, `subagent` |
| `claude_code.llm_request` span | `agent_id` | absent | `a10f6aaeff1f24fa1` |
| `claude_code.llm_request` span | `llm_request.context` | `interaction` | `tool` |
| `claude_code.tool` span of the Task call | `subagent_type` | `Explore` | – |

`claude_code.subagent_completed` is a further event, not currently known to
`claude.mjs`, carrying `agent_type`, `agent.source`, `is_built_in`, `is_async`,
`model`, `final_model`, `model_swapped`, `total_tokens`, `total_tool_uses` and
`duration_ms`.

**How full a context was**

Every `claude_code.llm_request` span and every `claude_code.api_request` event
carries `input_tokens`, `cache_read_tokens` and `cache_creation_tokens`. Their
sum is the size of the prompt that call was made with, which is that agent's
context occupancy at that moment. The measured run: main session 38.412 then
38.765 tokens, subagent 16.534 then 16.668 — four calls, two agents, two
separate curves.

**What was in it**

`claude_code.api_request_body` carries the whole request payload as a JSON string
in `body`, with `body_length` and `body_truncated` beside it. Parsed, it holds
the `system` blocks, the `tools` array and the full `messages` history of that
call, and it arrives once per agent per call, distinguished by `query_source`.

The CLI truncates that string at 61440 bytes. In the measured run the two
subagent bodies (46.813 and 47.259 bytes) arrived whole and parsed; both main
session bodies were cut from 110.141 and 111.365 bytes down to 61.440 and are not
valid JSON as delivered. `body_length` still states the real size.

The narrower content attributes are `prompt` on `claude_code.user_prompt`,
`response` on `claude_code.assistant_response`, and `tool_input`,
`tool_parameters`, `tool_input_size_bytes` and `tool_result_size_bytes` on
`claude_code.tool_result`. No tool result content was exported by any switch in
the measured run — the size is there, the text is not.

**Which switch each of those needs**

`OTEL_LOG_USER_PROMPTS` for the prompt text, `OTEL_LOG_TOOL_DETAILS` for tool
arguments, `OTEL_LOG_TOOL_CONTENT` for tool content, `OTEL_LOG_RAW_API_BODIES`
for the request and response bodies. `argus env` sets none of them.

Reproduce by starting a collector, exporting the four switches together with the
`argus env` block, and running a session that launches a subagent.

## Acceptance criteria
- [ ] `tools/argus` aggregates each session per agent, where an agent is the main session plus every subagent that ran inside it.
- [ ] The agent a record belongs to is resolved from the attributes listed above, and a record naming no agent counts as the main session rather than as an unknown one.
- [ ] Each agent carries a context occupancy series with one entry per model call, where occupancy is that call's `input_tokens + cache_read_tokens + cache_creation_tokens`.
- [ ] Each agent reports its peak occupancy, its last occupancy, and how much of its last prompt was cached prefix rather than newly written.
- [ ] Each agent reports its own tokens, cost, model or models, tool calls and wall time, so the session total can be read as the sum of its agents.
- [ ] A subagent additionally reports what `claude_code.subagent_completed` states about it, and `claude.mjs` learns that event name.
- [ ] The collector keeps the `claude_code.api_request_body` payload per agent per call and serves it, so the system prompt blocks, the tool definitions and the message history of that call can be read.
- [ ] A payload the CLI truncated is served as truncated, labelled with the real `body_length`, and never parsed into a half object or completed by guesswork.
- [ ] The user prompts, assistant responses and tool calls a session exported are readable per agent in the order they entered that agent's context.
- [ ] Every figure and panel that depends on one of the four `OTEL_LOG_*` switches names the missing switch when it is missing, instead of rendering empty.
- [ ] The collector's JSON API exposes all of the above, and `tools/argus/README.md` documents the routes it adds.
- [ ] `tools/argus-ui` shows it as a view of its own: the agents of the selected session, each with its context curve, its figures and its content, reachable without leaving the session.
- [ ] Request bodies fall under the existing bounded windows and retention, so a long session's memory stays bounded, and `tools/argus/README.md` says what that bound costs in memory.
- [ ] The "Sensitive data" section of `tools/argus/README.md` states that a captured request body contains the entire prompt, including file contents and tool arguments, and that persistence writes it to disk.
- [ ] `skills/argus/SKILL.md` says how to switch content capture on, what it then makes visible, and that it is off by default for that reason.
- [ ] `tools/argus` keeps zero runtime dependencies and `tools/argus-ui` keeps importing nothing from `tools/argus`.
- [ ] `./test.sh` is green.
- [ ] The plugin cache is deleted in the same change (`rm -rf ~/.claude/plugins/cache/uroboros`), because `skills/argus/SKILL.md` is part of it.

## Out of scope
- Recovering context for a session that was measured without the switches. What was not exported does not exist; the view says so and offers nothing else.
- Lifting the CLI's 61440-byte truncation. It happens before the collector sees anything.
- Any change to `argus env`, which keeps setting no content switch.
- A diff between two agents' contexts, or between two calls of one agent.
- Storing bodies outside the process, in a database or a search index.

## Assumptions taken as defaults (no answer from the human)
- The human asked for the content in plain text, so capturing request bodies is the point of this change and not a risk to design around; the change makes the cost explicit in the documentation rather than restricting the capture.
- The interface is `argus-ui`; the collector stays headless, as its `CLAUDE.md` requires.
- Where an existing tab already answers part of this, extending it is preferred over a second place that answers it differently — which of the two applies is the researcher's call.
