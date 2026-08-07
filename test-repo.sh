#!/bin/bash
# Facts about the repository itself that no other suite owns. Exit 0 = all
# cases pass.
set -u

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

passed=0
failed=0

ok() { passed=$((passed + 1)); echo "  ok   — $1"; }
no() { failed=$((failed + 1)); echo "  FAIL — $1"; }

echo "=== the licence"

# Every place that names a licence names the one in LICENSE. Three of them
# said Apache 2.0 over a GPL-3 LICENSE file, each drifting on its own,
# because nothing compared them.
declare -a claims=(
  ".claude-plugin/plugin.json"
  "tools/argus/package.json"
  "README.md"
)

if head -2 "$root/LICENSE" | grep -q "GNU GENERAL PUBLIC LICENSE"; then
  if head -3 "$root/LICENSE" | grep -q "Version 3"; then
    ok "LICENSE is the GNU GPL version 3"
  else
    no "LICENSE is a GNU GPL, but not version 3"
  fi
else
  no "LICENSE is not the GNU GPL — the cases below assume it is"
fi

for file in "${claims[@]}"; do
  if grep -q "GPL-3.0-or-later" "$root/$file"; then
    ok "$file names GPL-3.0-or-later"
  else
    no "$file does not name GPL-3.0-or-later: $(grep -io 'apache[^",]*\|gpl[^",]*' "$root/$file" | head -1)"
  fi
done

# The other direction: no file anywhere claims a licence LICENSE is not.
# The record of past runs under docs/issues/ is out of scope, the way *.sh
# already is: those documents quote this suite — the sentence above about
# three files drifting is itself quoted in one of them — and a quotation is
# not a claim. Nothing there sets the project's licence anyway.
strays="$(grep -rln 'Apache' "$root" \
  --include='*.md' --include='*.json' --include='*.mjs' --include='*.yaml' \
  --exclude='package-lock.json' --exclude-dir=node_modules \
  --exclude-dir=issues 2>/dev/null || true)"
if [ -z "$strays" ]; then
  ok "no file claims the Apache licence"
else
  no "these files still claim the Apache licence:"
  echo "$strays" | sed 's/^/       /'
fi

echo
echo "=== no repository-local rule reaches an agent"

# `.claude/rules/` is not shipped with the plugin, so anything it delivers
# exists in this checkout and nowhere else. An unscoped page loads at launch
# and is inherited by every subagent the session dispatches, which would give
# an agent working here rules it never holds in a project that installed
# uroboros. `paths:` frontmatter is what stops that: inheritance passes on the
# launch context alone, and a scoped page is not in it.
rules_unscoped=""
for page in "$root"/.claude/rules/*.md; do
  [ -e "$page" ] || continue
  if ! head -1 "$page" | grep -q '^---$' || ! sed -n '2,/^---$/p' "$page" | grep -q '^paths:'; then
    rules_unscoped="${rules_unscoped} $(basename "$page")"
  fi
done
if [ -z "$rules_unscoped" ]; then
  ok "every page in .claude/rules/ is path-scoped, so no subagent inherits one"
else
  no "unscoped rule pages would reach every subagent in this checkout alone:$rules_unscoped"
fi

# Scoping is only half the bargain. The page still has to reach whoever opens
# the files it governs — a reader loads it on its own reads, subagents
# included — and a pattern that matches nothing loads for nobody while looking
# deliberate. `agent/**` for `agents/` would read as scoping and be a deleted
# rule. So every pattern has to name files that exist.
scope_tmp="$(mktemp -d)"
cat >"$scope_tmp/scope.js" <<'JS'
const fs = require("fs"), path = require("path");
const root = process.argv[2];
const tracked = fs.readFileSync(process.argv[3], "utf8").split("\n").filter(Boolean);
const dir = path.join(root, ".claude/rules");
const unquote = (s) => s.trim().replace(/^["']|["']$/g, "");
const problems = [];
for (const page of fs.readdirSync(dir).filter((f) => f.endsWith(".md"))) {
  const fm = (fs.readFileSync(path.join(dir, page), "utf8").match(/^---\n([\s\S]*?)\n---/) || [])[1] || "";
  const lines = fm.split("\n");
  const at = lines.findIndex((l) => /^paths:/.test(l));
  if (at < 0) { problems.push(page + ": no paths:"); continue; }
  const patterns = [];
  const inline = unquote(lines[at].replace(/^paths:/, ""));
  if (inline) patterns.push(inline);
  for (let i = at + 1; i < lines.length && /^\s*-\s/.test(lines[i]); i++) {
    patterns.push(unquote(lines[i].replace(/^\s*-\s*/, "")));
  }
  if (!patterns.length) { problems.push(page + ": paths: is empty"); continue; }
  for (const p of patterns) {
    const rx = new RegExp("^" + p
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*+/g, (m) => (m.length > 1 ? ".*" : "[^/]*")) + "$");
    if (!tracked.some((f) => rx.test(f))) problems.push(page + ": " + p + " matches no tracked file");
  }
}
if (problems.length) { console.error(problems.join("; ")); process.exit(1); }
JS
git -C "$root" ls-files >"$scope_tmp/tracked.txt"
node "$scope_tmp/scope.js" "$root" "$scope_tmp/tracked.txt"
scope_status=$?
rm -rf "$scope_tmp"
if [ "$scope_status" -eq 0 ]; then
  ok "every paths: pattern in .claude/rules/ matches files that exist"
