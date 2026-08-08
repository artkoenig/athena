// The one workflow of the plugin, and a session runs it as
// `uroboros:agile-loop`. It ships because `plugin.json` declares the whole
// `workflows/` directory. There is no separate plain loop: the planner
// decides whether and how to cut, and a backlog of one increment is the
// plain chain, run by the same script.
//
// Every value in `meta` is one whole literal: the harness parses this object
// before it runs a line of the script and rejects anything it has to evaluate,
// concatenated strings included, so a `+` here costs the whole workflow its
// registration — it is never listed and never dispatchable. The lines below
// run long for that reason.
export const meta = {
  name: 'agile-loop',
  description: 'Runs the issue as a backlog: the planner maps the files the issue changes and cuts it into increments — one is a valid cut — then each increment runs through research, tests, implementation and review, and the planner re-cuts what is still open after each.',
  whenToUse: 'When an issue file with confirmed acceptance criteria exists and the whole chain should run without the main session steering it. The planner decides whether and how to cut the issue; nothing has to be decided before starting it. Pass the issue directory as args.issueDir.',
  phases: [
    { title: 'Load state', detail: 'the run state is read, so a restart resumes where it stopped' },
    { title: 'Decompose', detail: 'planner maps the files the issue changes and cuts it into a backlog of increments' },
    { title: 'Research', detail: 'researcher plans the current increment' },
    { title: 'Tests', detail: 'test-author writes failing tests' },
    { title: 'Implement', detail: 'implementer makes them pass' },
    { title: 'Review', detail: 'reviewer checks the increment against its criteria' },
    { title: 'Replan', detail: 'planner closes the increment and re-cuts the ones still open' },
    { title: 'Publish', detail: 'the branch goes to the remote and a pull request exists' },
  ],
}

// The script is the orchestrator. No agent dispatches another one: the shared
// brief every uroboros agent preloads says so, and no prompt below repeats it.
// That is the rule for every text here — a prompt carries what varies with the
// dispatch, and a rule that holds for a role whatever it is dispatched for
// belongs to the shared brief, one that holds for one role to that role's page.
// Restating either here makes a second copy that drifts on the first edit, and
// the two general-purpose dispatches are the exception because they preload
// neither.
//
// `<issueDir>/backlog.json` is the single source of truth of a run. Each agent
// writes its return there once, through the shipped helper, and the next role
// reads it there: a dispatch prompt below names the steps its agent must read
// and carries none of their content. So no content is ever produced twice, and
// what a resumed run works from is the same object the live run worked from,
// because there is only one of it.
//
// What this script does carry is steering: the cut, whether tests are needed,
// the closed list of commands the reviewer runs, how many findings a review
// filed, and the questions that end a run. Those few small values reach it as
// each agent's structured return, and a resumed run recovers them from the
// state's index rather than from any agent re-emitting them. That is the whole
// of the duplication left, and it is the price of a script that has no
// filesystem: the workflow runtime gives it `args`, `agent`, `log` and `phase`
// and nothing else.
//
// The reviewer is the one role outside all of this. It reads nothing and is
// handed nothing any agent produced, because it is the check on them.

const MAX_CORRECTIONS = 2

// Three separate backstops, because a backlog can run away in three separate
// ways. The planner may keep adding increments (MAX_INCREMENTS), it may keep
// handing back an increment that never finishes (MAX_ATTEMPTS, per id), and the
// run may be failing for a reason no re-cut will fix (MAX_BLOCKED). Each one
// stops the loop and hands back to the human rather than burning the budget.
//
// MAX_BLOCKED is derived from the statuses in the run state, so it survives a
// restart. MAX_ATTEMPTS is deliberately session-local: closing an increment
// ends its attempt in the state, so nothing there counts attempts, and a
// restart granting one more attempt is cheaper than a second counter in the
// file that every writer would have to maintain.
const MAX_INCREMENTS = 8
const MAX_ATTEMPTS = 2
const MAX_BLOCKED = 2

// The caller may hand us the object, a JSON string of it, or the bare path —
// the harness stringifies args on some paths, and a run must not die on that.
const parsed =
  typeof args === 'string'
    ? args.trim().startsWith('{')
      ? JSON.parse(args)
      : { issueDir: args.trim() }
    : args

const dir = parsed && parsed.issueDir
if (!dir) {
  log('No args.issueDir given — nothing to run. Call with args: { issueDir: "docs/issues/<name>" }.')
  return { ran: false, reason: 'missing args.issueDir' }
}

const maxIncrements = Number(parsed.maxIncrements) > 0 ? Number(parsed.maxIncrements) : MAX_INCREMENTS

// The index of the run state, not the state itself. It carries the cut, what
// each increment stands at, which steps are recorded and the small steering
// values each returned — never a codemap, a plan, a test plan or a finding. So
// the one agent that reads the state for this script emits something whose
// size does not grow with the run, however much the file itself keeps.
const INDEX_STEP = {
  type: 'object',
  properties: {
    label: { type: 'string', description: 'The step label, exactly as the index printed it.' },
    asked: {
      type: 'boolean',
      description: 'The index\'s `asked` for this step: true when its return carried questions.',
    },
    questions: {
      type: 'array',
      items: { type: 'string' },
      description: 'The step return\'s `questions`, when the index carried them. Empty otherwise.',
    },
    needsTests: {
      type: 'boolean',
      description: 'The step return\'s `needsTests` when the index carried one, false otherwise.',
    },
    checks: {
      type: 'array',
      items: { type: 'string' },
      description: 'The step return\'s `checks` when the index carried them. Empty otherwise.',
    },
    findingCount: {
      type: 'integer',
      description: 'The step return\'s `findingCount` when the index carried one, 0 otherwise.',
    },
    allDirect: {
      type: 'boolean',
      description: 'The step return\'s `allDirect` when the index carried one, false otherwise.',
    },
    reason: {
      type: 'string',
      description: 'The step return\'s `reason` when the index carried one, empty otherwise.',
    },
  },
  required: ['label', 'asked', 'questions', 'needsTests', 'checks', 'findingCount', 'allDirect', 'reason'],
  additionalProperties: false,
}

