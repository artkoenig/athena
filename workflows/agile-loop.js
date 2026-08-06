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
    { title: 'Decompose', detail: 'planner cuts the issue into a backlog of increments' },
    { title: 'Research', detail: 'researcher plans the current increment' },
    { title: 'Tests', detail: 'test-author writes failing tests' },
    { title: 'Implement', detail: 'implementer makes them pass' },
    { title: 'Review', detail: 'reviewer checks the increment against its criteria' },
    { title: 'Replan', detail: 'planner re-cuts the increments still open' },
    { title: 'Publish', detail: 'the branch goes to the remote and a pull request exists' },
  ],
}

// The script is the orchestrator. No agent dispatches another one — their
// pages say so, and every prompt below repeats it.

const MAX_CORRECTIONS = 2

// Three separate backstops, because a backlog can run away in three separate
// ways. The planner may keep adding increments (MAX_INCREMENTS), it may keep
// handing back an increment that never finishes (MAX_ATTEMPTS, per id), and the
// run may be failing for a reason no re-cut will fix (MAX_BLOCKED). Each one
// stops the loop and hands back to the human rather than burning the budget.
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
    backlogFile: { type: 'string', description: 'Path of the backlog file, relative to the repo root.' },
    handoffFile: { type: 'string', description: 'Path of your handoff file, relative to the repo root.' },
    summary: { type: 'string' },
  },
  required: ['increments', 'backlogFile', 'handoffFile', 'summary'],
  additionalProperties: false,
}

