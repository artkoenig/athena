# Measuring one athena run end to end

A full run — idea to pushed branch — was played through on a throwaway project
and measured with `tools/observability`. A second run of the same task without
the plugin ran as a control. This page records what it cost, where the tokens
went, and the ten things the measurement found.

Everything below is a measured number or a quoted file. Where something is an
assumption, it says so.

## The setup

| | with athena (A) | control (B) |
| --- | --- | --- |
| project | `tally`, a 30-line ESM word-frequency module, `node --test`, 5 cases green | identical copy |
| plugin | `athena@athenatest`, built from this checkout at `2776466` | none |
| idea handed over | *"countWords soll mir auch nur die häufigsten Wörter geben können, also Top 5 statt aller. Sonst bleibt alles wie es ist."* | identical |
| session | `claude -p`, opus-5, own `--session-id`, own bare `origin` | identical |

Both sessions exported OTLP to the same collector. The plugin was rebuilt from
the checkout on purpose: the installed one is older (see finding 8).

The control matters because the plain CLI's own context is nine tenths of the
starting size — without it, "athena costs 32k tokens to start" would be a
meaningless number.

## What it cost

Collector aggregates (`GET /api/sessions/:id`, source `metrics`):

| | A (athena) | B (control) | ratio |
| --- | --- | --- | --- |
| tokens total | 2,874,332 | 322,132 | 8.9× |
| cost | $3.30 | $0.37 | 9.0× |
| wall clock | 611 s | 63 s | 9.6× |
| LLM requests | 67 | 8 | 8.4× |
| tool calls (collector; see finding 9) | 73 | 11 | 6.6× |
| lines changed | +360 / −27 | +37 / −5 | |

What the 9× bought, stated as artefacts rather than as quality: 8 numbered
acceptance criteria fixed before any code, 166 lines of tests against them
including the edges, a 151-line record of decisions and checkpoints, a review
round with two findings, and a second issue filed for what those findings
touched. The control produced 23 lines of tests and one commit.

It did not buy a better function. Both runs implemented the same slice of a
sorted array. The control chose an options object, `countWords(text, {top})`;
athena chose a positional `countWords(text, limit)` — and then its own reviewer
reported that the positional form silently misreads `['a b','c'].map(countWords)`,
which the options object would not have. The record caught the hazard the
decision created.

## Where the tokens went

Per stage, from the run's own stream (`parent_tool_use_id` separates the
subagents), billed input = input + cache read + cache write:

| stage | messages | billed input | share |
| --- | --- | --- | --- |
| main thread (orchestrator) | 39 | 2,125,389 | 76% |
| test-author | 12 | 227,750 | 8% |
| implementer | 17 | 343,389 | 12% |
| reviewer | 9 | 116,547 | 4% |

The subagents are not the expensive part. The orchestrator is: it holds the
longest context, it takes the most turns, and 30 of its 48 tool calls neither
read nor write code — 13 edit the issue file, 17 maintain a task list
(findings 4 and 6). Tool calls per stage, counted as distinct `tool_use` ids:
main 48, test-author 12, implementer 17, reviewer 16.

## What athena adds to every session, before any work

First-turn context, A minus B: **3,454 tokens**, on top of the CLI's own
28,853. Split by character share of the injected texts:

| part | ~tokens |
| --- | --- |
| the rulebook, verbatim, from the SessionStart hook | 2,299 |
| four agent descriptions | 756 |
| two skill descriptions | 398 |

Two thirds is the rulebook itself. The single largest agent description is the
reviewer's, at 881 characters (~297 tokens) — resident in every session,
including the ones that never review anything.

## Findings

Each names what was measured, then what follows from it. None was fixed in the
change that measured them; they are the retro this run owes. Where a later
change on this branch settled one, a closing line says how — the measurement
above is left as it was taken.

### 1. `read the intent` withholds nothing

`skills/issue/SKILL.md` promises, for the test-author above all: *"return only
the running issue's `## Intent`, verbatim … the guarantee this operation makes
is what it withholds."*

Measured. The test-author's first three calls:

```
Skill  athena:issue  args="read the intent"
Bash   ls -la .../docs/issues/
Read   .../docs/issues/2026-08-02-countwords-top-n.md
```

A skill is a page, not a function — it returns a procedure, and the agent then
performs the lookup itself with the tools it has. There is no mechanism by
which the Intent arrives alone, so the whole file arrived, `## Decisions`
included. That section already named the implementation: *"a second, optional
positional parameter"*, *"throws `TypeError`"*, *"`0` … yields an empty
result"*. The test-author was written blind and read the answer.