const STATE = {
  type: 'object',
  properties: {
    exists: { type: 'boolean', description: 'True only when backlog.json exists and you read its index.' },
    branch: {
      type: 'string',
      description:
        'What `git branch --show-current` printed in the checkout. Empty string when it failed.',
    },
    increments: {
      type: 'array',
      description: 'The index\'s `increments`, in the order it printed them. Empty when there is no state.',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          goal: { type: 'string' },
          criteria: { type: 'array', items: { type: 'string' } },
          status: { type: 'string', enum: ['todo', 'done', 'blocked', 'dropped'] },
          note: { type: 'string' },
          branch: { type: 'string' },
          steps: { type: 'array', items: INDEX_STEP },
        },
        required: ['id', 'title', 'goal', 'criteria', 'status', 'note', 'branch', 'steps'],
        additionalProperties: false,
      },
    },
    runSteps: {
      type: 'array',
      description: 'The index\'s `run.steps`. Empty when there is no state.',
      items: INDEX_STEP,
    },
    summary: { type: 'string' },
  },
  required: ['exists', 'branch', 'increments', 'runSteps', 'summary'],
  additionalProperties: false,
}

// What each role hands back to this script: the values it steers on, and
// nothing else. Everything a role produces for another role goes into the run
// state instead, which is why none of these schemas carries a plan, a map, a
// test plan, a case list or a finding.
const BACKLOG = {
  type: 'object',
  properties: {
    increments: {
      type: 'array',
      description:
        'The cut you just wrote with `init`, finished and dropped increments included, in ' +
        'the order they should be worked. This is the one part of your work the script ' +
        'steers on, so it comes back here as well as going into the file.',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          goal: { type: 'string' },
          criteria: { type: 'array', items: { type: 'string' } },
          status: { type: 'string', enum: ['todo', 'done', 'blocked', 'dropped'] },
          note: { type: 'string' },
        },
        required: ['id', 'title', 'goal', 'criteria', 'status', 'note'],
        additionalProperties: false,
      },
    },
    questions: {
      type: 'array',
      items: { type: 'string' },
      description: 'Your return\'s `questions`, the way your shared brief defines them.',
    },
    summary: { type: 'string' },
  },
  required: ['increments', 'questions', 'summary'],
  additionalProperties: false,
}

const PLAN = {
  type: 'object',
  properties: {
    needsTests: {
      type: 'boolean',
      description: 'False only when this increment has nothing a test could check.',
    },
    checks: {
      type: 'array',
      items: { type: 'string' },
      description:
        'The `checks` you recorded, verbatim. The reviewer reads nothing you wrote, so the ' +
        'list reaches it through here.',
    },
    questions: {
      type: 'array',
      items: { type: 'string' },
      description: 'Your return\'s `questions`, the way your shared brief defines them.',
    },
    summary: { type: 'string' },
  },
  required: ['needsTests', 'checks', 'questions', 'summary'],
  additionalProperties: false,
}

const TESTS = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: { type: 'string' },
      description: 'Your return\'s `questions`, the way your shared brief defines them.',
    },
    summary: { type: 'string' },
  },
  required: ['questions', 'summary'],
  additionalProperties: false,
}

const BUILD = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: { type: 'string' },
      description: 'Your return\'s `questions`, the way your shared brief defines them.',
    },
    summary: { type: 'string' },
  },
  required: ['questions', 'summary'],
  additionalProperties: false,
}

const VERDICT = {
  type: 'object',
  properties: {
    findingCount: {
      type: 'integer',
      description: 'How many findings you recorded. 0 means the increment is accepted.',
    },
    allDirect: {
      type: 'boolean',
      description:
        'The `allDirect` you recorded. Such a round is corrected by the implementer alone, ' +
        'off your findings.',
    },
    reason: {
      type: 'string',
      description: 'The `reason` you recorded. Empty when findingCount is 0.',
    },
    questions: {
      type: 'array',
      items: { type: 'string' },
      description: 'Your return\'s `questions`, the way your shared brief defines them.',
    },
    summary: { type: 'string' },
  },
  required: ['findingCount', 'allDirect', 'reason', 'questions', 'summary'],
  additionalProperties: false,
}

const PUSH = {
  type: 'object',
  properties: {
    pushed: { type: 'boolean', description: 'True only when the push command exited 0.' },
    branch: { type: 'string' },
    prUrl: {
      type: 'string',
      description:
        'URL of the pull request for this branch — the one you opened, the open one ' +
        'you found, or the merged one you refused to duplicate. Empty string if there ' +
        'is none and you could not open one.',
    },
    prCreated: {
      type: 'boolean',
      description: 'True only when this run opened the pull request itself.',
    },
    summary: { type: 'string' },
  },
  required: ['pushed', 'branch', 'prUrl', 'prCreated', 'summary'],
  additionalProperties: false,
}

