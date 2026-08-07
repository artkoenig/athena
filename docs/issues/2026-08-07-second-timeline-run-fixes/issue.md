# Seven fixes the second argus-timeline run argues for

## Problem

The argus-timeline-ui issue was run a second time through `agile-loop`
(2026-08-07, 09:09–14:21 UTC: 44 agents, 77.6M tokens, 30 commits, five of
seven increments closed). The run worked — but its retro, appended to
`docs/issues/2026-08-06-argus-timeline-ui/issue.md`, shows 12.3% of the
subagent spend going to correction rounds that had nothing to correct, 2.8%
lost to a run that cannot survive a user turn, and four places where an agent
had to improvise around missing tooling.

The five findings of `2026-08-07-agile-loop-optimizations` are not these. Three
of them have shipped since (the pure-literal `meta` guard in `test-repo.sh`,
the per-round status `log()`, the per-step push in the agent brief); its
remaining two — telling the researcher the reviewer's mutation standard, and a
`superseded` status for a carried-over increment — attack why coverage gaps
arise and how a run reports itself. This issue attacks what happens after a
gap is found, and what the run costs around the chain.

1. **A correction round whose findings are all coverage gaps still spends the
   full four-agent chain.** All three correction rounds of this run were test
   gaps rather than defects, and they cost 9,347,227 tokens — 12.3% of the
   subagent spend. Two of the resulting commits record an implementer with
   nothing to do in their own subject lines: `d400b64 Record the round-1
   implement step: geometry already pinned` and `2ea9c04 Implement
   lane-select.1: verify the lane-detail guards, no code change`. When every
   finding a reviewer returns is "the behaviour is right but nothing goes red
   when it breaks", the work is a test-author's and a reviewer's; researcher
   and implementer are paid to conclude that the code is already correct.

2. **The UI test harness returns an element for every id, so an assertion can
   pass against markup the page never rendered.** `installFakes` in
   `tools/argus-ui/test/app.test.mjs` resolves `getElementById` through an
   `el(id)` helper that creates and caches a fake element for any id it is
   handed, and never returns `null`. A panel assertion that reads only that
   element therefore stays green after the container is deleted from the
   rendered markup: the page code still writes into the conjured element,
   while a real browser would have got `null`. This single trap caused two of
   the run's three correction rounds — `timeline-landing` round 2 and
   `lane-select` round 2, in separate increments an hour and a half apart. A
   mutation check during the second of them found 8 of 23 cases newly failing
   once the assertions read the composed markup instead.

3. **The run does not survive a user turn, and a session cannot tell that it
   died.** The `context-at-time` reviewer was killed at 14:09 coincident with a
   user message, and its replacement after the resume was killed at 14:21
   coincident with the next one: 2,177,588 tokens for a review that still has
   no verdict. `2026-08-06-loop-resume-after-restart` asks for a self check-in
   that resumes a dead run, which would recover this — but it says "verify the
   task is still alive" without saying how, and the naive check is wrong: in
   this session the workflow was reported to the human as running on the
   strength of transcript file timestamps while it was already dead. The
   authoritative check is the task's own status. Two facts that issue does not
   carry: the kill is caused by an ordinary user turn rather than a container
   reset, and the interrupted agent restarts from zero rather than resuming
   mid-flight, so every interruption costs a whole agent.

4. **Commit signing fails on a path every agent must take.** A researcher's
   commit exited 128 with `Key file set to
   "/home/claude/.ssh/commit_signing_key.pub" (ignored, using server key)` and
   then `signing failed`. Every agent in the chain commits and pushes its step
   return, so this sits on 44 mandatory paths per run, and it fails after the
   agent's real work is already done.

5. **The recorder only accepts a path to a JSON file.** `backlog.mjs record
   <backlogPath> <incrementId|-> <label> <payloadFile>` leaves each agent to
   build that file itself, and building it in a Bash heredoc is where the
   escaping breaks. A researcher whose summary contained an HTML attribute
   (`data-lane-id=\"main\"`) was rejected with `is not valid JSON: Expected
   ',' or '}' after property value`, then spent two further failed calls on the
   recovery — an `od -c` probe and a `node -e` attempt the harness refused for
   containing control characters. Three failed calls to hand a string to a
   recorder.

6. **`bin/parse-agent-log` has no notion of a workflow run.** The retro skill
   tells the session to run it and synthesise, but a workflow run is 44
   separate transcripts plus a `journal.jsonl` that orders them. Every table in
   this run's retro was assembled by looping the tool over each transcript and
   re-joining the results against the journal by hand. The measurement argus
   itself is being built to show is not available about argus's own runs.

7. **No fixture starts and stops the collector for an agent that needs a live
   instance.** An implementer inspecting the API ran `node
   tools/argus/bin/argus.mjs --port 4399 --no-persist`, crashed its inspection
   one-liner (exit 1) and tore the process down with `pkill -f "argus.mjs
   --port 4399"` (exit 144), leaving no guarantee the port was free for the
   next agent. `tools/argus/test/background.test.mjs` and `persist.test.mjs`
   already know how to start and stop a collector; that knowledge is not
   reachable by an agent poking the API outside the suites.

## Acceptance criteria

