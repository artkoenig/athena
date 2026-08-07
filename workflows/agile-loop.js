// The second workflow, beside `loop.js`, and a session runs it as
// `uroboros:agile-loop`. Both ship because `plugin.json` declares the whole
// `workflows/` directory, and they are two files rather than one with a switch
// because a workflow is picked by name at dispatch: a run that wants the plain
// chain should not carry the backlog machinery, and a session choosing between
// them reads two `whenToUse` lines instead of one flag.
//
// It repeats a good deal of `loop.js` — the schemas, the prompts of the four
// agents, the publish step — because a workflow script is evaluated on its own
// and cannot import a sibling. Anything changed in one of the two chains
// belongs in the other; `test-repo.sh` guards the parts of that where a
// divergence would be silent.
export const meta = {
  name: 'agile-loop',
  description:
    'Runs the issue as a backlog: cut it into increments, work one per iteration through ' +
    'research, tests, implementation and review, and re-cut the increments still open after each.',
  whenToUse:
    'When an issue file with confirmed acceptance criteria describes work worth delivering ' +
    'in steps — several criteria, or a change whose later parts depend on what the earlier ' +
    'ones turn up. For a single change use uroboros:loop instead; the backlog costs an extra ' +
    'agent per iteration and buys nothing when there is nothing to re-cut. Pass the issue ' +
    'directory as args.issueDir.',
  phases: [
    { title: 'Load state', detail: 'the run state is read, so a restart resumes where it stopped' },
    { title: 'Decompose', detail: 'planner cuts the issue into a backlog of increments' },
    { title: 'Research', detail: 'researcher plans the current increment' },
    { title: 'Tests', detail: 'test-author writes failing tests' },
    { title: 'Implement', detail: 'implementer makes them pass' },
    { title: 'Review', detail: 'reviewer checks the increment against its criteria' },
    { title: 'Replan', detail: 'planner closes the increment and re-cuts the ones still open' },
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

// Three separate backstops, because a backlog can run away in three separate
// ways. The planner may keep adding increments (MAX_INCREMENTS), it may keep
// handing back an increment that never finishes (MAX_ATTEMPTS, per id), and the
// run may be failing for a reason no re-cut will fix (MAX_BLOCKED). Each one
// stops the loop and hands back to the human rather than burning the budget.
//
// MAX_BLOCKED is derived from the statuses in the run state, so it survives a
// restart. MAX_ATTEMPTS is deliberately session-local: closing an increment
// sheds its step returns, so nothing in the state counts attempts, and a
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

const BACKLOG = {
  type: 'object',
  properties: {
    increments: {
      type: 'array',
      description:
        'Every increment in the backlog you just wrote, finished and dropped ones ' +
        'included, in the order they should be worked.',
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
            description:
              'The acceptance criteria for this increment alone — what would prove it done. ' +
              'Every criterion of the issue belongs to exactly one increment.',
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
      description: 'False only when this increment has nothing a test could check.',
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
        'codes judge this increment. Nobody downstream runs anything else.',
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
        'Every finding that requires a correction. An empty list means the increment is accepted.',
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

// The reviewer is handed no part of the plan — that is what keeps it an
// independent pair of eyes. So the one thing it needs, the list of commands
// that count for this increment, is handed to it here instead: what to run,
// never why.
function checkList(checks) {
  return checks && checks.length
    ? 'The commands that count for this increment, and the only ones anyone runs:\n' +
        checks.map((c) => `  - \`${c}\``).join('\n') +
        '\n'
    : 'The plan lists no command to run for this increment. Run none, and say so.\n'
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
    `This is correction loop ${round} of ${MAX_CORRECTIONS} for this increment. The review ` +
    `found:\n` +
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

// What every agent working an increment is told about the shape of the run. The
// issue file names criteria this increment is not meant to satisfy, and without
// this an agent reads them as its own — the researcher plans the whole issue in
// one go, and the reviewer files a finding for every criterion the run has not
// reached yet.
function scope(task, all, n) {
  const open = all.filter((t) => t.status === 'todo' && t.id !== task.id)
  return (
    `This run works ${dir}/issue.md one increment at a time, and increment ${n} is yours:\n` +
    `  ${task.title} — ${task.goal}\n` +
    `What it has to satisfy, and the whole of what you are asked for:\n` +
    task.criteria.map((c) => `  - ${c}`).join('\n') +
    '\n' +
    (open.length
      ? `Deliberately not yours, and not a gap: ${open.map((t) => t.title).join('; ')}. ` +
        `A later increment takes each of those, so work outside your criteria is scope you ` +
        `were not given, and a criterion of the issue that none of your criteria repeats is ` +
        `not yours to satisfy or to report as missing.\n`
      : `Every other increment is settled; this is the last one, so the issue is complete ` +
        `once yours is.\n`) +
    `The rest of ${dir}/issue.md is context for your increment, never a second work order.\n`
  )
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

const backlog = await step('decompose', 'Decompose', () =>
  agent(
    `Issue directory: ${dir}\n` +
      answeredBlock('decompose') +
      `Cut ${dir}/issue.md into a backlog of increments and write it to ${dir}/backlog.json ` +
      `with the \`init\` subcommand of the backlog helper your shared brief names, with ` +
      `workflow "agile-loop". This run works at most ${maxIncrements} of them, so a cut that ` +
      `needs more than that is a cut that is too fine.\n` +
      `Read ${dir}/backlog.json with the helper's \`read\` subcommand first if it is already ` +
      `there.\n` +
      recordStep('-', 'decompose') +
      noDispatch,
    { agentType: 'uroboros:planner', phase: 'Decompose', label: 'decompose', schema: BACKLOG },
  ),
)
asksTheHuman('decompose', backlog)

// The recorded state is authoritative about what is still open: the decompose
// return is what the planner said when it opened the run, and a status set by a
// later close lives in the file, not in that return.
let increments =
  saved && Array.isArray(saved.increments) && saved.increments.length
    ? saved.increments
    : (backlog && backlog.increments) || []

log(`Backlog: ${increments.map((t, i) => `${i + 1}. ${t.title}`).join(' | ')}`)

// Why each increment ended the way it did, in the agents' own words. The human
// sits in the main conversation and opens no file, so `log` puts it in front of
// them while the run goes, and `worked` comes back with the result so the
// session can repeat it once the run is done.
const worked = []
const attempts = new Map()
let stopped = ''

// The reviewer sees the whole diff against main, so from the second increment
// on that diff carries work an earlier review already ruled on. Saying which is
// what keeps it from re-litigating a settled increment every round, without
// costing it the one thing it is for: catching the regression this increment
// just caused in one. A blocked increment is named as blocked — telling the
// reviewer it was accepted would have it re-report the open findings as this
// increment's, and telling it nothing would have it fix them.
function baseline(n) {
  if (n === 1) return ''
  const name = (ns) => (ns.length === 1 ? `Increment ${ns[0]} was` : `Increments ${ns.join(', ')} were`)
  const ok = worked.filter((i) => i.accepted).map((i) => i.n)
  const bad = worked.filter((i) => !i.accepted).map((i) => i.n)
  return (
    (ok.length
      ? `${name(ok)} reviewed and accepted in an earlier iteration. That code is in your ` +
        `diff: treat it as the baseline increment ${n} builds on, and raise it again only ` +
        `where increment ${n} broke it.\n`
      : '') +
    (bad.length
      ? `${name(bad)} worked but not accepted, and those findings stand. That code is in ` +
        `your diff too: it is not increment ${n}'s to fix and not yours to report again.\n`
      : '')
  )
}

if (!blockedOnHuman.length) {
  for (let n = 1; ; n++) {
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

    let plan = null
    let tests = null
    let verdict = null
    for (let round = 0; round <= MAX_CORRECTIONS; round++) {
      const previousTests = tests
      const researchLabel = `research:${task.id}.${round}`
      plan = await step(researchLabel, 'Research', () =>
        agent(
          `Issue directory: ${dir}\n` +
            answeredBlock(researchLabel) +
            scope(task, increments, n) +
            (round === 0 ? '' : findingsBlock(verdict, round)) +
            openQuestionsBlock(previousTests) +
            recordStep(task.id, researchLabel) +
            noDispatch,
          { agentType: 'uroboros:researcher', phase: 'Research', label: researchLabel, schema: PLAN },
        ),
      )
      if (asksTheHuman(researchLabel, plan)) break
      log(
        `Increment ${n} round ${round}: tests needed: ${plan.needsTests}; ` +
          `checks: ${plan.checks && plan.checks.length ? plan.checks.join(', ') : 'none'}`,
      )

      tests = null
      if (plan.needsTests) {
        const testsLabel = `tests:${task.id}.${round}`
        tests = await step(testsLabel, 'Tests', () =>
          agent(
            `Issue directory: ${dir}\n` +
              answeredBlock(testsLabel) +
              scope(task, increments, n) +
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
            `Review round ${round} of increment ${n}. Check the whole ` +
            `diff against main.\n` +
            scope(task, increments, n) +
            baseline(n) +
            checkList(plan.checks) +
            recordStep(task.id, reviewLabel) +
            noDispatch,
          { agentType: 'uroboros:reviewer', phase: 'Review', label: reviewLabel, schema: VERDICT },
        ),
      )
      if (asksTheHuman(reviewLabel, verdict)) break

      const found = (verdict.findings || []).length
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

    const accepted = (verdict.findings || []).length === 0
    worked.push({
      n,
      id: task.id,
      title: task.title,
      accepted,
      findings: (verdict.findings || []).length,
      reason: verdict.reason || verdict.summary,
    })

    // Runs whether the review accepted or not: the planner owns the answer to a
    // blocked increment as much as to a finished one, and a state that never
    // records the failure sends the next call in blind.
    const replanLabel = `replan:${task.id}`
    const recut = await step(replanLabel, 'Replan', () =>
      agent(
        `Issue directory: ${dir}\n` +
          answeredBlock(replanLabel) +
          `Increment ${task.id} — ${task.title} — has been worked. The review ` +
          (accepted
            ? `accepted it.\n`
            : `did not accept it after ${MAX_CORRECTIONS} correction rounds, with ` +
              `${(verdict.findings || []).length} findings open: ` +
              `${verdict.reason || verdict.summary}\n`) +
          `Read ${dir}/backlog.json with the backlog helper's \`read\` subcommand. Close that ` +
          `increment with the \`close\` subcommand and the status the verdict earns — closing ` +
          `sheds its recorded step returns — then re-cut every increment still open against ` +
          `what this one showed and write the new cut with the \`init\` subcommand. ${n} of at ` +
          `most ${maxIncrements} increments are spent.\n` +
          recordStep('-', replanLabel) +
          noDispatch,
        { agentType: 'uroboros:planner', phase: 'Replan', label: replanLabel, schema: BACKLOG },
      ),
    )

    // The planner closed it in the file; mirror that here so the loop moves on
    // even when the re-cut hands back no list of its own.
    task.status = accepted ? 'done' : 'blocked'
    if (recut && Array.isArray(recut.increments) && recut.increments.length) {
      increments = recut.increments
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
    'which increments were delivered, which are still open or blocked and why, what the ' +
    'review said, and every open finding or recorded observation the human should see ' +
    'before merging. This run worked the issue in increments, so say plainly in the body ' +
    'when the backlog did NOT empty and name what is left, and when a question for the ' +
    'human ended the run. End the body with a blank line, `---`, and ' +
    '`🤖 Generated with [Claude Code](https://claude.com/claude-code)`.\n' +
    '4. If the only pull request for this branch is already MERGED, do NOT open a ' +
    'second one on top of merged history and do NOT rebase — report `prUrl` of the ' +
    "merged one and say so in the summary. That is the human's call.\n\n" +
    'Do NOT commit, do NOT stage, do NOT change any file, do NOT force-push, do NOT ' +
    'switch branches, and do NOT merge anything. If the working tree is dirty, leave ' +
    'it dirty and report it.\n' +
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