// The fields a role writes into the run state. The prompt names them and stops
// there: what each one holds is on the agent's own page, which is where a
// role-specific rule belongs, and `questions` and `summary` mean the same in
// every role, so the shared brief defines those two. A description here would
// be a third copy of a text that already has an owner.
//
// They are named in the dispatch prompt rather than in a schema, because the
// schema describes what comes back to this script and these never do: they are
// what the next role reads.
const PLAN_PAYLOAD = [
  'needsTests',
  'plan',
  'moduleMap',
  'environment',
  'testPlan',
  'checks',
  'questions',
  'summary',
]

const TESTS_PAYLOAD = ['cases', 'openQuestions', 'questions', 'summary']

const BUILD_PAYLOAD = ['deviations', 'commands', 'blockers', 'questions', 'summary']

const VERDICT_PAYLOAD = ['findings', 'findingCount', 'allDirect', 'reason', 'questions', 'summary']

const CUT_PAYLOAD = ['questions', 'summary']

// The reviewer is handed no part of the plan — that is what keeps it an
// independent pair of eyes. So the one thing it needs, the list of commands
// that count for this increment, is handed to it here instead: what to run,
// never why.
function checkList(checks) {
  return checks && checks.length
    ? 'The commands that count for this increment:\n' +
        checks.map((c) => `  - \`${c}\``).join('\n') +
        '\n'
    : 'No command counts for this increment: the list is empty.\n'
}

// Every dispatch ends with the two calls that make its work durable: the
// announcement that puts the agent in the run state as the step now running,
// and the record that writes its whole return there with the prompt that
// produced it. Both belong to every role alike, so why they exist, what goes in
// the files and that the structured return is not a second copy of them are the
// shared brief's, and this carries only what varies — the state file, the
// increment id, the label, and which fields this step returns.
function recordStep(incrementId, label, fields) {
  return (
    `Announce this step before you begin it and record it before you return, the way your ` +
    `shared brief describes, with the backlog helper it names:\n` +
    `  - \`start ${dir}/backlog.json ${incrementId} ${label} <the prompt file>\` — the ` +
    `prompt you were given, verbatim and whole, in a file outside the repository.\n` +
    `  - \`record ${dir}/backlog.json ${incrementId} ${label} <the return file> ` +
    `<the prompt file>\` — your return, in a file outside the repository, with that same ` +
    `prompt file. Commit it with your work and push the commit.\n` +
    `The fields your return carries, and your page says what each one holds:\n` +
    fields.map((name) => `  - \`${name}\``).join('\n') +
    '\n'
  )
}

// How a role takes its brief. It names the step and the fields it needs and gets
// exactly those out of the state — the plan, the test plan, the cases, the
// findings. No prompt carries that content itself, so these lines are the
// channel.
//
// The fields are named, not the step, wherever a role must not meet what sits
// beside its brief: the test-author reads the researcher's `testPlan` and the
// helper never hands it the `plan`. That is the same slicing the script used to
// do when it pasted content into prompts, moved into the read.
function readStep(incrementId, label, fields, what) {
  return (
    `  - \`steps ${dir}/backlog.json ${incrementId} ${label}` +
    (fields ? ` --fields ${fields}` : '') +
    `\` — ${what}\n`
  )
}

// The shared brief already binds an agent to exactly the steps and fields its
// prompt names, so this block is the naming and nothing around it.
function readBlock(intro, lines) {
  return (
    `${intro} It is in the run state, and these reads are how you get it, with the ` +
    `\`steps\` subcommand of the backlog helper your shared brief names:\n` +
    lines.join('')
  )
}

// The question this step asked before the run stopped. The human records the
// answer under `## Decisions` in issue.md, which is where this sends the agent.
function answeredBlock(label) {
  const asked = carriedQuestions.get(label)
  return asked && asked.length
    ? `This step ended the previous run with a question for the human:\n` +
        asked.map((q) => `  - ${q}`).join('\n') +
        '\n' +
        `The answer is under \`## Decisions\` in ${dir}/issue.md. Read it there first, then ` +
        `work this step again; ask again only what it does not answer.\n`
    : `This step ended the previous run with a question for the human. The answer is under ` +
      `\`## Decisions\` in ${dir}/issue.md, and your own earlier attempt is in the run state ` +
      `under this step's label. Read both, then work this step again.\n`
}

function questionBlock(label) {
  return carriedQuestions.has(label) ? answeredBlock(label) : ''
}

// A correction round whose findings are all `direct` is worked without a plan.
// The reproduction of such a finding already names the file, the line and the
// right result, so a researcher would spend a dispatch restating it and a test
// would have nothing to catch — a wrong word in a document is the case this
// exists for. What it does not skip is the review: the fix lands in the diff
// the next round judges, which is what keeps this cheap rather than unsafe, and
// it is also why the reviewer never makes the fix itself.
//
// A verdict that does not say `allDirect` counts as needing a plan: the fast
// path is something a verdict opts into, never something a missing field falls
// into.
function isDirectFixRound(verdict) {
  return !!(verdict && verdict.allDirect && (verdict.findingCount || 0) > 0)
}

// What every agent working an increment is told about the shape of the run. The
// issue file names criteria this increment is not meant to satisfy, and without
// this an agent reads them as its own — the researcher plans the whole issue in
// one go, and the reviewer files a finding for every criterion the run has not
// reached yet. What such a narrowing means is the shared brief's; this is the
// data it applies to.
function scope(task, all, n) {
  const open = all.filter((t) => t.status === 'todo' && t.id !== task.id)
  return (
    `This run works ${dir}/issue.md one increment at a time, and increment ${n} is yours:\n` +
    `  ${task.title} — ${task.goal}\n` +
    `What it has to satisfy:\n` +
    task.criteria.map((c) => `  - ${c}`).join('\n') +
    '\n' +
    (open.length
      ? `Deliberately not yours, and not a gap — a later increment takes each of these: ` +
        `${open.map((t) => t.title).join('; ')}.\n`
      : `Every other increment is settled; this is the last one, so the issue is complete ` +
        `once yours is.\n`)
  )
}

