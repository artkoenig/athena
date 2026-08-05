export const meta = {
  name: 'uroboros-loop',
  description: 'Runs the issue loop as a script: research, tests, implementation, review, correction.',
  whenToUse: 'When an issue file with confirmed acceptance criteria exists and the whole chain should run without the main session steering it. Pass the issue directory as args.issueDir.',
  phases: [
    { title: 'Research', detail: 'researcher writes the implementation plan' },
    { title: 'Tests', detail: 'test-author writes failing tests' },
    { title: 'Implement', detail: 'implementer makes them pass' },
    { title: 'Review', detail: 'reviewer checks the diff against main' },
    { title: 'Publish', detail: 'the branch goes to the remote and a pull request exists' },
  ],
}

// The script is the orchestrator. No agent dispatches another one — their
// pages say so, and every prompt below repeats it.

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

const noDispatch =
  'You are running inside a workflow script. Do NOT dispatch any subagent and ' +
  'do NOT hand over to anyone — the script calls the next agent itself. Write ' +
  'your handoff file, commit it, then return.'

function research(round) {
  const file = round === 0 ? 'researcher.md' : `researcher-${round}.md`
  const correction =
    round === 0
      ? ''
      : `This is correction loop ${round} of ${MAX_CORRECTIONS}. Read the reviewer's ` +
        `findings file in the issue directory and plan the corrections. ` +
        `Set needsTests true only if a finding needs a new failing test first.\n`
  return agent(
    `Issue directory: ${dir}\n${correction}Write your handoff to ${dir}/${file}.\n${noDispatch}`,
    { agentType: 'uroboros:researcher', phase: 'Research', label: `research:${round}`, schema: PLAN },
  )
}

phase('Research')
let plan = await research(0)
log(`Plan written to ${plan.handoffFile}; tests needed: ${plan.needsTests}`)

if (plan.needsTests) {
  await agent(
    `Issue directory: ${dir}\nWrite your handoff to ${dir}/test-author.md.\n${noDispatch}`,
    { agentType: 'uroboros:test-author', phase: 'Tests', label: 'tests' },
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
        { agentType: 'uroboros:test-author', phase: 'Tests', label: `tests:${round}` },
      )
    }
  }

  const implFile = round === 0 ? 'implementer.md' : `implementer-${round}.md`
  await agent(
    `Issue directory: ${dir}\nYour brief is ${plan.handoffFile}.\n` +
      `Write your handoff to ${dir}/${implFile}.\n${noDispatch}`,
    { agentType: 'uroboros:implementer', phase: 'Implement', label: `implement:${round}` },
  )

  const revFile = round === 0 ? 'reviewer.md' : `reviewer-${round}.md`
  verdict = await agent(
    `Issue directory: ${dir}\nReview round ${round}. Check the whole diff against main.\n` +
      `Write your findings to ${dir}/${revFile}.\n${noDispatch}`,
    { agentType: 'uroboros:reviewer', phase: 'Review', label: `review:${round}`, schema: VERDICT },
  )

  log(`Round ${round}: ${verdict.findings} findings — ${verdict.summary}`)
  if (verdict.findings === 0) break
}

const accepted = verdict.findings === 0
if (!accepted) {
  log(`Stopped after ${MAX_CORRECTIONS} correction loops with findings open. Hand back to the human.`)
}

// Every agent above commits, none of them pushes, and the main session is not
// allowed to. Without this step the branch stays local and the work is lost
// with the container. The pull request belongs here too: the human's third
// steering point is merging it, and they cannot merge what was never opened.
// Runs whether or not the review accepted — the commits exist either way, and
// a rejected run is exactly the one a human needs to look at.
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
    "from the issue directory's `issue.md` and the reviewer's findings file: what " +
    'was asked for, what was built, what the review said, and every open finding or ' +
    'recorded observation the human should see before merging. Say plainly in the ' +
    'body when the review did NOT accept. End the body with a blank line, `---`, and ' +
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

return { ran: true, accepted, verdict, issueDir: dir, push }
