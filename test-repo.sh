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

# Criterion 1: the coverage-gap/defect classification is a value the
# reviewer's structured return sets, not a phrase the workflow greps out of
# prose, so each workflow's verdict schema has to offer 'coverage-gap' and
# 'defect' as literal values a reviewer can choose. Without this a script
# could route on f.kind while no schema ever let a reviewer set it, and every
# driver mode above would still pass, because the driver stubs a fixture
# straight past whatever schema the workflow declares and never validate it.
for f in "$root/workflows/loop.js" "$root/workflows/agile-loop.js"; do
  name="$(basename "$f")"
  if grep -qF "'coverage-gap'" "$f" && grep -qF "'defect'" "$f"; then
    ok "$name's verdict schema offers 'coverage-gap' and 'defect' as literal values"
  else
    no "$name's verdict schema is missing 'coverage-gap' or 'defect' as a quoted literal"
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

# Criterion 6: what makes a finding a coverage gap rather than a defect has
# to be decided the same way twice, so the reviewer's own page states the
# rule instead of leaving it to be inferred from the field's name alone.
missing_classification_terms=""
for term in 'coverage-gap' 'defect' 'goes red'; do
  grep -qF -- "$term" "$reviewer_page" || missing_classification_terms="${missing_classification_terms} '$term'"
done
if [ -z "$missing_classification_terms" ]; then
  ok "the reviewer's page states what makes a finding a coverage gap rather than a defect"
else
  no "the reviewer's page is missing:$missing_classification_terms"
fi

# Finding 1: the shortened round must not dispatch the test-author against
# orders its own page forbids, so the test-author's page needs a
# coverage-only mode that tells it the round it is in and the proof it still
# owes.
test_author_page="$root/agents/test-author.md"
missing_coverage_only_terms=""
for term in 'coverage-only' 'goes red' 'worktree'; do
  grep -qF -- "$term" "$test_author_page" || missing_coverage_only_terms="${missing_coverage_only_terms} '$term'"
done
if [ -z "$missing_coverage_only_terms" ]; then
  ok "the test-author's page carries a coverage-only mode"
else
  no "the test-author's page is missing:$missing_coverage_only_terms"
fi

# "The reviewer's own brief states what makes a finding a coverage gap rather
# than a defect, so the classification is decided the same way twice" —
# finding 2: the reviewer's page has to name the test-author-alone path where
# it enumerates who works a correction round, not merely mention the word
# somewhere else on the page. 'test-author' already occurs twice elsewhere on
# the page, so a plain file-wide grep would be green today and prove nothing;
# the -B3 window is what makes this case about the enumeration.
if grep -B3 -F 'has these fields and' "$reviewer_page" | grep -q 'test-author'; then
  ok "the reviewer's page names the test-author-alone path in its round-worker enumeration"
else
  no "the reviewer's page does not name the test-author-alone path where it enumerates who works a correction round"
fi

# Finding 1 again, on the other side of the same contradiction: the shortened
# round's prompt must not forbid the go-red proof the test-author's page
# requires, so the sandbox the page prescribes has to be named in both
# workflows' coverage-only prompt.
for f in "$root/workflows/loop.js" "$root/workflows/agile-loop.js"; do
  name="$(basename "$f")"
  if grep -qF 'worktree' "$f"; then
    ok "$name's coverage-only prompt names the worktree sandbox"
  else
    no "$name's coverage-only prompt does not name the worktree sandbox"
  fi
done

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
  'MARKER-STALE-CUT',
  'MARKER-FRESH-CUT',
  'MARKER-CUT-QUESTION',
  'MARKER-DIRECT-CLAIM',
  'MARKER-DIRECT-REPRODUCTION',
  'MARKER-COVERAGE-CLAIM',
  'MARKER-COVERAGE-REPRODUCTION',
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
    fix: 'needs-plan',
  }],
  reason: 'MARKER-VERDICT-REASON',
  questions: [],
  summary: 'verdict summary',
};