// Every run opens with this one cheap dispatch, and it is the only read of the
// run state this script makes. It asks for the state's index and never for the
// state: the index carries the cut, the recorded labels and the small steering
// values, so what this agent has to emit stays the same size however much the
// file has accumulated. It is not a step of the run — it runs before there is a
// file to record into — so it records nothing.
const state = await agent(
  `Issue directory: ${dir}\n` +
    `Read the index of ${dir}/backlog.json and return it. Run ` +
    `\`node "<the agent-brief skill's assets directory>/backlog.mjs" index ${dir}/backlog.json\`. ` +
    `If your context names no such skill base directory, find the helper with ` +
    `\`find "$HOME/.claude/plugins" -path '*agent-brief/assets/backlog.mjs' | head -1\`.\n` +
    `Return exists true, the index's \`increments\` in increments and its \`run.steps\` in ` +
    `runSteps. Each step of either carries the index's \`label\` and \`asked\`; fill ` +
    `questions, needsTests, checks, findingCount, allDirect and reason from that step's ` +
    `\`return\` object where the index carried them, and leave them empty otherwise.\n` +
    `Do NOT read the file itself and do NOT return its content: the index is what this ` +
    `dispatch is for.\n` +
    `If the file does not exist, return exists false with both lists empty.\n` +
    `Return the branch the checkout is on, from \`git branch --show-current\`, in branch.\n` +
    `The checkout's copy of the state can trail the copy an in-flight increment carries: ` +
    `where an increment in the index has status "todo" and a non-empty \`branch\` field, run ` +
    `\`git fetch origin <that branch>\` and then ` +
    `\`git merge-base --is-ancestor HEAD origin/<that branch>\`. Exit 0 means that branch ` +
    `continues this checkout, so write ` +
    `\`git show origin/<that branch>:${dir}/backlog.json\` to a file outside the repository, ` +
    `run the helper's \`index\` on that file, and return that index instead. A failed fetch, ` +
    `or any other exit, means the branch is an abandoned attempt: keep the checkout's copy.\n` +
    `Read nothing else, change nothing, run no git command beyond the read-only ones named ` +
    `here, and do not dispatch any subagent.`,
  { agentType: 'general-purpose', phase: 'Load state', label: 'load-state', schema: STATE },
)

const savedIndex = state && state.exists ? state : null

// The branch the run publishes: whatever the checkout was on when it started.
// Every increment is worked on its own branch off it and merged back into it
// on acceptance, so the issue branch only ever holds accepted work. When the
// state loader could not name it, the branch machinery stands down and the
// run works the checkout as it is.
const issueBranch = (state && typeof state.branch === 'string' && state.branch.trim()) || ''
if (!issueBranch) {
  log('The state loader named no branch — increments are worked on the current checkout.')
}

// A step that ended the run with a question for the human is not replayed from
// its recorded return: the human answered in `issue.md`, so the step is worked
// again with the question in front of it. Replaying it instead would re-raise
// the same question and end the resumed run at Publish without dispatching
// anyone — the restart the rulebook promises would make no progress at all.
//
// What `recorded` holds is the steering projection of a step, not its content.
// That is all this script ever had of a step return, live or resumed, so a
// skipped step hands the same values on as a dispatched one; the content the
// next role needs is in the file, and the next role reads it there either way.
const recorded = new Map()
const carriedQuestions = new Map()
if (savedIndex) {
  const load = (s) => {
    const asked = Array.isArray(s.questions) ? s.questions.filter(Boolean) : []
    if (s.asked) carriedQuestions.set(s.label, asked)
    else recorded.set(s.label, s)
  }
  for (const s of savedIndex.runSteps || []) load(s)
  for (const increment of savedIndex.increments || []) {
    for (const s of increment.steps || []) load(s)
  }
}
if (recorded.size) log(`Resuming: ${recorded.size} step(s) already recorded in the run state.`)
if (carriedQuestions.size) {
  log(`${carriedQuestions.size} step(s) ended the last run with a question and are worked again.`)
}

// Which branch each increment is worked on, by id. Seeded from the state so a
// resumed run continues on the branch the dead session recorded; kept current
// in-session so a fresh attempt gets a fresh name.
const branches = new Map()
if (savedIndex) {
  for (const t of savedIndex.increments || []) {
    if (typeof t.branch === 'string' && t.branch) branches.set(t.id, t.branch)
  }
}

// Whether any step of this increment is recorded, or ended the last run asking
// the human. That is the mid-flight test: a recorded branch is continued only
// for an increment with history — a handed-back increment keeps its abandoned
// branch in the state, and resuming onto it would resume the failed attempt.
// The trailing dot keeps one id from matching another it prefixes.
function incrementHasHistory(id) {
  for (const source of [recorded, carriedQuestions]) {
    for (const label of source.keys()) {
      if (label.includes(`:${id}.`)) return true
    }
  }
  return false
}