else
  no "a paths: pattern matches nothing, so its page loads for nobody"
fi

echo
echo "=== the run state is the channel, and no prose handoff is left"

# The five handoff files used to be the channel between agents and the record
# of the run at once. A prompt or a page that still names one is a channel
# nobody deleted, so a grep across every prompt-bearing file catches a
# straggler before an agent goes looking for a file that no longer exists.
# The [^/] guard is load-bearing: README.md links agents/researcher.md as an
# agent page, which is not a handoff, and the regex must not flag it.
# .claude/rules/agents.md is deliberately outside the file set below — it
# names agent pages as examples for whoever writes them, not a channel.
handoff_refs="$(grep -nE '(^|[^/])(researcher|test-author|implementer|reviewer|planner)\.md|backlog\.md' \
  "$root"/workflows/*.js "$root"/agents/*.md "$root"/skills/*/SKILL.md "$root/rulebook.md" "$root/README.md" 2>/dev/null || true)"
if [ -z "$handoff_refs" ]; then
  ok "no prompt, agent page or skill still names a prose handoff file"
else
  no "these lines still name a prose handoff file:"
  echo "$handoff_refs" | sed 's/^/       /'
fi

# Finding 2 (round 1): a page can point at "your handoff" without naming any
# of the five files above, and the guard above matches file *names*, not the
# word — agents/planner.md line 55 said "Say in your handoff which criterion
# went where" and slipped through untouched. hand-?off, not a plain "hand":
# "hand over", which the shared brief and the agent pages say more than
# once, must not match. .claude/rules/agents.md stays outside this file set,
# same as above — it names agent pages as examples for whoever writes them.
handoff_word="$(grep -rniE 'hand-?off' \
  "$root"/workflows/*.js "$root"/agents/*.md "$root"/skills/*/SKILL.md "$root/rulebook.md" "$root/README.md" 2>/dev/null || true)"
if [ -z "$handoff_word" ]; then
  ok "no prompt, agent page or skill still says handoff, in any spelling"
else
  no "these lines still say handoff:"
  echo "$handoff_word" | sed 's/^/       /'
fi

# Both workflows open every run with the same cheap dispatch, so a diverging
# script would be a second re-entry mechanism no one asked for.
for f in "$root/workflows/loop.js" "$root/workflows/agile-loop.js"; do
  name="$(basename "$f")"
  if grep -q 'backlog.json' "$f" && grep -q 'load-state' "$f"; then
    ok "$name carries the state loader and the file it loads"
  else
    no "$name is missing backlog.json or load-state"
  fi
done

# The reviewer's independence is the one boundary a channel change could
# quietly erase: recording through the same file it must not read is only
# safe if its own page says so twice — once as a rule, once as a diff
# exclusion.
reviewer_page="$root/agents/reviewer.md"
if grep -i 'backlog.json' "$reviewer_page" | grep -Eiq 'not read|never read|without reading'; then
  ok "the reviewer's page forbids reading backlog.json"
else
  no "the reviewer's page does not forbid reading backlog.json"
fi
if grep -i 'backlog.json' "$reviewer_page" | grep -qi 'diff'; then
  ok "the reviewer's page excludes backlog.json from the diff it judges"
else
  no "the reviewer's page does not exclude backlog.json from its diff judgment"
fi

# Decision 5: the planner now opens and closes the plain loop too, not only
# the incremental one.
for f in "$root/workflows/loop.js" "$root/workflows/agile-loop.js"; do
  name="$(basename "$f")"
  if grep -q 'uroboros:planner' "$f"; then
    ok "$name dispatches the planner"
  else
    no "$name does not dispatch the planner"
  fi
done

