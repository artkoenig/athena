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
      description:
        'What the Test Plan section of your handoff decided: false only when the ' +
        'change has nothing a test could check.',
    },
    checks: {
      type: 'array',
      items: { type: 'string' },
      description:
        'The closed list from your Test Plan: the commands, verbatim and runnable from ' +
        'the repository root, whose exit codes this change is judged by. Nobody ' +
        'downstream runs anything else. Empty when nothing should be run at all.',
    },
    handoffFile: {
      type: 'string',
      description: 'Path of the handoff file you wrote, relative to the repo root.',
    },
    summary: { type: 'string' },
  },
  required: ['needsTests', 'checks', 'handoffFile', 'summary'],
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
    reason: {
      type: 'string',
      description:
        'Why another correction round is needed, in one or two sentences a human ' +
        'reads in the chat without opening a file: what is wrong and which ' +
        'acceptance criterion it misses. Empty string when findings is 0.',
    },
    summary: { type: 'string' },
  },
  required: ['findings', 'handoffFile', 'reason', 'summary'],
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

// The reviewer reads no handoff — that is what keeps it an independent pair of
// eyes. So the one thing it needs from the plan, the list of commands that count
// for this change, is handed to it here instead: what to run, never why.
function checkList(checks) {
  return checks && checks.length
    ? 'The commands that count for this change, and the only ones anyone runs:\n' +
        checks.map((c) => `  - \`${c}\``).join('\n') +
        '\n'
    : 'The plan lists no command to run for this change. Run none, and say so.\n'
}

const noDispatch =
  'You are running inside a workflow script. Do NOT dispatch any subagent and ' +
  'do NOT hand over to anyone — the script calls the next agent itself. Write ' +
  'your handoff file, commit it, then return.'

// One role, one file, for the whole run. A correction round appends its section
// to the file that is already there instead of opening `<role>-<round>.md`, so
// the issue directory holds four handoffs however many rounds it took, and
// whoever is pointed at `researcher.md` reads the current plan and the history
// that produced it in one place. The shared brief carries the same rule for the
// agents; this is where the prompts say which round it is.
function handoff(file, round) {
  return round === 0
    ? `Write your handoff to ${dir}/${file}.\n`
    : `Append a \`## Round ${round}\` section to the existing ${dir}/${file}, and ` +
        `leave every earlier section as it stands. Do not open a second file.\n`
}

// How to point an agent at somebody else's file: from round 1 on, only the
// round's own section is the work order.
function section(file, round) {
  return round === 0 ? file : `the \`## Round ${round}\` section of ${file}`
}

function research(round) {
  const correction =
    round === 0
      ? ''
      : `This is correction loop ${round} of ${MAX_CORRECTIONS}. Read the reviewer's ` +
        `findings file in the issue directory, its newest round section first, and ` +
        `plan the corrections. ` +
        `Set needsTests true only if a finding needs a new failing test first, and ` +
        `then give that test its own Test Plan section inside this round's section — ` +
        `the earlier rounds' plans do not carry over, the list of commands that ` +
        `count included.\n`
  return agent(
    `Issue directory: ${dir}\n${correction}${handoff('researcher.md', round)}${noDispatch}`,
    { agentType: 'uroboros:researcher', phase: 'Research', label: `research:${round}`, schema: PLAN },
  )
}

phase('Research')
let plan = await research(0)
log(
  `Plan written to ${plan.handoffFile}; tests needed: ${plan.needsTests}; ` +
    `checks: ${plan.checks.length ? plan.checks.join(', ') : 'none'}`,
)

if (plan.needsTests) {
  await agent(
    `Issue directory: ${dir}\nYour work order is the Test Plan section of ` +
      `${plan.handoffFile}: write those cases, in the files and style it names, and ` +
      `no others.\n${handoff('test-author.md', 0)}${noDispatch}`,
    { agentType: 'uroboros:test-author', phase: 'Tests', label: 'tests' },
  )
}

// Why each round was restarted, in the reviewer's own words. The human sits in
// the main conversation and does not read the findings files, so a round that
// sends the loop back has to say why where they are looking: `log` puts it in
// front of them while the loop runs, and `rounds` comes back with the result so
// the session can repeat it once the loop is done.
let verdict
const rounds = []
for (let round = 0; round <= MAX_CORRECTIONS; round++) {
  if (round > 0) {
    plan = await research(round)
    log(`Correction plan ${round} appended to ${plan.handoffFile}`)
    if (plan.needsTests) {
      await agent(
        `Issue directory: ${dir}\nThe reviewer's reproduction spec is your criterion, ` +
          `and the Test Plan section of ${section(plan.handoffFile, round)} is your ` +
          `work order for it.\n${handoff('test-author.md', round)}${noDispatch}`,
        { agentType: 'uroboros:test-author', phase: 'Tests', label: `tests:${round}` },
      )
    }
  }

  await agent(
    `Issue directory: ${dir}\nYour brief is ${section(plan.handoffFile, round)}.\n` +
      checkList(plan.checks) +
      handoff('implementer.md', round) +
      noDispatch,
    { agentType: 'uroboros:implementer', phase: 'Implement', label: `implement:${round}` },
  )

  verdict = await agent(
    `Issue directory: ${dir}\nReview round ${round}. Check the whole diff against main.\n` +
      checkList(plan.checks) +
      handoff('reviewer.md', round) +
      noDispatch,
    { agentType: 'uroboros:reviewer', phase: 'Review', label: `review:${round}`, schema: VERDICT },
  )

  const reason = verdict.reason || verdict.summary
  rounds.push({
    round,
    findings: verdict.findings,
    reason,
    findingsFile: verdict.handoffFile,
  })

  if (verdict.findings === 0) {
    log(`Round ${round}: accepted — ${verdict.summary}`)
    break
  }
  if (round === MAX_CORRECTIONS) {
    log(`Round ${round}: ${verdict.findings} findings, last round used up — ${reason}`)
    break
  }
  log(`Round ${round}: ${verdict.findings} findings, correcting — ${reason}`)
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

return { ran: true, accepted, rounds, verdict, issueDir: dir, push }