const PLAN = {
  type: 'object',
  properties: {
    needsTests: {
      type: 'boolean',
      description:
        'What the Test Plan section of your handoff decided: false only when this ' +
        'increment has nothing a test could check.',
    },
    checks: {
      type: 'array',
      items: { type: 'string' },
      description:
        'The closed list from your Test Plan: the commands, verbatim and runnable from ' +
        'the repository root, whose exit codes this increment is judged by. Nobody ' +
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
      description: 'Number of findings that require a correction. 0 means the increment is accepted.',
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

// The reviewer reads no handoff — that is what keeps it an independent pair of
// eyes. So the one thing it needs from the plan, the list of commands that count
// for this increment, is handed to it here instead: what to run, never why.
function checkList(checks) {
  return checks && checks.length
    ? 'The commands that count for this increment, and the only ones anyone runs:\n' +
        checks.map((c) => `  - \`${c}\``).join('\n') +
        '\n'
    : 'The plan lists no command to run for this increment. Run none, and say so.\n'
}

const noDispatch =
  'You are running inside a workflow script. Do NOT dispatch any subagent and ' +
  'do NOT hand over to anyone — the script calls the next agent itself. Write ' +
  'your handoff file, commit it, then return.'

// One role, one file, for the whole run — the same rule the plain loop follows,
// with the section naming an increment and a round instead of a round alone. An
// issue directory of a five-increment run holds five handoffs, not twenty-five,
// and whoever is pointed at `researcher.md` reads the current plan and the
// history that produced it in one place.
function heading(n, round) {
  return round === 0 ? `## Increment ${n}` : `## Increment ${n} — Round ${round}`
}

// One wording for every call, because the file exists on all of them but the
// first — and not even reliably then, since an increment that needs no tests
// leaves `test-author.md` unwritten for the next one to create.
function handoff(file, n, round) {
  return (
    `Your handoff file is ${dir}/${file}. Append a \`${heading(n, round)}\` section to it, ` +
    `creating the file with that section if it is not there yet, and leave every earlier ` +
    `section exactly as it stands. Do not open a second file.\n`
  )
}

// How to point an agent at somebody else's file: the section for this
// increment and round is the work order, and nothing above it is.
function section(file, n, round) {
  return `the \`${heading(n, round)}\` section of ${file}`
}

// What every agent working an increment is told about the shape of the run. The
// issue file names criteria this increment is not meant to satisfy, and without
// this an agent reads them as its own — the researcher plans the whole issue in
// one go, and the reviewer files a finding for every criterion the run has not
// reached yet.
function scope(task, backlog, n) {
  const open = backlog.increments.filter((t) => t.status === 'todo' && t.id !== task.id)
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

function research(task, backlog, n, round) {
  const correction =
    round === 0
      ? ''
      : `This is correction loop ${round} of ${MAX_CORRECTIONS} for this increment. Read the ` +
        `reviewer's findings file in the issue directory, its newest section first, and plan ` +
        `the corrections. ` +
        `Set needsTests true only if a finding needs a new failing test first, and then give ` +
        `that test its own Test Plan section inside this section — no earlier section's plan ` +
        `carries over, the list of commands that count included.\n`
  return agent(
    `Issue directory: ${dir}\n` +
      scope(task, backlog, n) +
      correction +
      handoff('researcher.md', n, round) +
      noDispatch,
    {
      agentType: 'uroboros:researcher',
      phase: 'Research',
      label: `research:${n}.${round}`,
      schema: PLAN,
    },
  )
}

// The planner's sections are named for the call, not for an increment and a
// round, because a call sits between two increments rather than inside one.
function plannerHandoff(n) {
  return (
    `Your handoff file is ${dir}/planner.md. Append a ` +
    `\`${n === 0 ? '## The cut' : `## After increment ${n}`}\` section to it, creating the ` +
    `file with that section if it is not there yet, and leave every earlier section exactly ` +
    `as it stands. Do not open a second file. ${dir}/backlog.md is the other file you write, ` +
    `and that one you rewrite in full.\n`
  )
}

// Increment 0 is the cut itself; every later call folds one finished increment
// back into the increments still open.
function plan(n, worked) {
  const brief =
    n === 0
      ? `Cut ${dir}/issue.md into a backlog of increments and write it to ${dir}/backlog.md. ` +
        `This run works at most ${maxIncrements} of them, so a cut that needs more than that ` +
        `is a cut that is too fine.\n`
      : `Increment ${n} — ${worked.task.title} — has been worked. The review ` +
        (worked.accepted
          ? `accepted it.\n`
          : `did not accept it after ${MAX_CORRECTIONS} correction rounds, with ` +
            `${worked.findings} findings open: ${worked.reason}\n`) +
        `Close it in the backlog with the status that verdict earns, then re-cut every ` +
        `increment still open against what this one showed, and rewrite ${dir}/backlog.md ` +
        `in full. ${n} of at most ${maxIncrements} increments are spent.\n`
  return agent(
    `Issue directory: ${dir}\n` +
      brief + plannerHandoff(n) + noDispatch,
    {
      agentType: 'uroboros:planner',
      phase: n === 0 ? 'Decompose' : 'Replan',
      label: n === 0 ? 'decompose' : `replan:${n}`,
      schema: BACKLOG,
    },
  )
}

phase('Decompose')
let backlog = await plan(0, null)
log(
  `Backlog written to ${backlog.backlogFile}: ` +
    backlog.increments.map((t, i) => `${i + 1}. ${t.title}`).join(' | '),
)

// Why each increment ended the way it did, in the agents' own words. The human
// sits in the main conversation and opens no file, so `log` puts it in front of
// them while the run goes, and `increments` comes back with the result so the
// session can repeat it once the run is done.
const increments = []
const attempts = new Map()
let blocked = 0
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
  const ok = increments.filter((i) => i.accepted).map((i) => i.n)
  const bad = increments.filter((i) => !i.accepted).map((i) => i.n)
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

for (let n = 1; ; n++) {
  const task = backlog.increments.find((t) => t.status === 'todo')
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

  let plan_ = null
  let verdict
  for (let round = 0; round <= MAX_CORRECTIONS; round++) {
    phase('Research')
    plan_ = await research(task, backlog, n, round)
    log(
      `Increment ${n} round ${round}: plan in ${plan_.handoffFile}; tests needed: ` +
        `${plan_.needsTests}; checks: ${plan_.checks.length ? plan_.checks.join(', ') : 'none'}`,
    )

    if (plan_.needsTests) {
      await agent(
        `Issue directory: ${dir}\n` +
          scope(task, backlog, n) +
          `Your work order is the Test Plan of ${section(plan_.handoffFile, n, round)}: write ` +
          `those cases, in the files and style it names, and no others.` +
          (round === 0
            ? '\n'
            : ` The reviewer's reproduction spec is the criterion for this round.\n`) +
          handoff('test-author.md', n, round) +
          noDispatch,
        { agentType: 'uroboros:test-author', phase: 'Tests', label: `tests:${n}.${round}` },
      )
    }

    await agent(
      `Issue directory: ${dir}\nYour brief is ${section(plan_.handoffFile, n, round)}.\n` +
        checkList(plan_.checks) +
        handoff('implementer.md', n, round) +
        noDispatch,
      { agentType: 'uroboros:implementer', phase: 'Implement', label: `implement:${n}.${round}` },
    )

    verdict = await agent(
      `Issue directory: ${dir}\nReview round ${round} of increment ${n}. Check the whole diff ` +
        `against main.\n` +
        scope(task, backlog, n) +
        baseline(n) +
        checkList(plan_.checks) +
        handoff('reviewer.md', n, round) +
        noDispatch,
      { agentType: 'uroboros:reviewer', phase: 'Review', label: `review:${n}.${round}`, schema: VERDICT },
    )

    const reason = verdict.reason || verdict.summary
    if (verdict.findings === 0) {
      log(`Increment ${n} round ${round}: accepted — ${verdict.summary}`)
      break
    }
    if (round === MAX_CORRECTIONS) {
      log(`Increment ${n} round ${round}: ${verdict.findings} findings, last round used up — ${reason}`)
      break
    }
    log(`Increment ${n} round ${round}: ${verdict.findings} findings, correcting — ${reason}`)
  }

  const accepted = verdict.findings === 0
  if (!accepted) blocked++
  increments.push({
    n,
    id: task.id,
    title: task.title,
    accepted,
    findings: verdict.findings,
    reason: verdict.reason || verdict.summary,
    findingsFile: verdict.handoffFile,
  })

  // Runs whether the review accepted or not: the planner owns the answer to a
  // blocked increment as much as to a finished one, and a backlog that never
  // records the failure sends the next call in blind.
  phase('Replan')
  backlog = await plan(n, {
    task,
    accepted,
    findings: verdict.findings,
    reason: verdict.reason || verdict.summary,
  })
  log(
    `After increment ${n}: ` +
      backlog.increments
        .map((t) => `${t.title} [${t.status}]`)
        .join(' | ') +
      ` — ${backlog.summary}`,
  )

  if (blocked >= MAX_BLOCKED) {
    stopped = `${blocked} increments ended with findings open`
    break
  }
}

const open = backlog.increments.filter((t) => t.status === 'todo')
const delivered = backlog.increments.filter((t) => t.status === 'done')
const accepted = !stopped && open.length === 0 && blocked === 0
if (stopped) {
  log(`Stopped: ${stopped}. ${open.length} increments left in the backlog. Hand back to the human.`)
}

// Every agent above commits, none of them pushes, and the main session is not
// allowed to. Without this step the branch stays local and the work is lost
// with the container. The pull request belongs here too: the human's third
// steering point is merging it, and they cannot merge what was never opened.
// Runs whether or not the backlog emptied — the commits exist either way, and
// a run that stopped early is exactly the one a human needs to look at.
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
    `from the issue directory's \`issue.md\`, the planner's \`backlog.md\` and the ` +
    "reviewer's findings file: what was asked for, which increments were delivered, " +
    'which are still open or blocked and why, what the review said, and every open ' +
    'finding or recorded observation the human should see before merging. This run ' +
    'worked the issue in increments, so say plainly in the body when the backlog did ' +
    'NOT empty and name what is left. End the body with a blank line, `---`, and ' +
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
  increments,
  backlog: backlog.increments,
  backlogFile: backlog.backlogFile,
  push,
}
