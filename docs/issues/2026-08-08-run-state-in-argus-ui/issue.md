# The run's backlog state, live in argus-ui

## Problem

While a run is going, the only way to see where it stands is to open
`backlog.json` in a checkout, or to scroll the chat and hope the session said
something. Neither is available to someone watching from a browser, and
neither updates on its own. argus-ui already answers "what did this session
cost" live, but says nothing about what the run is doing: which increments
exist, which one is being worked, what each step returned, what is left.

The state is already there and already well shaped —
`skills/agent-brief/assets/backlog.mjs` is the only writer of `backlog.json`,
and that file is the whole durable state of a run. What is missing is a way
for it to reach a page.

That way is the collector. argus-ui speaks to a collector over HTTP and
nothing else — it imports nothing from `tools/argus` and reads no uroboros
file, which is what lets it move out of this repository unchanged. Making it
read an issue directory would trade that rule away. So the recorder pushes
the state to the collector, the collector holds and serves it like everything
else it holds, and argus-ui reads it the one way it reads anything.

## Acceptance criteria

- [ ] The recorder sends the run's state to the collector after every write
      it makes — `init`, `record`, `branch` and `close` alike — identified by
      the issue the state belongs to. It stays the only writer of
      `backlog.json`, keeps its zero dependencies, and no agent page and no
      workflow prompt changes: how an agent calls the recorder is exactly
      what it is today.
- [ ] The send is best-effort and invisible. With no collector configured the
      recorder does nothing extra. A collector that is unreachable, slow or
      refusing costs the run neither a failure nor a wait beyond a short
      timeout, and never a word on stdout. The recorder's exit codes and its
      one confirmation line stay byte-identical to today's.
- [ ] The collector's address and token come from the same environment the
      rest of uroboros already uses for it, and from nowhere else.
- [ ] The collector accepts that state on an endpoint of its own, keeps the
      latest state per run, and serves it over its JSON API: the runs it
      holds, and the full state of one of them. The endpoints sit behind the
      collector's existing authentication, like every other endpoint it has.
- [ ] The state survives a collector restart, persisted the way the sessions
      it already holds are persisted.
- [ ] A write to a run's state reaches an already-open page live, over the
      collector's existing Server-Sent-Events stream. No polling, no reload,
      no manual refresh.
- [ ] argus-ui shows a run view holding, for the run it is showing: the issue
      and the workflow it belongs to and when it was last written; the
      increments in the backlog's order, each with its id, title, status,
      branch and note; a count of how many increments are closed and how
      many are open; per increment the steps recorded so far, each with its
      label and its time and its return, collapsed to a summary line and
      expandable to the full return; the run's own steps — the opening cut,
      each close, the publish — shown the same way; and the codemap.
- [ ] The view opens on the run written to most recently, and the reader can
      switch to any other run the collector holds.
- [ ] A closed increment reads as closed, with its status and its note. The
      recorder sheds a closed increment's step returns by design, so an
      increment with no steps is a normal state to render, not an empty
      panel that looks broken.
- [ ] argus-ui still imports nothing outside itself and reads no uroboros
      file; `test/independence.test.mjs` still guards exactly that rule and
      still passes.
- [ ] The documentation of each half is current in the same commit as the
      change: what the collector now accepts and serves, and what the
      interface now shows.
- [ ] `./test.sh` is green.

## Decisions

Recorded from the discussion of 2026-08-08; each answer is the human's.

1. **How does the backlog state reach the page?** Through the collector: the
   recorder pushes it, argus-ui reads it over `/api` like everything else.
   (Rejected: argus-ui reading the issue directory from a `--issues` flag —
   less work, but it teaches the interface the uroboros backlog format and
   gives up the independence rule that is the reason argus-ui is a project
   of its own.)
2. **Who builds it?** The loop, from this issue.

## Out of scope

- **Tying run steps to sessions in the timeline.** Knowing which session
  produced which step would be worth having, and it is a different feature
  with its own correlation problem. Nothing here may depend on it.
- **A history of a run.** The collector keeps the latest state per run, not
  every version it ever received. Replaying how a backlog changed over time
  is a separate issue.
- **Deploying anything new.** argus-ui stays local-only, with no `PATH`
  entry, no skill and no plugin manifest entry.