// w16's fixture: a review whose every finding is a direct fix — the wording of
// a document, with the file, the line and the right word in the reproduction.
// Such a round is worked without a researcher and without a test, so the
// implementer is dispatched straight off this verdict.
const verdictReturnWithDirectFinding = {
  findings: [{
    claim: 'MARKER-DIRECT-CLAIM',
    reproduction: 'MARKER-DIRECT-REPRODUCTION',
    criterion: 'none',
    kind: 'defect',
    fix: 'direct',
  }],
  reason: 'MARKER-VERDICT-REASON',
  questions: [],
  summary: 'verdict summary',
};

// w17's fixture: a review whose every finding is a coverage gap — the
// behaviour is right, but nothing goes red when it breaks. Such a round is
// worked by the test-author and the reviewer alone, off the finding itself,
// with no researcher and no implementer paid to conclude the code already
// works.
const verdictReturnWithCoverageFinding = {
  findings: [{
    claim: 'MARKER-COVERAGE-CLAIM',
    reproduction: 'MARKER-COVERAGE-REPRODUCTION',
    criterion: 'none',
    kind: 'coverage-gap',
    fix: 'needs-plan',
  }],
  reason: 'MARKER-VERDICT-REASON',
  questions: [],
  summary: 'verdict summary',
};

// w18's fixture: a review whose findings mix a coverage gap with a defect —
// at least one defect among them runs the full four-agent chain, and the
// mixed round must drop neither finding from the researcher's prompt.
const verdictReturnWithMixedFindings = {
  findings: [
    {
      claim: 'MARKER-COVERAGE-CLAIM',
      reproduction: 'MARKER-COVERAGE-REPRODUCTION',
      criterion: 'none',
      kind: 'coverage-gap',
      fix: 'needs-plan',
    },
    {
      claim: 'MARKER-FINDING-CLAIM',
      reproduction: 'MARKER-FINDING-REPRODUCTION',
      criterion: 'MARKER-FINDING-CRITERION',
      kind: 'defect',
      fix: 'needs-plan',
    },
  ],
  reason: 'MARKER-VERDICT-REASON',
  questions: [],
  summary: 'verdict summary',
};

