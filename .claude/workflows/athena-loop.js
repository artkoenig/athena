export const meta = {
  name: 'athena-loop',
  description: 'Runs the issue loop as a script: research, tests, implementation, review, correction.',
  whenToUse: 'When an issue file with confirmed acceptance criteria exists and the whole chain should run without the main session steering it. Pass the issue directory as args.issueDir.',
  phases: [
    { title: 'Research', detail: 'dispatcher writes the implementation plan' },
    { title: 'Tests', detail: 'test-author writes failing tests' },
    { title: 'Implement', detail: 'implementer makes them pass' },
    { title: 'Review', detail: 'reviewer checks the diff against main' },
  ],
}

// The script is the orchestrator. No agent dispatches another one — every
// prompt below says so, because the agent files still tell them to.

const MAX_CORRECTIONS = 2

const dir = args && args.issueDir
if (!dir) {
  log('No args.issueDir given — nothing to run. Call with args: { issueDir: "docs/issues/<name>" }.')
  return { ran: false, reason: 'missing args.issueDir' }
}

const PLAN = {
  type: 'object',
  properties: {
    needsTests: {
      type: 'boolean',
      description: 'False only when the change has nothing a test could check.',
    },
    handoffFile: {
      type: 'string',
      description: 'Path of the handoff file you wrote, relative to the repo root.',
    },
    summary: { type: 'string' },
  },
  required: ['needsTests', 'handoffFile', 'summary'],
  additionalProperties: false,
}

const VERDICT = {
  type: 'object',
  properties: {
    findings: {
      type: 'integer',
      description: 'Number of findings that require a correction. 0 means the change is accepted.',
    },
    handoffFile: {
      type: 'string',
      description: 'Path of the findings file you wrote, relative to the repo root.',
    },
    summary: { type: 'string' },
  },
  required: ['findings', 'handoffFile', 'summary'],
  additionalProperties: false,
}

const noDispatch =
  'You are running inside a workflow script. Do NOT dispatch any subagent and ' +
  'do NOT hand over to anyone — the script calls the next agent itself. Write ' +
  'your handoff file, commit it, then return.'

function research(round) {
  const file = round === 0 ? 'dispatcher.md' : `dispatcher-${round}.md`
  const correction =
    round === 0
      ? ''
      : `This is correction loop ${round} of ${MAX_CORRECTIONS}. Read the reviewer's ` +
        `findings file in the issue directory and plan the corrections. ` +
        `Set needsTests true only if a finding needs a new failing test first.\n`
  return agent(
    `Issue directory: ${dir}\n${correction}Write your handoff to ${dir}/${file}.\n${noDispatch}`,
    { agentType: 'athena:dispatcher', phase: 'Research', label: `research:${round}`, schema: PLAN },
  )
}

phase('Research')
let plan = await research(0)
log(`Plan written to ${plan.handoffFile}; tests needed: ${plan.needsTests}`)

if (plan.needsTests) {
  await agent(
    `Issue directory: ${dir}\nWrite your handoff to ${dir}/test-author.md.\n${noDispatch}`,
    { agentType: 'athena:test-author', phase: 'Tests', label: 'tests' },
  )
}

let verdict
for (let round = 0; round <= MAX_CORRECTIONS; round++) {
  if (round > 0) {
    plan = await research(round)
    log(`Correction plan ${round} written to ${plan.handoffFile}`)
    if (plan.needsTests) {
      await agent(
        `Issue directory: ${dir}\nThe reviewer's reproduction spec is your criterion. ` +
          `Write your handoff to ${dir}/test-author-${round}.md.\n${noDispatch}`,
        { agentType: 'athena:test-author', phase: 'Tests', label: `tests:${round}` },
      )
    }
  }

  const implFile = round === 0 ? 'implementer.md' : `implementer-${round}.md`
  await agent(
    `Issue directory: ${dir}\nYour brief is ${plan.handoffFile}.\n` +
      `Write your handoff to ${dir}/${implFile}.\n${noDispatch}`,
    { agentType: 'athena:implementer', phase: 'Implement', label: `implement:${round}` },
  )

  const revFile = round === 0 ? 'reviewer.md' : `reviewer-${round}.md`
  verdict = await agent(
    `Issue directory: ${dir}\nReview round ${round}. Check the whole diff against main.\n` +
      `Write your findings to ${dir}/${revFile}.\n${noDispatch}`,
    { agentType: 'athena:reviewer', phase: 'Review', label: `review:${round}`, schema: VERDICT },
  )

  log(`Round ${round}: ${verdict.findings} findings — ${verdict.summary}`)
  if (verdict.findings === 0) break
}

const accepted = verdict.findings === 0
if (!accepted) {
  log(`Stopped after ${MAX_CORRECTIONS} correction loops with findings open. Hand back to the human.`)
}

return { ran: true, accepted, verdict, issueDir: dir }
