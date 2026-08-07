// This file is a plugin component, declared in plugin.json's `workflows`
// field, and a session runs it as `uroboros:loop`. It sits here rather than in
// `.claude/workflows/` because that directory exists in this checkout alone: a
// loop kept there would run in this repository and be missing from every
// project that installed uroboros, which is where the rulebook sends the
// session in Issue Mode. Shipped, one file serves both.
export const meta = {
  name: 'loop',
  description: 'Runs the issue loop as a script: research, tests, implementation, review, correction.',
  whenToUse: 'When an issue file with confirmed acceptance criteria exists and the whole chain should run without the main session steering it. Pass the issue directory as args.issueDir.',
  phases: [
    { title: 'Load state', detail: 'the run state is read, so a restart resumes where it stopped' },
    { title: 'Decompose', detail: 'planner opens the run state with the one increment this loop works' },
    { title: 'Research', detail: 'researcher writes the implementation plan' },
    { title: 'Tests', detail: 'test-author writes failing tests' },
    { title: 'Implement', detail: 'implementer makes them pass' },
    { title: 'Review', detail: 'reviewer checks the diff against main' },
    { title: 'Close', detail: 'planner records the verdict and sheds the step returns' },
    { title: 'Publish', detail: 'the branch goes to the remote and a pull request exists' },
  ],
}

// The script is the orchestrator. No agent dispatches another one — their
// pages say so, and every prompt below repeats it.
//
// The channel between the agents is structured: each one returns an object,
// this script injects the slice the next role needs into its prompt, and each
// one records its own return into `<issueDir>/backlog.json` through the shipped
// helper. That file is the only durable state of a run, and a fresh session
// resumes from it alone.

const MAX_CORRECTIONS = 2

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

const STATE = {
  type: 'object',
  properties: {
    exists: { type: 'boolean', description: 'True only when backlog.json exists and you read it.' },
    backlogJson: {
      type: 'string',
      description:
        'The exact content of backlog.json, byte for byte. Empty string when it does not exist.',
    },
    summary: { type: 'string' },
  },
  required: ['exists', 'backlogJson', 'summary'],
  additionalProperties: false,
}

// The plain loop works the issue whole, so its backlog is exactly one
// increment. `maxItems` pins that in the schema rather than in a sentence the
// planner could read past.
const BACKLOG = {
  type: 'object',
  properties: {
    increments: {
      type: 'array',
      minItems: 1,
      maxItems: 1,
      description:
        'The one increment this loop works: the whole issue. This loop never cuts and ' +
        'never re-cuts.',
      items: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description:
              'The id this increment keeps for the rest of the run. Never reused, ' +
              'never given to a second increment.',
          },
          title: { type: 'string', description: 'One line naming what it delivers.' },
          goal: {
            type: 'string',
            description: 'What this increment delivers, in one or two sentences, in the imperative.',
          },
          criteria: {
            type: 'array',
            items: { type: 'string' },
            description: 'The acceptance criteria that would prove it done — here, the whole issue.',
          },
          status: {
            type: 'string',
            enum: ['todo', 'done', 'blocked', 'dropped'],
            description:
              'todo: still to be worked. done: the review accepted it. blocked: the review ' +
              'did not, and the correction rounds are used up. dropped: it is not going to ' +
              'be built, and the note says why.',
          },
          note: {
            type: 'string',
            description:
              'Why this increment changed on this call, or empty when it did not. A dropped ' +
              'or blocked one always carries its reason.',
          },
        },
        required: ['id', 'title', 'goal', 'criteria', 'status', 'note'],
        additionalProperties: false,
      },
    },
    questions: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Decisions only the human can make, each answerable without opening a file. ' +
        'A non-empty list ends the run.',
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
      description: 'False only when the change has nothing a test could check.',
    },
    plan: {
      type: 'string',
      description:
        'The implementation plan: what gets built and the decisions behind it, the ' +
        'rejected ones included.',
    },
    moduleMap: {
      type: 'string',
      description:
        'The files the change touches: path, what each holds, the entry points. One line ' +
        'per file.',
    },
    environment: {
      type: 'string',
      description:
        'Every command the test plan asks anyone to run, with its prerequisites. ' +
        '"There is no linter" is an answer.',
    },
    testPlan: {
      type: 'string',
      description:
        'The whole work order for the test-author and the only thing it is given: per case ' +
        'the criterion it proves, input, state, expected result, the level, the test file by ' +
        'path, the framework, the conventions of that file, and the command that runs just ' +
        'it. Name what you leave untested and why.',
    },
    checks: {
      type: 'array',
      items: { type: 'string' },
      description:
        'The closed list of commands, verbatim, runnable from the repo root, whose exit ' +
        'codes judge the work. Nobody downstream runs anything else.',
    },
    questions: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Decisions only the human can make, each answerable without opening a file. ' +
        'A non-empty list ends the run.',
    },
    summary: { type: 'string' },
  },
  required: ['needsTests', 'plan', 'moduleMap', 'environment', 'testPlan', 'checks', 'questions', 'summary'],
  additionalProperties: false,
}