// The name of a fresh attempt's branch. The first attempt gets
// `<issueBranch>--<id>`; a later one bumps a `-take<n>` suffix onto the name
// the state still holds, so the abandoned branch keeps its name on the remote
// and the new one never collides with it.
function nextBranchName(id) {
  const base = `${issueBranch}--${id}`
  const prior = branches.get(id)
  if (!prior) return base
  const taken = prior.match(/-take(\d+)$/)
  return `${base}-take${taken ? Number(taken[1]) + 1 : 2}`
}

// What every dispatch of an increment is told about the branch it works on.
// The first dispatch of a fresh attempt records the name in the run state
// while still on the issue branch — that commit is how a resumed session finds
// the branch — and then creates it; every later dispatch makes sure it is on
// it. The shared brief owns the rule that the step's commits and pushes belong
// to the branch the prompt names.
function branchBlock(taskId, incrementBranch, create) {
  if (!incrementBranch) return ''
  if (create) {
    return (
      `This increment is worked on its own branch: \`${incrementBranch}\`, off \`${issueBranch}\`.\n` +
      `Before anything else, on \`${issueBranch}\`: record the name with the backlog helper's ` +
      `\`branch\` subcommand, as \`branch ${dir}/backlog.json ${taskId} ${incrementBranch}\`, ` +
      `commit that state change and push \`${issueBranch}\`. Then create the branch with ` +
      `\`git checkout -b ${incrementBranch}\`, push it with \`-u\`, and work on it from there.\n`
    )
  }
  return (
    `This increment is worked on branch \`${incrementBranch}\`. Before anything else make sure ` +
    `you are on it: \`git fetch origin ${incrementBranch}\` and check it out; if the remote ` +
    `does not have it, create it from \`${issueBranch}\` and push it with \`-u\`.\n`
  )
}

// The whole of resume. A recorded step returns its stored steering values and is
// never dispatched again; the step in flight when a session died was never
// recorded, so it repeats. Labels are keyed on the increment id, never on an
// ordinal a re-cut would move.
async function step(label, phaseName, run) {
  if (recorded.has(label)) {
    log(`${label}: recorded already, skipping`)
    return recorded.get(label)
  }
  phase(phaseName)
  const out = await run()
  recorded.set(label, out)
  return out
}

// Every step label that belongs to one increment: `research:<id>.<round>` and
// its siblings, plus `replan:<id>`. `load-state`, `decompose` and `publish`
// carry no id and are never forgotten.
function forgetSteps(id) {
  for (const label of [...recorded.keys()]) {
    const at = label.indexOf(':')
    if (at < 0) continue
    const rest = label.slice(at + 1)
    if (rest === id || rest.startsWith(`${id}.`)) recorded.delete(label)
  }
}

// A question only the human can answer ends the run: the loop skips to Publish
// and hands the questions back. The question is inside the step return the agent
// recorded, so the session that resumes finds it in the state too.
const blockedOnHuman = []
function asksTheHuman(label, out) {
  const questions = out && Array.isArray(out.questions) ? out.questions.filter(Boolean) : []
  for (const q of questions) {
    blockedOnHuman.push({ step: label, question: q })
    log(`${label} has a question for the human: ${q}`)
  }
  return questions.length > 0
}

// Asked before the step runs, never after: `step` writes the label into
// `recorded` the moment it dispatches, so the answer afterwards is always yes.
const cutWasReplayed = recorded.has('decompose')

const backlog = await step('decompose', 'Decompose', () =>
  agent(
    `Issue directory: ${dir}\n` +
      questionBlock('decompose') +
      `Open the run state for ${dir}/issue.md: map the issue against the codebase, decide ` +
      `the cut, and write both into ${dir}/backlog.json with the \`init\` subcommand of the ` +
      `backlog helper your shared brief names, with workflow "agile-loop" and the whole ` +
      `codemap in the payload's \`codemap\` field.\n` +
      `This run works at most ${maxIncrements} increments, so a cut that needs more than ` +
      `that is a cut that is too fine.\n` +
      recordStep('-', 'decompose', CUT_PAYLOAD),
    { agentType: 'uroboros:planner', phase: 'Decompose', label: 'decompose', schema: BACKLOG },
  ),
)
asksTheHuman('decompose', backlog)

// Which of the two lists of increments the run works. A replayed cut is the
// older of them: what `recorded` holds for it is the steering projection of the
// opening cut, and a status a later close set lives in the index this run read
// at startup. A Decompose dispatched again this session is the opposite case —
// the planner has just rewritten the file, so its return is the newer of the
// two and the snapshot this run read at startup is the stale one. Either side
// falls back to the other when it is empty.
const savedIncrements =
  savedIndex && Array.isArray(savedIndex.increments) && savedIndex.increments.length
    ? savedIndex.increments
    : null
const cutIncrements =
  backlog && Array.isArray(backlog.increments) && backlog.increments.length
    ? backlog.increments
    : null
let increments =
  (cutWasReplayed ? savedIncrements || cutIncrements : cutIncrements || savedIncrements) || []

// The planner wrote the codemap into the state and nobody carries it in a
// prompt. Every researcher reads it there, which is what keeps the largest
// thing the planner produces from being emitted a second time.
function codemapBlock() {
  return (
    `The planner's codemap is in the run state: read it with the backlog helper's ` +
    `\`codemap\` subcommand, as \`codemap ${dir}/backlog.json\`, before you research.\n`
  )
}

log(`Backlog: ${increments.map((t, i) => `${i + 1}. ${t.title}`).join(' | ')}`)

// Why each increment ended the way it did, in the agents' own words. The human
// sits in the main conversation and opens no file, so `log` puts it in front of
// them while the run goes, and `worked` comes back with the result so the
// session can repeat it once the run is done.
const worked = []
const attempts = new Map()
let stopped = ''

