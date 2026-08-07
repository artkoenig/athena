# Researcher handoff — structured prompts replace the handoffs

## Implementation plan

The change replaces one channel with another. Today every agent writes a prose
file into the issue directory and the next agent reads it; after the change
every agent **returns** a structured object, the workflow script injects the
slice the next role needs into its prompt, and every agent **records** its own
return into `docs/issues/<slug>/backlog.json` through a shipped helper. That
file is the only durable run state, and a fresh session resumes from it alone.

### The pieces

1. **`skills/agent-brief/assets/backlog.mjs`** — new, a zero-dependency Node
   CLI. It is the only writer of `backlog.json`. Four subcommands (`init`,
   `record`, `close`, `read`), specified below. It exists so an agent can write
   the file without reading it (the reviewer's blind append) and so the shed
   and the file shape are enforced by code instead of by prose.
2. **`skills/agent-brief/assets/backlog.test.mjs`** — new, its suite, beside it
   as `skills/CLAUDE.md` requires, listed in `test.sh`.
3. **`skills/agent-brief/SKILL.md`** — the "Your handoff" section becomes "Your
   step return": what you return, how you record it, commit it and push it.
4. **`agents/*.md`** (all five) — each page's handoff section becomes its return
   section, naming its fields. The reviewer gains the no-read boundary; the
   planner gains `backlog.json` and the `init`/`close` calls.
5. **`workflows/loop.js`** and **`workflows/agile-loop.js`** — rewritten
   channel: state loader first, planner opens and closes both, structured slices
   injected, recorded steps skipped, publish always re-asserted.
6. **`test-repo.sh`** — the three append-a-section guards fall; guards on the new
   mechanism replace them, driver cases included.
7. **`test.sh`** — one `run` line for the recorder suite.
8. **`README.md`**, **`rulebook.md`**, **`skills/retro/SKILL.md`**,
   **`.claude/rules/agents.md`** — the prose that describes the old channel.

Nothing migrates. Old issue directories keep their prose files; no code reads
them.

### `backlog.json` — the shape

Written by `backlog.mjs` only, pretty-printed with two-space indent and a
trailing newline:

```json
{
  "version": 1,
  "issue": "docs/issues/2026-08-07-example",
  "workflow": "loop",
  "increments": [
    {
      "id": "i1",
      "title": "One line naming what it delivers",
      "goal": "What it delivers, imperative.",
      "criteria": ["..."],
      "status": "todo",
      "note": "",
      "steps": [
        { "label": "research:i1.0", "at": "2026-08-07T09:12:33.001Z", "return": { } }
      ]
    }
  ],
  "run": {
    "steps": [
      { "label": "decompose", "at": "...", "return": { } }
    ]
  }
}
```

- `increments[].steps` holds the full structured return of every step of that
  increment — the channel payload and the resume anchor at once.
- `run.steps` holds the steps that sit between increments or outside them:
  `decompose`, `replan:<id>` / `close:<id>`, `publish`.
- Closing an increment empties its `steps` (the shed). The record of a closed
  increment is its status, its note, its criteria and the git history.
- `load-state` is never recorded — it is the read that opens a run.

### Step labels

Labels are the resume key, so they are derived from data that survives a
session: the increment **id** (never the ordinal, which a re-cut moves) and the
round number.

| Step | Label | Recorded under |
| --- | --- | --- |
| state loader | `load-state` | not recorded |
| planner, opening call | `decompose` | `run.steps` |
| researcher | `research:<id>.<round>` | increment `<id>` |
| test-author | `tests:<id>.<round>` | increment `<id>` |
| implementer | `implement:<id>.<round>` | increment `<id>` |
| reviewer | `review:<id>.<round>` | increment `<id>` |
| planner, closing call | `close:<id>` (loop) / `replan:<id>` (agile-loop) | `run.steps` |
| publish | `publish` | `run.steps` |

### The return schemas

The brevity discipline lives in the field descriptions — the implementer writes
them out in full, in the wording below or tighter.

`STATE` (state loader, `general-purpose`):

```js
{ exists: boolean,        // True only when backlog.json exists and you read it.
  backlogJson: string,    // The exact content of backlog.json, byte for byte. Empty string when it does not exist.
  summary: string }
```

`BACKLOG` (planner):

```js
{ increments: [ { id, title, goal, criteria: [string], status: 'todo'|'done'|'blocked'|'dropped', note } ],
  questions: [string],
  summary: string }
```

`loop.js` uses the same schema with `minItems: 1, maxItems: 1` on `increments`.
`backlogFile` and `handoffFile` are gone from it.

`PLAN` (researcher):

```js
{ needsTests: boolean,
  plan: string,        // The implementation plan: what gets built and the decisions behind it, the rejected ones included.
  moduleMap: string,   // The files the change touches: path, what each holds, the entry points. One line per file.
  environment: string, // Every command the test plan asks anyone to run, with its prerequisites. "There is no linter" is an answer.
  testPlan: string,    // The whole work order for the test-author and the only thing it is given: per case the criterion it
                       // proves, input, state, expected result, the level, the test file by path, the framework, the
                       // conventions of that file, and the command that runs just it. Name what you leave untested and why.
  checks: [string],    // The closed list of commands, verbatim, runnable from the repo root, whose exit codes judge the work.
  questions: [string], // Decisions only the human can make, each answerable without opening a file. Non-empty ends the run.
  summary: string }
```

`TESTS` (test-author):

```js
{ cases: [ { case,        // The planned case in the plan's words, one line.
             file,        // Test file by path. Empty when you did not write it.
             testName,    // The test's name. Empty when you did not write it.
             expected,    // What the case demands, one line.
             got } ],     // The failure it produced, one line — or why you did not write it.
  openQuestions: [string], // Gaps and conflicts in the test plan, one line each. The next research round picks them up.
  questions: [string],
  summary: string }
```

`BUILD` (implementer):

```js
{ deviations: [string],  // Every place you built something other than what the plan named: what it said, what you did, why.
  commands: [ { command, exitCode: integer, note } ],
  blockers: [string],
  questions: [string],
  summary: string }
```

`VERDICT` (reviewer):

```js
{ findings: [ { claim,         // What is wrong, one line.
                reproduction,  // These inputs or this state, this wrong result, at this file and line.
                criterion } ], // The acceptance criterion it violates, or "none".
  reason: string,   // Why another correction round is needed, in one or two sentences a human reads in the chat. Empty when findings is empty.
  questions: [string],
  summary: string }
```

`findings` changes from an integer to an array: the script triages on
`verdict.findings.length`. `PUSH` is unchanged.

### The slices the workflow injects

Criterion 1 fixes who gets what, and the driver cases below pin it:

- **test-author** — `plan.testPlan`, and nothing else from the plan.
- **implementer** — `plan.plan`, `plan.moduleMap`, `plan.environment`,
  `plan.checks`, plus the test-author's `cases` as a one-line-per-case table and
  its `openQuestions`. Not `plan.testPlan`.
- **reviewer** — `plan.checks` alone, exactly as `checkList()` builds it today.
- **researcher, correction round** — the reviewer's `findings` as
  claim/reproduction/criterion, plus the test-author's `openQuestions` from the
  round before.
- **planner, closing call** — the increment's id and title, the verdict's
  `findings.length` and `reason`. It reads `backlog.json` itself.

### Resume

Every run opens with a `general-purpose` dispatch labelled `load-state`:

```
Issue directory: <dir>
Read <dir>/backlog.json and return it. Run
`node "<the agent-brief skill's assets>/backlog.mjs" read <dir>/backlog.json` if you
prefer; either way return its exact content in backlogJson and exists true.
If the file does not exist, return exists false and backlogJson "".
Read nothing else, change nothing, run no git command, and do not dispatch any subagent.
```

The script parses `backlogJson` in a `try`/`catch` — a parse failure logs and is
treated as no state — and builds `recorded: Map<label, return>` from
`run.steps` and every increment's `steps`. Every dispatch goes through one
wrapper:

```js
async function step(label, phaseName, run) {
  if (recorded.has(label)) { log(`${label}: recorded already, skipping`); return recorded.get(label) }
  phase(phaseName)
  const out = await run()
  recorded.set(label, out)
  return out
}
```

That is the whole of resume: a recorded step returns its stored payload and is
never re-dispatched, and the step in flight when the session died is not
recorded, so it repeats. `publish` is the one exception — it is dispatched every
time, recorded or not, because criterion 5 asks a finished run to re-assert it.

Consequences the implementer must honour:

- An increment whose `status` is not `todo` is never worked, so the shed of its
  steps costs the resume nothing.
- The round number resumes from the labels: round `r` is worked only if
  `review:<id>.<r>` is not recorded.
- `MAX_BLOCKED` is derived from `increments.filter(i => i.status === 'blocked')`
  so it survives a restart. `MAX_ATTEMPTS` stays session-local — after the shed
  nothing in the file counts attempts, and a restart granting one more attempt
  is cheaper than a second counter in the state. Say so in a comment.

### Push per step

The script runs no command, so the agent that commits also pushes. The shared
brief's "Commit, never push" becomes "Commit your step, then push it", with the
pull request still the human's gate and `git push` retried up to four times
(2s, 4s, 8s, 16s) and never fatal — a push that fails is a line in the return's
summary, not a stopped step. Every dispatch prompt ends with the same sentence
(the `noDispatch` constant, reworded), so the rule is stated once per workflow.

### The blind append, and how an agent finds the helper

`CLAUDE_PLUGIN_ROOT` is **not** in a subagent's environment (checked: the
variable is absent from this agent's `env`). What *is* in a subagent's context
is the line Claude Code prepends to a preloaded skill —

```
Base directory for this skill: /root/.claude/plugins/cache/uroboros/uroboros/<sha>/skills/agent-brief
```

— and that directory is a full checkout of this repository, so
`<base>/assets/backlog.mjs` resolves in every installing project. The shared
brief therefore says: run the helper from the `assets/` directory of the
`agent-brief` skill whose base directory your context names, and if no such line
is there, find it with
`find "$HOME/.claude/plugins" -path '*agent-brief/assets/backlog.mjs' | head -1`.

The reviewer records its step with `backlog.mjs record`, which prints one
confirmation line and never the file, so recording hands it nothing about the
plan. Its page forbids reading `backlog.json`, and its diff judgment excludes
that file the way it excludes the handoff files today.

### A question for the human

Any return whose `questions` is non-empty ends the run: the script logs the
questions, skips to `Publish`, and returns them as `blockedOnHuman` alongside
what ran. The question is in `backlog.json` already, inside the step return the
agent recorded, so the session that resumes finds it. The rulebook tells the
session to put the questions to the human, record the answers under
`## Decisions` in `issue.md`, and start the same workflow on the same issue
directory again; the resuming researcher reads them there.

### The plain loop

`loop.js` gets the same mechanism with one increment:

1. `load-state`.
2. `decompose` — the planner, told to write `backlog.json` with **exactly one**
   increment spanning the whole issue, pinned by the prompt and by
   `maxItems: 1`. Its prompt says plainly: do not cut, the loop never re-cuts.
3. The chain, restructured into a single `for (let round = 0; round <=
   MAX_CORRECTIONS; round++)` loop identical in shape to `agile-loop.js`'s (the
   current pre-loop research/tests block disappears), so the two scripts stay
   comparable and one driver guards both.
4. `close:<id>` — the planner, told to set the status the verdict earned and
   shed the step returns, cutting nothing new.
5. `publish`.

The loop hands its agents no increment-scope block: its one increment is the
whole issue, and the shared brief's "where your prompt names no increment, the
issue is the scope, whole" still holds.

### Decisions taken, and what was rejected

- **The agent records, the script never does.** Rejected: a `record` step
  dispatched after each agent (doubles the dispatch count) and the script
  writing the file itself (the workflow runtime gives the script `args`,
  `agent`, `log` and `phase` — no file access, and criterion 5 fixes that).
- **A helper CLI rather than a `node -e` one-liner in each prompt.** The issue's
  own assumption; it also makes the shed, the shape and the idempotent repeat
  testable in a suite instead of hoped for in prose.
- **Labels keyed by increment id, not by ordinal.** A re-cut reorders
  increments, and an ordinal-keyed label would replay the wrong step after a
  restart.
- **One `steps` array per increment plus one for the run**, rather than a single
  flat list with an `increment` field: criterion 4 asks for the step "under the
  increment in flight", and the shed is then a single assignment.
- **`questions` (human, ends the run) and `openQuestions` (test-author, feeds
  the next research round) are two fields.** Criterion 1 asks for the
  test-author's open questions and criterion 9 for the human's; ending a run
  over a vague test case would be the wrong trade.
- **`MAX_ATTEMPTS` stays session-local**, `MAX_BLOCKED` is derived from the
  statuses. Rejected: a counter in the state, which the shed would have to
  preserve for no benefit a human notices.
- **`publish` always re-runs.** Criterion 5.
- **The `meta` blocks stay as they are.** Their string concatenation is another
  issue's (`2026-08-07-agile-loop-optimizations`); touching it here is scope
  this issue did not give. Adding a phase to `meta.phases` is fine — the array
  is already literal.