const TESTS = {
  type: 'object',
  properties: {
    cases: {
      type: 'array',
      description: 'Every case the test plan named, written or not.',
      items: {
        type: 'object',
        properties: {
          case: { type: 'string', description: "The planned case in the plan's words, one line." },
          file: { type: 'string', description: 'Test file by path. Empty when you did not write it.' },
          testName: { type: 'string', description: "The test's name. Empty when you did not write it." },
          expected: { type: 'string', description: 'What the case demands, one line.' },
          got: {
            type: 'string',
            description: 'The failure it produced, one line — or why you did not write it.',
          },
        },
        required: ['case', 'file', 'testName', 'expected', 'got'],
        additionalProperties: false,
      },
    },
    openQuestions: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Gaps and conflicts in the test plan, one line each. The next research round picks ' +
        'them up.',
    },
    questions: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Decisions only the human can make, each answerable without opening a file. ' +
        'A non-empty list ends the run.',
    },
    summary: { type: 'string' },
  },
  required: ['cases', 'openQuestions', 'questions', 'summary'],
  additionalProperties: false,
}

const BUILD = {
  type: 'object',
  properties: {
    deviations: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Every place you built something other than what the plan named: what it said, ' +
        'what you did, why.',
    },
    commands: {
      type: 'array',
      description: 'Every command you ran from the list that counts, with its exit code.',
      items: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          exitCode: { type: 'integer' },
          note: { type: 'string' },
        },
        required: ['command', 'exitCode', 'note'],
        additionalProperties: false,
      },
    },
    blockers: {
      type: 'array',
      items: { type: 'string' },
      description: 'What stopped you, one line each. Empty when nothing did.',
    },
    questions: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Decisions only the human can make, each answerable without opening a file. ' +
        'A non-empty list ends the run.',
    },
    summary: { type: 'string' },
  },
  required: ['deviations', 'commands', 'blockers', 'questions', 'summary'],
  additionalProperties: false,
}

const VERDICT = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      description:
        'Every finding that requires a correction. An empty list means the change is accepted.',
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string', description: 'What is wrong, one line.' },
          reproduction: {
            type: 'string',
            description: 'These inputs or this state, this wrong result, at this file and line.',
          },
          criterion: {
            type: 'string',
            description: 'The acceptance criterion it violates, or "none".',
          },
        },
        required: ['claim', 'reproduction', 'criterion'],
        additionalProperties: false,
      },
    },
    reason: {
      type: 'string',
      description:
        'Why another correction round is needed, in one or two sentences a human reads in ' +
        'the chat. Empty when findings is empty.',
    },
    questions: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Decisions only the human can make, each answerable without opening a file. ' +
        'A non-empty list ends the run.',
    },
    summary: { type: 'string' },
  },
  required: ['findings', 'reason', 'questions', 'summary'],
  additionalProperties: false,
}