// A resumed run picks up counting where the state left off. Every increment
// the file already holds closed was worked by an earlier session: it keeps its
// ordinal and its line in the result — `done` is the accepted case, `blocked`
// the not-accepted one, and a dropped increment was never worked and counts
// for nothing. The findings behind a restored `blocked` are in the attempt the
// close archived, so its note is the reason this result carries.
for (const t of increments) {
  if (t.status === 'done' || t.status === 'blocked') {
    worked.push({
      n: worked.length + 1,
      id: t.id,
      title: t.title,
      accepted: t.status === 'done',
      findings: t.status === 'done' ? 0 : null,
      reason: t.note || `closed as ${t.status} in an earlier session`,
    })
  }
}

if (!blockedOnHuman.length) {
  for (let n = worked.length + 1; ; n++) {
    const task = increments.find((t) => t.status === 'todo')
    if (!task) break

    if (n > maxIncrements) {
      stopped = `the backlog still holds "${task.title}" after ${maxIncrements} increments`
      break
    }
    const attempt = (attempts.get(task.id) || 0) + 1
    attempts.set(task.id, attempt)
    if (attempt > MAX_ATTEMPTS) {
      stopped =
        `"${task.title}" was worked ${MAX_ATTEMPTS} times and the planner handed it back ` +
        `again without re-cutting it`
      break
    }

    log(`Increment ${n}: ${task.title}`)

    // The branch this attempt is worked on. An increment with recorded history
    // continues on the branch the state names; anything else — the first
    // attempt, or one after a hand-back — starts a fresh branch off the issue
    // branch, and the attempt's first dispatch records and creates it.
    let incrementBranch = ''
    let freshBranch = false
    if (issueBranch) {
      const prior = branches.get(task.id)
      if (prior && incrementHasHistory(task.id)) {
        incrementBranch = prior
      } else {
        incrementBranch = nextBranchName(task.id)
        freshBranch = true
      }
      branches.set(task.id, incrementBranch)
      log(`Increment ${n} is worked on ${incrementBranch}${freshBranch ? ' (fresh)' : ''}`)
    }

    let plan = null
    let planLabel = ''
    let testsLabel = ''
    let previousTestsLabel = ''
    let verdict = null
    let verdictLabel = ''
    for (let round = 0; round <= MAX_CORRECTIONS; round++) {
      previousTestsLabel = testsLabel
      // Decided before anything is dispatched, and only from the verdict of the
      // round before: round 0 is never a direct-fix round, so `plan` is always
      // the one an earlier round produced by the time this is true.
      const directFix = round > 0 && isDirectFixRound(verdict)

      if (directFix) {
        log(
          `Increment ${n} round ${round}: every finding is a direct fix — research and tests ` +
            `skipped, checks carried over from round ${round - 1}.`,
        )
        testsLabel = ''
      } else {
        const researchLabel = `research:${task.id}.${round}`
        // What the round before left for this one, all of it in the state: the
        // review's findings, and the questions the test-author left open.
        plan = await step(researchLabel, 'Research', () =>
          agent(
            `Issue directory: ${dir}\n` +
              questionBlock(researchLabel) +
              branchBlock(task.id, incrementBranch, freshBranch && round === 0) +
              scope(task, increments, n) +
              codemapBlock() +
              (round === 0
                ? ''
                : readBlock(
                    `This is correction loop ${round} of ${MAX_CORRECTIONS} for this increment, ` +
                      `and what the round before produced is your work order.`,
                    [
                      readStep(task.id, verdictLabel, 'findings', `the review's findings.`),
                      previousTestsLabel
                        ? readStep(
                            task.id,
                            previousTestsLabel,
                            'openQuestions',
                            `what the test-author left open, and it is yours to settle.`,
                          )
                        : '',
                    ].filter(Boolean),
                  )) +
              recordStep(task.id, researchLabel, PLAN_PAYLOAD),
            { agentType: 'uroboros:researcher', phase: 'Research', label: researchLabel, schema: PLAN },
          ),
        )
        planLabel = researchLabel
        if (asksTheHuman(researchLabel, plan)) break
        log(
          `Increment ${n} round ${round}: tests needed: ${plan.needsTests}; ` +
            `checks: ${plan.checks && plan.checks.length ? plan.checks.join(', ') : 'none'}`,
        )

        testsLabel = ''
        if (plan.needsTests) {
          const label = `tests:${task.id}.${round}`
          const tests = await step(label, 'Tests', () =>
            agent(
              `Issue directory: ${dir}\n` +
                questionBlock(label) +
                branchBlock(task.id, incrementBranch, false) +
                scope(task, increments, n) +
                readBlock(`Your work order is the researcher's test plan.`, [
                  readStep(task.id, planLabel, 'testPlan', `the test plan.`),
                ]) +
                (round === 0 ? '' : `This is correction round ${round} of this increment.\n`) +
                recordStep(task.id, label, TESTS_PAYLOAD),
              { agentType: 'uroboros:test-author', phase: 'Tests', label, schema: TESTS },
            ),
          )
          testsLabel = label
          if (asksTheHuman(label, tests)) break
        }
      }

      const buildLabel = `implement:${task.id}.${round}`
      const build = await step(buildLabel, 'Implement', () =>
        agent(
          `Issue directory: ${dir}\n` +
            questionBlock(buildLabel) +
            branchBlock(task.id, incrementBranch, false) +
            (directFix
              ? readBlock(
                  `This is correction loop ${round} of ${MAX_CORRECTIONS} for this increment, ` +
                    `and it is a direct-fix round: nobody planned it and nobody wrote a test ` +
                    `for it, so the findings are your whole brief.`,
                  [readStep(task.id, verdictLabel, 'findings', `the findings you correct.`)],
                )
              : readBlock(
                  `Your brief is the plan the researcher wrote` +
                    (testsLabel ? ` and the tests that already exist.` : `.`),
                  [
                    readStep(
                      task.id,
                      planLabel,
                      'plan,moduleMap,environment',
                      `what gets built and why, the files it touches, and the commands the ` +
                        `plan asks anyone to run.`,
                    ),
                    testsLabel
                      ? readStep(task.id, testsLabel, 'cases', `the cases the test-author wrote.`)
                      : '',
                  ].filter(Boolean),
                ) +
                (testsLabel
                  ? ''
                  : `No test was written for this round — the plan asked for none.\n`)) +
            // No researcher ran this round, so the list of commands that counts
            // is the one the last round closed. It is the same code being
            // judged.
            checkList(plan.checks) +
            recordStep(task.id, buildLabel, BUILD_PAYLOAD),
          Object.assign(
            { agentType: 'uroboros:implementer', phase: 'Implement', label: buildLabel, schema: BUILD },
            // A fix whose whole brief is "this line, this word" has nothing to
            // reason about, and the round exists to be cheap.
            directFix ? { effort: 'low' } : {},
          ),
        ),
      )
      if (asksTheHuman(buildLabel, build)) break

      const reviewLabel = `review:${task.id}.${round}`
      verdict = await step(reviewLabel, 'Review', () =>
        agent(
          `Issue directory: ${dir}\n` +
            questionBlock(reviewLabel) +
            branchBlock(task.id, incrementBranch, false) +
            `Review round ${round} of increment ${n}. ` +
            // The increment's diff is a fact of git — its branch against the
            // merge-base with the issue branch — so no prose list of settled
            // increments is needed: what earlier increments delivered is
            // simply not in the range.
            (incrementBranch
              ? `The increment's diff is its branch against the merge-base with ` +
                `\`${issueBranch}\`: judge \`git diff ${issueBranch}...HEAD\` (three dots), ` +
                `whole, and nothing outside it.\n`
              : `Check the whole diff against main.\n`) +
            scope(task, increments, n) +
            checkList(plan.checks) +
            // The one role that reads nothing. It records into the state and
            // never opens it, because that state holds the plan it is the check
            // on. Its page says so at length; this prompt is what makes the
            // instruction arrive with the dispatch that could break it.
            `Read nothing out of ${dir}/backlog.json — not with the helper, not by hand.\n` +
            recordStep(task.id, reviewLabel, VERDICT_PAYLOAD),
          { agentType: 'uroboros:reviewer', phase: 'Review', label: reviewLabel, schema: VERDICT },
        ),
      )
      verdictLabel = reviewLabel
      if (asksTheHuman(reviewLabel, verdict)) break

      const found = verdict.findingCount || 0
      const reason = verdict.reason || verdict.summary
      if (found === 0) {
        log(`Increment ${n} round ${round}: accepted — ${verdict.summary}`)
        break
      }
      if (round === MAX_CORRECTIONS) {
        log(`Increment ${n} round ${round}: ${found} findings, last round used up — ${reason}`)
        break
      }
      log(`Increment ${n} round ${round}: ${found} findings, correcting — ${reason}`)
    }

    if (blockedOnHuman.length) break

    const findingCount = (verdict && verdict.findingCount) || 0
    const accepted = findingCount === 0
    worked.push({
      n,
      id: task.id,
      title: task.title,
      accepted,
      findings: findingCount,
      reason: (verdict && (verdict.reason || verdict.summary)) || '',
    })

    // Runs whether the review accepted or not: the planner owns the answer to a
    // blocked increment as much as to a finished one, and a state that never
    // records the failure sends the next call in blind.
    const replanLabel = `replan:${task.id}`
    const recut = await step(replanLabel, 'Replan', () =>
      agent(
        `Issue directory: ${dir}\n` +
          questionBlock(replanLabel) +
          `Increment ${task.id} — ${task.title} — has been worked. The review ` +
          (accepted
            ? `accepted it.\n`
            : `did not accept it after ${MAX_CORRECTIONS} correction rounds, with ` +
              `${findingCount} findings open: ${verdict.reason || verdict.summary}\n`) +
          (incrementBranch
            ? accepted
              ? `Land it first: check out \`${issueBranch}\`, run ` +
                `\`git fetch origin ${incrementBranch}\`, merge that branch and push ` +
                `\`${issueBranch}\`.\n`
              : `Its work was not accepted, so it stays off the issue branch: do not merge ` +
                `\`${incrementBranch}\`. Check out \`${issueBranch}\` first, so the state you ` +
                `write lands there, and name that unmerged branch in the note you close with.\n`
            : '') +
          `What this increment turned up is what you re-cut against, and it is in the run ` +
          `state. Read it with the backlog helper your shared brief names:\n` +
          `  - \`steps ${dir}/backlog.json ${task.id}\` — every step this increment recorded, ` +
          `whole.\n` +
          `  - \`index ${dir}/backlog.json\` — the rest of the cut, with no step content in it.\n` +
          `  - \`codemap ${dir}/backlog.json\` — the map as it stands.\n` +
          `Then close that increment with \`close\` and re-cut what is still open with ` +
          `\`init\`, the whole codemap in its \`codemap\` field. ${n} of at most ` +
          `${maxIncrements} increments are spent.\n` +
          recordStep('-', replanLabel, CUT_PAYLOAD),
        { agentType: 'uroboros:planner', phase: 'Replan', label: replanLabel, schema: BACKLOG },
      ),
    )

    // The planner closed it in the file; mirror that here so the loop moves on
    // even when the re-cut hands back no list of its own.
    task.status = accepted ? 'done' : 'blocked'
    if (recut && Array.isArray(recut.increments) && recut.increments.length) {
      increments = recut.increments
    }
    // The planner may hand an increment already worked back as `todo` — the
    // second chance MAX_ATTEMPTS exists for. Closing it ended its attempt in
    // the run state, so the in-session map forgets its steps too: left there,
    // every label of the next attempt would be found recorded, the attempt
    // would dispatch nobody and would re-read this iteration's verdict and
    // this iteration's re-cut as if they were the new ones.
    for (const t of increments) {
      if (t.status === 'todo' && attempts.has(t.id)) forgetSteps(t.id)
    }
    log(`After increment ${n}: ${increments.map((t) => `${t.title} [${t.status}]`).join(' | ')}`)
    if (asksTheHuman(replanLabel, recut)) break

    const blocked = increments.filter((t) => t.status === 'blocked').length
    if (blocked >= MAX_BLOCKED) {
      stopped = `${blocked} increments ended with findings open`
      break
    }
  }
}