## Module map

| Path | What it holds | Entry points / what changes |
| --- | --- | --- |
| `skills/agent-brief/assets/backlog.mjs` | **New.** The only writer of `backlog.json`. | `init`, `record`, `close`, `read`; `process.argv[2]` dispatch; atomic write via `<path>.tmp` + `rename`. |
| `skills/agent-brief/assets/backlog.test.mjs` | **New.** Its suite. | `node --test skills/agent-brief/assets/`. |
| `skills/agent-brief/SKILL.md` | The rules every agent holds. Sections: what always holds, your brief, your tools, reporting a run, your handoff, you do not hand over, check mode, what this is not. | "Commit, never push" (l. 18–21) → commit and push. "Your handoff" (l. 68–94) → "Your step return": the fields your page names, `backlog.mjs record`, commit, push. The append-a-section paragraph and the "reading someone else's file" paragraph go. |
| `agents/researcher.md` | Role, what the handoff contains, the test plan, correction rounds, boundaries, what you return. | Drop "Your handoff file is `researcher.md`" (l. 30–31) and "What the handoff contains" → the `PLAN` fields. Correction rounds: findings arrive **in the prompt**, not from a file. |
| `agents/test-author.md` | Role, how you work, boundaries, handoff. | Step 1 reads `issue.md` and the test plan **in its prompt**; the handoff section becomes the `TESTS` fields. Frontmatter `description` names the return, not the file. |
| `agents/implementer.md` | Role, how you work, boundaries, handoff. | Brief is the injected plan slice; handoff section becomes the `BUILD` fields. |
| `agents/reviewer.md` | Role, what you check, reproduction rule, touch no code, findings file. | Findings file section → the `VERDICT` fields; "except the other agents' handoff files" (l. 53) → "except `backlog.json`"; new boundary: you never read `backlog.json`, you only record into it. |
| `agents/planner.md` | Role, what an increment is, brief, what you may not do, what you write, what you return. | Reads `backlog.json` (via `read`), writes it with `init`, closes with `close`; "Every later call ... read `researcher.md` and `reviewer.md`" (l. 56–58) → what its prompt carries; `planner.md` handoff section goes. |
| `workflows/loop.js` | The plain chain. `meta`, schemas, `checkList`, `handoff`, `section`, `research`, the round loop, publish. | `handoff()`/`section()` deleted; state loader, planner open/close, `step()` wrapper, new schemas, slice builders, per-step record instruction. |
| `workflows/agile-loop.js` | The incremental chain. `meta`, backstops, schemas, `checkList`, `handoff`, `heading`, `section`, `scope`, `baseline`, `research`, `plannerHandoff`, `plan`, the increment loop, publish. | Same, plus `heading()`/`plannerHandoff()` deleted; `scope()` and `baseline()` stay. |
| `test-repo.sh` | Repo facts, `ok`/`no` helpers, sections. | Section "a correction round reuses the handoff it already has" (l. 126–156) is deleted whole and replaced; the `scope.js` heredoc at l. 86–118 is the precedent for the new driver. |
| `test.sh` | Runs every suite. | One `run` line for the recorder suite. |
| `README.md` | The public description. | l. 35 (subgraph label), l. 58–76 (handoff prose), l. 98 and 105–117 (`backlog.md`). |
| `rulebook.md` | The session's rules. | Issue Mode step 4 gains resume and the questions handling; step 5 (l. 52) mentions the findings file. |
| `skills/retro/SKILL.md` | The retro procedure. | One sentence: the retro works from `backlog.json` and the git history; it reads no handoff file. |
| `.claude/rules/agents.md` | Developer-facing rules for `agents/`. | The one phrase "how it writes and commits its handoff" becomes the step return. |

## `backlog.mjs` — the contract the suite pins

`node backlog.mjs <command> ...`. Unknown command, missing argument, unreadable
JSON: exit 2 with a message on stderr and nothing on stdout.

- **`init <backlogPath> <payloadFile>`** — payload is
  `{ issue, workflow, increments: [...] }`. Writes the file in the shape above.
  When the file already exists it **merges**: an increment whose id is in both
  keeps its recorded `steps`, an increment absent from the payload is dropped,
  `run.steps` is preserved untouched. Prints one confirmation line.
- **`record <backlogPath> <incrementId|-> <label> <payloadFile>`** — appends
  `{ label, at: new Date().toISOString(), return: <payload> }` to that
  increment's `steps`, or to `run.steps` when the id is `-`. An entry with the
  same label is **replaced**, not duplicated. Prints `recorded <label>` and
  nothing else — never any part of the file. Exit 1 when the backlog file does
  not exist or the increment id is unknown, leaving the file byte-identical.
- **`close <backlogPath> <incrementId> <status> [note]`** — sets `status` and
  `note` and empties that increment's `steps`. Status outside
  `done|blocked|dropped`, or an unknown id: exit 1, file unchanged. Prints one
  confirmation line.
- **`read <backlogPath>`** — prints the file's exact content on stdout, exit 0.
  Missing file: exit 1, nothing on stdout, a message on stderr.

Every write goes to `<backlogPath>.tmp` and is renamed, so a killed step leaves
either the old file or the new one and never a half-written one, and no `.tmp`
file survives a successful call.

## Environment

- Repository root: `/home/user/uroboros`. `node` is v22.22.2; `npm` is present.
- **There is no linter and no formatter in this repository.** Nothing to run.
- Tests are `node:test` + `node:assert/strict`, zero dependencies, no install
  step. `node --test <dir>` picks up `*.test.mjs` in that directory.
- `./test.sh` runs, in order: `test-repo.sh`, `test-worktree.sh`, and
  `npm test` for `tools/argus`, `tools/argus-ui`, `tools/log-parser`. It exits
  non-zero if any of them does, so it subsumes `./test-repo.sh`.
- `bash test-repo.sh` runs the repository suite alone; it needs `git`, `node`
  and `mktemp`, all present.
- `node --test skills/agent-brief/assets/` runs the new suite alone.
- The agents of *this* run still follow the brief in the installed plugin cache:
  they commit and do **not** push. The push-per-step rule is what this change
  writes into the product, not how this run behaves.

## Test plan

Tests are needed. Two suites carry them: a new behaviour suite for
`backlog.mjs`, and new cases in `test-repo.sh` — greps for the facts that are
textual, and a driver that runs both workflow scripts with stubbed
`agent`/`log`/`phase` for the facts that are behavioural.

### What proves each criterion

**Criterion 1 — structured returns, and the slice per role.** Driver cases
W4–W6 below: the test-author's prompt carries the test plan and not the
implementation plan; the implementer's carries the plan and the checks and not
the test plan; the reviewer's carries the checks and neither. That the schemas
carry the named fields is pinned by the driver too — it feeds canned returns
with exactly those fields and `additionalProperties: false` is not enforced at
run time, so the field *names* are additionally pinned by grep case G8.

**Criterion 2 — no prose handoff.** Grep case G1.

**Criterion 3 — `backlog.json` shape.** Recorder cases R1, R2.

**Criterion 4 — step-level state, every agent writes it.** Recorder cases R3,
R4, R5; grep case G5 (every agent page names the record call).

**Criterion 5 — every step pushed.** Grep case G6 (both workflows and the
shared brief instruct the push). Not otherwise testable: no test in this
repository may run `git push`.

**Criterion 6 — resume.** Driver cases W2 (a recorded step is skipped and the
run starts at the first one it did not record), W3 (a backlog whose increments
are all closed dispatches only the state loader and publish), and recorder case
R4 (a repeated step replaces its own earlier entry rather than duplicating it).

**Criterion 7 — `backlog.json` stays small.** Recorder case R8: `close` empties
that increment's steps and leaves the others alone.

**Criterion 8 — the plain loop runs the same mechanism.** Driver cases W1–W3
are run against `workflows/loop.js` *and* `workflows/agile-loop.js`; grep case
G4 (both dispatch `uroboros:planner`). The one-increment pin is grep case G7.

**Criterion 9 — the reviewer's independence.** Driver case W6 (checks alone in
its prompt); grep case G3 (its page forbids reading `backlog.json` and excludes
it from the diff it judges); recorder case R3 (`record` prints nothing from the
file). That the human still gets the reason sentence is the unchanged `reason`
field, covered by W1's assertion that the reviewer's schema keeps it.

**Criterion 10 — a question ends the run.** Driver case W7.

**Criterion 11 — brief, pages and guards move together.** The whole `test-repo.sh`
section is the criterion; G1–G8 are it.

**Criterion 12 — the suites are green.** The closed list below.

**Left untested, deliberately:** the prose quality of `README.md`,
`rulebook.md`, `skills/retro/SKILL.md` and `.claude/rules/agents.md` beyond
grep G1 — a document reads correctly or it does not, and no exit code decides
that; the push retry/backoff, which no test may exercise; the state loader's
own dispatch, whose prompt is asserted by W1's call sequence but whose reading
of a real file happens in a live run; and the shed's effect on a live agent's
context, which is a cost, not a behaviour.

### The cases

**A. `skills/agent-brief/assets/backlog.test.mjs`** — new file, `node:test` with
`node:assert/strict`, the style of `tools/argus-ui/test/config.test.mjs`: one
`test('a sentence stating the fact', () => { ... })` per case, an assertion
message on anything a reader could misread, and a short comment above a case
whose *reason* is not obvious from its name. No fixtures directory: each case
makes its own directory with
`fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-'))` and writes its payload
files there. Run the CLI with
`execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8' })` and catch
the throw for the non-zero cases (`err.status`, `err.stderr`). Resolve the CLI
with `new URL('./backlog.mjs', import.meta.url)`.

| # | Case | Expected |
| --- | --- | --- |
| R1 | `init` on a path with no file, payload of two increments | exit 0; the file parses; `version`, `issue`, `workflow` are the payload's; each increment carries id, title, goal, criteria, status, note and `steps: []`; `run.steps` is `[]`; the content ends with a newline |
| R2 | `record` a step, then `init` again with a payload that keeps that increment and drops the other and adds a third | the kept increment's `steps` still holds the recorded step, the dropped one is gone, the new one has `steps: []`, `run.steps` is untouched |
| R3 | `record <path> i1 research:i1.0 <payload>` | exit 0; `increments[i1].steps` grows by one entry with `label`, an ISO `at` and the payload under `return`; stdout is one line containing the label and no substring of the file's other content (assert stdout does not contain a marker string that is in the file but not in the payload) |
| R4 | `record` the same label twice with different payloads | one entry for that label, carrying the second payload — the repeated step after a crash |
| R5 | `record <path> - decompose <payload>` | the entry lands in `run.steps`, no increment is touched |
| R6 | `record` with an increment id no increment has | exit 1; a message on stderr; the file byte-identical to before |
| R7 | `record` against a path with no file | exit 1; no file created |
| R8 | `close <path> i1 done "the review accepted it"` after both increments have steps | exit 0; `i1.status` is `done`, `i1.note` is the note, `i1.steps` is `[]`, and `i2.steps` is untouched |
| R9 | `close` with status `finished` | exit 1; the file byte-identical |
| R10 | `read` an existing file | exit 0; stdout is byte-identical to the file |
| R11 | `read` a missing file | exit 1; stdout empty |
| R12 | after a successful `record`, `<path>.tmp` does not exist | the atomic write leaves nothing behind |

Runs with: `node --test skills/agent-brief/assets/`

**B. `test-repo.sh`** — delete the section "a correction round reuses the
handoff it already has" (its three cases and their comments) and add two
sections in the file's own style: an `echo "=== ..."` header, then one `ok`/`no`
line per case, comments explaining *why* the case exists.

Section `=== the run state is the channel, and no prose handoff is left`:

| # | Case | How |
| --- | --- | --- |
| G1 | No prompt, agent page or skill still names a prose handoff file | `grep -nE '(^\|[^/])(researcher\|test-author\|implementer\|reviewer\|planner)\.md\|backlog\.md' workflows/*.js agents/*.md skills/*/SKILL.md rulebook.md README.md` finds nothing. The `[^/]` guard is load-bearing: `README.md` links `agents/researcher.md` as an agent page, which is not a handoff. `.claude/rules/agents.md` is deliberately outside the file set — it names agent pages as examples for whoever writes them |
| G2 | Both workflows carry the state loader and the file it loads | each of `workflows/loop.js`, `workflows/agile-loop.js` contains `backlog.json` and `load-state` |
| G3 | The reviewer never reads the state it writes | `agents/reviewer.md` has a line naming `backlog.json` that also matches `not read\|never read\|without reading`, and a line excluding `backlog.json` from the diff it judges |
| G4 | The planner opens and closes both workflows | both workflow files contain `uroboros:planner` |
| G5 | Every agent records its own step | each of `agents/*.md` contains `backlog.json`, and `skills/agent-brief/SKILL.md` contains `backlog.mjs` |
| G6 | Every step's commit is pushed | `skills/agent-brief/SKILL.md` and both workflow files each contain `push` |
| G7 | The plain loop is pinned to one increment | `workflows/loop.js` contains `maxItems: 1` |
| G8 | The helper ships, parses, and its suite is listed | `skills/agent-brief/assets/backlog.mjs` exists, `node --check` on it exits 0, and `test.sh` names `skills/agent-brief/assets` |

