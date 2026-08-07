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
