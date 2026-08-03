---
status: backlog
branch:
pr:
---

# The licence check misses the file that disagrees and flags files that only mention a licence

## Intent

`test-repo.sh` holds the repository's licence consistency check. Two things about it
came out of the argus run, and they pull in opposite directions: it does not look at
the one file that actually contradicts the declared licence, and it fails on files
that merely write a licence name down.

Established, each by the command that established it:

- **It misses a real disagreement.** `tools/argus/package.json` declares
  `GPL-3.0-or-later`; `tools/argus/package-lock.json` declares a permissive licence
  instead. The check inspects `package.json` only, so the lockfile — which is
  checked in and which tooling reads — has been contradicting it unnoticed. Found
  while removing session naming; pre-existing, older than that change.
- **It fails on a file that claims nothing.** The check greps the whole repository
  for the permissive licence's name and treats any hit as a claim. During the argus
  run, a tracker record that *reported* the drift above — quoting the lockfile's
  value in order to describe the problem — turned the suite red at a commit that
  changed no code. Reproduced by `bash test-repo.sh` at `06ac6e1`: exit 1, "FAIL: 1
  of 5 cases", pointing at a line inside `docs/issues/`. It was worked around by
  rewording the record, which is not a fix — the next record that has to name a
  licence will do it again.

Wanted: a check whose failures mean what they say. It should notice when two files
that declare this repository's licence disagree, and it should not fire on prose
that mentions a licence name.

Acceptance criteria:

1. **The lockfile is covered.** When a checked-in `package-lock.json` declares a
   licence that differs from its `package.json`, the check fails and names both
   files and both values.
2. **The existing disagreement is resolved.** After the change,
   `tools/argus/package-lock.json` and `tools/argus/package.json` agree, and the
   check passes on them.
3. **Prose is not a claim.** A file that writes a licence name in running text — a
   tracker record, a README sentence, a comment — does not fail the check. Proven by
   a case that puts such a line in the tree and runs the check.
4. **A real claim still fails.** A file that actually declares the wrong licence for
   this repository still fails the check, so criterion 3 has not simply switched it
   off. Proven by a case.
5. **The suite says so.** `bash test.sh` exits 0, and the licence cases in
   `test-repo.sh` cover 1 through 4.

## Map

## Plan

## Tasks

## Decisions

- Filed as its own issue rather than fixed inside the argus run. Source: the
  rulebook — both findings violate none of that issue's criteria, and one of them
  predates it entirely.
- The argus run's own workaround — rewording the tracker record so it no longer
  contains the licence name — stays until this issue lands. Source: default,
  unanswered; it unblocked a red suite without touching a check that is not that
  run's business.

## Log

## Checkpoints

### Before implementation

### Before the PR

## Retro