Section `=== a run resumes from the state it recorded`, driven by a heredoc
script written into a `mktemp -d` and removed afterwards — the same pattern the
existing `scope.js` case uses (`test-repo.sh` l. 86–118). The driver loads a
workflow the way the compile check does and runs it with stubs:

```js
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const src = fs.readFileSync(file, 'utf8').replace(/^export const meta =/m, 'const meta =')
const fn = new AsyncFunction('args', 'agent', 'log', 'phase', src)
const calls = []
const stub = async (prompt, opts) => {
  calls.push({ label: opts.label, agentType: opts.agentType, prompt })
  return returnFor(opts.label)
}
const result = await fn({ issueDir: 'docs/issues/x' }, stub, () => {}, () => {})
```

The four parameters are the whole runtime the scripts may use, so the driver
also proves they use nothing else. `returnFor` is keyed on the label's prefix
(`load-state`, `decompose`, `research`, `tests`, `implement`, `review`,
`close`/`replan`, `publish`) and returns canned objects in the schemas above,
with marker strings — `plan: 'PLAN-MARKER'`, `testPlan: 'TESTPLAN-MARKER'`,
`checks: ['echo CHECK-MARKER']` — so a slice assertion is a substring test. The
driver takes the workflow path and a mode as `process.argv`, prints its failures
to stderr and exits non-zero on any; `test-repo.sh` calls it once per mode per
workflow and turns each exit code into one `ok`/`no` line.

| # | Case | Expected |
| --- | --- | --- |
| W1 | Fresh run: the state loader returns `exists: false`; the canned reviewer returns no findings | the labels dispatched, in order, are `load-state`, `decompose`, `research:…0`, `tests:…0`, `implement:…0`, `review:…0`, the closing planner, `publish`; the planner dispatches use `uroboros:planner` and the state loader and publish use `general-purpose` |
| W2 | Resume: the state loader returns a backlog whose one `todo` increment already has `research:<id>.0` and `tests:<id>.0` recorded | neither the researcher nor the test-author is dispatched; the first dispatch after `load-state` is the implementer; the implementer's prompt carries the *recorded* plan's markers, so the stored return really is the channel |
| W3 | Complete: every increment `done` | the only labels dispatched are `load-state` and `publish` |
| W4 | The test-author's slice | its prompt contains `TESTPLAN-MARKER` and not `PLAN-MARKER` |
| W5 | The implementer's slice | its prompt contains `PLAN-MARKER` and `CHECK-MARKER` and not `TESTPLAN-MARKER` |
| W6 | The reviewer's slice | its prompt contains `CHECK-MARKER` and neither `PLAN-MARKER` nor `TESTPLAN-MARKER` |
| W7 | A question for the human | with a researcher return whose `questions` is `['ask the human']`, no test-author, implementer or reviewer is dispatched, `publish` still is, and the returned result carries the question (assert on a `blockedOnHuman` field) |

W1–W3 run against **both** workflow files — that is the divergence guard that
replaces the deleted append-a-section cases. W4–W7 run against `loop.js` alone;
the same slice builders exist in `agile-loop.js`, and running seven cases twice
buys less than it costs. For `agile-loop.js` the canned `decompose` return has
two increments and W1 additionally expects the second increment's chain and a
second `replan:<id>`.

Runs with: `bash test-repo.sh`

### What counts as done

```
./test.sh
```

That is the closed list, and it is one command on purpose: `test.sh` runs
`test-repo.sh` and the new recorder suite and fails if either does, so it
satisfies both halves of criterion 12 in a single exit code, and the three
argus suites it also runs are the cheap price of proving nothing else broke.
Nobody runs anything beyond it. The two per-file commands named above —
`node --test skills/agent-brief/assets/` and `bash test-repo.sh` — are for the
test-author proving its cases red, not for the judgment.

### What is already red

I ran none of it, and no baseline run exists from me. Everything in section A
and the new cases in section B are red until the code is written: the file
`backlog.mjs` does not exist, and the deleted guards currently pass. The rest of
`./test.sh` I have no evidence about either way; whoever runs it first reports
what it says.

Two commands I did run, both to settle facts the plan turns on and neither a
test: `node --version` (v22.22.2, so `node --test <dir>` is available) and `ls`
on `/root/.claude/plugins/cache/uroboros/uroboros/` (the plugin cache is a full
checkout of this repository, which is what makes `<skill base>/assets/` a real
path in an installing project). `env` showed no `CLAUDE_PLUGIN_ROOT`, which is
why the skill base directory is the channel and not that variable.

## Round 1

The reviewer filed five findings. Four of them are defects in the guards
themselves — one guard that can never pass, one that guards the wrong thing,
two suites of driver cases that cover one workflow of two — and one is a real
defect in the recorder: `close` never sheds `run.steps`, so a long run keeps a
full copy of the cut per closed increment. Nothing in the workflow scripts
changes in this round.

### Implementation plan

Five changes, one per finding, in two production files and two test files.

**Finding 1 — the two markers overlap, so the test-author guard can never
pass.** `test-repo.sh`'s driver sets `PLAN_MARKER = 'PLAN-MARKER'` and
`TESTPLAN_MARKER = 'TESTPLAN-MARKER'`, and `'TESTPLAN-MARKER'.includes(
'PLAN-MARKER')` is `true`, so mode `w4`'s "does not carry the implementation
plan" assertion fires against a prompt that carries only the test plan. The fix
is in the driver alone: rename the two constants to strings neither of which
contains the other —

```js
const PLAN_MARKER = 'MARKER-IMPLEMENTATION-PLAN';
const TESTPLAN_MARKER = 'MARKER-TEST-PLAN';
```

— and add a standing assertion at the top of `main()` that the three markers are
pairwise disjoint, so the same class of bug cannot come back silently. Rejected:
asserting on the whole prompt with a regex anchored to the `## Implementation
plan` heading. That pins the prompt's prose instead of its payload, and the
payload is what criterion 1 is about.

**Finding 2 — the planner page still names a handoff.** `agents/planner.md`
line 55 says "Say in your handoff which criterion went where", and the planner
writes no handoff. Change it to name the field that does reach the caller:
"Say in your `summary` which criterion went where." That is the field the page's
own "What you return" section already describes and the `BACKLOG` schema already
carries, so nothing else moves. The guard that let it through matches file
*names*; add a second guard that matches the *word* over the same file set
(`workflows/*.js`, `agents/*.md`, `skills/*/SKILL.md`, `rulebook.md`,
`README.md`). `hand-?off` is the pattern: "hand over", which the shared brief
says twice, must not match. Rejected: widening the existing name guard's regex
to include the word — the two failures read differently and a reader of a red
line deserves to know which of the two it is.

**Finding 3 — nothing fails if the per-step push instruction is deleted.** The
guard is `grep -qi 'push'` over `SKILL.md`, `loop.js` and `agile-loop.js`, and
both scripts contain "push" in the Publish prompt regardless. Replace the two
workflow entries of that loop with a new driver mode `w8` that runs a fresh run
and asserts, for every dispatch that is a recorded step — every call whose label
is neither `load-state` nor `publish` — that its prompt names `backlog.json`,
carries the word `record`, and carries the word `push`. That is behavioural
rather than textual: it fails the moment `, then push the commit` leaves
`noDispatch` in either script, and it does not care how the sentence is worded.
Keep the `SKILL.md` entry of that loop but tighten it from `grep -qi 'push'` to
`grep -q 'push the commit'`, which is the shared brief's own words at line 104
and is not satisfied by the frontmatter description. Rejected: a plain
`grep -q 'push the commit'` over the two scripts — it would pass on a script
that carries the sentence in a comment and hands it to nobody.

**Finding 4 — `agile-loop.js` is unguarded on the slices and on the human-question
exit.** Modes `w4`-`w7` run against `workflows/loop.js` alone. Move them inside
the existing `for wf in ... loop.js ... agile-loop.js` loop, prefix their case
descriptions with `$wf_name` the way `w1`-`w3` already are, and add `w8` there
too. No driver logic needs a branch for this: `contextFor` already returns a
one-increment `decomposeReturn` for `w4`-`w7` whichever workflow is under test,
and the assertions read the prompts by label. Traced against
`workflows/agile-loop.js` by reading it: in `w4` the test-author prompt is
`scope()` plus `plan.testPlan` (no `plan.plan`), in `w5` the implementer prompt
is `plan.plan`, `plan.moduleMap`, `plan.environment`, `casesBlock` and
`checkList` (no `plan.testPlan`), in `w6` the reviewer prompt is `scope()`,
`baseline(1)` — empty for the first increment — and `checkList`, and in `w7` the
research question breaks the round loop, then `if (blockedOnHuman.length) break`
at line 692 leaves the increment loop and the run reaches `publish`, returning
`blockedOnHuman`. So all four pass against `agile-loop.js` once the markers are
disjoint; the test-author reports it if any does not.

**Finding 5 — `run.steps` is never shed.** `close()` in
`skills/agent-brief/assets/backlog.mjs` empties the closed increment's `steps`
and leaves `backlog.run.steps` alone, so every `replan:<id>` return — a whole
`BACKLOG`, the entire cut — survives every later close. Fix in `close()`: after
`increment.steps = []`, walk `backlog.run.steps` and `delete step.return` on
every entry, guarding a backlog that carries no `run` key at all.

Shed the *return*, not the entry. Both workflows rebuild their resume map with
`for (const s of (saved.run && saved.run.steps) || []) recorded.set(s.label,
s.return)` and skip a step on `recorded.has(label)`; `Map.set(k, undefined)`
leaves `has(k)` true, so a `{label, at}` stub still skips its step, while
dropping the entry outright would re-dispatch `decompose` after every close and
hand the planner an unasked-for re-cut. Nothing consumes a shed run-level
return: `decompose`'s payload is only used when `saved.increments` is empty
(`loop.js` line 513, `agile-loop.js` line 545), `asksTheHuman` tolerates
`undefined`, and `agile-loop.js` guards `recut && Array.isArray(recut.increments)`
before using it. Rejected: shedding only the run steps whose label names the
increment being closed — `decompose` is the largest of them and belongs to no
increment, so that fix would leave the biggest payload in place. Rejected:
truncating returns at `init` instead — `close` is where the criterion puts the
shed, and `init` runs on every re-cut including ones that close nothing.

One residue is by design and worth stating: the close's own return is recorded
*after* the shed, so exactly one run-level full return exists at any moment (the
newest close or replan) alongside the in-flight increment's steps. That is the
bounded state the criterion asks for, not the per-increment pile the reviewer
found.

Two page comments move with the code, both in `skills/agent-brief/assets/`
and `agents/`: the header comment of `backlog.mjs` (lines 8-12) and the comment
over `close()` (lines 156-159) both say closing sheds "its step returns" — they
say the run's steps go too. `agents/planner.md`'s `close` bullet (lines 107-110)
says the same and gets the same sentence. `skills/agent-brief/SKILL.md` needs no
change: it never describes `close`.

### Module map

- `test-repo.sh` — the repository's own suite, 37 cases today. Three regions
  change: the push-guard loop (lines 200-209), the driver source heredoc (lines
  250-444: constants at 268-270, `contextFor` at 340-357, the mode branches at
  385-432), and the `run_driver` calls (lines 456-466). One region is added: a
  new word-level handoff guard, next to the existing name-level one at lines
  126-143.
- `skills/agent-brief/assets/backlog.mjs` — the recorder CLI, the only writer of
  `backlog.json`. Entry point `close()` at lines 160-174; header comment at
  lines 8-12.
- `skills/agent-brief/assets/backlog.test.mjs` — the recorder's suite, 12 cases,
  `node:test` + `node:assert/strict`. The close cases sit at lines 195-226.
- `agents/planner.md` — the planner's page. Line 55 (the first-call paragraph)
  and lines 107-110 (the `close` bullet).
- `workflows/loop.js`, `workflows/agile-loop.js` — read only, not edited this
  round. They are what the driver runs.

### Environment

- `node` v22.22.2 is on `PATH`; `node --test` and `node:test` are available.
- `bash` runs every suite. `test.sh` and `test-repo.sh` are **not executable**
  in this checkout (mode `-rw-r--r--`, unchanged from `origin/main`), so they
  are invoked as `bash test.sh` and `bash test-repo.sh`. Do not `chmod` them:
  the mode is a property of the checkout and outside this issue.
- `npm` is needed only by the three `tools/` suites that `test.sh` runs; they
  are zero-install and untouched by this round.
- There is no linter and no formatter in this repository.
- No network access is needed by any command below.

### Test plan

Tests are needed. Two findings need a red test first — finding 2 (the word
`handoff` still in a prompt-bearing page) and finding 5 (`run.steps` never
shed) — and three are repairs to the guards themselves, which the test-author
owns.

#### What proves each finding

**Finding 1.** Mode `w4` against both workflows, once the markers are disjoint.
Proof that the repair is real and not a deleted assertion: the driver's new
disjointness assertion, which fails if anyone reintroduces a marker that
contains another. Left untested: that the prompt carries the test plan in the
*right place* in its text — the payload is what the criterion is about.

