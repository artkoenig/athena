# The run learns the codebase once, not once per agent

## Problem

The agile-loop run that delivered
`docs/issues/2026-08-07-timeline-focus-and-context-filter` (PR #65: 4
increments, 35 agents, 4 h 45 m) spent **38 % of its chain time reading** —
58 m 27 s against 58 m 18 s of writing. Almost none of it was new: the run
opened **192 files through `Read` across 26 distinct paths, a repetition
factor of 7.4**, and 86 % of those opens were of a file some agent in the
same run had already opened. Another 41 reads went through `Bash`
(`cat`, `sed -n`, `git show`) and 18 through `Grep`, at the same paths.

This is not an agent behaving badly. It is the run having nowhere to put what
it learns.

1. **The module map is built seven times and kept zero times.** `moduleMap`
   and `environment` are already structured fields of the researcher's return
   — the schema asks for "the files the change touches: path, what each
   holds, the entry points". They reach exactly one reader: the implementer of
   the same round. The next round's researcher is handed the review findings
   and nothing else; the next increment's researcher cannot be handed anything,
   because `close()` deletes every step return on purpose ("nobody downstream
   re-reads the returns that got it there"). So each of the seven researchers
   rebuilt the map from the filesystem. After the first one, **30 of their 40
   file-opens were files an earlier researcher had already opened** — five of
   the six later researchers found between one and four genuinely new files
   each. Cost: 67 `Read` calls, 17.2 M cache-read tokens, 21 m 24 s, and the
   researcher is the most expensive role per agent in output tokens.

2. **The test-author is the most expensive role in the run and gets the least
   about the code.** 31.4 M cache-read tokens over six agents — 5.24 M each,
   more than double any other role. Its whole brief is `plan.testPlan`. That
   plan names the target file by path and says the file's conventions matter,
   but nothing carries what those conventions *are*, so the author reads the
   file whole to find out where a case belongs and which helper to reuse.
   `context.test.mjs` was opened 20 times in the run, `page.test.mjs` 19,
   `timeline.test.mjs` 12. One agent alone read 13.8 M cache tokens.

3. **The reviewer re-derives the diff every round, and that part is not its
   independence.** The reviewer is deliberately handed no part of the plan;
   that is what makes it a second pair of eyes and it must stay. But 17.9 M
   cache-read tokens and 20 m 48 s went into re-touring the repository to find
   what changed, across seven agents. What changed is a fact of git, not a
   part of the plan — a reviewer told which files the increment touched still
   forms its own judgement about them.

4. **`issue.md` is read once by every single agent.** 26 opens, one per agent,
   ~330 000 characters, even though `scope()` already injects the increment's
   criteria into every prompt. It is the brief, so this is the most defensible
   of the four — but it is still the same bytes 26 times, and the prompt
   already carries the part that matters.

The shape of the fix is one idea: the run keeps a small, durable map of what it
has learned about the codebase, every agent that needs it starts from it, and
each amends it instead of rebuilding it. `close()` sheds step returns to keep
`backlog.json` from growing without bound, and that reason is sound — so the
map is run-level and capped, not another step return.

## Acceptance criteria

- [ ] `backlog.json` carries a run-level `map` alongside `issue`, `workflow`,
      `increments` and `run`. It holds what the run has learned about the
      codebase — the module map and the environment as the last researcher
      left them — for the whole issue, not one copy per increment.
- [ ] `close()` sheds step returns exactly as it does today and does **not**
      shed the map. A re-cut (`init`) preserves it the way it preserves
      `run.steps`.
- [ ] The recorder enforces a size ceiling on the map and refuses a write past
      it with a message naming the limit and the actual size, so the field
      cannot grow into the bloat `close()` exists to prevent. The ceiling is a
      named constant, and `backlog.test.mjs` covers both sides of it.
- [ ] Every researcher dispatch carries the map when one exists, with the
      instruction to amend rather than rebuild: verify it where its increment
      touches, correct what is wrong, add what is missing, and return the
      whole amended map. A researcher handed no map returns the map it built.
- [ ] The researcher's return carries a suite index — for each test file the
      change touches, what it covers, the helpers and fixtures a new case
      should reuse, and where a case for this increment belongs — and the
      test-author dispatch carries it. It is part of the map, so it survives
      into later increments like the rest.
- [ ] The reviewer dispatch names the files the increment's diff touches. It
      is still handed no plan, no map, no test plan and no researcher output —
      only the file list, which it could compute itself from git.
- [ ] `workflows/loop.js` carries the same map across its correction rounds.
      It has no increments to cross, but it has rounds, and its researcher
      re-derives across them for the same reason.
- [ ] `agents/researcher.md` states the amend-don't-rebuild contract once, in
      one wording, wherever the page and the prompts divide that
      responsibility today.
- [ ] `./test.sh` is green.

## Out of scope

- **The reviewer's independence.** It stays blind to the plan, the map and
  every other agent's output. The one thing it gains is the diff's file list.
- **Trimming `issue.md` out of the agents' reading.** Finding 4 is real but
  small, and the file is the brief; cutting it risks an agent working from a
  summary of its own work order. Worth its own issue if the map lands and the
  reads stay high.
- **The five optimizations filed in
  `docs/issues/2026-08-07-agile-loop-optimizations`** (mutation standard in
  the researcher's brief, per-round status log, push after every step, pure
  `meta` literals, a word for a superseded increment). None of them is this;
  this one touches the same two scripts, so whichever lands second rebases on
  the first.
- **Caching at the platform level.** The run's cache efficiency was already
  15.0 : 1. The waste here is agents re-deriving knowledge, not the transport
  re-sending bytes.
- **The dead session** that cost this run 1 h 31 m. That is a resume problem,
  already filed.

## Evidence

Measured from the 35 subagent transcripts and the main-session transcript of
the run of 2026-08-07 (session `claude/timeline-implementation-adjustments-t8s8rz`,
PR #65), window 14:43:22–19:28:43 UTC.

Wall clock inside the 2 h 33 m agent chain:

| Activity | Time | Share |
| --- | ---: | ---: |
| reading | 58 m 27 s | 38.2 % |
| writing | 58 m 18 s | 38.1 % |
| verifying | 17 m 04 s | 11.1 % |
| reporting, recording | 18 m 52 s | 12.3 % |

Reads, by file (`Read` tool only):

| File | opens | distinct agents |
| --- | ---: | ---: |
| `tools/argus-ui/public/app.js` | 28 | 16 |
| `docs/issues/…/issue.md` | 26 | 26 |
| `tools/argus-ui/test/context.test.mjs` | 20 | 12 |
| `tools/argus-ui/test/page.test.mjs` | 19 | 13 |
| `tools/argus-ui/public/context.js` | 12 | 12 |
| `tools/argus-ui/public/timeline.js` | 12 | 10 |
| `tools/argus-ui/test/timeline.test.mjs` | 12 | 6 |
| `tools/argus/README.md` | 11 | 4 |
| `tools/argus-ui/README.md` | 10 | 9 |
| `tools/argus-ui/test/independence.test.mjs` | 9 | 11 |
| **total** | **192** over 26 files | 7.4× repetition |

166 of the 192 opens (86 %) were repeats, ≈1.69 M characters, ≈424 k tokens.

By role:

| Role | n | cache read | per agent | `Read` calls | reading time |
| --- | ---: | ---: | ---: | ---: | ---: |
| `test-author` | 6 | 31,422,141 | 5,237,023 | 46 | 9 m 15 s |
| `reviewer` | 7 | 17,932,123 | 2,561,731 | 38 | 20 m 48 s |
| `researcher` | 7 | 17,224,186 | 2,460,598 | 67 | 21 m 24 s |
| `implementer` | 8 | 9,934,840 | 1,241,855 | 27 | 4 m 42 s |
| `planner` | 5 | 2,908,521 | 581,704 | 5 | 1 m 55 s |

New files per researcher, in run order — the first builds the map, the rest
mostly re-walk it:

| Researcher | distinct files opened | of them new to the run |
| --- | ---: | ---: |
| #3 (increment 1, round 0) | 7 | 7 |
| #7 (increment 1, round 1) | 5 | 1 |
| #12 (increment 2, round 0) | 7 | 1 |
| #17 (increment 3, round 0) | 9 | 4 |
| #21 (increment 3, round 1) | 3 | 1 |
| #25 (increment 4, round 0) | 9 | 2 |
| #30 (increment 4, round 1) | 7 | 1 |

The design decisions this issue works against, both deliberate and both worth
keeping in spirit:

- `skills/agent-brief/assets/backlog.mjs`, `close()`: "a closed increment's
  record is its status, its note, its criteria and the git history, and nobody
  downstream re-reads the returns that got it there."
- `workflows/agile-loop.js`: "The slice each role gets, and no more. The
  test-author is given the test plan and nothing else about the change; the
  implementer the plan, the map, the environment, the checks and the tests
  that now exist; the reviewer the checks alone."
