---
status: backlog
branch:
pr:
---

# Nobody can tell whether commits from this environment are actually verified

## Intent

Every commit made in a remote Claude Code session for this repository is written
with a signature, and nothing in the session can establish whether that signature
is worth anything. The local setup contradicts itself and the local check reports a
false alarm, so the one question that matters — does GitHub mark these commits
Verified — goes unanswered on every run, and each run spends turns rediscovering
that.

What is established, each by the command that established it, at `fadcdf4`:

- Signing is switched on and configured for SSH: `git config --get commit.gpgsign`
  → `true`, `gpg.format` → `ssh`, `user.signingkey` →
  `/home/claude/.ssh/commit_signing_key.pub`.
- **The file named as the signing key is empty**: `ls -l` reports 0 bytes.
- **Signatures are nevertheless written.** `git cat-file commit <sha> | grep
  '^gpgsig'` matches for every commit of this run and for `6e7f28e`, which merged
  into the default branch as part of pull request #22.
- **Local verification is impossible.** `git log --format='%G?'` returns `N` for
  those commits and prints `gpg.ssh.allowedSignersFile needs to be configured and
  exist for ssh signature verification`. `git config --get
  gpg.ssh.allowedSignersFile` is unset.
- Author and committer are already correct: `noreply@anthropic.com`, name `Claude`,
  and GitHub attributes the commits to the `claude` account.
- **Not verified:** what GitHub shows. `mcp__github__get_commit` on `fadcdf4`
  returns no verification field, so the question cannot be answered from inside a
  session with the tools it has.

The session stop hook `~/.claude/stop-hook-git-check.sh` reads the `N` and asks for
`git commit --amend --reset-author` on the tip, or a rebase over earlier commits.
That remedy does not fit the finding: the committer address it resets is already
right, and resetting an author changes no signature. Following it would rewrite
history that other agents are committing into, for no effect.

Wanted: the answer, once, written down where the next session finds it — and
whichever of the two possible repairs the answer calls for.

Acceptance criteria:

1. **The answer is established and recorded.** Whether GitHub marks a commit pushed
   from this environment as Verified is stated as a fact with the evidence it came
   from — the commit, and where the status was read.
2. **The contradiction is explained.** Why a signature header is produced although
   the file named by `user.signingkey` is empty, stated with the command that shows
   it.
3. **The right repair lands.** If the commits are not verified on GitHub, the
   signing setup is corrected so that a newly made commit is, proven on a fresh
   commit. If they are verified, the local check is corrected so it stops reporting
   a false alarm, proven by running it against a commit it previously flagged.
4. **No existing history is rewritten** to reach any of the above.
5. **The next session does not re-derive this.** Whatever the answer is, it is
   written where a session will meet it — this record at minimum, and the project's
   own documentation where the finding contradicts something it claims.

## Map

## Plan

## Tasks

## Decisions

- Filed as its own issue rather than fixed inside the argus run. Source: the human,
  asked directly. It violates none of that issue's criteria, and the rulebook sends
  a finding that violates no criterion to its own run.
- The remedy the stop hook proposes was not followed during the argus run. Source:
  default, unanswered — the committer address it resets is already correct, an
  author reset changes no signature, and a rebase would have torn up the commits a
  running implementer was making in the same checkout.

## Log

## Checkpoints

### Before implementation

### Before the PR

## Retro