Nothing visibly went wrong in this run — but the guarantee that makes the
test-author worth dispatching is not one the current design can keep.

Either the operation ships something that can actually cut the file
(`assets/` is where the skills page already puts executables), or the page
stops promising a guarantee and says it is a convention.

*Since measured:* the mechanics moved into the `tracker` subagent, which reads
the file in its own context and returns the Intent alone. The guarantee is now
one the design can keep, because a separate context is what withholds.

### 2. Three round trips to reach the tracker, per dispatch

The same `Skill → ls → Read` triple ran for the implementer. The rulebook
requires it: *"Every dispatch hands over a reference to the issue, never its
content retold"*, and the issue skill: *"A caller hands this skill content and
names an operation — never a path, a filename, a frontmatter key or a
heading."*

So the caller, which knows the path, may not say it, and each subagent spends
three LLM round trips rediscovering it — plus the 10 KB skill page loaded whole
to perform one operation.

The interface argument holds for *writing* — the format should stay the skill's.
It does not hold for *finding the file*. A dispatch that names the path costs
one `Read`.

*Since measured:* the triple is gone from both ends. A subagent that needs its
own narrow read finds the file itself and has no `Skill` tool; the tracker gets
its page preloaded, so no run-time call loads it at all.

### 3. The reviewer's prescribed lookup cannot work where the run puts it

`agents/reviewer.md`: *"read its `## Intent` at the tip of the range via git
(`git show HEAD:path`, not a working-tree `Read`), so what you see can never
drift from the range you were actually handed."*

The rulebook reviews before it commits. At review time the change — the issue
file and every new test file included — was staged, not committed, so
`git show HEAD:docs/issues/…` names a file that does not exist at `HEAD`. The
reviewer worked it out and used `git show :path`, the index, for all four
files it read.

It recovered, so this cost nothing but tokens. The run's own retro found the
same gap independently and proposed the fix from the other end: say in the
rulebook that everything is staged before the review.

### 4. Two progress records, and the one the rulebook points at does not survive

`CLAUDE.md`: *"Track it as tasks: `TaskCreate` one per stage … A session
picking the work back up reads `TaskList` for where the run stands, instead of
asking."*

Measured, 13 calls: `TaskList` ×1, `TaskCreate` ×6, `TaskUpdate` ×6.

Then measured again, in a fresh session in the same project:

```
$ claude -p "Rufe TaskList auf und gib nur zurück, wie viele Tasks es gibt."
0 Tasks, keine Betreffzeilen.
```

The task list is session state. The session that would need it is by definition
a different one, and for that session the list is empty. The issue file's
`## Log` holds the same progress, is written anyway, and does survive — the
issue skill's *orient a session* is built on exactly that.

So the run keeps two records of one thing, and pays 13 round trips at the
orchestrator's context for the one that evaporates.

*Since measured:* the rulebook no longer asks for the task list. The issue
file's `## Log` is the only progress record, and *orient a session* reads it.

### 5. Both tables the rulebook makes mandatory were skipped

*"A run opens with the issue in front of the human: title and its numbered
criteria, as a table."* and *"After every round, show the human a table … each
cell a count. Whether the run converges must be visible, not asked for."*

The run produced three messages to the human. Neither table is in any of them.

The rulebook argues against itself here — *"only as many sentences as they
need now"*, *"a clear request needs no ceremony"* — and in an unattended `-p`
run, where nobody is watching a criteria table before the work starts, the
brevity rule won. A rule that loses to another rule in the normal case should
say who it is for, or go.

### 6. The record is maintained by the most expensive context in the run

13 of the orchestrator's tool calls are `Write`/`Edit`/`Read` on the issue
file. Each is one LLM request against the largest context in the run — the
orchestrator's, which peaked at 69,492 tokens. The rulebook asks for this
directly: decisions and observations go into the issue *"as they happen"*.

"As they happen" is what makes the record trustworthy, so this is a real cost
for a real thing, not waste. But it is the single biggest line item in the
run's biggest stage, and it is the one place where batching — one edit per
stage instead of per thought — would change the number without changing what
the record says.

*Since measured:* the writing moved out of the orchestrator entirely. The
`tracker` holds it in its own context and runs on the smallest model athena
uses, so "as they happen" stays and the price of each one drops twice over.

### 7. The rulebook is in context twice in athena's own repository