- [ ] When every finding a reviewer returns is a coverage gap rather than a
      defect, the correction round runs test-author and reviewer only, and
      skips researcher and implementer. What makes a finding a coverage gap is
      decided by the reviewer and carried in its structured return — a field
      the reviewer sets per finding, not a phrase the workflow greps for — and
      a round with even one defect among its findings runs the full chain
      unchanged.
- [ ] The shortened round is visible in the run: the workflow `log()`s that it
      is correcting coverage only, and the reviewer's classification of each
      finding is recorded in `backlog.json` with the round.
- [ ] `installFakes` in `tools/argus-ui/test/app.test.mjs` returns `null` for
      an id the rendered markup does not contain, so page code reading a
      container the page never wrote fails the way a browser would. Every
      existing case still passes, or is corrected to assert what the page
      actually renders.
- [ ] A test proves the harness itself: removing a container from the rendered
      markup makes at least one case go red, and that guard is a case in the
      suite rather than a manual mutation check.
- [ ] The loop skill pages tell the invoking session to establish liveness from
      the task's own status rather than from transcript file timestamps, and
      say plainly that a user turn kills a running workflow, so a session that
      takes a message mid-run knows to check and resume rather than to report
      progress from stale files.
- [ ] `./test.sh` verifies that commit signing works in the environment it runs
      in — a signed commit in a throwaway repository, or the equivalent check
      the setup allows — so a signing misconfiguration is caught before an
      agent's first commit rather than after its work is done.
- [ ] `backlog.mjs record` accepts the step return on stdin as well as from a
      file path, and the agent brief instructs agents to use the stdin form, so
      no agent has to survive a heredoc to record a summary containing quotes
      or markup. The file-path form keeps working.
- [ ] `bin/parse-agent-log` takes a workflow run directory and reports the run
      as one thing: per-agent-type totals, per-agent rows joined to the
      journal's order, tool breakdown with failures, and which agents started
      without returning. The retro skill's instructions use that mode instead
      of telling the session to loop the tool by hand.
- [ ] A documented way to start and stop a collector for ad-hoc inspection
      exists and is named in the agent brief — a script or an existing test
      helper made reachable — so an agent needing a live instance does not
      improvise a `pkill`.
- [ ] `./test.sh` is green.

## Out of scope

- The two open findings of `2026-08-07-agile-loop-optimizations` (the
  reviewer's mutation standard stated in the researcher's brief, and a
  `superseded` status for an increment another increment carried). They attack
  why coverage gaps arise and how the run reports itself; this issue attacks
  what a round costs once a gap is found. Its three shipped findings are done.
- The resume mechanism of `2026-08-06-loop-resume-after-restart` — the periodic
  self check-in and the `resumeFromRunId` re-entry. This issue adds only the
  liveness-check correction and the fact that a user turn is the trigger.
- The reviewer's standard itself. Rejecting a round for missing go-red coverage
  was right every time; nothing here softens it.
- Making the workflow survive a user turn. Whether the platform can keep a
  background run alive across a turn is not this repository's to change; the
  fix here is that the session knows and resumes.
- The argus timeline feature. `docs/issues/2026-08-06-argus-timeline-ui` owns
  it and has one increment still open.

## Evidence

From the `agile-loop` run of 2026-08-07 (run `wf_fe6db294-b60`, branch
`claude/argus-zeitleiste-agile-loop-knnzsj`), measured from the 44 subagent
transcripts, `journal.jsonl`, `backlog.json` and the git history. The full
retro is appended to `docs/issues/2026-08-06-argus-timeline-ui/issue.md`.

- 44 agents spawned, 42 returned, 2 killed. 89 steps, 1,306 subagent tool calls
  (10 failed), 30 commits, 5h 12m wall time.
- 77,590,119 tokens total; the main session accounted for 1,469,097 (1.9%).
  Cache read was 95.3% of subagent tokens and 91.2% of main-session tokens —
  only 3,655,232 tokens (4.7%) of the run were uncached.
- Correction rounds: `timeline-landing` round 2 (2,114,110 tokens), round 3
  (4,469,814), `lane-select` round 2 (2,763,303) — 9,347,227 total, 12.3% of
  subagent spend, none of them a defect.
- Correction rounds per increment before and after the planner began writing a
  provability criterion into each increment: 2 for `timeline-landing`, then
  0 for `lane-activity`, 0 for `scrub-live`, 1 for `lane-select`.
- Killed reviewers: 512,785 tokens (14:09) and 1,664,803 (14:21), both
  coincident with a user message; the second was the resume's replacement for
  the first. The resume itself replayed 42 cached results instantly.
- Failed subagent calls, all 10: `git commit` exit 128 on signing; `backlog.mjs
  record` on invalid JSON, plus two calls in the recovery from it; a `wc -l` and
  a `sed`/`grep` on a missing path; a malformed Bash call carrying `Read`
  parameters; a `Read` of a non-existent file; the collector one-liner (exit 1)
  and its `pkill` (exit 144).
- No test-suite failure in the run came from a missing dependency or an unset
  variable; `npm --prefix tools/argus test` and `npm --prefix tools/argus-ui
  test` ran clean throughout.