const open = increments.filter((t) => t.status === 'todo')
const delivered = increments.filter((t) => t.status === 'done')
const blocked = increments.filter((t) => t.status === 'blocked')
const accepted = !stopped && !blockedOnHuman.length && open.length === 0 && blocked.length === 0
if (stopped) {
  log(`Stopped: ${stopped}. ${open.length} increments left open. Hand back to the human.`)
}
if (blockedOnHuman.length) {
  log(
    `${blockedOnHuman.length} question(s) for the human ended this run. Answer them under ` +
      `\`## Decisions\` in ${dir}/issue.md and start this workflow on the same directory again.`,
  )
}

// Every agent above commits and pushes its own step; this one makes sure the
// branch has a pull request, which is the human's gate. It is dispatched every
// time, recorded or not: a finished run re-asserting an open pull request costs
// one cheap step, and a run whose push failed silently costs the work. Like the
// state loader it is not a step of the run and records nothing — it is the one
// dispatch that must leave the working tree exactly as it found it.
phase('Publish')
const push = await agent(
  `Issue directory: ${dir}\n` +
    (issueBranch
      ? `Push the issue branch \`${issueBranch}\` and make sure an open pull request exists ` +
        'for it. Nothing else.\n\n' +
        `1. Check out \`${issueBranch}\` if the checkout is elsewhere — a run that stopped ` +
        `mid-increment leaves it on an increment branch. Then run ` +
        `\`git push -u origin ${issueBranch}\`. On a network error ` +
        'retry up to 4 times, waiting 2s, 4s, 8s, 16s.\n'
      : 'Push the current branch and make sure an open pull request exists for it. ' +
        'Nothing else.\n\n' +
        '1. Run `git push -u origin "$(git branch --show-current)"`. On a network error ' +
        'retry up to 4 times, waiting 2s, 4s, 8s, 16s.\n') +
    '2. Find the pull request whose head is this branch. Prefer the GitHub MCP tools, ' +
    'loading them with ToolSearch first, and fall back to the `gh` CLI where this ' +
    'environment has one and no MCP tool. If an OPEN one exists, ' +
    'leave it alone: pushing already updated it. Report its URL.\n' +
    '3. If none is open, open one against the default branch. Title and body come ' +
    `from the issue directory's \`issue.md\` and from the run state's skeleton, which you ` +
    `read with the backlog helper's \`index\` subcommand — never the state file whole: ` +
    'what was asked for, ' +
    'which increments were delivered, which are still open or blocked and why, what the ' +
    'review said, and every open finding or recorded observation the human should see ' +
    'before merging. This run worked the issue in increments, so say plainly in the body ' +
    'when the backlog did NOT empty and name what is left, and when a question for the ' +
    'human ended the run. Name the branch of every blocked increment — its `branch` ' +
    'field in the index — so its unmerged work is findable without being in the ' +
    'diff. End the body with a blank line, `---`, and ' +
    '`🤖 Generated with [Claude Code](https://claude.com/claude-code)`.\n' +
    '4. If the only pull request for this branch is already MERGED, do NOT open a ' +
    'second one on top of merged history and do NOT rebase — report `prUrl` of the ' +
    "merged one and say so in the summary. That is the human's call.\n\n" +
    'Do NOT commit, do NOT stage, do NOT change any file, do NOT force-push, and do ' +
    'NOT merge anything. Beyond the one checkout step 1 names, do NOT switch ' +
    'branches. If the working tree is dirty, leave it dirty and report it.\n' +
    'You are running inside a workflow script. Do NOT dispatch any subagent.',
  { agentType: 'general-purpose', phase: 'Publish', label: 'publish', schema: PUSH },
)
log(`Push: ${push.pushed ? 'ok' : 'FAILED'} — ${push.summary}`)
log(`Pull request: ${push.prUrl || 'none'}${push.prCreated ? ' (opened by this run)' : ''}`)

return {
  ran: true,
  accepted,
  stopped,
  issueDir: dir,
  delivered: delivered.length,
  open: open.length,
  increments: worked,
  backlog: increments,
  blockedOnHuman,
  push,
}