Not in the test project — in this one. The SessionStart hook injects the
plugin's `CLAUDE.md` verbatim, and Claude Code loads the checkout's `CLAUDE.md`
as project instructions. Both are in context, ~2,300 tokens each.

In the session that wrote this page they were not even the same text: the hook
delivered the version with *"The invariants"*, the checkout has the version
with *"The run"*. Two rulebooks, one session, differing wording of the same
rules.

This only bites the repository that ships the plugin. It bites it every
session.

### 8. The installed plugin is older than the repository it was installed from

Measured in this session: the plugin cache holds `c3d9102`, `origin/main` is
at `2776466` — eleven commits ahead, with a changed rulebook and all four
agent pages changed. The cached `agents/reviewer.md` still says the caller hands the
reviewer *"the written intent copied from the issue word for word"*; the
checkout says the caller hands it *"the repository root and the diff range,
nothing else"*.

`README.md` says: *"Updates come with the next session, not with a
re-installation."* For this session they did not.

Not verified: whether a session in a fresh container would pick them up. The
cache here was populated when the container started. What is verified is that
a running session can be reading a rulebook three commits behind the
repository open in front of it — which is why the measurement above built its
own marketplace from the checkout instead of trusting the installed one.

### 9. The collector undercounted tool calls by a fifth

Tokens and cost agreed with the CLI to the cent. Tool calls did not: the
collector reports 73 for run A, the session's own stream carries 93 distinct
`tool_use` ids. Per tool, `Bash` 33 against 43, `TaskUpdate` 6 against 10,
`Edit` 10 against 13, `Write` 3 against 5 — while `Read`, `Skill`,
`TaskCreate` and `ToolSearch` match exactly.

The token figures come from metrics, the tool figures from log events, so a
dropped export window would explain it — `README.md` warns that at process
exit *"there is only a narrow flush window"*. That does not explain why the
gap sits in four tools and not across all of them. Unverified either way; this
page therefore takes tokens and cost from the collector and tool structure
from the stream.

### 10. One tool-discovery detour

`ToolSearch` ×2, one of them `select:Monitor`. That is the harness's deferred
tools, not athena's doing. Recorded because the question asked for tool calls
caused by missing information, and this is the only one that was not.

## What worked

Stated as plainly as the findings, because it is the same measurement.

- **The criteria were fixed before any code and nothing moved them.** Eight of
  them, each falsifiable. Two agents hit edges the criteria did not decide —
  the test-author on an explicitly passed `undefined`, the reviewer on the
  arity change — and both came back as a question. Neither guessed, neither
  reinterpreted a criterion.
- **Triage held.** The review's two findings violated no criterion and were
  filed as their own issue with a reproduction, not fixed in the diff.
- **The reviewer did not trust the record.** It re-established the log's own
  numbers — 5 cases at the base commit, 35 cases / 18 pass / 17 fail with the
  new tests against unchanged source — in a throwaway worktree it created and
  removed. That is what makes the log worth reading.
- **The absence of static analysis was reported as a fact, with the commands
  that established it**, rather than as "green".
- **The run wrote its own retro and found two of the findings above** —
  number 3 and the `pr:` field having no honest value where the remote has no
  pull requests — without being asked.

## Reproducing this

```bash
# collector
node tools/observability/bin/athena-observe.mjs

# one measured run, own session id so the collector can separate it
env -u CLAUDE_CODE_SESSION_ID \
  CLAUDE_CODE_ENABLE_TELEMETRY=1 CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1 \
  OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 \
  OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf \
  OTEL_METRICS_EXPORTER=otlp OTEL_LOGS_EXPORTER=otlp OTEL_TRACES_EXPORTER=otlp \
  OTEL_METRIC_EXPORT_INTERVAL=1000 OTEL_LOGS_EXPORT_INTERVAL=1000 \
  OTEL_TRACES_EXPORT_INTERVAL=1000 OTEL_LOG_TOOL_DETAILS=1 \
  claude -p "<the idea>" --session-id "$(uuidgen)" \
    --output-format stream-json --verbose
```

Two traps this measurement fell into first, both worth knowing:

- **`CLAUDE_CODE_SESSION_ID` is inherited.** Every child session then reports
  the parent's id and the collector merges them into one. `--session-id` fixes
  it; `env -u` alone does not, because the id is also derived from the remote
  session.
- **`--output-format stream-json` repeats a message id while it streams.**
  Summing usage per line double-counts; keep the last version of each `id`.
  The collector's aggregates are the safer number — they matched the CLI's own
  `total_cost_usd` to the cent for the control run.