**Finding 2.** A new `test-repo.sh` case: no file in `workflows/*.js`,
`agents/*.md`, `skills/*/SKILL.md`, `rulebook.md`, `README.md` matches
`hand-?off`, case-insensitively. Edge covered by the pattern choice: "hand
over", which `skills/agent-brief/SKILL.md` and the agent pages carry, must not
match. Left untested: `.claude/rules/agents.md`, deliberately outside the file
set for the same reason the existing name guard leaves it out — it addresses
whoever writes the agents, not an agent.

**Finding 3.** New driver mode `w8`, run against both workflows: every recorded
step's prompt names `backlog.json`, carries `record` and carries `push`. Plus
the tightened `SKILL.md` grep. Left untested: that the agent actually pushes —
that is a run-time behaviour no unit-level guard here can reach.

**Finding 4.** Modes `w4`, `w5`, `w6`, `w7` and the new `w8` run against
`workflows/agile-loop.js` as well as `workflows/loop.js`. Left untested: the
agile-only mechanics `w1` already covers (the re-cut, `maxIncrements`,
`MAX_ATTEMPTS`, `baseline()`), which no finding touches.

**Finding 5.** Three cases in `backlog.test.mjs`: the shed itself, the shed
repeated, and a backlog with no `run` key. Left untested: that a resumed
workflow skips a shed step — the driver's `w3` fixture is changed to carry a
shed `decompose` entry instead, which pins the same fact where the workflow
scripts actually run.

#### The cases

All `test-repo.sh` work is one file; the command that runs it is
`bash test-repo.sh`. All recorder work is one file; the command that runs it is
`node --test skills/agent-brief/assets/backlog.test.mjs`.

**A. `test-repo.sh` — the driver heredoc** (integration level: the driver runs
each whole workflow script through `new AsyncFunction` with a stubbed `agent`).
Conventions of that file: a case is one `run_driver "$wf" <mode> "<description>"`
call whose description opens with the workflow's basename; assertions inside the
driver push a sentence onto `failures` and the process exits 1 with them on
stderr; nothing is mocked but `agent`, `log` and `phase`.

1. **Disjoint markers.** At the top of `main()`, before any dispatch:
   `PLAN_MARKER`, `TESTPLAN_MARKER` and `'CHECK-MARKER'` — assert no one of the
   three contains another. Expected: passes for the renamed constants. It is the
   guard against finding 1 returning, so it runs in every mode.
2. **`w4` on both workflows** — "the test-author's prompt carries the test plan
   and not the implementation plan". Unchanged assertions, disjoint markers, and
   now inside the two-workflow loop.
3. **`w5` on both workflows** — "the implementer's prompt carries the plan and
   the checks and not the test plan". Unchanged assertions, moved into the loop.
4. **`w6` on both workflows** — "the reviewer's prompt carries the checks
   alone". Unchanged assertions, moved into the loop.
5. **`w7` on both workflows** — "a question from the researcher ends the run at
   publish". Unchanged assertions, moved into the loop.
6. **`w8` on both workflows**, new — "every step's prompt tells the agent to
   record its return and push the commit". `contextFor` gets a `w8` arm
   identical to `w4`-`w6` (no saved state, one increment, a clean plan). The
   mode branch, after the run:

   ```js
   for (const c of calls) {
     if (c.label === 'load-state' || c.label === 'publish') continue;
     assertTrue(/backlog\.json/.test(c.prompt) && /\brecord\b/i.test(c.prompt),
       c.label + ' is not told to record its return into backlog.json');
     assertTrue(/\bpush\b/i.test(c.prompt),
       c.label + " is not told to push its step's commit");
   }
   ```

   Six labels are covered on `loop.js` (`decompose`, `research:i1.0`,
   `tests:i1.0`, `implement:i1.0`, `review:i1.0`, `close:i1`) and six on
   `agile-loop.js` (with `replan:i1` for the last). Expected: passes as the
   scripts stand. The mutation it exists for: delete `, then push the commit`
   from `noDispatch` in either script and this case alone goes red.
7. **`w3`'s fixture carries a shed run step.** In `doneBacklog()`, the
   `decompose` entry loses its `return` key and keeps `label` and `at`; the
   close entry keeps its return, which is what a real closed run looks like. The
   assertion stays `['load-state', 'publish']`. Expected: passes — a `Map` entry
   whose value is `undefined` still answers `has()` with true. This is the case
   that proves the shed of finding 5 does not break resume.

**B. `test-repo.sh` — the word guard** (shell level, next to the existing
name-level guard at lines 126-143, same idiom: collect into a variable, `ok` on
empty, `no` plus the indented lines otherwise).

8. **"no prompt, agent page or skill still says handoff"** —
   `grep -rniE 'hand-?off'` over `"$root"/workflows/*.js "$root"/agents/*.md
   "$root"/skills/*/SKILL.md "$root/rulebook.md" "$root/README.md"`, empty
   required. Expected before the fix: **red**, on
   `agents/planner.md:55: ... Say in your handoff which criterion went where.`
   Expected after: green. Verified by reading that this is the only match in
   that file set today.

**C. `test-repo.sh` — the push-guard loop** (shell level, lines 200-209).

9. **The loop keeps `SKILL.md` and loses the two workflow files**, and its
   condition tightens from `grep -qi 'push'` to `grep -q 'push the commit'`.
   Expected: passes — `skills/agent-brief/SKILL.md` line 104 reads "Record your
   step, commit it with your work, and push the commit." The mutation it exists
   for: delete that paragraph and the frontmatter's "pushes its step return" no
   longer saves the case.

**D. `skills/agent-brief/assets/backlog.test.mjs`** (unit level, `node:test`
with `node:assert/strict`). Conventions of that file: one `test('<a sentence
saying what holds>', () => { ... })` per case; a fresh `tmpDir()` per case;
payloads written with `writeJson`; the CLI invoked through `run([...])`, or
`runFails([...])` when a non-zero exit is the point; nothing is stubbed, the
real CLI runs as a child process; helpers `backlogTemplate` and
`incrementPayload` build the fixtures. Add these after the existing close cases
(line 214).

10. **"close sheds the returns of the run's own steps and keeps their labels".**
    `init` with `i1` and `i2`; `record - decompose` with a payload carrying
    `{ increments: [...], summary: 'MARKER-RUN-STEP-RETURN' }`; `record i1
    research:i1.0`; then `close <path> i1 done 'the review accepted it'`. Assert:
    `run.steps.length === 1`; `run.steps[0].label === 'decompose'`;
    `run.steps[0].at` still matches the ISO pattern the file already uses;
    `Object.prototype.hasOwnProperty.call(run.steps[0], 'return') === false`;
    and the raw file text does not contain `MARKER-RUN-STEP-RETURN`. Expected
    before the fix: **red** — the key is still there and the marker is still in
    the file. Expected after: green.
11. **"closing a second increment leaves the already-shed run steps shed"**
    (the repeat edge). Same setup, then `close i1 done`, then `record i2
    research:i2.0`, then `close i2 done`. Assert exit 0 for both closes,
    `run.steps.length === 1`, and still no `return` key. Expected before the
    fix: **red** on the missing-key assertion. Expected after: green.
