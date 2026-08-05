# Dispatcher handoff — Zwei Modi: Issue-Modus und Direkt-Modus

Loop: 1 (first pass). Branch: `claude/zwei-modi-issue-workflow-2fnxb4` — stay
on it, never push to `main`/`master` (the shipped `pre-push` guard refuses it
anyway).

## 1. What this change is

A documentation-only change to the rulebook. The Main Session today has
exactly one way to work: grill, write the issue file, dispatch the
`dispatcher`, and touch nothing else. The change adds a second mode in which
the Main Session does the work itself, and makes the rulebook say which mode
applies and how the choice is made.

No production code, no scripts, no tests, no configuration change. Nothing in
this repository asserts anything about the *content* of the rulebook, so no
test can be written for this (see section 5 for the evidence). The suite must
still be run and reported green.

## 2. Acceptance criteria (verbatim from `issue.md`, translated intent kept)

The implementer does not read `issue.md`, so they are reproduced here in full:

1. The rulebook (`CLAUDE.md`, and `.claude/rules/` where needed) describes two
   modes: **Issue Mode** and **Direct Mode**.
2. At the start of a new task the Main Session settles which mode applies. If
   the user already named the mode ("mach das direkt", "leg ein Issue an"),
   there is no question.
3. **Issue Mode:** unchanged. Every responsibility and every restriction the
   Main Session has today still holds — no code reading, no code changes, no
   git, no implementation plan; write the issue file, get it confirmed, call
   `dispatcher`.
4. **Direct Mode:** the Main Session may read code, change code and tests, run
   the tests, commit and push. No issue file, no dispatcher, no subagents
   required. A broad search through the code may still be handed to a subagent
   to save context.
5. The mode belongs to the task, not to the session. If a direct task grows,
   the Main Session may switch to Issue Mode and says so.
6. The texts stay short and in the language of the existing rulebook. No new
   machinery, no flags, no configuration file.

Defaults already recorded in the issue (do not re-open them):
- The mode is settled at the start of a task, not per message.
- Commit and push are allowed in Direct Mode.
- With no statement from the user and no way to ask, Issue Mode holds.

## 3. Module map — the files this touches

| Path | What it holds | Role in this change |
| --- | --- | --- |
| `/home/user/athena/CLAUDE.md` | The rulebook, 42 lines. Sections: intro (3 principles), `## The Main Session` (`### Your Responsibilities`, `### Your Restrictions`), `## The Human`. | **The change.** Rewrite the `## The Main Session` section. |
| `/home/user/athena/GEMINI.md` | A byte-identical copy of `CLAUDE.md` (verified: `diff CLAUDE.md GEMINI.md` is empty). Nothing in the repo references it; it is the same rulebook for the Gemini CLI and has been changed in the same commit as `CLAUDE.md` in the past (`2221334`). | **Must be updated to stay byte-identical.** Copy `CLAUDE.md` over it. |
| `/home/user/athena/.claude/rules/agents.md` | Path-scoped (`paths: agents/**`) page about how subagent pages are written. Says nothing about the Main Session's modes. | **No change.** Nothing here contradicts the two modes. |
| `/home/user/athena/hooks/session-start.sh` | SessionStart hook. Reads `${plugin_root}/CLAUDE.md` and puts its whole text into the session context verbatim (JSON-escaped), plus a self-check line. | **No change.** It ships whatever `CLAUDE.md` says; the new text reaches sessions automatically. |
| `/home/user/athena/skills/grill/SKILL.md` | The grill skill: vague idea → filed issue with approved criteria. Contains "The main session does NO research of its own in the codebase" and "The main session does no git operations". | **No change — deliberate.** Grill exists only to produce a filed issue, i.e. it is an Issue-Mode tool, and there its statements stay true. Restating the mode split here would be a second description of one rule (`skills/CLAUDE.md`: "Describe each thing once"). |
| `/home/user/athena/agents/*.md` | The four subagent pages. | **No change.** The subagent flow is untouched; Direct Mode simply does not enter it. |
| `/home/user/athena/README.md` | Project page. Describes the bet on judgment and the unattended run; does not enumerate the Main Session's steps. | **No change.** It never claims the issue route is the only one. |

Out of scope, noticed while researching — report as notes, do not fix:
- `skills/grill/SKILL.md` line 44 hands over to a `researcher` subagent; no
  such agent exists (it is `dispatcher`).
- `.githooks/pre-push` cites "CLAUDE.md, Bookkeeping"; there is no Bookkeeping
  section in the current rulebook.

## 4. Implementation plan

### 4.1 The exact target text

Replace lines 13–30 of `/home/user/athena/CLAUDE.md` — the whole block from
`## The Main Session` up to and including the line
`- All research and code work is delegated to the subagents, starting with the `dispatcher`.` —
with the text below. The intro (lines 1–11) and `## The Human` (lines 32–42)
stay exactly as they are.

