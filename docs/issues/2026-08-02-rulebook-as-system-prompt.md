---
status: active
branch: claude/system-prompt-review-mzlbqk
pr:
---

# The rulebook is the system prompt

## Intent

athena delivers its rulebook as a user message: the SessionStart hook pushes
the text of `CLAUDE.md` into the session through `additionalContext`. Claude
Code's own documentation says what that means — CLAUDE.md content arrives "as
a user message after the system prompt, not as part of the system prompt
itself. Claude reads it and tries to follow it, but there's no guarantee of
strict compliance."

Above it sits Claude Code's full default prompt, including a block of software
engineering instructions athena does not need and that contradicts its rules in
places. And in athena's own repository the rulebook is in context twice — once
from the hook, once as project memory — which the token measurement recorded as
finding 7.

Wanted: the rulebook itself is the session's system prompt, and nothing of the
default prompt remains. A session that does not get it says so instead of
running on rules it does not have.

Acceptance criteria:

1. When a session is started through the launcher athena ships, its system
   prompt is the rulebook text, and no section of Claude Code's default system
   prompt is present.
2. When a session is started with `claude` directly in a project where the
   plugin is active, the SessionStart status names that this session has no
   rulebook and withdraws success.
3. The rulebook text exists exactly once in the repository, under a name Claude
   Code does not load as project memory.
4. The SessionStart hook no longer puts the rulebook text into
   `additionalContext`; what it carries is the status line and an environment
   block naming the working directory, whether it is a git repository, and the
   current branch.
5. The rulebook carries what the dropped default prompt was still needed for —
   an opening that names what the agent is, tool preferences, what a denied
   tool call means, that `/<name>` invokes a skill, and how output reaches the
   human — and carries nothing else that was added from it.
6. The launcher resolves its own location, so launcher and rulebook always come
   from the same copy, and it passes every argument through to `claude`.
7. `bash test.sh` exits 0, and its suites cover the launcher and both branches
   of the hook's rulebook check.
8. No document in the repository still states that the hook delivers the
   rulebook text or that `CLAUDE.md` is the rulebook.

## Plan

## Tasks

## Decisions

- **The system prompt is replaced with `--system-prompt-file`, not narrowed
  with a plugin output style.** Source: the human's answer, asked with both
  options and their prices on the table. A forced plugin output style
  (`force-for-plugin: true`) would reach every session automatically but only
  drops the built-in coding-instructions block; the flag drops the whole
  default prompt but cannot be delivered by a plugin.
