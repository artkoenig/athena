---
status: backlog
branch:
pr:
---

# Two argus flags fail quietly instead of saying something is wrong

## Intent

Two ways of invoking `argus` produce a plausible-looking collector that is not doing
what the caller asked. Neither says anything. Both were found by a reviewer during
the run that split the observer into `argus` and `argus-ui`; neither violates a
criterion of that issue, so neither was fixed there.

**A flag whose value is missing is treated as a flag that was not given.** `argus
start --open` with nothing after it parses the flag as `true`, resolves that to no
directory, and falls through to the default: an ordinary collector persisting a
fresh measurement into the current project. The caller asked to look at an existing
measurement and got a new empty one, with no message. `--persist` with no value
behaves the same way. This is the same class of mistake the run deliberately guarded
against elsewhere — `--open` on a directory that is not there is a hard error,
precisely so that a typo cannot look like a measurement that recorded nothing.

**A backgrounded tunnel keeps its token to itself.** `argus start --background
--tunnel` does not strip `--tunnel` when it hands the arguments to the child, so the
child opens the tunnel and generates its own access token, while the parent prints
the token it knows about — none. The generated token reaches nobody; it exists only
in `collector.log`. The caller is told the collector is up and given no way in.

Wanted: an invocation that cannot silently mean something other than what it says.

Acceptance criteria:

1. **A value-taking flag with no value is refused.** `argus start --open` and `argus
   start --persist`, each with nothing after it, exit non-zero and say which flag is
   missing its value. Neither starts a collector and neither creates a measurement
   directory.
2. **The same holds for the flag written as `--open=`** with an empty value, so the
   refusal cannot be walked around by the other spelling.
3. **A backgrounded tunnel reports its token.** When `argus start --background
   --tunnel` succeeds, the caller's output carries the token that actually admits
   them to the collector, and the public URL. Proven by a case that reads the token
   out of the caller's output and uses it.
4. **Or the combination is refused**, if reporting it turns out to need more than
   passing it back through the ready line — but then it is refused with a message
   saying to start it in the foreground, not silently accepted.
5. **The suite says so.** `bash test.sh` exits 0 and `tools/argus` covers criteria 1
   to 3 or 1, 2 and 4.

## Map

## Plan

## Tasks

## Decisions

- Filed as its own issue rather than fixed inside the argus split. Source: the
  rulebook — a finding that violates no criterion of the running issue is filed and
  waits for its own run.
- Criterion 4 exists because criterion 3 may not be worth its cost. Source: default,
  unanswered — the run that takes this decides which, and records why.

## Log

## Checkpoints

### Before implementation

### Before the PR

## Retro