```markdown
## The Main Session

You are the **Main Session**. You are the primary interface to the human.

Two modes, and a task runs in one of them: **Issue Mode**, where the subagents
do the work, and **Direct Mode**, where you do it yourself. The human names it
— "mach das direkt", "leg ein Issue an" — and then it stands. If they did not,
ask once, in one line, and say which one you would take; that is a question,
not a fourth steering point, and unanswered it falls to Issue Mode.

The mode belongs to the task, not to the session — the next task settles it
again. A direct task that turns out bigger than it looked moves to Issue Mode;
say so when it moves.

### Issue Mode

The requirements are yours, the work is the subagents'.

1. **Collect Requirements:** Conduct the initial interview ("grill") to clarify the user's intent.
2. **Create the Issue File:** Establish the acceptance criteria and write them to a new issue file under `docs/issues/` (e.g. `docs/issues/<timestamp>-<slug>/issue.md`).
3. **Confirm the acceptance criteria** with the human.
4. **Dispatch Dispatcher:** Once the issue is created and confirmed, dispatch the `dispatcher` subagent and hand over the filename of the issue.

And what you do not do here:

- **No Implementation Plan:** You do NOT write implementation plans.
- **No Code Reading:** You may not read the codebase. Your context is the most expensive in the run.
- **No Git Operations:** You do not run git operations.
- **No Code Changes:** You do not modify production code or tests.
- All research and code work is delegated to the subagents, starting with the `dispatcher`.

### Direct Mode

Small or obvious work: you do it. Read the code, change the code and the
tests, run them, commit, push. No issue file, no dispatcher, no subagent is
required. Push to a branch — the default branch still advances only through a
merged pull request.

Hand a broad search through the code to a subagent anyway; it comes back as an
answer instead of as a hundred files in your context.
```

### 4.2 Rules the text follows (keep them if you reword anything)

- **English.** The rulebook is English; the issue is German. Only the two
  quoted user phrases stay German, because they are what the human says and
  the rulebook already speaks German to the human ("Informally (German: du)").
- **The four Issue-Mode numbered items and the five restriction bullets are
  copied verbatim from today's file**, except that the trailing space after
  "You do not modify production code or tests." is dropped. Criterion 3 says
  Issue Mode is unchanged, so do not re-word them. The only structural change
  is that the two `### Your Responsibilities` / `### Your Restrictions`
  headings are replaced by the `### Issue Mode` heading with two short
  lead-in lines — nesting them one level deeper (`####`) would be heavier for
  no gain.
- **Line width.** New prose wraps at ~76 columns, like the intro and
  `## The Human`. The copied list items keep their existing long single lines.
- **No new machinery.** No flag, no file, no state to store, nothing a tool
  has to read. The mode lives in the conversation.

### 4.3 Decisions already taken (do not re-litigate; a reviewer asking about
these gets this section as the answer)

- **Why the mode question is not a fourth steering point.** `## The Human`
  says "Three steering points, nothing else". The mode question would read as
  a contradiction, so the text defuses it in the same breath ("that is a
  question, not a fourth steering point") and names the default for the
  unanswered case, which is exactly what the existing away-rule prescribes
  ("pick a default, record it as a default, carry on"). `## The Human` itself
  is therefore left untouched.
- **Why the push guard is named in Direct Mode.** Direct Mode is the first
  time the rulebook lets the Main Session push. Without the clause a session
  could push to `main`; the hook would refuse it, but the rulebook would have
  been silent. One clause, no new rule — the human merging the pull request is
  already in `## The Human`.
- **Why `GEMINI.md` is in scope.** It is a verbatim copy of the rulebook for a
  second CLI. Leaving it behind means two rulebooks that disagree about what
  the Main Session may do.
- **Why grill is not touched.** See the module map.

### 4.4 Steps

1. Edit `/home/user/athena/CLAUDE.md` as in 4.1.
2. `cp /home/user/athena/CLAUDE.md /home/user/athena/GEMINI.md` — then verify
   with `diff /home/user/athena/CLAUDE.md /home/user/athena/GEMINI.md`
   (must print nothing, exit 0).
3. Run the suite (section 5) and record the exit codes.
4. Write `/home/user/athena/docs/issues/2026-08-05-zwei-modi/implementer.md`.
5. Commit `CLAUDE.md`, `GEMINI.md` and the handoff on
   `claude/zwei-modi-issue-workflow-2fnxb4`. Do not push to `main`.
6. Dispatch the `reviewer` with this issue directory.

## 5. Tests — why none are written, and what to run

Searched for anything that asserts rulebook *content*:
`grep -n "CLAUDE.md" test-plugin.sh` returns only mechanical uses — the
scratch copy of the plugin (line 32), `claude plugin validate --strict`
warnings (205–209), the verbatim-delivery case (372–373: the whole text of
`CLAUDE.md` must arrive in `additionalContext`), a version-marker case (401)
and the missing-rulebook case (546–549). None of them read a heading, a
section name or a phrase. `test-repo.sh` covers licences and the deployment
only. So there is no test that can express "the rulebook describes two modes"
without inventing a new content-assertion suite — that would be exactly the
new machinery criterion 6 forbids. Hence: no `test-author`, the implementer is
dispatched directly.

Still run and report, with the command and the exit code:

```bash
bash /home/user/athena/test.sh
```

It runs `test-repo.sh`, `test-plugin.sh`, `test-worktree.sh` and the three
`tools/*` npm suites. Expected: unchanged and green — in particular the
verbatim-delivery case, which now carries the new text. If a suite was already
red before this edit, say so with the evidence (`git stash` + re-run) instead
of chasing it; scope is the brief.

## 6. Definition of done

- `CLAUDE.md` has `## The Main Session` with `### Issue Mode` and
  `### Direct Mode`, the mode-choice paragraph, and the Issue-Mode lists
  unchanged in substance.
- `GEMINI.md` is byte-identical to `CLAUDE.md`.
- Nothing else in the repository is modified except the handoff file.
- `bash test.sh` reported with its exit code.
- Handoff written, everything committed on the issue branch.