const CLOSED = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Decisions only the human can make, each answerable without opening a file. ' +
        'A non-empty list ends the run.',
    },
    summary: { type: 'string', description: 'What you set the increment to, and why.' },
  },
  required: ['questions', 'summary'],
  additionalProperties: false,
}

const PUSH = {
  type: 'object',
  properties: {
    pushed: {
      type: 'boolean',
      description: 'True only when the push command exited 0.',
    },
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

// The reviewer is handed no part of the plan — that is what keeps it an
// independent pair of eyes. So the one thing it needs, the list of commands
// that count for this change, is handed to it here instead: what to run, never
// why.
function checkList(checks) {
  return checks && checks.length
    ? 'The commands that count for this change, and the only ones anyone runs:\n' +
        checks.map((c) => `  - \`${c}\``).join('\n') +
        '\n'
    : 'The plan lists no command to run for this change. Run none, and say so.\n'
}

const noDispatch =
  'You are running inside a workflow script. Do NOT dispatch any subagent and ' +
  'do NOT hand over to anyone — the script calls the next agent itself. Record ' +
  'your step return, commit it with your work, then push the commit.'

// Every dispatch carries the one line that turns its return into durable state.
// The agent writes the file; this script never touches it, because the workflow
// runtime gives a script `args`, `agent`, `log` and `phase` and no file access
// at all.
function recordStep(incrementId, label) {
  return (
    `Record this step: write your whole return to a JSON file outside the repository, then ` +
    `run the \`record\` subcommand of the backlog helper your shared brief names, as ` +
    `\`record ${dir}/backlog.json ${incrementId} ${label} <that file>\`.\n`
  )
}

// The question this step asked before the run stopped. The human records the
// answer under `## Decisions` in issue.md, which is where this sends the agent;
// the step's own recorded return is never replayed.
function answeredBlock(label) {
  const asked = carriedQuestions.get(label)
  return asked && asked.length
    ? `This step ended the previous run with a question for the human:\n` +
        asked.map((q) => `  - ${q}`).join('\n') +
        '\n' +
        `The answer is under \`## Decisions\` in ${dir}/issue.md. Read it there first, then ` +
        `work this step again; ask again only what it does not answer.\n`
    : ''
}

// The slice each role gets, and no more. The test-author is given the test plan
// and nothing else about the change; the implementer the plan, the map, the
// environment, the checks and the tests that now exist; the reviewer the checks
// alone.
function casesBlock(tests) {
  if (!tests) return 'No test was written for this round — the plan asked for none.\n'
  const cases = Array.isArray(tests.cases) ? tests.cases : []
  const open = Array.isArray(tests.openQuestions) ? tests.openQuestions : []
  return (
    'The tests that already exist, one line per case — case, file, test name, what it ' +
    'demands, what it produced:\n' +
    cases
      .map(
        (c) =>
          `  - ${c.case} | ${c.file || '(not written)'} | ${c.testName || '(not written)'} | ` +
          `demands ${c.expected} | got ${c.got}`,
      )
      .join('\n') +
    '\n' +
    (open.length
      ? 'The test-author left these open:\n' + open.map((q) => `  - ${q}`).join('\n') + '\n'
      : '')
  )
}

function findingsBlock(verdict, round) {
  const findings = (verdict && Array.isArray(verdict.findings) && verdict.findings) || []
  return (
    `This is correction loop ${round} of ${MAX_CORRECTIONS}. The review found:\n` +
    findings
      .map(
        (f, i) =>
          `  ${i + 1}. ${f.claim}\n     Reproduction: ${f.reproduction}\n     Criterion: ${f.criterion}`,
      )
      .join('\n') +
    '\n' +
    `Plan the corrections. Set needsTests true only if a finding needs a new failing test ` +
    `first, and then write that test's whole work order into testPlan — nothing from an ` +
    `earlier round carries over, the list of commands that count included.\n`
  )
}

function openQuestionsBlock(tests) {
  const open = (tests && Array.isArray(tests.openQuestions) && tests.openQuestions) || []
  return open.length
    ? `The test-author left these open in the round before, and they are yours to settle:\n` +
        open.map((q) => `  - ${q}`).join('\n') +
        '\n'
    : ''
}

// Every run opens with this one cheap dispatch. It is the only read of the run
// state the script makes, and it is never recorded — it is the read that opens
// a run, not a step of one.
const state = await agent(
  `Issue directory: ${dir}\n` +
    `Read ${dir}/backlog.json and return it. Run ` +
    `\`node "<the agent-brief skill's assets directory>/backlog.mjs" read ${dir}/backlog.json\` ` +
    `if you prefer; either way return its exact content in backlogJson and exists true. ` +
    `If your context names no such skill base directory, find the helper with ` +
    `\`find "$HOME/.claude/plugins" -path '*agent-brief/assets/backlog.mjs' | head -1\`.\n` +
    `If the file does not exist, return exists false and backlogJson "".\n` +
    `Read nothing else, change nothing, run no git command, and do not dispatch any subagent.`,
  { agentType: 'general-purpose', phase: 'Load state', label: 'load-state', schema: STATE },
)

// A state file that does not parse is treated as no state: the run starts over
// rather than dying on a half-written file no one can fix from here.
let saved = null
if (state && state.exists && state.backlogJson) {
  try {
    saved = JSON.parse(state.backlogJson)
  } catch (err) {
    log(`backlog.json did not parse (${err.message}) — starting this run from no state.`)
    saved = null
  }
}

// A step that ended the run with a question for the human is not replayed from
// its recorded return: the human answered in `issue.md`, so the step is worked
// again with the question in front of it. Replaying it instead would re-raise
// the same question and end the resumed run at Publish without dispatching
// anyone — the restart the rulebook promises would make no progress at all.
const recorded = new Map()
const carriedQuestions = new Map()
if (saved) {
  const load = (s) => {
    const asked =
      s && s.return && Array.isArray(s.return.questions) ? s.return.questions.filter(Boolean) : []
    if (asked.length) carriedQuestions.set(s.label, asked)
    else recorded.set(s.label, s.return)
  }
  for (const s of (saved.run && saved.run.steps) || []) load(s)
  for (const increment of saved.increments || []) {
    for (const s of increment.steps || []) load(s)
  }
}
if (recorded.size) log(`Resuming: ${recorded.size} step(s) already recorded in the run state.`)
if (carriedQuestions.size) {
  log(`${carriedQuestions.size} step(s) ended the last run with a question and are worked again.`)
}

// The whole of resume. A recorded step returns its stored payload and is never
// dispatched again; the step in flight when a session died was never recorded,
// so it repeats. Labels are keyed on the increment id, never on an ordinal a
// re-cut would move.
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
      answeredBlock('decompose') +
      `Open the run state for this issue. Do not cut: this loop works ${dir}/issue.md as a ` +
      `single increment spanning the whole issue, and it never re-cuts. Write ` +
      `${dir}/backlog.json with the \`init\` subcommand of the backlog helper your shared ` +
      `brief names, with workflow "loop" and exactly one increment whose criteria are the ` +
      `issue's acceptance criteria, whole.\n` +
      `Read ${dir}/backlog.json with the helper's \`read\` subcommand first if it is already ` +
      `there.\n` +
      recordStep('-', 'decompose') +
      noDispatch,
    { agentType: 'uroboros:planner', phase: 'Decompose', label: 'decompose', schema: BACKLOG },
  ),
)
asksTheHuman('decompose', backlog)