12. **"close on a backlog that carries no run key exits 0 and writes the
    status"** (the empty edge). Write `backlog.json` by hand — `{ version: 1,
    issue: 'docs/issues/x', workflow: 'loop', increments: [{ id: 'i1', title:
    'First', goal: 'First.', criteria: ['does i1'], status: 'todo', note: '',
    steps: [] }] }`, no `run` key — then `close <path> i1 done`. Assert the call
    exits 0, its stdout is the one `closed i1 as done` line, and the reread file
    has `increments[0].status === 'done'`. Expected before the fix: green (the
    old `close` never looks at `run`). Expected after: green — it is the guard
    on the fix's own crash risk, and the test-author reports it as green on
    arrival rather than as a proof.

Nothing in `workflows/loop.js` or `workflows/agile-loop.js` is edited this
round, so no case is written against a change in them.

#### What counts as done

Run these two, from the repository root, and nothing else:

```
bash test-repo.sh
bash test.sh
```

`test-repo.sh` is where all but three of this round's cases live, and it runs in
seconds, so it is listed on its own for a diagnosable exit code; `test.sh` is
the criterion the issue states in as many words and is the only run that reaches
the recorder suite. `node --test skills/agent-brief/assets/backlog.test.mjs` is
the command for writing case 10-12 against and is named above for that, but it
is not on this list: `test.sh` runs it.

Expect `test-repo.sh` to report around 42 cases when this round is done (37
today, minus the two workflow entries of the push loop, plus the word guard,
plus `w4`-`w7` on `agile-loop.js`, plus `w8` on both). No assertion pins that
number; it is a sanity figure, not a criterion.

#### What is already red

I ran nothing this round, and I state this from reading alone. Before the
implementer's change: case 8 is red on `agents/planner.md:55`, and cases 10 and
11 are red on the missing shed in `close()`. `test-repo.sh` is red today on
`loop.js: the test-author's prompt carries the test plan and not the
implementation plan`, which case 2 repairs. Everything else listed here — cases
1, 3, 4, 5, 6, 7, 9 and 12 — is green on arrival against the code as it stands,
and each names above the mutation it would catch. The rest of `test.sh` (the
three `tools/` suites and `test-worktree.sh`) was green in the reviewer's run
and nothing this round touches it. Whoever runs the list first reports what it
says.

## Round 2

The reviewer filed three findings. One is a real defect in both workflow
scripts — a run that ended on a question for the human replays the recorded
question on resume and makes no progress, ever. One is a hole in the guards: no
driver mode ever reaches a correction round, so the whole findings channel and
the reason sentence are untested. One is a missing sentence: nothing tells a
repeated step that its interrupted first run may already have committed work.
The recorder (`backlog.mjs`) is not touched this round.

### Implementation plan

**Finding 1 — a run that ended on a question can never be resumed.** The step
that asked is recorded, so `recorded.has(label)` is true on the next run, the
stored return is replayed, `asksTheHuman` reads the same `questions` out of it,
and the run breaks to Publish without dispatching anyone. The fix is in the
resume loader of both workflow scripts: a recorded step whose return carries a
non-empty `questions` is **not** loaded as recorded — it is worked again, and
its prompt carries the question it asked plus where the answer is.

In `workflows/loop.js` (lines 456-462) and `workflows/agile-loop.js` (lines
489-495), replace the two loading loops with one that triages each entry:

```js
// A step that ended the run with a question for the human is not replayed from
// its recorded return: the human answered in `issue.md`, so the step is worked
// again with the question in front of it. Replaying it instead would re-raise
// the same question and end the resumed run at Publish without dispatching
// anyone — the restart the rulebook promises would make no progress at all.
const recorded = new Map()
const carriedQuestions = new Map()
if (saved) {
  const load = (s) => {
    const asked =
      s && s.return && Array.isArray(s.return.questions) ? s.return.questions.filter(Boolean) : []
    if (asked.length) carriedQuestions.set(s.label, asked)
    else recorded.set(s.label, s.return)
  }
  for (const s of (saved.run && saved.run.steps) || []) load(s)
  for (const increment of saved.increments || []) {
    for (const s of increment.steps || []) load(s)
  }
}
if (recorded.size) log(`Resuming: ${recorded.size} step(s) already recorded in the run state.`)
if (carriedQuestions.size) {
  log(`${carriedQuestions.size} step(s) ended the last run with a question and are worked again.`)
}
```

and add, next to `recordStep()` in both files:

```js
// The question this step asked before the run stopped. The human records the
// answer under `## Decisions` in issue.md, which is where this sends the agent;
// the step's own recorded return is never replayed.
function answeredBlock(label) {
  const asked = carriedQuestions.get(label)
  return asked && asked.length
    ? `This step ended the previous run with a question for the human:\n` +
        asked.map((q) => `  - ${q}`).join('\n') +
        '\n' +
        `The answer is under \`## Decisions\` in ${dir}/issue.md. Read it there first, then ` +
        `work this step again; ask again only what it does not answer.\n`
    : ''
}
```

Then insert `answeredBlock(<that step's label>) +` immediately after the
`` `Issue directory: ${dir}\n` `` fragment of every recorded dispatch, and
nowhere else. That is six sites in `workflows/loop.js` — `decompose` (l. 495),
`research` (l. 539), `tests` (l. 558), `implement` (l. 575, so the string
splits into `` `Issue directory: ${dir}\n` + answeredBlock(buildLabel) + `Your
brief is the plan below.\n\n` ``), `review` (l. 591), `close` (l. 622) — and
six in `workflows/agile-loop.js`: `decompose` (l. 528), `research` (l. 613,
before `scope(...)`), `tests` (l. 633, before `scope(...)`), `implement`
(l. 651), `review` (l. 667), `replan` (l. 710). `load-state` and `publish` get
none: neither is a recorded step. Do not write the word "handoff" or "hand-off"
into any of this text — `test-repo.sh` greps the workflow scripts for it.

Rejected: not recording a step whose return carries questions. Criterion 10
asks for exactly the opposite — the question "lands in `backlog.json`" and the
resuming session "finds the question in the state it resumes from". Rejected:
dropping the recorded entry but adding no block to the prompt, leaving the
agent to find `## Decisions` on its own — criterion 10's last clause ("the
resuming researcher reads it there") needs something to send it there, and the
prompt is the only channel that reaches every role. Rejected: a sentence on the
agent pages instead of the prompt block — it would fire on every run rather
than on the one that resumes a question, and it cannot name the question that
was asked. Rejected: folding the block into `recordStep()` because that
function already takes the label — the two say different things (bookkeeping
versus the brief) and the record instruction belongs at the end of a prompt
while the answer belongs at its top.

Two knock-on facts, both by design and both worth stating rather than
discovering: a re-dispatched step records under the same label and
`backlog.mjs record` replaces an entry with a matching label, so the stale
return with the question is overwritten and nothing duplicates; and a human who
restarts without answering gets the same question again and the same regular
exit, which is a no-op run and not a loop.

The one path the fix does not carry an answer into is `replan:<id>` in
`agile-loop.js`: closing the increment happened before the question, so the
resumed run finds that increment closed and moves to the next one instead of
re-dispatching the planner for it. That is progress, which is what the
criterion asks for, and the answer still stands in `issue.md` for whoever reads
it next.

**Finding 1, the documentation half.** `rulebook.md` line 54 promises the
restart makes progress, and after this fix it does. Extend that sentence so the
session also knows what the restart does, replacing the line whole:

> A result carrying `blockedOnHuman` is a run one or more questions ended. Put
> those questions to the human as they stand, record their answers under a
> `## Decisions` heading in `issue.md`, commit and push that file, and start the
> same workflow on the same directory again: it works the step that asked again,
> with the question in its prompt and your answer in `issue.md`, and skips every
> other step it already recorded.

Line 52 of the same file and `README.md` line 78 stay as they are: both
describe the ordinary resume, and the exception is stated once, in the
paragraph that owns questions.

**Finding 2 — no test exercises a correction round.** Nothing in production
changes; the repair is a new driver mode. See test plan case A2.

**Finding 3 — nothing tells a repeated step about work its first run
committed.** One sentence, in the one place that reaches every role in every
installing project: `skills/agent-brief/SKILL.md`, at the end of the "Your step
return" section, after line 104.

> A step you work again may meet what its interrupted first run already
> committed: tests that exist and fail, code that half-exists. Read the working
> tree and `git log` before you start, then finish or correct what is there
> instead of writing it a second time.

Rejected: the same sentence on `agents/test-author.md` and
`agents/implementer.md` — `.claude/rules/agents.md` forbids an agent page from
restating what the shared brief says, and two wordings of one rule drift.
Rejected: a line in the workflow prompts — it would be paid for on every step
of every run, including the overwhelming majority that repeat nothing.

### Module map

| Path | What it holds | What changes |
| --- | --- | --- |
| `workflows/loop.js` | The plain chain. Resume loader at l. 456-463, `step()` at l. 469-478, `recordStep()` at l. 370-376, six recorded dispatches. | The triaging loader, `carriedQuestions`, `answeredBlock()`, and `answeredBlock(<label>) +` at the six dispatches. |
| `workflows/agile-loop.js` | The incremental chain, same shapes. Loader at l. 489-496, `step()` at l. 502-511, `recordStep()` at l. 377-384, six recorded dispatches. | Identical, word for word where the two scripts already agree. |
| `skills/agent-brief/SKILL.md` | The rules every agent preloads. "Your step return" ends at l. 104. | One paragraph appended to that section. |
| `rulebook.md` | The session's rules. Issue Mode step 4, l. 52-54. | Line 54 replaced with the text above. |
| `test-repo.sh` | The repository's own suite, 42 cases. Driver heredoc l. 269-497 (fixtures l. 298-368, `contextFor` l. 370-388, `returnFor` l. 392-402, mode branches l. 426-485), `run_driver` loop l. 513-523, the shared-brief greps at l. 210-228. | Two new driver modes and their fixtures, a log-capturing stub, two `run_driver` lines, one new grep case. |
| `skills/agent-brief/assets/backlog.mjs` and its suite | The recorder. | Unchanged this round. |

### Environment

- Repository root `/home/user/uroboros`. `node` is v22.22.2 on `PATH`; `bash`,
  `git` and `mktemp` are present.
- `test.sh` and `test-repo.sh` are **not executable** in this checkout (mode
  `-rw-r--r--`, unchanged from `origin/main`), so they are invoked as `bash
  test.sh` and `bash test-repo.sh`. Do not `chmod` them.
- There is no linter and no formatter in this repository. Nothing to run.
- The `tools/` suites `test.sh` runs are zero-install; `npm` is present and no
  network access is needed by any command below.

### Test plan

Tests are needed. Finding 1 needs a failing test first — a resumed run whose
recorded step carries a question. Finding 2 *is* a missing test, and its repair
is the new mode itself, green on arrival and named below by the mutation it
catches. Finding 3 needs a grep, red until the sentence is written.

#### What proves each finding

**Finding 1.** Driver mode `w9`, run against both workflow scripts: a saved
backlog whose `research:i1.0` return carries a question is resumed, and the
researcher is dispatched again with the question and the pointer to
`## Decisions` in its prompt, the chain runs to the close, and the returned
`blockedOnHuman` is empty. Left untested, deliberately: the same resume when it
is `decompose` or `replan` that asked — the loader triages every step by the
same three lines, and a second mode would pin the same code twice; and the
rulebook sentence, which no exit code can judge.

**Finding 2.** Driver mode `w10`, run against both workflow scripts: the round-0
review returns a finding, and the round-1 researcher prompt carries that
finding's claim, reproduction and criterion, the round-0 prompt carries none of
them, the test-author's open question from round 0 reaches the round-1
researcher, and the reviewer's reason sentence reaches `log`. Left untested: the
correction round's test-author prompt clause ("The reviewer's reproduction spec
is the criterion for this round") — mode `w4` already pins what that prompt
carries, and the round-1 wording is prose.

**Finding 3.** A grep case over `skills/agent-brief/SKILL.md`. Left untested:
that an agent actually behaves that way at run time, which no unit-level guard
reaches.

#### The cases

All work this round is in one test file, `test-repo.sh`. The command that runs
just it is `bash test-repo.sh`. Its conventions: a shell case is a grep or a
`node -e` collecting problems into a variable, then `ok "<sentence>"` or
`no "<sentence>:"` plus the offending lines indented by `sed 's/^/       /'`; a
driver case is one `run_driver "$wf" <mode> "<description>"` call inside the
`for wf in ... loop.js ... agile-loop.js` loop, whose description opens with
`$wf_name`; inside the heredoc, assertions push a sentence onto `failures` and
the process exits 1 with them on stderr; `agent`, `log` and `phase` are the only
stubs and the whole workflow script is run through `new AsyncFunction`.

**A. `test-repo.sh` — the driver heredoc.**

1. **Shared driver changes** (no case of their own):
   - New fixtures beside the existing ones (l. 298-328):

     ```js
     const planReturnWithMarkedQuestion = Object.assign({}, planReturn, {
       questions: ['MARKER-HUMAN-QUESTION'],
     });
     const testsReturnWithOpenQuestion = Object.assign({}, testsReturn, {
       openQuestions: ['MARKER-OPEN-QUESTION'],
     });
     const verdictReturnWithFinding = {
       findings: [{
         claim: 'MARKER-FINDING-CLAIM',
         reproduction: 'MARKER-FINDING-REPRODUCTION',
         criterion: 'MARKER-FINDING-CRITERION',
       }],
       reason: 'MARKER-VERDICT-REASON',
       questions: [],
       summary: 'verdict summary',
     };
     ```

   - `DISJOINT_MARKERS` (l. 296) gains `'MARKER-HUMAN-QUESTION'`,
     `'MARKER-OPEN-QUESTION'`, `'MARKER-FINDING-CLAIM'`,
     `'MARKER-FINDING-REPRODUCTION'`, `'MARKER-FINDING-CRITERION'` and
     `'MARKER-VERDICT-REASON'`, so the standing disjointness assertion covers
     the new markers too. It passes: no one of the nine strings contains
     another.
   - `returnFor` (l. 392-402) takes two returns from the context when it offers
     them: `if (label.startsWith('tests:')) return ctx.testsReturn ||
     testsReturn;` and `if (label.startsWith('review:')) return ctx.verdictFor ?
     ctx.verdictFor(label) : verdictReturnClean;`. Every existing mode leaves
     both unset and is unaffected.
   - The `log` stub (l. 423) captures instead of discarding:
     `const logs = []; ... await fn({ issueDir: 'docs/issues/x' }, stub, (m) =>
     logs.push(String(m)), () => {})`.
   - A new fixture `questionBacklog()` beside `resumeBacklog()` (l. 330-346):
     the same shape, `increments[0].steps` holding one entry
     `{ label: 'research:i1.0', at: '2026-08-07T00:00:00.000Z', return:
     planReturnWithMarkedQuestion }`, and `run.steps` holding the `decompose`
     entry with `decomposeReturnOne` as its return.
   - `contextFor` (l. 370-388) gains two arms:

     ```js
     case 'w9':
       return { stateReturn: { exists: true, backlogJson: JSON.stringify(questionBacklog(), null, 2) + '\n', summary: '' }, decomposeReturn: decomposeReturnOne, researchReturn: planReturn };
     case 'w10':
       return { stateReturn: { exists: false, backlogJson: '', summary: '' }, decomposeReturn: decomposeReturnOne, researchReturn: planReturn, testsReturn: testsReturnWithOpenQuestion, verdictFor: (label) => (label === 'review:i1.0' ? verdictReturnWithFinding : verdictReturnClean) };
     ```

2. **`w9` on both workflows** — "a run resumed after a question works the step
   that asked again". Input: the state loader returns `questionBacklog()`;
   `research:i1.0` returns the clean `planReturn` when it is dispatched again.
   The mode branch asserts:

   ```js
   const closeLabel = isAgile ? 'replan:i1' : 'close:i1';
   assertEqualArrays(labels,
     ['load-state', 'research:i1.0', 'tests:i1.0', 'implement:i1.0', 'review:i1.0', closeLabel, 'publish'],
     'the resumed run did not work the step that asked the human again, or did not carry on past it');
   const researchCall = calls.find((c) => c.label === 'research:i1.0');
   assertTrue(!!researchCall && researchCall.prompt.includes('MARKER-HUMAN-QUESTION'),
     "the repeated step's prompt does not carry the question it asked");
   assertTrue(!!researchCall && /## Decisions/.test(researchCall.prompt) && /issue\.md/.test(researchCall.prompt),
     "the repeated step's prompt does not send the agent to the answer under ## Decisions in issue.md");
   assertTrue(!!result && Array.isArray(result.blockedOnHuman) && result.blockedOnHuman.length === 0,
     'the resumed run ended on the stale recorded question instead of making progress');
   ```

   `decompose` is absent from the expected labels on purpose: it is recorded
   without a question and stays skipped, which is the other half of the fix.
   Expected before the change: **red** on the first assertion — today the run
   dispatches `load-state` and `publish` and nothing else.

3. **`w10` on both workflows** — "a correction round carries the reviewer's
   findings to the researcher and the reason to the human". Input: a fresh run,
   one increment, round 0's review dirty and round 1's clean. The mode branch
   asserts:

   ```js
   const closeLabel = isAgile ? 'replan:i1' : 'close:i1';
   assertEqualArrays(labels,
     ['load-state', 'decompose', 'research:i1.0', 'tests:i1.0', 'implement:i1.0', 'review:i1.0',
      'research:i1.1', 'tests:i1.1', 'implement:i1.1', 'review:i1.1', closeLabel, 'publish'],
     'a review with findings does not open exactly one correction round');
   const round1 = calls.find((c) => c.label === 'research:i1.1');
   for (const marker of ['MARKER-FINDING-CLAIM', 'MARKER-FINDING-REPRODUCTION', 'MARKER-FINDING-CRITERION']) {
     assertTrue(!!round1 && round1.prompt.includes(marker),
       "the correction round's researcher prompt does not carry " + marker);
   }
   assertTrue(!!round1 && round1.prompt.includes('MARKER-OPEN-QUESTION'),
     "the correction round's researcher prompt does not carry what the test-author left open");
   const round0 = calls.find((c) => c.label === 'research:i1.0');
   assertTrue(!!round0 && !round0.prompt.includes('MARKER-FINDING-CLAIM'),
     "the first round's researcher prompt carries findings that do not exist yet");
   assertTrue(logs.some((l) => l.includes('MARKER-VERDICT-REASON')),
     "the reviewer's reason sentence never reached the human in the chat");
   ```

   Expected before and after the change: **green**. It is the guard finding 2
   asks for, and the mutations it exists for are deleting `(round === 0 ? '' :
   findingsBlock(verdict, round)) +` or `openQuestionsBlock(previousTests) +`
   from either script's researcher dispatch, or dropping the `log` at
   `loop.js` l. 612 / `agile-loop.js` l. 689 — each turns this case red in the
   script it was made in.

4. **Two `run_driver` lines** inside the existing two-workflow loop
   (l. 513-523), after the `w8` line:

   ```
   run_driver "$wf" w9 "$wf_name: a run resumed after a question for the human works that step again with the question in its prompt"
   run_driver "$wf" w10 "$wf_name: a correction round carries the reviewer's findings to the researcher and the reason to the human"
   ```

**B. `test-repo.sh` — the shared-brief greps** (shell level, beside the
`push the commit` case at l. 224-228, same idiom).

5. **"the shared brief tells a repeated step what its first run may have left
   behind"** — `grep -q 'already committed' "$root/skills/agent-brief/SKILL.md"`,
   `ok` on a hit, `no` otherwise. Expected before the change: **red** — the
   phrase appears nowhere in that file today. Expected after: green.

Nothing else in `test-repo.sh` changes, and no case is written against
`skills/agent-brief/assets/` this round: the recorder is untouched.

#### What counts as done

Run these two, from the repository root, and nothing else:

```
bash test-repo.sh
bash test.sh
```

`test-repo.sh` holds every case of this round and runs in seconds, so it is
listed on its own for a diagnosable exit code; `test.sh` is the criterion the
issue states in as many words, and it is the only run that reaches the recorder
suite and the three `tools/` suites this round's edits could not touch. Expect
`test-repo.sh` to report 47 cases when this round is done — 42 today, plus `w9`
and `w10` on two workflows each, plus the brief grep.

#### What is already red

I ran neither command and state this from reading alone. Before the
implementer's change: case 2 (`w9`) is red on both workflow scripts, because a
recorded step carrying a question is replayed and the run reaches only
`load-state` and `publish`; case 5 is red, because `already committed` is in no
line of `skills/agent-brief/SKILL.md`. Case 3 (`w10`) and the widened
disjointness assertion are green on arrival, and each names above the mutation
it exists to catch. The rest of `test.sh` was exit 0 in the reviewer's round-1
run and nothing here touches it. Whoever runs the list first reports what it
says.

## Round 3

The reviewer filed two findings, both in the workflow scripts, both about a
step return the script throws away or replays wrongly. Finding 1 is a real
divergence: `workflows/loop.js` discards the closing planner's return, so a
question asked at the Close step reaches nobody, while `workflows/agile-loop.js`
handles the same role in the same position correctly. Finding 2 is a regression
the resume mechanism caused: `workflows/agile-loop.js` keys its step labels on
the increment id, so the second attempt at an increment the planner handed back
finds every one of its labels in the in-session `recorded` map, dispatches
nobody and re-reads the first attempt's verdict — `MAX_ATTEMPTS` turned from
"worked twice" into "worked once, then a no-op iteration".

Neither `skills/agent-brief/assets/backlog.mjs`, nor any agent page, skill,
`rulebook.md` or `README.md` is touched this round. The whole change is
`workflows/loop.js`, `workflows/agile-loop.js` and `test-repo.sh`.

### Implementation plan

**Finding 1 — the plain loop throws away the closing planner's question.**
`workflows/loop.js` line 656 dispatches the Close step and drops the value:

```js
  await step(closeLabel, 'Close', () =>
    agent(
```

Bind it and put it through `asksTheHuman`, exactly as `agile-loop.js` line 772
does for `replan`. Replace lines 656 and 673-674 so the block reads:

```js
  const closed = await step(closeLabel, 'Close', () =>
    agent(
      ... unchanged prompt ...
    ),
  )
  task.status = accepted ? 'done' : 'blocked'
  // The planner may end its own step with a question — a status only the human
  // can settle. Same call, same position as the incremental loop's replan: a
  // question here ends the run as a regular exit, and the run state the planner
  // recorded carries it into the session that picks the run back up.
  asksTheHuman(closeLabel, closed)
  if (!accepted) {
```

Nothing else in the block moves: the prompt, `answeredBlock(closeLabel)`, the
`recordStep('-', closeLabel)` and the schema stay as they are, `task.status` is
still mirrored before the question is triaged (agile-loop's order), and the
existing `if (blockedOnHuman.length)` log at lines 680-685 then fires on its
own, which is the whole of what the run has to do about it. The name `closed`
is free in this file — no other binding uses it.

Order matters in one respect only: `asksTheHuman` must run before the
`blockedOnHuman.length` log, which it does. Placing it before `task.status`
instead would be equally correct but would diverge from `agile-loop.js`, which
is the thing this finding is about.

What this fix does **not** do, stated so it is a decision and not an oversight:
a resumed run does not re-dispatch the Close step that asked. The planner
closed the increment in `backlog.json` before it asked, so the resumed run finds
no `todo` increment, skips the chain and ends as already complete. That is the
same limit `agile-loop.js`'s `replan` already has and that Round 2 recorded for
it; the question is in the state, which is what criterion 10 asks for, and the
human's answer stands in `issue.md` for whoever reads it next.

Rejected: re-raising, at the end of a resumed run, every carried question whose
step was never re-dispatched. It reads well and costs little, but it would put
an already-answered question back into `blockedOnHuman` on every subsequent
run, and in `agile-loop.js` `accepted` is computed as
`!stopped && !blockedOnHuman.length && ...`, so a finished run would report
itself unfinished forever. Rejected: dispatching the Close step again on resume
even though the increment is closed — the planner would be asked to close what
is already closed, and `close` on a closed increment sheds nothing new but does
re-write the file.

Rejected: moving the `questions` triage inside `step()` so every dispatch is
triaged automatically. It would be one line instead of two and would have
caught this class of bug, but `step()` returns the recorded payload on a resume
too, so triaging there would re-raise every recorded question on every resumed
run — the exact bug Round 2 fixed.

**Finding 2 — an increment handed back is never worked a second time.** In
`workflows/agile-loop.js` the labels are keyed on the increment id on purpose
(the comment at lines 527-530 says why: an ordinal moves when a re-cut
reorders the backlog, and a moving label breaks resume across sessions). Keep
that. The repair is to forget the in-session recordings of an increment the
planner hands back, which is exactly what the file itself already did: `close`
sets `increment.steps = []`, so on a fresh session that increment starts with
no recorded steps at all. The in-session map is the only thing that still
remembers them.

Add, next to `step()` in `workflows/agile-loop.js` (after line 540, and in that
file only — the plain loop never re-cuts):

```js
// Every step label that belongs to one increment: `research:<id>.<round>` and
// its siblings, plus `replan:<id>`. `load-state`, `decompose` and `publish`
// carry no id and are never forgotten.
function forgetSteps(id) {
  for (const label of [...recorded.keys()]) {
    const at = label.indexOf(':')
    if (at < 0) continue
    const rest = label.slice(at + 1)
    if (rest === id || rest.startsWith(`${id}.`)) recorded.delete(label)
  }
}
```

and call it right after the re-cut replaces the backlog, between lines 770 and
771:

```js
    if (recut && Array.isArray(recut.increments) && recut.increments.length) {
      increments = recut.increments
    }
    // The planner may hand an increment already worked back as `todo` — the
    // second chance MAX_ATTEMPTS exists for. Closing it emptied its steps in
    // the run state, so the in-session map forgets them too: left there, every
    // label of the next attempt would be found recorded, the attempt would
    // dispatch nobody and would re-read this iteration's verdict and this
    // iteration's re-cut as if they were the new ones.
    for (const t of increments) {
      if (t.status === 'todo' && attempts.has(t.id)) forgetSteps(t.id)
    }
    log(`After increment ${n}: ...`)
```

`attempts.has(t.id)` is what keeps this from touching anything else: only an
increment this session already worked is forgotten, so an untouched `todo`
increment and a re-cut that returns no list of its own both leave the map
alone. The exact-match `rest === id` plus the `${id}.` prefix is what keeps
increment `i1` from forgetting `i10`'s steps.

Rejected: putting the attempt ordinal in the label
(`research:${task.id}.${attempt}.${round}`). `attempts` is session-local by
design (the comment at lines 44-51 says so, and closing an increment sheds the
returns that would count attempts), so the ordinal differs between a run and its
resume and the labels stop matching across sessions — resume would re-dispatch
recorded steps. Rejected: clearing `recorded` wholesale after a re-cut — it
would forget `decompose` and every other increment's steps and turn a resumed
multi-increment run into a full re-run. Rejected: leaving the behaviour as it
is and only correcting the stop message ("was worked 2 times") to match — the
second attempt is the backstop's whole point, and a truthful message about a
useless retry is not the repair.

There is no cross-session half of this fix to write: a handed-back increment
comes out of `backlog.json` with `steps: []`, because `close` empties them, so
a resumed session already dispatches its chain fresh.

### Module map

| Path | What it holds | What changes this round |
| --- | --- | --- |
| `workflows/loop.js` | The plain chain, 720 lines. `asksTheHuman` at l. 513-520, the Close block at l. 652-678, the `blockedOnHuman` log at l. 680-685, the return at l. 720. | Bind the Close step's return and pass it to `asksTheHuman`. Three lines. |
| `workflows/agile-loop.js` | The incremental chain, 841 lines. `step()` at l. 531-540, the increment loop at l. 615-780, `attempts` at l. 587, the re-cut at l. 765-772. | Add `forgetSteps()` after `step()`; call it after the re-cut. Nothing else. |
| `test-repo.sh` | The repository's own suite, 47 cases. Driver heredoc l. 280-613: markers l. 304-317, fixtures l. 319-434, `contextFor` l. 436-458, `returnFor` l. 462-476, mode branches l. 504-601. `run_driver` at l. 615-623, the two-workflow loop at l. 629-641. | One marker, two `contextFor` arms, one `returnFor` line, two mode branches, three `run_driver` lines. |
| `skills/agent-brief/assets/backlog.mjs`, the agent pages, `rulebook.md`, `README.md`, `skills/*/SKILL.md` | — | Unchanged. Do not touch them. |

One standing constraint for whoever edits the workflow scripts: `test-repo.sh`
lines 136-159 grep `workflows/*.js` for the word `handoff` in any spelling and
for the file names `researcher.md`, `test-author.md`, `implementer.md`,
`reviewer.md`, `planner.md` and `backlog.md`. Do not write any of them into a
comment or a prompt.

### Environment

- Repository root `/home/user/uroboros`, branch `claude/structured-prompts-issues-dphlv9`, working tree clean.
- `node` is v22.22.2 on `PATH`; `bash`, `git` and `mktemp` are present.
- `test.sh` and `test-repo.sh` are **not executable** in this checkout (mode
  `-rw-r--r--`, unchanged from `origin/main`), so they are invoked as
  `bash test.sh` and `bash test-repo.sh`. Do not `chmod` them.
- There is no linter and no formatter in this repository. Nothing to run.
- The `tools/` suites `test.sh` runs are zero-install; `npm` is present and no
  command below needs network access.

### Test plan

Tests are needed. Finding 1 needs a failing test first: no driver mode has ever
given the closing planner a question to ask, and the mode that does is red on
`loop.js` and green on `agile-loop.js`, which is the divergence stated as an
exit code. Finding 2 needs a failing test first too: no mode has ever exercised
a re-cut that hands an increment back.

#### What proves each finding

**Finding 1.** Driver mode `w11`, run against **both** workflow scripts: a
fresh run in which the closing planner (`close:i1` in the plain loop,
`replan:i1` in the incremental one) returns a question. The run must end at
Publish with that question in `blockedOnHuman`, attributed to the step that
asked, and logged for the human. Running it on both is the point — it is green
on `agile-loop.js` before the change and red on `loop.js`, and afterwards it
holds the two to one behaviour.

Left untested, deliberately: the resumed run after a Close question, because
the increment is closed and no step is re-dispatched — there is no behaviour
there to pin beyond `w3`, which already covers a fully-closed backlog; and the
`decompose` planner's question, which `asksTheHuman('decompose', backlog)` at
`loop.js` l. 538 / `agile-loop.js` l. 570 has always handled and no finding
touches.

**Finding 2.** Driver mode `w12`, run against `agile-loop.js` **only**: the
plain loop has no re-cut and no `replan` step, so the mode has nothing to mean
there. The first `replan:i1` hands `i1` back as `todo`; the second closes it as
`done`. The run must dispatch the whole chain a second time and finish without
`stopped` being set.

Left untested, deliberately: a re-cut that hands back an increment worked two
iterations earlier rather than the one just finished — the `attempts.has(t.id)`
loop treats every increment the same way and a second mode would pin the same
three lines twice; and the third attempt hitting `MAX_ATTEMPTS`, which is
pre-existing behaviour this change does not touch.

#### The cases

All work this round is in one test file, `test-repo.sh`. The command that runs
just it is `bash test-repo.sh`. Its conventions, unchanged: a driver case is one
`run_driver "$wf" <mode> "<description>"` call whose description opens with
`$wf_name` when it runs inside the two-workflow loop; inside the heredoc,
assertions push a sentence onto `failures` via `assertTrue` /
`assertEqualArrays` and the process exits 1 with them on stderr; `agent`, `log`
and `phase` are the only stubs, `logs` captures every `log` call, `calls` holds
every dispatch as `{ label, agentType, prompt }`, and the whole workflow script
is run through `new AsyncFunction`. Every new fixture carries a comment naming
the round and finding it exists for, as the round-1 and round-2 fixtures do.

**1. Shared driver changes** (no case of their own).

- `DISJOINT_MARKERS` (l. 307-317) gains `'MARKER-CLOSE-QUESTION'`. It passes:
  no existing marker contains it and it contains none of them.
- `returnFor` (l. 473) takes a per-mode override, so every existing mode keeps
  the fixed return it has today:

  ```js
  // Round 3, w11 and w12: the closing planner's return is a channel of its
  // own — it can carry a question for the human (w11) and it can hand an
  // increment back as todo (w12) — so these two labels take a per-mode
  // override instead of the one fixed fixture.
  if (label.startsWith('close:') || label.startsWith('replan:')) {
    return ctx.closeFor ? ctx.closeFor(label) : { summary: 'closed' };
  }
  ```

- `contextFor` (l. 436-458) gains two arms, before `default`:

  ```js
  case 'w11':
    return { stateReturn: { exists: false, backlogJson: '', summary: '' }, decomposeReturn: decomposeReturnOne, researchReturn: planReturn, closeFor: () => ({ questions: ['MARKER-CLOSE-QUESTION'], summary: 'closed' }) };
  case 'w12': {
    // Round 3, finding 2: the planner closes the increment and hands it
    // straight back as todo — the second chance MAX_ATTEMPTS exists for —
    // and settles it on the second pass.
    let replans = 0;
    return {
      stateReturn: { exists: false, backlogJson: '', summary: '' },
      decomposeReturn: decomposeReturnOne,
      researchReturn: planReturn,
      closeFor: () => {
        replans += 1;
        return replans === 1
          ? { increments: [increment('i1')], questions: [], summary: 'handed back' }
          : { increments: [Object.assign(increment('i1'), { status: 'done' })], questions: [], summary: 'closed' };
      },
    };
  }
  ```

  `increment('i1')` (l. 370-372) returns a fresh `todo` increment each call, so
  the two returns share no object.

**2. `w11` on both workflows** — "a question from the closing planner ends the
run and reaches the human". Input: a fresh run, one increment, every step clean
until the close, whose return is `{ questions: ['MARKER-CLOSE-QUESTION'],
summary: 'closed' }`. New mode branch, after the `w10` branch:

```js
  } else if (mode === 'w11') {
    // Round 3, finding 1: loop.js dispatched the Close step and dropped its
    // return, so a question the closing planner asked reached nobody — no
    // blockedOnHuman, no log line, and a run that reported itself finished.
    // agile-loop.js already handled the same role in the same position, so
    // this mode runs on both and pins them to one behaviour.
    const closeLabel = isAgile ? 'replan:i1' : 'close:i1';
    assertEqualArrays(labels,
      ['load-state', 'decompose', 'research:i1.0', 'tests:i1.0', 'implement:i1.0', 'review:i1.0', closeLabel, 'publish'],
      'a question from the closing planner does not stop the run at publish');
    assertTrue(!!result && Array.isArray(result.blockedOnHuman) && result.blockedOnHuman.length === 1,
      "the closing planner's question did not end the run as blocked on the human");
    const blocked = JSON.stringify((result && result.blockedOnHuman) || []);
    assertTrue(blocked.includes('MARKER-CLOSE-QUESTION'),
      'blockedOnHuman does not carry the question the closing planner asked');
    assertTrue(blocked.includes(closeLabel),
      'blockedOnHuman does not name ' + closeLabel + ' as the step that asked');
    assertTrue(logs.some((l) => l.includes('MARKER-CLOSE-QUESTION')),
      "the closing planner's question never reached the human in the chat");
  } else if (mode === 'w12') {
```

Expected before the change: **red on `loop.js`** — `blockedOnHuman` is `[]`, so
the second assertion and the two after it fail; the label sequence itself is
already right. **Green on `agile-loop.js`**, which is the divergence made
visible. Expected after: green on both.

**3. `w12` on `agile-loop.js` only** — "an increment the planner hands back is
worked a second time". Input: as above, with the stateful `closeFor`. New mode
branch, after `w11`:

```js
  } else if (mode === 'w12') {
    // Round 3, finding 2: labels are keyed on the increment id, so the second
    // attempt at an increment the planner handed back re-used the first
    // attempt's labels, found them all in the in-session recorded map,
    // dispatched nobody and re-read the first attempt's verdict and re-cut.
    // MAX_ATTEMPTS' second chance is what that cost.
    assertTrue(isAgile, 'w12 is the incremental loop's mode: the plain loop never re-cuts');
    assertEqualArrays(labels,
      ['load-state', 'decompose',
       'research:i1.0', 'tests:i1.0', 'implement:i1.0', 'review:i1.0', 'replan:i1',
       'research:i1.0', 'tests:i1.0', 'implement:i1.0', 'review:i1.0', 'replan:i1',
       'publish'],
      'an increment the planner handed back as todo was not worked a second time');
    assertTrue(calls.filter((c) => c.label === 'research:i1.0').length === 2,
      'the researcher was not dispatched again for the second attempt');
    assertTrue(!!result && result.stopped === '',
      'the run stopped on the attempt backstop instead of working the increment again');
    assertTrue(!!result && result.delivered === 1 && Array.isArray(result.increments) && result.increments.length === 2,
      'the second attempt did not deliver the increment');
  } else {
```

Note for whoever writes it: the `assertTrue(isAgile, ...)` message contains an
apostrophe inside a single-quoted JavaScript string — write it as
`"w12 is the incremental loop's mode: the plain loop never re-cuts"` with double
quotes, the idiom the surrounding assertions already use.

Expected before the change: **red on `agile-loop.js`** — the second attempt
dispatches nothing, so `labels` is the eight-entry sequence
`[... 'replan:i1', 'publish']`, `research:i1.0` is called once, and
`result.stopped` names the `MAX_ATTEMPTS` backstop. Expected after: green.

**4. Three `run_driver` lines.** Two inside the two-workflow loop (l. 629-641),
after the `w10` line:

```
  run_driver "$wf" w11 "$wf_name: a question from the closing planner ends the run and reaches the human"
```

and one after the loop closes at l. 641, before `rm -rf "$driver_tmp"`:

```
# Round 3, finding 2: only the incremental loop re-cuts, so an increment
# handed back is agile-loop.js's case alone.
run_driver "$root/workflows/agile-loop.js" w12 "agile-loop.js: an increment the planner hands back is worked a second time, not skipped as recorded"
```

Nothing else in `test-repo.sh` changes. No case is written against
`skills/agent-brief/assets/`, no grep case is added or removed, and no existing
mode, fixture or assertion is edited beyond the three insertions named above.

#### What counts as done

Run these two, from the repository root, and nothing else:

```
bash test-repo.sh
bash test.sh
```

`test-repo.sh` holds every case of this round and runs in seconds, so it is
listed on its own for a diagnosable exit code; `test.sh` is the criterion the
issue states in as many words, and it is the only run that reaches the recorder
suite and the three `tools/` suites this round's edits cannot touch. Expect
`test-repo.sh` to report **50 cases** when this round is done — 47 today, plus
`w11` on two workflows and `w12` on one.

#### What is already red

I ran neither command and state this from reading alone. Before the
implementer's change: `w11` on `loop.js` is red (the Close step's return is
discarded, so `blockedOnHuman` is empty and no log line carries the question),
`w11` on `agile-loop.js` is green, and `w12` on `agile-loop.js` is red (the
second attempt dispatches nobody). Everything else in both commands was exit 0
in the reviewer's round-2 run — `bash test-repo.sh`, 47 cases, and `bash
test.sh`, all 6 suites — and nothing planned here touches it. Whoever runs the
list first reports what it says.

## Round 4

The reviewer filed one finding, present in both workflow scripts and in the same
expression in each: the list of increments the run works is taken from the state
snapshot the session read at startup whenever that snapshot holds any, even when
the Decompose step was dispatched again in this session and returned a newer
cut. So the planner reads the human's answer, re-cuts, rewrites `backlog.json` —
and the run works the cut the answer replaced.

The repair is one condition: the snapshot wins only over a cut that was
*replayed*. A cut that was *dispatched* this session is newer than the snapshot,
because the planner wrote the file after the snapshot was taken.

Nothing else this round. `skills/agent-brief/assets/backlog.mjs`, every agent
page, every `SKILL.md`, `rulebook.md` and `README.md` stay exactly as they are.
The whole change is `workflows/loop.js`, `workflows/agile-loop.js` and
`test-repo.sh`.

The reviewer's two "facts, neither a finding" are deliberately left alone: the
stale word "the publish" in `backlog.mjs`'s comment at line 131 stays, because
touching that file pulls the recorder into a diff this round has no business in,
and the non-executable mode of `test.sh` and `test-repo.sh` stays, because it
predates the change and `chmod` would put an unrelated mode change in the diff.

### Implementation plan

**The fix, in both scripts.** The two files hold the identical expression —
`workflows/loop.js` lines 543-546 and `workflows/agile-loop.js` lines 587-590 —
and take the identical patch, differing only in `const` versus `let` (the
incremental loop reassigns `increments` at its re-cut).

Ask whether the cut is replayed *before* the step runs: `step()` writes the
label into `recorded` the moment it dispatches, so asking afterwards always
answers "yes".

In `workflows/loop.js`, insert immediately above line 522 (`const backlog =
await step('decompose', ...)`):

```js
// Asked before the step runs, never after: `step` writes the label into
// `recorded` the moment it dispatches, so the answer afterwards is always yes.
const cutWasReplayed = recorded.has('decompose')
```

and replace lines 540-546 — the comment and the `increments` binding — with:

```js
// Which of the two lists of increments the run works. A replayed cut is the
// older of them: the decompose return is what the planner said when it opened
// the run, and a status a later close set lives in the file, not in that
// return. A Decompose dispatched again this session is the opposite case — the
// planner has just rewritten the file, so its return is the newer of the two
// and the snapshot this run read at startup is the stale one. Either side
// falls back to the other when it is empty.
const savedIncrements =
  saved && Array.isArray(saved.increments) && saved.increments.length ? saved.increments : null
const cutIncrements =
  backlog && Array.isArray(backlog.increments) && backlog.increments.length
    ? backlog.increments
    : null
const increments =
  (cutWasReplayed ? savedIncrements || cutIncrements : cutIncrements || savedIncrements) || []
```

In `workflows/agile-loop.js`, the same two edits: the `cutWasReplayed` line
immediately above line 567 (`const backlog = await step('decompose', ...)`), and
lines 584-590 replaced by the same block with the last binding written as `let
increments = ...` — line 781 assigns to it after a re-cut and `const` would
throw.

Nothing else moves in either file. `asksTheHuman('decompose', backlog)` keeps
its position between the two, `step()`, `forgetSteps()`, `carriedQuestions` and
the re-cut at agile-loop's lines 780-782 are untouched, and no prompt changes.

**Why this is the whole fix.** There are exactly three ways a run reaches the
`increments` binding, and the condition sorts them:

1. No state, or state with no increments — `savedIncrements` is null, the cut
   wins. Unchanged from today.
2. State whose `run.steps` records `decompose` — `cutWasReplayed` is true, the
   file wins. Unchanged from today, and it must stay that way: `close` sheds a
   run step's `return` but keeps its label, so a finished run replays
   `decompose` as `undefined` and the file is the only place the closed statuses
   live. This is what keeps `w2`, `w3` and `w9` green.
3. State whose `decompose` is carried as a question, or missing altogether —
   `cutWasReplayed` is false, the fresh return wins. This is the finding.

Case 3 has two routes into it and the condition covers both by construction:
`recorded.has('decompose')` is false whether the label went into
`carriedQuestions` (the planner asked, `loop.js` lines 481-482) or was never
written at all (a session that died between the planner's `init` and its
`record`). Keying the fix on `carriedQuestions.has('decompose')` instead would
repair the first route and leave the second, which is why the test plan below
pins both.

**Why no status is lost when the fresh return wins.** In case 3 no increment can
have been worked to a close in an earlier session: a `decompose` that asked a
question ends its run before any increment is worked (`loop.js` line 549,
`agile-loop.js` line 627 both gate on `blockedOnHuman.length`), and a
`decompose` that never recorded never returned, so nothing downstream of it ran.
And `backlog.mjs`'s `init` (lines 103-119) merges: an increment the fresh cut
keeps arrives with the steps it already recorded, so the run replays them from
`recorded` exactly as it should. An increment the fresh cut drops takes its
labels out of use, and the entries left in `recorded` for it are simply never
looked up.

**The empty-return fallback is deliberate.** `cutIncrements || savedIncrements`
in the dispatched branch means a Decompose that returns no increments at all
falls back to the snapshot rather than to `[]`. Without it, a malformed return
would give `loop.js` an empty backlog, no `todo` increment, and a run that logs
"Every increment in the run state is closed" and reports itself accepted — a
worse failure than working a stale cut. The same fallback in the other direction
(`savedIncrements || cutIncrements`) is today's behaviour written out.

Rejected: making `step()` report whether it dispatched, by returning a pair or
by setting a flag. It would carry the fact to every call site instead of the one
that needs it, and every other call site would have to be re-read to be sure the
new shape did not break it. `recorded.has(label)` read one line above the call
is local, and the comment says why the order matters.

Rejected: dropping the snapshot branch entirely and always preferring the
Decompose return. It reads simplest and it is wrong for case 2: the replayed
return is the opening cut with every increment still `todo`, so a resumed run
would re-work increments the file records as closed — the bug round 1 fixed by
introducing this expression in the first place.

Rejected: having the script re-read `backlog.json` after the Decompose step,
through a second `load-state` dispatch. It would be authoritative rather than
inferred, and it costs a dispatch on every run to repair a case that arises on
some. The planner's return and the file it just wrote are the same cut.

Rejected: keying on `carriedQuestions.has('decompose')`. It repairs the answered
question and leaves the crashed session, and the two are one bug.

### Module map

| Path | What it holds | What changes this round |
| --- | --- | --- |
| `workflows/loop.js` | The plain chain, 726 lines. `recorded`/`carriedQuestions` load at l. 475-492, `step()` at l. 498-507, `asksTheHuman` at l. 512-520, the Decompose step at l. 522-538, the `increments` binding at l. 540-546, `task` at l. 548-552, the Close block at l. 652-683, the return at l. 725. | One `cutWasReplayed` line above l. 522; the `increments` binding at l. 540-546 replaced. Nothing else. |
| `workflows/agile-loop.js` | The incremental chain, 863 lines. Same load at l. 508-525, `step()` at l. 531-540, `forgetSteps()` at l. 545-552, `asksTheHuman` at l. 558-565, the Decompose step at l. 567-582, the `increments` binding at l. 584-590, `scope()` at l. 457-474, the increment loop at l. 628-800, the re-cut at l. 780-791, the return at l. 851-862. | One `cutWasReplayed` line above l. 567; the `increments` binding at l. 584-590 replaced, with `let`. Nothing else. |
| `test-repo.sh` | The repository's own suite, 50 cases. Driver heredoc l. 280-677: markers l. 304-318, fixtures l. 320-435, `contextFor` l. 437-478, `returnFor` l. 482-502, mode branches l. 530-665. `run_driver` at l. 679-687, the two-workflow loop at l. 693-706, the `w12` line at l. 710. | Three markers, one fixture function, one return fixture, two `contextFor` arms, one shared mode branch, two `run_driver` lines inside the loop. |
| `skills/agent-brief/assets/backlog.mjs`, the agent pages, `rulebook.md`, `README.md`, `skills/*/SKILL.md` | — | Unchanged. Do not touch them. |

One standing constraint for whoever edits the workflow scripts: `test-repo.sh`
lines 136-159 grep `workflows/*.js` for the word `handoff` in any spelling and
for the file names `researcher.md`, `test-author.md`, `implementer.md`,
`reviewer.md`, `planner.md` and `backlog.md`. Do not write any of them into a
comment or a prompt. The comments this round proposes are clear of both.

### Environment

- Repository root `/home/user/uroboros`, branch
  `claude/structured-prompts-issues-dphlv9`, working tree clean.
- `node` is v22.22.2 on `PATH`; `bash`, `git` and `mktemp` are present.
- `test.sh` and `test-repo.sh` are **not executable** in this checkout (mode
  `-rw-r--r--`), so they are invoked as `bash test.sh` and `bash test-repo.sh`.
  Do not `chmod` them.
- There is no linter and no formatter in this repository. Nothing to run.
- The `tools/` suites `test.sh` runs are zero-install; no command below needs
  network access.

### Test plan

Tests are needed, and the finding needs a failing test first. No fixture has
ever put increments in `backlog.json` while leaving `decompose` unrecorded, so
the branch the finding is about has never been executed by the suite in either
script. Two new driver modes, `w13` and `w14`, each run against **both**
workflow scripts — the expression is duplicated in the two files, and a fix
applied to one only has to fail.

#### What proves the finding

**`w13` — the answered question.** The state a run leaves behind when its
opening cut ended with a question: `increments` holds `i1` and `i2`, and
`run.steps` records `decompose` with the question that stopped the run. The
resumed run must dispatch Decompose again (round 2's fix, already green), and
must then work the cut that Decompose returns — a single increment `i3` — and
not the `i1`/`i2` the file still held when the run started.

**`w14` — the session that died between `init` and `record`.** The same
increments in the file, `run.steps` empty, no question anywhere. The same fresh
cut, and the same expectation. This mode exists to rule out the wrong fix that
keys on the carried question: `w13` alone passes with it, `w14` does not.

Left untested, deliberately, each with the reason:

- A re-dispatched Decompose that returns **no** increments falling back to the
  snapshot. It is a defensive fallback against a malformed return, not a path
  the workflow produces; a mode for it would pin a schema violation.
- The replayed-cut branch (`decompose` recorded, the file authoritative). `w2`,
  `w3` and `w9` already run it in both scripts, and the fix must leave all three
  green — that is this round's regression check and it costs nothing new.
- An increment kept across the re-cut replaying the steps it recorded before.
  That is `backlog.mjs`'s `init` merge, pinned by the recorder suite `test.sh`
  runs, and the workflow does nothing of its own for it.
- The plain loop's Close step and the incremental loop's re-cut, both settled in
  round 3 by `w11` and `w12`, which stay as they are.

#### The cases

All work this round is in one test file, `test-repo.sh`. The command that runs
just it is `bash test-repo.sh`. Its conventions, unchanged: a driver case is one
`run_driver "$wf" <mode> "<description>"` call whose description opens with
`$wf_name` when it runs inside the two-workflow loop; inside the heredoc,
assertions push a sentence onto `failures` via `assertTrue` /
`assertEqualArrays` and the process exits 1 with them on stderr; `agent`, `log`
and `phase` are the only stubs, `logs` captures every `log` call, `calls` holds
every dispatch as `{ label, agentType, prompt }`, and the whole workflow script
is run through `new AsyncFunction`. Every new fixture carries a comment naming
the round and the finding it exists for, as the round-1, round-2 and round-3
fixtures do. Assertion messages that contain an apostrophe are written in double
quotes, the idiom the file already uses.

**1. Shared driver changes** (no case of their own).

- `DISJOINT_MARKERS` (l. 307-318) gains three entries:
  `'MARKER-STALE-CUT'`, `'MARKER-FRESH-CUT'`, `'MARKER-CUT-QUESTION'`. They pass
  the disjointness guard: no existing marker contains any of them and none
  contains another (`MARKER-CUT-QUESTION` shares no whole marker with
  `MARKER-HUMAN-QUESTION`, `MARKER-OPEN-QUESTION` or `MARKER-CLOSE-QUESTION`).

- A new fixture, after `doneBacklog()` (l. 435):

  ```js
  // Round 4, finding 1's fixtures: a state file that holds increments while
  // its decompose step is not replayable, which is the only case in which the
  // Decompose is dispatched again with a populated backlog behind it.
  // `carried` true is the run whose opening cut ended with a question for the
  // human — the increments are in the file and the step is recorded with the
  // question. `carried` false is the session that died between the planner's
  // `init` and its `record` — the same increments, and no decompose step at
  // all. Both make the resumed run work Decompose again, and both used to
  // throw away the cut it returned.
  function recutBacklog(carried) {
    return {
      version: 1,
      issue: 'docs/issues/x',
      workflow: isAgile ? 'agile-loop' : 'loop',
      increments: [
        { id: 'i1', title: 'MARKER-STALE-CUT', goal: 'Deliver i1.', criteria: ['does i1'], status: 'todo', note: '', steps: [] },
        { id: 'i2', title: 'Deliver i2', goal: 'Deliver i2.', criteria: ['does i2'], status: 'todo', note: '', steps: [] },
      ],
      run: {
        steps: carried
          ? [{
              label: 'decompose',
              at: '2026-08-07T00:00:00.000Z',
              return: Object.assign({}, decomposeReturnTwo, { questions: ['MARKER-CUT-QUESTION'] }),
            }]
          : [],
      },
    };
  }

  // The cut the human's answer bought: one increment under an id the stale
  // file does not hold, so a run that works the superseded cut instead shows
  // it in the labels it dispatches as well as in the prompts it sends.
  const decomposeReturnRecut = {
    increments: [{ id: 'i3', title: 'MARKER-FRESH-CUT', goal: 'Deliver i3.', criteria: ['does i3'], status: 'todo', note: '' }],
    questions: [],
    summary: 'backlog summary',
  };
  ```

- `contextFor` (l. 437-478) gains two arms, before `default`:

  ```js
  case 'w13':
    return { stateReturn: { exists: true, backlogJson: JSON.stringify(recutBacklog(true), null, 2) + '\n', summary: '' }, decomposeReturn: decomposeReturnRecut, researchReturn: planReturn };
  case 'w14':
    return { stateReturn: { exists: true, backlogJson: JSON.stringify(recutBacklog(false), null, 2) + '\n', summary: '' }, decomposeReturn: decomposeReturnRecut, researchReturn: planReturn };
  ```

  `returnFor` needs no change: every label these two modes dispatch is already
  covered by it, and the close/replan label falls through to the fixed
  `{ summary: 'closed' }` because neither mode sets `closeFor`.

**2. `w13` and `w14` on both workflows** — one shared mode branch, inserted
after the `w12` branch (l. 644-662) and before the closing `} else {`:

```js
  } else if (mode === 'w13' || mode === 'w14') {
    // Round 4, finding 1: both scripts preferred the increments of the state
    // snapshot they read at startup over the ones Decompose returned,
    // unconditionally — including when Decompose was dispatched in this
    // session rather than replayed. So a planner that read the human's answer,
    // re-cut and rewrote backlog.json had its new cut thrown away, and the run
    // worked the cut the answer had just replaced.
    const closeLabel = isAgile ? 'replan:i3' : 'close:i3';
    assertEqualArrays(labels,
      ['load-state', 'decompose', 'research:i3.0', 'tests:i3.0', 'implement:i3.0', 'review:i3.0', closeLabel, 'publish'],
      'the run worked the stale cut from the state file instead of the cut the re-dispatched Decompose returned');
    assertTrue(!calls.some((c) => c.prompt.includes('MARKER-STALE-CUT')),
      'a prompt of this run carries the superseded increment the state file still held');
    const closeCall = calls.find((c) => c.label === closeLabel);
    assertTrue(!!closeCall && closeCall.prompt.includes('MARKER-FRESH-CUT'),
      'the closing planner was not told about the increment of the fresh cut');
    assertTrue(!!result && Array.isArray(result.blockedOnHuman) && result.blockedOnHuman.length === 0,
      'the run ended blocked on the human instead of working the fresh cut to a close');
    if (mode === 'w13') {
      const decomposeCall = calls.find((c) => c.label === 'decompose');
      assertTrue(!!decomposeCall && decomposeCall.prompt.includes('MARKER-CUT-QUESTION'),
        'the Decompose worked again does not carry the question that ended the last run');
    }
  } else {
```

The `MARKER-FRESH-CUT` assertion is what carries the plain loop: `loop.js` puts
no increment title into the researcher's prompt, and its Close prompt is the one
place the increment it worked is named. On `agile-loop.js` the same title also
reaches every `scope()` block, which the same assertion covers.

**3. Two `run_driver` lines**, inside the two-workflow loop (l. 693-706), after
the `w11` line:

```
  run_driver "$wf" w13 "$wf_name: a Decompose worked again after the human's answer has its new cut worked, not the one the state file still held"
  run_driver "$wf" w14 "$wf_name: a Decompose worked again after a session died before recording it has its new cut worked"
```

Both run on both scripts: the expression is duplicated in the two files.

Nothing else in `test-repo.sh` changes. No case is written against
`skills/agent-brief/assets/`, no grep case is added or removed, and no existing
mode, fixture, marker or assertion is edited beyond the insertions named above.

#### What counts as done

Run these two, from the repository root, and nothing else:

```
bash test-repo.sh
bash test.sh
```

`test-repo.sh` holds every case of this round and runs in seconds, so it is
listed on its own for a diagnosable exit code; `test.sh` is the criterion the
issue states in as many words, and it is the only run that reaches the recorder
suite and the three `tools/` suites this round's edits cannot touch. Expect
`test-repo.sh` to report **54 cases** when this round is done — 50 today, plus
`w13` and `w14` on two workflows each.

#### What is already red

I ran neither command and state this from reading alone. Before the
implementer's change, `w13` and `w14` are red on **both** workflow scripts:
`loop.js` works `i1` from the stale file, so its labels are the `i1` sequence
and its `close:i1` prompt carries `MARKER-STALE-CUT`; `agile-loop.js` works `i1`
and then `i2`, so its label sequence is longer still. In each of the four cases
the label assertion, the stale-marker assertion and the fresh-title assertion
fail together, and the run exits 1. Everything else in both commands was exit 0
in the reviewer's round-3 run — `bash test-repo.sh`, 50 cases, and `bash
test.sh`, all 6 suites — and nothing planned here touches it. Whoever runs the
list first reports what it says.