// w19's fixture: a coverage gap the reviewer also marked a direct fix — the
// coverage-only shortcut still has to apply; the guard that sends a
// direct-fix finding straight to the implementer alone must not swallow a
// coverage gap that happens to carry fix: 'direct' too.
const verdictReturnWithDirectCoverageFinding = {
  findings: [{
    claim: 'MARKER-COVERAGE-CLAIM',
    reproduction: 'MARKER-COVERAGE-REPRODUCTION',
    criterion: 'none',
    kind: 'coverage-gap',
    fix: 'direct',
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

// Round 4, finding 1's fixtures: a state file that holds increments while
// its decompose step is not replayable, which is the only case in which the
// Decompose is dispatched again with a populated backlog behind it.
// `carried` true is the run whose opening cut ended with a question for the
// human — the increments are in the file and the step is recorded with the
// question. `carried` false is the session that died between the planner's
// `init` and its `record` — the same increments, and no decompose step at
// all. Both make the resumed run work Decompose again, and both used to
// throw away the cut it returned.
function recutBacklog(carried) {
  return {
    version: 1,
    issue: 'docs/issues/x',
    workflow: isAgile ? 'agile-loop' : 'loop',
    increments: [
      { id: 'i1', title: 'MARKER-STALE-CUT', goal: 'Deliver i1.', criteria: ['does i1'], status: 'todo', note: '', steps: [] },
      { id: 'i2', title: 'Deliver i2', goal: 'Deliver i2.', criteria: ['does i2'], status: 'todo', note: '', steps: [] },
    ],
    run: {
      steps: carried
        ? [{
            label: 'decompose',
            at: '2026-08-07T00:00:00.000Z',
            return: Object.assign({}, decomposeReturnTwo, { questions: ['MARKER-CUT-QUESTION'] }),
          }]
        : [],
    },
  };
}

// The cut the human's answer bought: one increment under an id the stale
// file does not hold, so a run that works the superseded cut instead shows
// it in the labels it dispatches as well as in the prompts it sends.
const decomposeReturnRecut = {
  increments: [{ id: 'i3', title: 'MARKER-FRESH-CUT', goal: 'Deliver i3.', criteria: ['does i3'], status: 'todo', note: '' }],
  questions: [],
  summary: 'backlog summary',
};

// Round 5's fixture (round 4, finding 1): a closed increment beside an open
// one — the state a session leaves when it dies after `replan:i1` closed the
// first increment and re-cut. The resumed run must count `i1` as increment 1
// even though this session never worked it, pick `i2` up as increment 2, and
// hand its reviewer the baseline block naming the accepted code in the diff.
function laterIncrementBacklog() {
  return {
    version: 1,
    issue: 'docs/issues/x',
    workflow: 'agile-loop',
    increments: [
      { id: 'i1', title: 'Deliver i1', goal: 'Deliver i1.', criteria: ['does i1'], status: 'done', note: 'accepted', steps: [] },
      { id: 'i2', title: 'Deliver i2', goal: 'Deliver i2.', criteria: ['does i2'], status: 'todo', note: '', steps: [] },
    ],
    run: {
      steps: [
        { label: 'decompose', at: '2026-08-07T00:00:00.000Z' },
        { label: 'replan:i1', at: '2026-08-07T00:00:02.000Z', return: { summary: 'closed' } },
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
    case 'w20':
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
    case 'w13':
      return { stateReturn: { exists: true, backlogJson: JSON.stringify(recutBacklog(true), null, 2) + '\n', summary: '' }, decomposeReturn: decomposeReturnRecut, researchReturn: planReturn };
    case 'w14':
      return { stateReturn: { exists: true, backlogJson: JSON.stringify(recutBacklog(false), null, 2) + '\n', summary: '' }, decomposeReturn: decomposeReturnRecut, researchReturn: planReturn };
    case 'w15':
      return { stateReturn: { exists: true, backlogJson: JSON.stringify(laterIncrementBacklog(), null, 2) + '\n', summary: '' }, decomposeReturn: decomposeReturnTwo, researchReturn: planReturn };
    case 'w16':
      return { stateReturn: { exists: false, backlogJson: '', summary: '' }, decomposeReturn: decomposeReturnOne, researchReturn: planReturn, verdictFor: (label) => (label === 'review:i1.0' ? verdictReturnWithDirectFinding : verdictReturnClean) };
    case 'w17':
      return { stateReturn: { exists: false, backlogJson: '', summary: '' }, decomposeReturn: decomposeReturnOne, researchReturn: planReturn, verdictFor: (label) => (label === 'review:i1.0' ? verdictReturnWithCoverageFinding : verdictReturnClean) };
    case 'w18':
      return { stateReturn: { exists: false, backlogJson: '', summary: '' }, decomposeReturn: decomposeReturnOne, researchReturn: planReturn, verdictFor: (label) => (label === 'review:i1.0' ? verdictReturnWithMixedFindings : verdictReturnClean) };
    case 'w19':
      return { stateReturn: { exists: false, backlogJson: '', summary: '' }, decomposeReturn: decomposeReturnOne, researchReturn: planReturn, verdictFor: (label) => (label === 'review:i1.0' ? verdictReturnWithDirectCoverageFinding : verdictReturnClean) };
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
    // Fixture maintenance for this increment: verdictReturnWithFinding
    // carries no kind key at all — the missing-field guard — so a round
    // built on it is not coverage-only and must not claim to be.
    assertTrue(!logs.some((l) => l.includes('correcting coverage only')),
      'a review whose finding carries no kind at all logged that it is correcting coverage only');
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
  } else if (mode === 'w13' || mode === 'w14') {
    // Round 4, finding 1: both scripts preferred the increments of the state
    // snapshot they read at startup over the ones Decompose returned,
    // unconditionally — including when Decompose was dispatched in this
    // session rather than replayed. So a planner that read the human's answer,
    // re-cut and rewrote backlog.json had its new cut thrown away, and the run
    // worked the cut the answer had just replaced.
    const closeLabel = isAgile ? 'replan:i3' : 'close:i3';
    assertEqualArrays(labels,
      ['load-state', 'decompose', 'research:i3.0', 'tests:i3.0', 'implement:i3.0', 'review:i3.0', closeLabel, 'publish'],
      'the run worked the stale cut from the state file instead of the cut the re-dispatched Decompose returned');
    assertTrue(!calls.some((c) => c.prompt.includes('MARKER-STALE-CUT')),
      'a prompt of this run carries the superseded increment the state file still held');
    const closeCall = calls.find((c) => c.label === closeLabel);
    assertTrue(!!closeCall && closeCall.prompt.includes('MARKER-FRESH-CUT'),
      'the closing planner was not told about the increment of the fresh cut');
    assertTrue(!!result && Array.isArray(result.blockedOnHuman) && result.blockedOnHuman.length === 0,
      'the run ended blocked on the human instead of working the fresh cut to a close');
    if (mode === 'w13') {
      const decomposeCall = calls.find((c) => c.label === 'decompose');
      assertTrue(!!decomposeCall && decomposeCall.prompt.includes('MARKER-CUT-QUESTION'),
        'the Decompose worked again does not carry the question that ended the last run');
    }
  } else if (mode === 'w15') {
    // Round 4, finding 1: a resumed run counted its increments from scratch,
    // so the first increment it picked up was treated as increment 1 —
    // baseline(1) is the empty string, and the reviewer was handed the code
    // an earlier iteration had already accepted with nothing naming it. The
    // human's result lost the closed increment's line the same way.
    assertTrue(isAgile, "w15 is the incremental loop's mode: the plain loop holds one increment");
    assertEqualArrays(labels,
      ['load-state', 'research:i2.0', 'tests:i2.0', 'implement:i2.0', 'review:i2.0', 'replan:i2', 'publish'],
      'the resumed run did not pick up the open increment behind the closed one');
    const reviewCall = calls.find((c) => c.label === 'review:i2.0');
    assertTrue(!!reviewCall && reviewCall.prompt.includes('Increment 1 was reviewed and accepted'),
      "the resumed reviewer's prompt does not name the closed increment as its baseline");
    assertTrue(!!reviewCall && reviewCall.prompt.includes('increment 2 is yours'),
      'the resumed run does not count the open increment as the second');
    assertTrue(!!result && result.delivered === 2,
      'the resumed run did not close both increments as delivered');
    assertTrue(!!result && Array.isArray(result.increments) && result.increments.length === 2
      && JSON.stringify(result.increments).includes('"i1"'),
      'the increment the earlier session closed has no line in result.increments');
  } else if (mode === 'w16') {
    // The direct-fix round: a review whose findings all need no plan is worked
    // by the implementer alone, off the findings themselves, and is reviewed
    // afterwards like any other. Without that path the same wrong word in a
    // document costs a researcher, and with it skipping the review as well it
    // would ship unread.
    const closeLabel = isAgile ? 'replan:i1' : 'close:i1';
    assertEqualArrays(labels,
      ['load-state', 'decompose', 'research:i1.0', 'tests:i1.0', 'implement:i1.0', 'review:i1.0',
       'implement:i1.1', 'review:i1.1', closeLabel, 'publish'],
      'a review whose findings are all direct fixes did not skip exactly the researcher and the test-author');
    const fixCall = calls.find((c) => c.label === 'implement:i1.1');
    for (const marker of ['MARKER-DIRECT-CLAIM', 'MARKER-DIRECT-REPRODUCTION']) {
      assertTrue(!!fixCall && fixCall.prompt.includes(marker),
        "the direct-fix round's implementer prompt does not carry " + marker);
    }
    assertTrue(!!fixCall && fixCall.prompt.includes('CHECK-MARKER'),
      "the direct-fix round's implementer prompt does not carry the checks the round before closed");
    assertTrue(!!fixCall && !fixCall.prompt.includes(TESTPLAN_MARKER),
      "the direct-fix round's implementer prompt carries a test plan");
    const reviewCall = calls.find((c) => c.label === 'review:i1.1');
    assertTrue(!!reviewCall && reviewCall.prompt.includes('CHECK-MARKER'),
      'the review after a direct-fix round was handed no checks');
    assertTrue(!!reviewCall && !reviewCall.prompt.includes('MARKER-DIRECT-CLAIM'),
      "the review after a direct-fix round was handed the finding it wrote, and is no longer independent");
  } else if (mode === 'w17') {
    // Criteria 2 and 4: a correction round whose every finding is a coverage
    // gap runs the test-author and the reviewer alone — no researcher, no
    // implementer — and the workflow logs that it took the shortened path.
    const closeLabel = isAgile ? 'replan:i1' : 'close:i1';
    assertEqualArrays(labels,
      ['load-state', 'decompose', 'research:i1.0', 'tests:i1.0', 'implement:i1.0', 'review:i1.0',
       'tests:i1.1', 'review:i1.1', closeLabel, 'publish'],
      'a correction round whose findings are all coverage gaps did not skip exactly the researcher and the implementer');
    const testsCall = calls.find((c) => c.label === 'tests:i1.1');
    for (const marker of ['MARKER-COVERAGE-CLAIM', 'MARKER-COVERAGE-REPRODUCTION']) {
      assertTrue(!!testsCall && testsCall.prompt.includes(marker),
        "the coverage-only round's test-author prompt does not carry " + marker);
    }
    assertTrue(!!testsCall && testsCall.prompt.includes('CHECK-MARKER'),
      "the coverage-only round's test-author prompt does not carry the checks the round before closed");
    assertTrue(!!testsCall && !testsCall.prompt.includes(TESTPLAN_MARKER),
      "the coverage-only round's test-author prompt carries a stale test plan no researcher wrote this round");
    const reviewCall = calls.find((c) => c.label === 'review:i1.1');
    assertTrue(!!reviewCall && reviewCall.prompt.includes('CHECK-MARKER'),
      'the review after a coverage-only round was handed no checks');
    assertTrue(!!reviewCall && !reviewCall.prompt.includes('MARKER-COVERAGE-CLAIM'),
      "the review after a coverage-only round was handed the finding it wrote, and is no longer independent");
    assertTrue(logs.some((l) => l.includes('correcting coverage only')),
      'the workflow never logged that it is correcting coverage only');
    assertTrue(!!result && Array.isArray(result.blockedOnHuman) && result.blockedOnHuman.length === 0,
      'a coverage-only round did not run to a clean close');
  } else if (mode === 'w18') {
    // Criterion 3: at least one defect among a round's findings runs the
    // full four-agent chain unchanged, dropping neither finding from the
    // researcher's prompt.
    const closeLabel = isAgile ? 'replan:i1' : 'close:i1';
    assertEqualArrays(labels,
      ['load-state', 'decompose', 'research:i1.0', 'tests:i1.0', 'implement:i1.0', 'review:i1.0',
       'research:i1.1', 'tests:i1.1', 'implement:i1.1', 'review:i1.1', closeLabel, 'publish'],
      'a correction round with one defect among its coverage gaps did not run the full chain');
    assertTrue(!logs.some((l) => l.includes('correcting coverage only')),
      'a round with a defect among its findings logged that it is correcting coverage only');
    const researchCall = calls.find((c) => c.label === 'research:i1.1');
    for (const marker of ['MARKER-FINDING-CLAIM', 'MARKER-COVERAGE-CLAIM']) {
      assertTrue(!!researchCall && researchCall.prompt.includes(marker),
        "the mixed round's researcher prompt does not carry " + marker);
    }
  } else if (mode === 'w19') {
    // The repeat/conflict edge of criterion 2 against the existing
    // direct-fix fast path: a coverage gap the reviewer also marked a
    // direct fix still goes to the test-author, not to the implementer
    // alone — the coverage-gap classification wins the routing over fix.
    const closeLabel = isAgile ? 'replan:i1' : 'close:i1';
    assertEqualArrays(labels,
      ['load-state', 'decompose', 'research:i1.0', 'tests:i1.0', 'implement:i1.0', 'review:i1.0',
       'tests:i1.1', 'review:i1.1', closeLabel, 'publish'],
      'a coverage gap marked a direct fix was routed to the implementer alone instead of the test-author');
    assertTrue(logs.some((l) => l.includes('correcting coverage only')),
      'the workflow never logged that it is correcting coverage only');
  } else if (mode === 'w20') {
    // The stdin form has to reach the agent in the prompt it is actually
    // dispatched with, not only in the brief: a `<that file>` regression in
    // recordStep would leave both pages disagreeing with each other.
    for (const c of calls) {
      if (c.label === 'load-state' || c.label === 'publish') continue;
      assertTrue(/record \S*backlog\.json \S+ \S+ -/.test(c.prompt),
        c.label + " is not told to record its return with the stdin argument");
      assertTrue(/stdin/i.test(c.prompt),
        c.label + ' is not told that its return goes to the recorder on stdin');
    }
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
  run_driver "$wf" w13 "$wf_name: a Decompose worked again after the human's answer has its new cut worked, not the one the state file still held"
  run_driver "$wf" w14 "$wf_name: a Decompose worked again after a session died before recording it has its new cut worked"
  run_driver "$wf" w16 "$wf_name: a correction round whose findings are all direct fixes skips the researcher and the test-author, and is still reviewed"
  run_driver "$wf" w17 "$wf_name: a correction round whose findings are all coverage gaps runs the test-author and the reviewer alone, and logs that it is correcting coverage only"
  run_driver "$wf" w18 "$wf_name: a correction round with one defect among its coverage gaps runs the full chain"
  run_driver "$wf" w19 "$wf_name: a coverage gap marked a direct fix still goes to the test-author, not to the implementer alone"
  run_driver "$wf" w20 "$wf_name: every step's prompt tells the agent to pipe its return to the recorder on stdin"
done

# Round 3, finding 2: only the incremental loop re-cuts, so an increment
# handed back is agile-loop.js's case alone.
run_driver "$root/workflows/agile-loop.js" w12 "agile-loop.js: an increment the planner hands back is worked a second time, not skipped as recorded"
run_driver "$root/workflows/agile-loop.js" w15 "agile-loop.js: a run resumed behind a closed increment counts it and hands the reviewer its baseline"

rm -rf "$driver_tmp"

echo
echo "=== no page under tools/argus describes an argus-ui view that does not exist"

# docs/issues/2026-08-07-timeline-focus-and-context-filter removed argus-ui's
# six technical tabs, so a session's detail pane is now only the session list,
# the timeline and the context panel. tools/argus/README.md still promised the
# old shape: "tabs" plural, a "waterfall" figure, the wrapped enumeration
# "sessions, overview, tasks, traces, events, metrics, attributes", a "tools
# table", content shown "under \"Attributes\"", and a sentence that "writes
# the source under" every figure. Nothing compared the collector's own docs to
# the interface it describes, so this drifted for a whole increment before a
# reviewer caught it. Whitespace is collapsed before matching because the
# offending enumeration is line-wrapped in the source — "sessions, overview,"
# ends one line and "tasks, traces, …" begins the next — and a per-line grep
# would miss it.
declare -a argus_view_patterns=(
  '\btabs?\b'
  '\bwaterfall\b'
  'overview, *tasks'
  'tools table'
  'under "Attributes"'
  'writes the source under'
)
argus_view_hits=""
for file in "$root"/tools/argus/*.md; do
  [ -e "$file" ] || continue
  collapsed="$(tr '\n' ' ' <"$file" | tr -s ' ')"
  for pattern in "${argus_view_patterns[@]}"; do
    if echo "$collapsed" | grep -qiE "$pattern"; then
      argus_view_hits="${argus_view_hits}$(basename "$file") matches $pattern
"
    fi
  done
done
if [ -z "$argus_view_hits" ]; then
  ok "no page under tools/argus describes an argus-ui view that does not exist"
else
  no "these pages under tools/argus still describe a removed argus-ui view:"
  echo "$argus_view_hits" | sed 's/^/       /'
fi

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
    // Parsing is not enough. The harness reads `meta` before it runs a line of
    // the script and rejects any value it would have to evaluate — a
    // concatenated string, a variable, a template, a spread. A workflow that
    // trips that rule is valid JavaScript, compiles here, and is still never
    // listed and never dispatchable, which is how agile-loop shipped unusable.
    // Strings go first and comments after them, so a brace inside either is not
    // read as structure; then the keys go, and what is left is the values.
    const from = src.indexOf("{", src.indexOf("export const meta ="));
    // The apostrophe is spelled \u0027 below, and named nowhere in this
    // comment, because the whole program is one single-quoted argument to
    // `node -e`: a bare apostrophe anywhere in it ends the argument.
    const bare = src.slice(from)
      .replace(/\u0027(?:[^\u0027\\]|\\.)*\u0027/g, "0")
      .replace(/"(?:[^"\\]|\\.)*"/g, "0")
      .replace(/\/\/.*$/gm, "");
    let depth = 0, end = -1;
    for (let i = 0; i < bare.length; i++) {
      if (bare[i] === "{") depth++;
      else if (bare[i] === "}" && --depth === 0) { end = i; break; }
    }
    const values = bare.slice(0, end + 1).replace(/[A-Za-z_$][\w$]*\s*:/g, ":");
    const bad = [];
    if (end < 0) bad.push("it is never closed");
    if (/`/.test(values)) bad.push("a template literal");
    if (/\+/.test(values)) bad.push("a concatenation");
    if (/\.\.\./.test(values)) bad.push("a spread");
    for (const id of values.match(/[A-Za-z_$][\w$]*/g) || []) {
      if (id !== "true" && id !== "false" && id !== "null") { bad.push(id); break; }
    }
    if (bad.length) problems.push(file + ": meta is not a pure literal (" + bad.join(", ") + ")");
    if (names.has(meta[1])) problems.push(meta[1] + " is declared by " + names.get(meta[1]) + " and " + file);
    names.set(meta[1], file);
  }
  for (const wanted of ["loop", "agile-loop"]) {
    if (!names.has(wanted)) problems.push("no workflow declares the name " + wanted);
  }
  if (problems.length) { console.error(problems.join("; ")); process.exit(1); }
' "$root"
if [ $? -eq 0 ]; then
  ok "every workflow script parses, keeps meta a pure literal, and declares its own name, loop and agile-loop among them"
else
  no "a workflow script does not parse, its meta is not a pure literal, or two of them claim one name"
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
echo "=== the retro reads a whole run, not one transcript at a time"

# `bin/parse-agent-log` gained a run-directory mode so a 44-agent run is one
# report instead of 44 hand-joined ones. The retro skill must point at that
# mode, and no page describing the tool may still tell a reader to loop it
# over each transcript and re-join the results by hand — the exact manual
# process this mode replaces.
if grep -q -- '--latest-run' "$root/skills/retro/SKILL.md" && grep -qi 'run directory' "$root/skills/retro/SKILL.md"; then
  ok "the retro skill points the session at the run-directory mode"
else
  no "the retro skill does not point the session at the run-directory mode:"
  grep -n -- '--latest-run\|run directory' "$root/skills/retro/SKILL.md" | sed 's/^/       /'
fi

# This fails on the phrase however it is meant, a prohibition included — the
# pages must simply not contain these words, whatever the sentence around
# them says.
doc_loop_hits="$(grep -inE 'each (subagent )?transcript|per transcript|transcript at a time|re-?join' \
  "$root/README.md" "$root"/skills/*/SKILL.md 2>/dev/null || true)"
if [ -z "$doc_loop_hits" ]; then
  ok "no page documenting the parser asks for a per-transcript loop"
else
  no "these lines still ask for a per-transcript loop:"
  echo "$doc_loop_hits" | sed 's/^/       /'
fi

echo
echo "=== the recorder takes the step return on stdin"

# Finding 5: the shared brief's own record command has to show the stdin
# argument, not just a payload file. -F because the string carries `<`, `>`
# and `/`. This is the case that goes red if the brief regresses to
# `<thatFile>`, and it asserts what the page says now rather than the
# absence of the old phrase.
if grep -qF 'record <issueDir>/backlog.json <incrementId> <label> -' "$root/skills/agent-brief/SKILL.md"; then
  ok "the shared brief's record command ends in the stdin argument"
else
  no "the shared brief does not show the record command with the stdin argument:"
  grep -n 'backlog.json <incrementId>' "$root/skills/agent-brief/SKILL.md" | sed 's/^/       /'
fi

if grep -qi 'stdin' "$root/skills/agent-brief/SKILL.md"; then
  ok "the shared brief names stdin as the channel a step return is recorded through"
else
  no "the shared brief never mentions stdin"
fi

echo
if [ "$failed" -eq 0 ]; then
  echo "PASS: $passed cases"
else
  echo "FAIL: $failed of $((passed + failed)) cases"
  exit 1
fi