// Which of the two lists of increments the run works. A replayed cut is the
// older of them: the decompose return is what the planner said when it opened
// the run, and a status a later close set lives in the file, not in that
// return. A Decompose dispatched again this session is the opposite case — the
// planner has just rewritten the file, so its return is the newer of the two
// and the snapshot this run read at startup is the stale one. Either side
// falls back to the other when it is empty.
const savedIncrements =
  saved && Array.isArray(saved.increments) && saved.increments.length ? saved.increments : null
const cutIncrements =
  backlog && Array.isArray(backlog.increments) && backlog.increments.length
    ? backlog.increments
    : null
const increments =
  (cutWasReplayed ? savedIncrements || cutIncrements : cutIncrements || savedIncrements) || []

let task = null
if (!blockedOnHuman.length) {
  task = increments.find((t) => t.status === 'todo') || null
  if (!task) log('Every increment in the run state is closed — nothing left to work.')
}

// Why each round was restarted, in the reviewer's own words. The human sits in
// the main conversation and opens no file, so `log` puts it in front of them
// while the loop runs, and `rounds` comes back with the result so the session
// can repeat it once the loop is done.
let verdict = null
let plan = null
let tests = null
const rounds = []

if (task) {
  for (let round = 0; round <= MAX_CORRECTIONS; round++) {
    const previousTests = tests
    const researchLabel = `research:${task.id}.${round}`
    plan = await step(researchLabel, 'Research', () =>
      agent(
        `Issue directory: ${dir}\n` +
          answeredBlock(researchLabel) +
          (round === 0 ? '' : findingsBlock(verdict, round)) +
          openQuestionsBlock(previousTests) +
          recordStep(task.id, researchLabel) +
          noDispatch,
        { agentType: 'uroboros:researcher', phase: 'Research', label: researchLabel, schema: PLAN },
      ),
    )
    if (asksTheHuman(researchLabel, plan)) break
    log(
      `Round ${round}: tests needed: ${plan.needsTests}; ` +
        `checks: ${plan.checks && plan.checks.length ? plan.checks.join(', ') : 'none'}`,
    )

    tests = null
    if (plan.needsTests) {
      const testsLabel = `tests:${task.id}.${round}`
      tests = await step(testsLabel, 'Tests', () =>
        agent(
          `Issue directory: ${dir}\n` +
            answeredBlock(testsLabel) +
            `Your work order is the test plan below, and it is the whole of what you are ` +
            `given about the change:\n\n${plan.testPlan}\n\n` +
            (round === 0
              ? ''
              : `The reviewer's reproduction spec is the criterion for this round.\n`) +
            recordStep(task.id, testsLabel) +
            noDispatch,
          { agentType: 'uroboros:test-author', phase: 'Tests', label: testsLabel, schema: TESTS },
        ),
      )
      if (asksTheHuman(testsLabel, tests)) break
    }

    const buildLabel = `implement:${task.id}.${round}`
    const build = await step(buildLabel, 'Implement', () =>
      agent(
        `Issue directory: ${dir}\n` +
          answeredBlock(buildLabel) +
          `Your brief is the plan below.\n\n` +
          `## Implementation plan\n${plan.plan}\n\n` +
          `## Module map\n${plan.moduleMap}\n\n` +
          `## Environment\n${plan.environment}\n\n` +
          casesBlock(tests) +
          checkList(plan.checks) +
          recordStep(task.id, buildLabel) +
          noDispatch,
        { agentType: 'uroboros:implementer', phase: 'Implement', label: buildLabel, schema: BUILD },
      ),
    )
    if (asksTheHuman(buildLabel, build)) break

    const reviewLabel = `review:${task.id}.${round}`
    verdict = await step(reviewLabel, 'Review', () =>
      agent(
        `Issue directory: ${dir}\n` +
          answeredBlock(reviewLabel) +
          `Review round ${round}. Check the whole diff against main.\n` +
          checkList(plan.checks) +
          recordStep(task.id, reviewLabel) +
          noDispatch,
        { agentType: 'uroboros:reviewer', phase: 'Review', label: reviewLabel, schema: VERDICT },
      ),
    )
    if (asksTheHuman(reviewLabel, verdict)) break

    const found = (verdict.findings || []).length
    const reason = verdict.reason || verdict.summary
    rounds.push({ round, findings: found, reason })

    if (found === 0) {
      log(`Round ${round}: accepted — ${verdict.summary}`)
      break
    }
    if (round === MAX_CORRECTIONS) {
      log(`Round ${round}: ${found} findings, last round used up — ${reason}`)
      break
    }
    log(`Round ${round}: ${found} findings, correcting — ${reason}`)
  }
}

