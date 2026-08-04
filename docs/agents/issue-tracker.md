# Issue tracker: local markdown

Work for this repository is tracked as local markdown issues in two levels.

## Layout
- Root: `Issues/`.
- A top-level `NN-<slug>/` directory is a **main-issue**: it maps 1:1 to one
  branch `issue/<slug>`, one worktree and one pull request, and its `issue.md`
  holds the specification (PRD). It carries a `Type:`
  (feature|fix|refactor|chore) — the change category that used to be a
  branch-name prefix.
- The directories nested inside a main-issue are its **child-issues** — the
  vertically-sliced units that make up that one PR. A child-issue inherits its
  main-issue's type.
- Each issue is a directory `NN-<slug>/` with an `issue.md`, addressed by its
  path relative to `Issues/`, e.g. `01-checkout/02-cart-api`.

## States (enforced transitions)
- `needs-triage` — awaiting evaluation by the maintainer
- `needs-info` — waiting for feedback
- `ready-for-agent` — fully specified, ready for autonomous implementation (AFK)
- `claimed` — in progress by the agent
- `resolved` — implemented and done
- `superseded` — closed without being implemented: replaced by another issue,
  made obsolete, or a duplicate. Which of those it was is stated in the
  mandatory reason, not in the state name.

Allowed transitions:
- `needs-triage` -> `needs-info`, `ready-for-agent`, `superseded`
- `needs-info` -> `ready-for-agent`, `needs-triage`, `superseded`
- `ready-for-agent` -> `claimed`, `needs-info`, `superseded`
- `claimed` -> `resolved`, `ready-for-agent`, `superseded`
- `resolved` -> `ready-for-agent` (reopen)
- `superseded` -> `needs-triage` (reopen)

`superseded` is reachable from every open state — work in progress can become
obsolete too — but never from `resolved`: finished work is not undone after the
fact. The transition requires a reason and is rejected without one:

```bash
tracker.py set-status <id> superseded --reason "Subsumed by 03-cart-rewrite."
```

The reason is recorded as a comment on the issue.

`resolved` and `superseded` both count as **closed**. A main-issue cannot become
`resolved` while any child-issue is still open, so it is "done" — and its PR
ready to open — only once its whole subtree is closed; a `superseded`
child-issue does not hold it up. Likewise a `superseded` blocker releases the
issues it blocks — otherwise an issue that will never be implemented would block
its neighbours forever.

## Planning a main-issue (module level, before slicing)
Right after a main-issue's specification exists — and before deciding whether
it needs child-issues at all — a module-level plan is written once,
unconditionally, to a **temporary** `Issues/<main-id>/design.md`: a module
map, an explicit single-module-vs-multiple-modules classification, and the
shared contracts (interfaces, types, data shapes) a slice would need to honour.
That classification is one input — not a hard rule — into whether the
main-issue actually gets sliced into child-issues; each slice, if any get
created, reads `design.md` while implementing. `design.md` is a working
artifact: it is deleted before the main-issue is committed, so it never enters
the PR, and the `issue.md` files stay solution-free. It exists for every
main-issue, including one that ends up with no child-issues at all — it is not
skipped just because the work turned out to be a single slice.

## Implementing a main-issue
Every child-issue is implemented on the main-issue's one branch `issue/<slug>`;
the pull request is opened only once every child-issue is closed (`resolved`, or
`superseded` for a slice that turned out not to be needed).

Work the child-issues one at a time. For each:
1. Pick the next actionable child with `tracker.py next --parent <main-id>`. It
   returns the next `ready-for-agent` child whose blockers are all closed.
   If nothing is returned, there is no ready work.
2. Claim it: `tracker.py set-status <id> claimed`, and read it with
   `tracker.py show <id>`.
3. Implement **only** what that child specifies — do not anticipate other
   children. Follow this project's engineering principles (meaningful names,
   single responsibility, comprehensive tests).
4. Run the test suite; verify all tests pass and the acceptance criteria are met.
5. Resolve it: append a short solution summary with
   `tracker.py comment <id> "..."`, then `tracker.py set-status <id> resolved`.

Repeat until `next` reports no ready child. Then resolve the main-issue and open
the PR.

## Seeing the whole frontier at once
`tracker.py next --parent <main-id> --all` prints every actionable child-issue
instead of just the first. Blocked issues are excluded, so it is an overview of
what is currently unblocked — not an instruction to work them at the same time.
Child-issues are implemented **sequentially, one after another** in numeric
(dependency) order: numeric prefix order is a valid dependency order, since a
child can only be blocked by a sibling that already existed when it was created,
so every blocker has a lower prefix. There is no per-child worktree and no child
branch to merge — each slice is built directly on the main-issue branch, and the
next slice starts only once the current one is resolved.

## Do not hand-edit
Manage issues through the `issue-tracker` skill's `tracker.py` so that the state
machine and blocker rules are respected. When you fill a freshly created issue's
`## Description` and `## Acceptance Criteria` — the parts `tracker.py` leaves as
placeholders — read that new `issue.md` before editing it, since the `Write`
tool only overwrites a file already read this session.