- **What the rulebook takes over from the dropped default prompt.** Source:
  the human delegated the choice ("nur das Wesentliche, nichts was überflüssig
  für athena ist — deine Entscheidung"). Taken over: an opening naming what the
  agent is, the tool preferences, what a denied tool call means, that `/<name>`
  invokes a skill, and how output reaches the human. Left out: the
  software-engineering block, "Executing actions with care", the URL rule,
  time estimates, the `<system-reminder>` explanation, scratchpad and MCP
  sections — each already covered by a rule athena states better, or touching
  nothing a run does.
- **`CLAUDE.md` is renamed to `rulebook.md` rather than kept.** Default,
  unanswered. It stops the file being loaded as project memory in athena's own
  checkout, which is what put the rulebook in context twice (finding 7), and it
  names the file for what it now is.
- **A launcher is shipped rather than an alias documented.** Default,
  unanswered. A script can be tested; an alias in a README cannot.
- **The launcher exports `ATHENA_RULEBOOK`.** Default, unanswered. It is the
  only thing by which the hook can tell whether this session actually has the
  rulebook, and a session silently running without it is the main risk this
  change introduces.
- **The hook keeps no fallback delivery of the rulebook text.** Default,
  unanswered. Keeping one would put the text in context twice again, which is
  the reason the change exists.
- **The environment block moves into the hook, not the rulebook.** Default,
  unanswered. A static file cannot know the working directory. The date is
  deliberately not in it: the rulebook already says to take it from `date +%F`.

## Log

- Session ran in Claude Code on the web. athena's plugin was not active in it:
  the session's available agent types were the harness's own, none of athena's
  five. The roles were therefore dispatched as fresh contexts pointed at their
  pages under `agents/`, as the rulebook's shelf allows. The self-check, run by
  hand against the checkout, reported: "2 skills and 5 agents reachable;
  rulebook delivered; push guard set; no problems." — so the tree itself is
  whole; only this session could not reach it.
- The mechanism was established against the installed binary
  (`/opt/node22/lib/node_modules/@anthropic-ai/claude-code/cli.js`, version
  2.1.220, `claude --version`), not from documentation. `--system-prompt-file`
  is registered there with `.hideHelp()`, which is why it does not appear in
  `claude --help`. The prompt assembler resolves
  `[...H ? [H] : K ? [K] : Y, ...z ? [z] : []]`, where `K` is the file's
  contents and `Y` the whole default prompt — so a custom prompt replaces the
  default outright, and `--append-system-prompt` still lands after it.
- Both assumptions recorded at checkpoint 1 were then settled by running
  sessions, not by reading further. In a scratch git repository:
  - `claude -p "What is 2+2?" --system-prompt-file <fixture>`, where the
    fixture says to answer every question with the single token
    `SYSPROMPT-REPLACED`, returned `SYSPROMPT-REPLACED`. The same question
    without the flag returned `4`. The flag replaces the default prompt
    outright.
  - With the plugin installed, `claude -p` asked whether its context holds a
    line starting with `Athena self-check:` quoted it verbatim **both** with
    and without the flag. Plugin loading is independent of the system prompt,
    so hooks still reach a session started through the launcher.
  - Asked to list its dispatchable subagent types, a session started with the
    flag returned `athena:implementer, athena:researcher, athena:reviewer,
    athena:test-author, athena:tracker` alongside the harness's own. Agents
    survive the flag too.
- Establishing that cost one detour worth recording: a project that only writes
  `extraKnownMarketplaces` and `enabledPlugins` into its own
  `.claude/settings.json` does **not** get the plugin. Nothing loaded, with or
  without the flag, and the first probe therefore proved nothing. The plugin has
  to be installed — `claude plugin marketplace add <path>` then
  `claude plugin install athena@athena` — which writes
  `~/.claude/plugins/installed_plugins.json` and unpacks a copy under
  `~/.claude/plugins/cache/athena/athena/<sha>/`. That cache path is where the
  launcher will run from, which is what makes resolving its own location the
  right way to find the rulebook beside it.

## Checkpoints

### Before implementation

- **Does this match what was asked?** Yes. The human was shown both routes with
  their prices and chose `--system-prompt-file` outright, and delegated what the
  rulebook should take over from the prompt it replaces. Two things go beyond
  the literal ask and are here because the ask cannot stand without them: a
  launcher, because a plugin cannot set a CLI flag, and a way for the hook to
  see that the launcher was used, because otherwise a session runs with no
  rules and says nothing.
- **What surprised me?** That `--system-prompt-file` is registered with
  `.hideHelp()`. My first answer to the human said the flag was not a usable
  route; they corrected it, and they were right. Second surprise: this session
  runs in a checkout whose plugin tree the self-check calls whole, and still
  none of athena's five agents were reachable in it — the plugin was not active
  in the session at all.
- **What am I assuming without having verified it?** Two things. That a session
  started with the flag really carries no section of the default prompt — that
  comes from reading the assembler, not from starting a session, and it is
  criterion 1. And that plugin loading is independent of the flag, so hooks,
  agents and skills still reach a session started through the launcher. Both
  are settled by running it, not by reading more code.

### Before the PR

- Does this match what was asked?
- What surprised me?
- What am I assuming without having verified it?

## Retro