let accepted = false
if (task && verdict && !blockedOnHuman.length) {
  accepted = (verdict.findings || []).length === 0
  const closeLabel = `close:${task.id}`
  const closed = await step(closeLabel, 'Close', () =>
    agent(
      `Issue directory: ${dir}\n` +
        answeredBlock(closeLabel) +
        `Increment ${task.id} — ${task.title} — has been worked. The review ` +
        (accepted
          ? `accepted it.\n`
          : `did not accept it after ${MAX_CORRECTIONS} correction rounds, with ` +
            `${(verdict.findings || []).length} findings open: ${verdict.reason || verdict.summary}\n`) +
        `Close it in ${dir}/backlog.json with the \`close\` subcommand of the backlog helper, ` +
        `with the status that verdict earns; closing sheds its recorded step returns. Cut ` +
        `nothing new — this loop has one increment and the run ends with it. Read ` +
        `${dir}/backlog.json with the helper's \`read\` subcommand for what is in it.\n` +
        recordStep('-', closeLabel) +
        noDispatch,
      { agentType: 'uroboros:planner', phase: 'Close', label: closeLabel, schema: CLOSED },
    ),
  )
  task.status = accepted ? 'done' : 'blocked'
  // The planner may end its own step with a question — a status only the human
  // can settle. Same call, same position as the incremental loop's replan: a
  // question here ends the run as a regular exit, and the run state the planner
  // recorded carries it into the session that picks the run back up.
  asksTheHuman(closeLabel, closed)
  if (!accepted) {
    log(`Stopped after ${MAX_CORRECTIONS} correction loops with findings open. Hand back to the human.`)
  }
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
// one cheap step, and a run whose push failed silently costs the work.
phase('Publish')
const push = await agent(
  `Issue directory: ${dir}\n` +
    'Push the current branch and make sure an open pull request exists for it. ' +
    'Nothing else.\n\n' +
    '1. Run `git push -u origin "$(git branch --show-current)"`. On a network error ' +
    'retry up to 4 times, waiting 2s, 4s, 8s, 16s.\n' +
    '2. Find the pull request whose head is this branch. Use the GitHub MCP tools — ' +
    'load them with ToolSearch first; there is no `gh` CLI. If an OPEN one exists, ' +
    'leave it alone: pushing already updated it. Report its URL.\n' +
    '3. If none is open, open one against the default branch. Title and body come ' +
    `from the issue directory's \`issue.md\` and \`backlog.json\`: what was asked for, ` +
    'what was built, what the review said, and every open finding or recorded ' +
    'observation the human should see before merging. Say plainly in the body when the ' +
    'review did NOT accept, and when a question for the human ended the run. End the ' +
    'body with a blank line, `---`, and ' +
    '`🤖 Generated with [Claude Code](https://claude.com/claude-code)`.\n' +
    '4. If the only pull request for this branch is already MERGED, do NOT open a ' +
    'second one on top of merged history and do NOT rebase — report `prUrl` of the ' +
    'merged one and say so in the summary. That is the human\'s call.\n\n' +
    'Do NOT commit, do NOT stage, do NOT change any file, do NOT force-push, do NOT ' +
    'switch branches, and do NOT merge anything. If the working tree is dirty, leave ' +
    'it dirty and report it.\n' +
    'You are running inside a workflow script. Do NOT dispatch any subagent.',
  { agentType: 'general-purpose', phase: 'Publish', label: 'publish', schema: PUSH },
)
log(`Push: ${push.pushed ? 'ok' : 'FAILED'} — ${push.summary}`)
log(`Pull request: ${push.prUrl || 'none'}${push.prCreated ? ' (opened by this run)' : ''}`)

return { ran: true, accepted, rounds, verdict, issueDir: dir, blockedOnHuman, push }