# Every agent records its own step now — the planner's exclusive backlog
# ownership is what this change ends.
missing_backlog_ref=""
for page in "$root"/agents/*.md; do
  grep -q 'backlog.json' "$page" || missing_backlog_ref="$missing_backlog_ref $(basename "$page")"
done
if [ -z "$missing_backlog_ref" ]; then
  ok "every agent page names backlog.json, the file it records its step into"
else
  no "these agent pages do not mention backlog.json:$missing_backlog_ref"
fi
if grep -q 'backlog.mjs' "$root/skills/agent-brief/SKILL.md"; then
  ok "the shared brief names the helper that records a step"
else
  no "the shared brief does not name backlog.mjs"
fi

# Finding 3 (round 1): step-level granularity is theater without a push per
# step, and a plain `grep -qi 'push'` over the two workflow scripts survives
# even if the per-step push instruction is deleted from noDispatch — both
# scripts also say "push" in their unrelated Publish prompt. That behavioural
# fact is now guarded by driver mode w8 above, per step, per workflow. What
# stays a grep is the shared brief's own sentence, tightened to its exact
# words so the frontmatter description ("pushes its step return") cannot
# satisfy it by accident.
if grep -q 'push the commit' "$root/skills/agent-brief/SKILL.md"; then
  ok "the shared brief instructs pushing the step's commit"
else
  no "the shared brief does not instruct pushing the step's commit"
fi

# Round 2, finding 3: a step worked a second time after a restart can find
# what its interrupted first run already committed — failing tests that
# exist, code that half-exists — and nothing said so, so a repeated step was
# free to write everything a second time instead of finishing or correcting
# it.
if grep -q 'already committed' "$root/skills/agent-brief/SKILL.md"; then
  ok "the shared brief tells a repeated step what its first run may have left behind"
else
  no "the shared brief does not tell a repeated step what its first run may have left behind"
fi

# The plain loop's one-increment shape is enforced in the schema, not just
# asked for in a prompt an agent could misread.
if grep -q 'maxItems: 1' "$root/workflows/loop.js"; then
  ok "the plain loop's backlog schema is pinned to exactly one increment"
else
  no "the plain loop's schema does not pin maxItems: 1"
fi

# The helper is the only writer of backlog.json, so it has to exist, parse,
# and be in the one command that proves the suite green.
if [ -f "$root/skills/agent-brief/assets/backlog.mjs" ]; then
  ok "skills/agent-brief/assets/backlog.mjs exists"
else
  no "skills/agent-brief/assets/backlog.mjs does not exist"
fi
if node --check "$root/skills/agent-brief/assets/backlog.mjs" >/dev/null 2>&1; then
  ok "the backlog helper parses"
else
  no "the backlog helper does not parse (or does not exist)"
fi
if grep -q 'skills/agent-brief/assets' "$root/test.sh"; then
  ok "test.sh lists the recorder suite"
else
  no "test.sh does not list the recorder suite"
fi

echo
echo "=== a run resumes from the state it recorded"

# A workflow script is only ever compiled at dispatch, minutes into a real
# run — the same reason the compile check below exists. Here the same
# AsyncFunction trick runs the whole script with a stubbed agent(), so the
# resume mechanics (a recorded step is skipped, a finished backlog dispatches
# only the state loader and publish, each role's prompt carries only its own
# slice) are proven without ever paying for a live dispatch. `args`, `agent`,
# `log` and `phase` are the whole runtime the scripts may use, so running them
# this way also proves they use nothing else — no `require`, no ambient file
# access.
driver_tmp="$(mktemp -d)"
cat >"$driver_tmp/driver.js" <<'JS'
const fs = require('fs');
const path = require('path');

const file = process.argv[2];
const mode = process.argv[3];
const failures = [];

function fail(msg) { failures.push(msg); }
function assertTrue(cond, msg) { if (!cond) fail(msg); }
function assertEqualArrays(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) fail(msg + ' — expected ' + e + ' got ' + a);
}

const isAgile = path.basename(file) === 'agile-loop.js';

// Finding 1 (round 1): the two literals used to be 'PLAN-MARKER' and
// 'TESTPLAN-MARKER', and 'TESTPLAN-MARKER'.includes('PLAN-MARKER') is true —
// so the w4 assertion that the test-author's prompt does NOT carry
// PLAN_MARKER failed against a prompt that in fact carried only the test
// plan. Renamed so neither contains the other; DISJOINT_MARKERS below is the
// standing guard against the same class of bug coming back unnoticed.
const PLAN_MARKER = 'MARKER-IMPLEMENTATION-PLAN';
const TESTPLAN_MARKER = 'MARKER-TEST-PLAN';
const CHECK_MARKER = 'echo CHECK-MARKER';
const DISJOINT_MARKERS = [
  PLAN_MARKER,
  TESTPLAN_MARKER,
  'CHECK-MARKER',
  'MARKER-HUMAN-QUESTION',
  'MARKER-OPEN-QUESTION',
  'MARKER-FINDING-CLAIM',
  'MARKER-FINDING-REPRODUCTION',
  'MARKER-FINDING-CRITERION',
  'MARKER-VERDICT-REASON',
  'MARKER-CLOSE-QUESTION',
];

const planReturn = {
  needsTests: true,
  plan: PLAN_MARKER,
  moduleMap: 'module map',
  environment: 'environment',
  testPlan: TESTPLAN_MARKER,
  checks: [CHECK_MARKER],
  questions: [],
  summary: 'plan summary',
};
const planReturnWithQuestion = Object.assign({}, planReturn, { questions: ['ask the human'] });
const testsReturn = {
  cases: [{ case: 'a case', file: 'x.test.mjs', testName: 'it works', expected: 'x', got: 'y' }],
  openQuestions: [],
  questions: [],
  summary: 'tests summary',
};
const buildReturn = {
  deviations: [],
  commands: [{ command: 'echo hi', exitCode: 0, note: '' }],
  blockers: [],
  questions: [],
  summary: 'build summary',
};
const verdictReturnClean = { findings: [], reason: '', questions: [], summary: 'verdict summary' };

// Round 2, finding 1's fixture: a step that ended the previous run with a
// question for the human. A resumed run must work this step again instead of
// replaying the stale question, so w9 dispatches research:i1.0 a second time
// and expects the clean planReturn back (see returnFor's ctx.researchReturn
// override below).
const planReturnWithMarkedQuestion = Object.assign({}, planReturn, {
  questions: ['MARKER-HUMAN-QUESTION'],
});
// Round 2, finding 2's fixtures: a dirty round-0 review and the test-author's
// open question from round 0, both of which the round-1 researcher prompt
// must carry.
const testsReturnWithOpenQuestion = Object.assign({}, testsReturn, {
  openQuestions: ['MARKER-OPEN-QUESTION'],
});
const verdictReturnWithFinding = {
  findings: [{
    claim: 'MARKER-FINDING-CLAIM',
    reproduction: 'MARKER-FINDING-REPRODUCTION',
    criterion: 'MARKER-FINDING-CRITERION',
  }],
  reason: 'MARKER-VERDICT-REASON',
  questions: [],
  summary: 'verdict summary',
};

function increment(id) {
  return { id, title: 'Deliver ' + id, goal: 'Deliver ' + id + '.', criteria: ['does ' + id], status: 'todo', note: '' };
}
const decomposeReturnOne = { increments: [increment('i1')], questions: [], summary: 'backlog summary' };
const decomposeReturnTwo = { increments: [increment('i1'), increment('i2')], questions: [], summary: 'backlog summary' };

function resumeBacklog() {
  return {
    version: 1,
    issue: 'docs/issues/x',
    workflow: isAgile ? 'agile-loop' : 'loop',
    increments: [
      {
        id: 'i1', title: 'Deliver i1', goal: 'Deliver i1.', criteria: ['does i1'], status: 'todo', note: '',
        steps: [
          { label: 'research:i1.0', at: '2026-08-07T00:00:00.000Z', return: planReturn },
          { label: 'tests:i1.0', at: '2026-08-07T00:00:01.000Z', return: testsReturn },
        ],
      },
    ],
    run: { steps: [{ label: 'decompose', at: '2026-08-07T00:00:00.000Z', return: decomposeReturnOne }] },
  };
}

// Round 2, finding 1's fixture: a run whose research:i1.0 step ended with a
// question for the human, recorded exactly as backlog.mjs record would leave
// it. A resumed run must not replay this stale return.
function questionBacklog() {
  return {
    version: 1,
    issue: 'docs/issues/x',
    workflow: isAgile ? 'agile-loop' : 'loop',
    increments: [
      {
        id: 'i1', title: 'Deliver i1', goal: 'Deliver i1.', criteria: ['does i1'], status: 'todo', note: '',
        steps: [
          { label: 'research:i1.0', at: '2026-08-07T00:00:00.000Z', return: planReturnWithMarkedQuestion },
        ],
      },
    ],
    run: { steps: [{ label: 'decompose', at: '2026-08-07T00:00:00.000Z', return: decomposeReturnOne }] },
  };
}

function doneBacklog() {
  const closeLabel = isAgile ? 'replan:i1' : 'close:i1';
  return {
    version: 1,
    issue: 'docs/issues/x',
    workflow: isAgile ? 'agile-loop' : 'loop',
    increments: [
      { id: 'i1', title: 'Deliver i1', goal: 'Deliver i1.', criteria: ['does i1'], status: 'done', note: 'accepted', steps: [] },
    ],
    run: {
      steps: [
        // Finding 5 (round 1): a real closed run has already shed the
        // return of a run-level step — the `close` CLI drops the key but
        // keeps the label and the timestamp — so this fixture now matches
        // that shape instead of a full BACKLOG return surviving forever.
        { label: 'decompose', at: '2026-08-07T00:00:00.000Z' },
        { label: closeLabel, at: '2026-08-07T00:00:02.000Z', return: { summary: 'closed' } },
      ],
    },
  };
}

function contextFor(m) {
  switch (m) {
    case 'w1':
      return { stateReturn: { exists: false, backlogJson: '', summary: '' }, decomposeReturn: isAgile ? decomposeReturnTwo : decomposeReturnOne, researchReturn: planReturn };
    case 'w2':
      return { stateReturn: { exists: true, backlogJson: JSON.stringify(resumeBacklog(), null, 2) + '\n', summary: '' }, decomposeReturn: decomposeReturnOne, researchReturn: planReturn };
    case 'w3':
      return { stateReturn: { exists: true, backlogJson: JSON.stringify(doneBacklog(), null, 2) + '\n', summary: '' }, decomposeReturn: decomposeReturnOne, researchReturn: planReturn };
    case 'w4':
    case 'w5':
    case 'w6':
    case 'w8':
      return { stateReturn: { exists: false, backlogJson: '', summary: '' }, decomposeReturn: decomposeReturnOne, researchReturn: planReturn };
    case 'w7':
      return { stateReturn: { exists: false, backlogJson: '', summary: '' }, decomposeReturn: decomposeReturnOne, researchReturn: planReturnWithQuestion };
    case 'w9':
      return { stateReturn: { exists: true, backlogJson: JSON.stringify(questionBacklog(), null, 2) + '\n', summary: '' }, decomposeReturn: decomposeReturnOne, researchReturn: planReturn };
    case 'w10':
      return { stateReturn: { exists: false, backlogJson: '', summary: '' }, decomposeReturn: decomposeReturnOne, researchReturn: planReturn, testsReturn: testsReturnWithOpenQuestion, verdictFor: (label) => (label === 'review:i1.0' ? verdictReturnWithFinding : verdictReturnClean) };
    case 'w11':
      return { stateReturn: { exists: false, backlogJson: '', summary: '' }, decomposeReturn: decomposeReturnOne, researchReturn: planReturn, closeFor: () => ({ questions: ['MARKER-CLOSE-QUESTION'], summary: 'closed' }) };
    case 'w12': {
      // Round 3, finding 2: the planner closes the increment and hands it
      // straight back as todo — the second chance MAX_ATTEMPTS exists for —
      // and settles it on the second pass.
      let replans = 0;
      return {
        stateReturn: { exists: false, backlogJson: '', summary: '' },
        decomposeReturn: decomposeReturnOne,
        researchReturn: planReturn,
        closeFor: () => {
          replans += 1;
          return replans === 1
            ? { increments: [increment('i1')], questions: [], summary: 'handed back' }
            : { increments: [Object.assign(increment('i1'), { status: 'done' })], questions: [], summary: 'closed' };
        },
      };
    }
    default:
      throw new Error('unknown mode ' + m);
  }
}

const ctx = contextFor(mode);

function returnFor(label) {
  if (label === 'load-state') return ctx.stateReturn;
  if (label === 'decompose') return ctx.decomposeReturn;
  if (label.startsWith('research:')) return ctx.researchReturn;
  // Round 2, w10: the round-0 test-author's openQuestions and the round-0
  // review's findings both have to reach the round-1 researcher, so these
  // two lookups take a per-mode override instead of the fixed fixture every
  // earlier mode was content with.
  if (label.startsWith('tests:')) return ctx.testsReturn || testsReturn;
  if (label.startsWith('implement:')) return buildReturn;
  if (label.startsWith('review:')) return ctx.verdictFor ? ctx.verdictFor(label) : verdictReturnClean;
  // Round 3, w11 and w12: the closing planner's return is a channel of its
  // own — it can carry a question for the human (w11) and it can hand an
  // increment back as todo (w12) — so these two labels take a per-mode
  // override instead of the one fixed fixture.
  if (label.startsWith('close:') || label.startsWith('replan:')) {
    return ctx.closeFor ? ctx.closeFor(label) : { summary: 'closed' };
  }
  if (label === 'publish') return { summary: 'published' };
  throw new Error('unexpected label ' + label);
}

async function main() {
  // Guards finding 1 from returning: if any two of the three markers stop
  // being disjoint, a slice assertion built on them can pass for the wrong
  // reason, so this fires before a single dispatch happens, in every mode.
  for (const a of DISJOINT_MARKERS) {
    for (const b of DISJOINT_MARKERS) {
      if (a === b) continue;
      assertTrue(!a.includes(b), 'marker "' + a + '" contains marker "' + b + '" as a substring, so a slice assertion built on them cannot be trusted');
    }
  }

  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const src = fs.readFileSync(file, 'utf8').replace(/^export const meta =/m, 'const meta =');
  const fn = new AsyncFunction('args', 'agent', 'log', 'phase', src);
  const calls = [];
  const stub = async (prompt, opts) => {
    calls.push({ label: opts.label, agentType: opts.agentType, prompt });
    return returnFor(opts.label);
  };
  // Round 2, w10: the reviewer's reason sentence has to reach the human in
  // the chat, which in this driver means the log() the workflow calls, so
  // the stub captures instead of discarding it.
  const logs = [];
  const result = await fn({ issueDir: 'docs/issues/x' }, stub, (m) => logs.push(String(m)), () => {});
  const labels = calls.map((c) => c.label);

  if (mode === 'w1') {
    const closeLabel = isAgile ? 'replan:i1' : 'close:i1';
    let expected = ['load-state', 'decompose', 'research:i1.0', 'tests:i1.0', 'implement:i1.0', 'review:i1.0', closeLabel];
    if (isAgile) {
      expected = expected.concat(['research:i2.0', 'tests:i2.0', 'implement:i2.0', 'review:i2.0', 'replan:i2']);
    }
    expected.push('publish');
    assertEqualArrays(labels, expected, 'the labels dispatched are not the expected fresh-run sequence');
    const byLabel = (l) => calls.find((c) => c.label === l);
    assertTrue(!!byLabel('decompose') && byLabel('decompose').agentType === 'uroboros:planner', 'decompose is not dispatched as uroboros:planner');
    assertTrue(!!byLabel(closeLabel) && byLabel(closeLabel).agentType === 'uroboros:planner', closeLabel + ' is not dispatched as uroboros:planner');
    assertTrue(!!byLabel('load-state') && byLabel('load-state').agentType === 'general-purpose', 'load-state is not dispatched as general-purpose');
    assertTrue(!!byLabel('publish') && byLabel('publish').agentType === 'general-purpose', 'publish is not dispatched as general-purpose');
    if (isAgile) {
      assertTrue(!!byLabel('replan:i2') && byLabel('replan:i2').agentType === 'uroboros:planner', 'replan:i2 is not dispatched as uroboros:planner');
    }
  } else if (mode === 'w2') {
    assertTrue(!labels.some((l) => l.startsWith('research:')), 'the researcher was dispatched even though its step was already recorded');
    assertTrue(!labels.some((l) => l.startsWith('tests:')), 'the test-author was dispatched even though its step was already recorded');
    const afterLoadState = calls[1];
    assertTrue(!!afterLoadState && afterLoadState.label.startsWith('implement:'), 'the first dispatch after load-state is not the implementer');
    assertTrue(!!afterLoadState && afterLoadState.prompt.includes(PLAN_MARKER), "the implementer's prompt does not carry the recorded plan's marker");
  } else if (mode === 'w3') {
    assertEqualArrays(labels, ['load-state', 'publish'], 'a fully-closed backlog dispatches more than the state loader and publish');
  } else if (mode === 'w4') {
    const testsCall = calls.find((c) => c.label.startsWith('tests:'));
    assertTrue(!!testsCall, 'the test-author was never dispatched');
    assertTrue(!!testsCall && testsCall.prompt.includes(TESTPLAN_MARKER), "the test-author's prompt does not carry the test plan");
    assertTrue(!!testsCall && !testsCall.prompt.includes(PLAN_MARKER), "the test-author's prompt carries the implementation plan");
  } else if (mode === 'w5') {
    const implCall = calls.find((c) => c.label.startsWith('implement:'));
    assertTrue(!!implCall, 'the implementer was never dispatched');
    assertTrue(!!implCall && implCall.prompt.includes(PLAN_MARKER), "the implementer's prompt does not carry the plan");
    assertTrue(!!implCall && implCall.prompt.includes('CHECK-MARKER'), "the implementer's prompt does not carry the checks");
    assertTrue(!!implCall && !implCall.prompt.includes(TESTPLAN_MARKER), "the implementer's prompt carries the test plan");
  } else if (mode === 'w6') {
    const reviewCall = calls.find((c) => c.label.startsWith('review:'));
    assertTrue(!!reviewCall, 'the reviewer was never dispatched');
    assertTrue(!!reviewCall && reviewCall.prompt.includes('CHECK-MARKER'), "the reviewer's prompt does not carry the checks");
    assertTrue(!!reviewCall && !reviewCall.prompt.includes(PLAN_MARKER), "the reviewer's prompt carries the implementation plan");
    assertTrue(!!reviewCall && !reviewCall.prompt.includes(TESTPLAN_MARKER), "the reviewer's prompt carries the test plan");
  } else if (mode === 'w7') {
    assertEqualArrays(labels, ['load-state', 'decompose', 'research:i1.0', 'publish'], 'a question from the researcher does not stop the run at publish');
    assertTrue(!!result && !!result.blockedOnHuman, 'the returned result does not carry blockedOnHuman');
    assertTrue(!!result && JSON.stringify(result.blockedOnHuman).includes('ask the human'), 'blockedOnHuman does not carry the question');
  } else if (mode === 'w8') {
    // Finding 3 (round 1): a plain grep for the word "push" over the whole
    // script survives even if the per-step push instruction is deleted,
    // because the unrelated Publish prompt in both scripts also says
    // "push". This asserts on every recorded step's own prompt instead.
    for (const c of calls) {
      if (c.label === 'load-state' || c.label === 'publish') continue;
      assertTrue(/backlog\.json/.test(c.prompt) && /\brecord\b/i.test(c.prompt),
        c.label + ' is not told to record its return into backlog.json');
      assertTrue(/\bpush\b/i.test(c.prompt),
        c.label + " is not told to push its step's commit");
    }
  } else if (mode === 'w9') {
    // Round 2, finding 1: a recorded step whose return carried a question
    // used to be replayed as-is, so a resumed run dispatched only
    // load-state and publish, forever. This pins the fix: the step that
    // asked is worked again, with the question and the answer's location in
    // its prompt, and the run makes it all the way to a clean close.
    const closeLabel = isAgile ? 'replan:i1' : 'close:i1';
    assertEqualArrays(labels,
      ['load-state', 'research:i1.0', 'tests:i1.0', 'implement:i1.0', 'review:i1.0', closeLabel, 'publish'],
      'the resumed run did not work the step that asked the human again, or did not carry on past it');
    const researchCall = calls.find((c) => c.label === 'research:i1.0');
    assertTrue(!!researchCall && researchCall.prompt.includes('MARKER-HUMAN-QUESTION'),
      "the repeated step's prompt does not carry the question it asked");
    assertTrue(!!researchCall && /## Decisions/.test(researchCall.prompt) && /issue\.md/.test(researchCall.prompt),
      "the repeated step's prompt does not send the agent to the answer under ## Decisions in issue.md");
    assertTrue(!!result && Array.isArray(result.blockedOnHuman) && result.blockedOnHuman.length === 0,
      'the resumed run ended on the stale recorded question instead of making progress');
  } else if (mode === 'w10') {
    // Round 2, finding 2: nothing exercised a correction round before this
    // mode, so the findings channel (researcher <- reviewer) and the reason
    // sentence (human <- reviewer) were both untested.
    const closeLabel = isAgile ? 'replan:i1' : 'close:i1';
    assertEqualArrays(labels,
      ['load-state', 'decompose', 'research:i1.0', 'tests:i1.0', 'implement:i1.0', 'review:i1.0',
       'research:i1.1', 'tests:i1.1', 'implement:i1.1', 'review:i1.1', closeLabel, 'publish'],
      'a review with findings does not open exactly one correction round');
    const round1 = calls.find((c) => c.label === 'research:i1.1');
    for (const marker of ['MARKER-FINDING-CLAIM', 'MARKER-FINDING-REPRODUCTION', 'MARKER-FINDING-CRITERION']) {
      assertTrue(!!round1 && round1.prompt.includes(marker),
        "the correction round's researcher prompt does not carry " + marker);
    }
    assertTrue(!!round1 && round1.prompt.includes('MARKER-OPEN-QUESTION'),
      "the correction round's researcher prompt does not carry what the test-author left open");
    const round0 = calls.find((c) => c.label === 'research:i1.0');
    assertTrue(!!round0 && !round0.prompt.includes('MARKER-FINDING-CLAIM'),
      "the first round's researcher prompt carries findings that do not exist yet");
    assertTrue(logs.some((l) => l.includes('MARKER-VERDICT-REASON')),
      "the reviewer's reason sentence never reached the human in the chat");
  } else if (mode === 'w11') {
    // Round 3, finding 1: loop.js dispatched the Close step and dropped its
    // return, so a question the closing planner asked reached nobody — no
    // blockedOnHuman, no log line, and a run that reported itself finished.
    // agile-loop.js already handled the same role in the same position, so
    // this mode runs on both and pins them to one behaviour.
    const closeLabel = isAgile ? 'replan:i1' : 'close:i1';
    assertEqualArrays(labels,
      ['load-state', 'decompose', 'research:i1.0', 'tests:i1.0', 'implement:i1.0', 'review:i1.0', closeLabel, 'publish'],
      'a question from the closing planner does not stop the run at publish');
    assertTrue(!!result && Array.isArray(result.blockedOnHuman) && result.blockedOnHuman.length === 1,
      "the closing planner's question did not end the run as blocked on the human");
    const blocked = JSON.stringify((result && result.blockedOnHuman) || []);
    assertTrue(blocked.includes('MARKER-CLOSE-QUESTION'),
      'blockedOnHuman does not carry the question the closing planner asked');
    assertTrue(blocked.includes(closeLabel),
      'blockedOnHuman does not name ' + closeLabel + ' as the step that asked');
    assertTrue(logs.some((l) => l.includes('MARKER-CLOSE-QUESTION')),
      "the closing planner's question never reached the human in the chat");
  } else if (mode === 'w12') {
    // Round 3, finding 2: labels are keyed on the increment id, so the second
    // attempt at an increment the planner handed back re-used the first
    // attempt's labels, found them all in the in-session recorded map,
    // dispatched nobody and re-read the first attempt's verdict and re-cut.
    // MAX_ATTEMPTS' second chance is what that cost.
    assertTrue(isAgile, "w12 is the incremental loop's mode: the plain loop never re-cuts");
    assertEqualArrays(labels,
      ['load-state', 'decompose',
       'research:i1.0', 'tests:i1.0', 'implement:i1.0', 'review:i1.0', 'replan:i1',
       'research:i1.0', 'tests:i1.0', 'implement:i1.0', 'review:i1.0', 'replan:i1',
       'publish'],
      'an increment the planner handed back as todo was not worked a second time');
    assertTrue(calls.filter((c) => c.label === 'research:i1.0').length === 2,
      'the researcher was not dispatched again for the second attempt');
    assertTrue(!!result && result.stopped === '',
      'the run stopped on the attempt backstop instead of working the increment again');
    assertTrue(!!result && result.delivered === 1 && Array.isArray(result.increments) && result.increments.length === 2,
      'the second attempt did not deliver the increment');
  } else {
    throw new Error('unknown mode ' + mode);
  }

  if (failures.length) {
    process.stderr.write(failures.join('\n') + '\n');
    process.exit(1);
  }
}

main().catch((e) => {
  process.stderr.write(String((e && e.stack) || e) + '\n');
  process.exit(1);
});
JS

run_driver() {
  # $1 = workflow file, $2 = mode, $3 = human-readable case description
  if node "$driver_tmp/driver.js" "$1" "$2" 2>"$driver_tmp/err"; then
    ok "$3"
  else
    no "$3:"
    sed 's/^/       /' "$driver_tmp/err"
  fi
}

# Finding 4 (round 1): w4-w7 used to run against loop.js alone, so the same
# per-role slicing and the same human-question exit could break in
# agile-loop.js with this whole section still green. w8 (finding 3) is new
# and joins the loop for the same reason from the start.
for wf in "$root/workflows/loop.js" "$root/workflows/agile-loop.js"; do
  wf_name="$(basename "$wf")"
  run_driver "$wf" w1 "$wf_name: a fresh run dispatches load-state, decompose, the chain, the close and publish, in order"
  run_driver "$wf" w2 "$wf_name: a resumed run skips the recorded researcher and test-author and starts at the implementer"
  run_driver "$wf" w3 "$wf_name: a backlog whose increments are all closed dispatches only the state loader and publish"
  run_driver "$wf" w4 "$wf_name: the test-author's prompt carries the test plan and not the implementation plan"
  run_driver "$wf" w5 "$wf_name: the implementer's prompt carries the plan and the checks and not the test plan"
  run_driver "$wf" w6 "$wf_name: the reviewer's prompt carries the checks alone"
  run_driver "$wf" w7 "$wf_name: a question from the researcher ends the run at publish"
  run_driver "$wf" w8 "$wf_name: every step's prompt tells the agent to record its return and push the commit"
  run_driver "$wf" w9 "$wf_name: a run resumed after a question for the human works that step again with the question in its prompt"
  run_driver "$wf" w10 "$wf_name: a correction round carries the reviewer's findings to the researcher and the reason to the human"
  run_driver "$wf" w11 "$wf_name: a question from the closing planner ends the run and reaches the human"
done

# Round 3, finding 2: only the incremental loop re-cuts, so an increment
# handed back is agile-loop.js's case alone.
run_driver "$root/workflows/agile-loop.js" w12 "agile-loop.js: an increment the planner hands back is worked a second time, not skipped as recorded"

rm -rf "$driver_tmp"

echo
echo "=== the two workflows coexist"

# `loop` and `agile-loop` are two files rather than one with a switch, and the
# plugin ships the directory, so a new one is live the moment it is written —
# including one that does not parse. A workflow script is only ever compiled at
# dispatch, minutes into a run, so nothing else in this repository would catch
# a syntax error before an agent chain had already been paid for. Compiling
# them here is that check: `new AsyncFunction` parses the body without running
# a line of it.
node -e '
  const fs = require("fs"), path = require("path");
  const root = process.argv[1];
  const dir = path.join(root, "workflows");
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const problems = [];
  const names = new Map();
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".js")).sort();
  for (const file of files) {
    const src = fs.readFileSync(path.join(dir, file), "utf8");
    // Top-level `return` and `await` are what the workflow runtime gives a
    // script, so the body only parses inside an async function — and `export`
    // only parses outside one. Trading the keyword away leaves the syntax the
    // check is for.
    try { new AsyncFunction(src.replace(/^export const meta =/m, "const meta =")); }
    catch (e) { problems.push(file + " does not parse: " + e.message); continue; }
    const meta = /export const meta = \{[\s\S]*?\bname:\s*.([\w-]+)./.exec(src);
    if (!meta) { problems.push(file + ": no meta.name"); continue; }
    if (names.has(meta[1])) problems.push(meta[1] + " is declared by " + names.get(meta[1]) + " and " + file);
    names.set(meta[1], file);
  }
  for (const wanted of ["loop", "agile-loop"]) {
    if (!names.has(wanted)) problems.push("no workflow declares the name " + wanted);
  }
  if (problems.length) { console.error(problems.join("; ")); process.exit(1); }
' "$root"
if [ $? -eq 0 ]; then
  ok "every workflow script parses and declares its own name, loop and agile-loop among them"
else
  no "a workflow script does not parse, or two of them claim one name"
fi

# The incremental loop is the one that hands an agent a slice of the issue, and
# the rule that makes that safe — the named increment is the whole of what the
# agent is asked for — has to reach the agent, not just the script. The shared
# brief is the only channel that does so in every project alike.
if grep -q 'increment' "$root/skills/agent-brief/SKILL.md"; then
  ok "the shared brief tells an agent what a prompt naming one increment means"
else
  no "nothing in the shared brief bounds an agent to the increment its prompt names"
fi

echo
echo "=== every agent page is declared"

# Agent discovery for a plugin scans `agents/` recursively, so `plugin.json`
# declares the pages instead — and nothing compares the two. A page missing
# from the list is an agent that is simply not there in any session, which the
# workflow calling it discovers only at dispatch.
node -e '
  const fs = require("fs"), path = require("path");
  const root = process.argv[1];
  const declared = JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin/plugin.json"), "utf8")).agents || [];
  const onDisk = fs.readdirSync(path.join(root, "agents")).filter((f) => f.endsWith(".md")).sort();
  const problems = [];
  for (const page of onDisk) {
    if (!declared.includes("./agents/" + page)) problems.push("agents/" + page + " is not declared in plugin.json");
  }
  for (const entry of declared) {
    if (!fs.existsSync(path.join(root, entry))) problems.push(entry + " is declared but does not exist");
  }
  if (problems.length) { console.error(problems.join("; ")); process.exit(1); }
' "$root"
if [ $? -eq 0 ]; then
  ok "plugin.json declares every page in agents/ and nothing that is not there"
else
  no "plugin.json and agents/ disagree about which agents exist"
fi

echo
echo "=== remote operation deploys the collector alone"

# Dockerfile, compose.yaml and render.yaml build and run argus. The interface
# is local only: it is never packaged into the image, never named by the
# blueprint, and the collector no longer carries the files it serves.
node -e '
  const fs = require("fs"), path = require("path");
  const root = process.argv[1];
  const problems = [];
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "tools/argus/package.json"), "utf8"));
  if ((pkg.files || []).includes("public")) problems.push("tools/argus/package.json still ships public/");
  if (fs.existsSync(path.join(root, "tools/argus/public"))) problems.push("tools/argus/public still exists");
  for (const file of ["tools/argus/Dockerfile", "tools/argus/compose.yaml", "render.yaml"]) {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    if (/argus-ui/.test(text)) problems.push(file + " deploys the interface");
    if (/public\//.test(text)) problems.push(file + " still references public/");
  }
  if (problems.length) { console.error(problems.join("; ")); process.exit(1); }
' "$root"
if [ $? -eq 0 ]; then
  ok "the image, the compose file and the blueprint carry the collector and no interface"
else
  no "the deployment still carries the interface"
fi

echo
if [ "$failed" -eq 0 ]; then
  echo "PASS: $passed cases"
else
  echo "FAIL: $failed of $((passed + failed)) cases"
  exit 1
fi
