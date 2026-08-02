#!/bin/bash
# Tests for the Claude Code plugin this repository packages: the two
# manifests, the SessionStart hook that delivers the rulebook, and the push
# guard.
#
# Everything runs against scratch directories. The real ~/.claude, the real
# Claude configuration and this repository's own git config are never
# touched: every `claude` call gets a scratch CLAUDE_CONFIG_DIR, every hook
# run gets a scratch project repository. No model is called — `claude plugin
# validate` is shell-level. Exit 0 = all cases pass.
set -u

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

export CLAUDE_CONFIG_DIR="$tmp/claude-config"
mkdir -p "$CLAUDE_CONFIG_DIR"

passed=0
failed=0

ok() { passed=$((passed + 1)); echo "  ok   — $1"; }
no() { failed=$((failed + 1)); echo "  FAIL — $1"; }
check() { if [ "$1" = "0" ]; then ok "$2"; else no "$2"; fi; }

# A scratch copy of everything the plugin ships, free to mutate.
plugin_copy() {
  local dest="$1"
  mkdir -p "$dest"
  cp -R "$root/.claude-plugin" "$root/hooks" "$root/.githooks" "$dest/"
  cp "$root/CLAUDE.md" "$dest/"
  for optional in skills agents; do
    [ -d "$root/$optional" ] && cp -R "$root/$optional" "$dest/"
  done
  return 0
}

# A scratch git repository standing in for a project the plugin loads into.
project_repo() {
  local dest="$1"
  mkdir -p "$dest"
  git -C "$dest" init -q -b main
  git -C "$dest" config user.email test@example.com
  git -C "$dest" config user.name test
  echo hello >"$dest/file.txt"
  git -C "$dest" add file.txt
  git -C "$dest" commit -qm init
}

run_hook() {
  local plugin="$1" project="$2"
  # Explicitly cleared, not merely omitted: this suite may itself be
  # running inside a remote session, and an inherited CLAUDE_CODE_REMOTE=true
  # would silently take every one of these calls through the self-update
  # block instead of the plain path they are meant to exercise.
  CLAUDE_PLUGIN_ROOT="$plugin" CLAUDE_PROJECT_DIR="$project" CLAUDE_CODE_REMOTE= \
    bash "$plugin/hooks/session-start.sh" 2>/dev/null
}

# A stand-in `claude` on PATH for the self-update block: no network, no
# model, deterministic. FAKE_CLAUDE_CALLED_MARKER records that it ran at
# all; FAKE_CLAUDE_UPDATE_EXIT and FAKE_CLAUDE_UPDATE_DELAY control `plugin
# update`; FAKE_CLAUDE_LIST_VERSION controls what `plugin list` reports for
# athena@athena, empty meaning "no Version: line".
fake_claude_bin() {
  local bin_dir="$1"
  mkdir -p "$bin_dir"
  cat >"$bin_dir/claude" <<'EOF'
#!/bin/bash
[ -n "${FAKE_CLAUDE_CALLED_MARKER:-}" ] && touch "$FAKE_CLAUDE_CALLED_MARKER"
if [ "${1:-}" = "plugin" ] && [ "${2:-}" = "update" ]; then
  [ "${FAKE_CLAUDE_UPDATE_DELAY:-0}" != "0" ] && sleep "$FAKE_CLAUDE_UPDATE_DELAY"
  exit "${FAKE_CLAUDE_UPDATE_EXIT:-0}"
elif [ "${1:-}" = "plugin" ] && [ "${2:-}" = "list" ]; then
  echo "Installed plugins:"
  echo
  echo "  > athena@athena"
  [ -n "${FAKE_CLAUDE_LIST_VERSION:-}" ] && echo "    Version: ${FAKE_CLAUDE_LIST_VERSION}"
  echo "    Scope: user"
  echo "    Status: (mock) enabled"
  exit 0
fi
exit 0
EOF
  chmod +x "$bin_dir/claude"
}

# Runs the hook as a remote session would: CLAUDE_CODE_REMOTE=true and the
# fake claude ahead of the real one on PATH.
run_hook_remote() {
  local plugin="$1" project="$2" fake_bin="$3"
  CLAUDE_CODE_REMOTE=true CLAUDE_PLUGIN_ROOT="$plugin" CLAUDE_PROJECT_DIR="$project" \
    PATH="$fake_bin:$PATH" \
    bash "$plugin/hooks/session-start.sh" 2>/dev/null
}

# The status line the hook appends after the rulebook.
hook_status() {
  node -e '
    const fs = require("fs");
    const out = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const ctx = out.hookSpecificOutput.additionalContext;
    const line = ctx.split("\n").filter(l => l.startsWith("Athena self-check:")).pop();
    process.stdout.write(line || "");
  ' "$1"
}

echo "=== manifests"

# the plugin manifest is the documented shape, and declares no
# version — a resolved version that never changes is what makes an
# installation keep its cached copy instead of picking up merged commits.
node -e '
  const m = require(process.argv[1]);
  const allowed = new Set(["name","description","author","homepage","repository","license","keywords","skills","agents"]);
  const problems = [];
  for (const k of Object.keys(m)) if (!allowed.has(k)) problems.push("unknown field: " + k);
  for (const k of ["name","description","author","repository","license"]) if (!m[k]) problems.push("missing field: " + k);
  if (m.name !== "athena") problems.push("name is not athena: " + m.name);
  if ("version" in m) problems.push("declares a version");
  if (problems.length) { console.error(problems.join("; ")); process.exit(1); }
' "$root/.claude-plugin/plugin.json"
check $? "plugin.json has the documented fields, names athena, pins no version"

# every skill directory in the tree is declared. `skills` normally adds to
# the default `skills/` scan, but this marketplace entry's source is the
# repository root, and for that case a declared path replaces the default —
# so a tree whose skills/ is not listed loses it silently.
node -e '
  const fs = require("fs"), path = require("path");
  const root = process.argv[1];
  const declared = [].concat(require(path.join(root, ".claude-plugin/plugin.json")).skills || []);
  const problems = [];
  const dirsOf = (p) => fs.existsSync(p) ? fs.readdirSync(p, { withFileTypes: true }).filter(e => e.isDirectory()) : [];
  const holders = new Set();
  for (const e of dirsOf(path.join(root, "skills"))) holders.add("./skills/");
  for (const a of dirsOf(path.join(root, "agents")))
    for (const _ of dirsOf(path.join(root, "agents", a.name, "skills"))) holders.add(`./agents/${a.name}/skills/`);
  for (const h of holders) if (!declared.includes(h)) problems.push("skills path holding a SKILL.md is not declared: " + h);
  for (const d of declared) if (!fs.existsSync(path.join(root, d))) problems.push("declared skills path does not exist: " + d);
  if (problems.length) { console.error(problems.join("; ")); process.exit(1); }
' "$root"
check $? "plugin.json declares every directory that holds skills, the default skills/ included"

# every agent file is declared, and nothing else is. `agents` replaces the
# scan of agents/, and that scan is recursive: undeclared, a skill an agent
# preloads loads as an agent named after its path; declared but missing from
# the list, an agent silently disappears from every session.
node -e '
  const fs = require("fs"), path = require("path");
  const root = process.argv[1];
  const declared = [].concat(require(path.join(root, ".claude-plugin/plugin.json")).agents || []);
  const tree = fs.readdirSync(path.join(root, "agents"), { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith(".md")).map(e => `./agents/${e.name}`);
  const problems = [];
  for (const f of tree) if (!declared.includes(f)) problems.push("agent in the tree but not declared: " + f);
  for (const f of declared) if (!tree.includes(f)) problems.push("agent declared but not in the tree: " + f);
  if (problems.length) { console.error(problems.join("; ")); process.exit(1); }
' "$root"
check $? "plugin.json declares exactly the agent files the tree holds"

# the marketplace manifest offers exactly this repository as the
# athena plugin, and pins no version either.
node -e '
  const m = require(process.argv[1]);
  const problems = [];
  if (m.name !== "athena") problems.push("marketplace name is not athena: " + m.name);
  if (!m.owner || !m.owner.name) problems.push("no owner");
  if (!Array.isArray(m.plugins) || m.plugins.length !== 1) problems.push("expected exactly one plugin entry");
  const p = (m.plugins || [])[0] || {};
  if (p.name !== "athena") problems.push("plugin entry is not athena: " + p.name);
  if (p.source !== "./") problems.push("plugin source is not the repository root: " + p.source);
  if ("version" in p) problems.push("plugin entry declares a version");
  if (problems.length) { console.error(problems.join("; ")); process.exit(1); }
' "$root/.claude-plugin/marketplace.json"
check $? "marketplace.json offers this repository as the athena plugin, no version"

# the validator accepts the repository at both of its targets. They
# check different things: the marketplace target reads marketplace.json and
# stops, the plugin target walks the components — every skills/<name>/SKILL.md
# and every agents/<name>.md.
claude plugin validate "$root/.claude-plugin/marketplace.json" >/dev/null 2>&1
check $? "claude plugin validate accepts the marketplace manifest"

claude plugin validate "$root/.claude-plugin/plugin.json" >/dev/null 2>&1
check $? "claude plugin validate accepts the plugin manifest and its components"

# with no version key, --strict cannot be used as a pass/fail gate —
# it turns the "No version specified" warning into an error on a defect-free
# tree. Its warnings are still the only thing that catches a manifest field
# the loader ignores (a misspelled `repository`) or one it misses
# (`description`), or a file that lands in a component directory without
# being a component — an `agents/CLAUDE.md` registers as an agent with no
# frontmatter. So the gate is the warning list, not the exit code: two
# warnings are expected on a defect-free tree, and any third is a defect.
#
# The two: the missing version, and the root CLAUDE.md — the rulebook
# itself, deliberately not loaded by the CLI's own convention and
# delivered to sessions of installing projects via the hook instead.
strict_out="$tmp/strict.txt"
claude plugin validate "$root/.claude-plugin/plugin.json" --strict >"$strict_out" 2>&1
warnings="$(grep -c '^  > ' "$strict_out")"
version_warnings="$(grep -c '^  > version: No version specified' "$strict_out")"
root_md_warnings="$(grep -c '^  > root: CLAUDE.md at the plugin root is not loaded' "$strict_out")"
if [ "$warnings" = "2" ] && [ "$version_warnings" = "1" ] && [ "$root_md_warnings" = "1" ]; then
  ok "--strict warns about the missing version and the root CLAUDE.md, and nothing else"
else
  no "--strict warns about more than the missing version and the root CLAUDE.md:"
  grep '^  > ' "$strict_out" | sed 's/^/       /'
fi

echo
echo "=== the plugin installs"

# the manifests being well-formed is not the same as the CLI being
# able to install from them. A scratch config and a scratch HOME take the
# marketplace and the install, and `claude plugin details` then has to report
# this plugin with exactly the components the tree holds — which for now is
# the one SessionStart hook and nothing else.
install_home="$tmp/install-home"
install_cfg="$tmp/install-config"
mkdir -p "$install_home" "$install_cfg"
details="$tmp/details.txt"
(
  export HOME="$install_home" CLAUDE_CONFIG_DIR="$install_cfg"
  claude plugin marketplace add "$root" >/dev/null 2>&1 \
    && claude plugin install athena@athena >/dev/null 2>&1 \
    && claude plugin details athena@athena >"$details" 2>&1
)
check $? "the marketplace adds and athena@athena installs from it"

# Agents are not compared here: `claude plugin details` counts the default
# agents/ scan, and this plugin replaces that scan with an explicit file list
# in plugin.json, which the inventory view reports as zero even though every
# session loads all of them. The manifest-against-tree check above is what
# guards the agent list.
expected_hooks=1
node -e '
  const text = require("fs").readFileSync(process.argv[1], "utf8");
  const want = { Skills: Number(process.argv[2]), Hooks: Number(process.argv[4]) };
  const problems = [];
  for (const [kind, n] of Object.entries(want)) {
    const m = text.match(new RegExp(kind + " \\((\\d+)\\)"));
    if (!m) problems.push("no " + kind + " line in the inventory");
    else if (Number(m[1]) !== n) problems.push(kind + ": inventory says " + m[1] + ", tree has " + n);
  }
  if (problems.length) { console.error(problems.join("; ")); process.exit(1); }
' "$details" "$(( $(find "$root/skills" -mindepth 2 -maxdepth 2 -name SKILL.md 2>/dev/null | wc -l | tr -d ' ') \
                 + $(find "$root/agents" -mindepth 4 -maxdepth 4 -path '*/skills/*' -name SKILL.md 2>/dev/null | wc -l | tr -d ' ') ))" \
  "$(find "$root/agents" -mindepth 1 -maxdepth 1 -name '*.md' 2>/dev/null | wc -l | tr -d ' ')" "$expected_hooks"
check $? "the installed inventory equals what the tree holds, agent-owned skills included: skills, one SessionStart hook"

echo
echo "=== the rulebook reaches the session"

happy_plugin="$tmp/happy-plugin"
happy_project="$tmp/happy-project"
plugin_copy "$happy_plugin"
project_repo "$happy_project"
run_hook "$happy_plugin" "$happy_project" >"$tmp/happy.json"

# stdout is a single valid hook JSON object and nothing else.
node -e '
  const out = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  if (out.hookSpecificOutput.hookEventName !== "SessionStart") process.exit(1);
  if (typeof out.hookSpecificOutput.additionalContext !== "string") process.exit(1);
' "$tmp/happy.json"
check $? "the hook writes one valid SessionStart hook object to stdout"

# the rulebook text itself is delivered, not a pointer to it — a
# pointer would leave the session free to skip it.
node -e '
  const fs = require("fs");
  const out = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const rulebook = fs.readFileSync(process.argv[2], "utf8");
  if (!out.hookSpecificOutput.additionalContext.includes(rulebook.trimEnd())) process.exit(1);
' "$tmp/happy.json" "$root/CLAUDE.md"
check $? "the whole text of CLAUDE.md arrives verbatim in additionalContext"

# hooks.json registers exactly one SessionStart command hook, and it
# runs the script this suite exercises, from the plugin root.
node -e '
  const h = require(process.argv[1]).hooks;
  const entries = h.SessionStart;
  if (Object.keys(h).length !== 1) process.exit(1);
  if (!Array.isArray(entries) || entries.length !== 1) process.exit(1);
  const hooks = entries[0].hooks;
  if (!Array.isArray(hooks) || hooks.length !== 1) process.exit(1);
  if (hooks[0].type !== "command") process.exit(1);
  if (!hooks[0].command.includes("${CLAUDE_PLUGIN_ROOT}")) process.exit(1);
  if (!hooks[0].command.endsWith("/hooks/session-start.sh")) process.exit(1);
' "$root/hooks/hooks.json"
check $? "hooks.json registers one SessionStart hook, the plugin root's session-start.sh"

echo
echo "=== the plugin self-updates when remote"

# The version the fake update lands on, and the plugin tree it resolves
# to — a second copy with a marker line in its rulebook, so a test can tell
# which copy's CLAUDE.md the hook actually delivered.
selfupdate="$tmp/self-update"
old_root="$selfupdate/old-version"
new_root="$selfupdate/new-version"
plugin_copy "$old_root"
plugin_copy "$new_root"
printf '\ntest-marker: new-version\n' >>"$new_root/CLAUDE.md"
selfupdate_project="$tmp/self-update-project"
project_repo "$selfupdate_project"
fake_bin="$tmp/fake-bin"
fake_claude_bin "$fake_bin"

# the update succeeds and reports the new version: the hook delivers the
# new copy's rulebook, not the one it was invoked with.
called_marker="$tmp/called.marker"
rm -f "$called_marker"
FAKE_CLAUDE_CALLED_MARKER="$called_marker" FAKE_CLAUDE_LIST_VERSION="new-version" \
  run_hook_remote "$old_root" "$selfupdate_project" "$fake_bin" >"$tmp/selfupdate-ok.json"
node -e '
  const out = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  if (out.hookSpecificOutput.hookEventName !== "SessionStart") process.exit(1);
  if (!out.hookSpecificOutput.additionalContext.includes("test-marker: new-version")) process.exit(1);
' "$tmp/selfupdate-ok.json"
check $? "a resolvable new version delivers that version's rulebook, still valid JSON"
[ -f "$called_marker" ]
check $? "the self-update block actually ran claude"

# the update reports a version with no directory on disk: plugin_root
# stays what it was inherited as, and the hook still delivers cleanly.
FAKE_CLAUDE_LIST_VERSION="no-such-version" \
  run_hook_remote "$old_root" "$selfupdate_project" "$fake_bin" >"$tmp/selfupdate-ghost.json"
node -e '
  const out = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  if (out.hookSpecificOutput.additionalContext.includes("test-marker: new-version")) process.exit(1);
' "$tmp/selfupdate-ghost.json"
check $? "a version claude list reports but that is not on disk falls back to the inherited plugin_root"

# `plugin update` itself fails outright: same fallback, no crash, no
# broken JSON.
FAKE_CLAUDE_UPDATE_EXIT=1 FAKE_CLAUDE_LIST_VERSION="" \
  run_hook_remote "$old_root" "$selfupdate_project" "$fake_bin" >"$tmp/selfupdate-fail.json"
node -e '
  const out = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  if (out.hookSpecificOutput.hookEventName !== "SessionStart") process.exit(1);
  if (out.hookSpecificOutput.additionalContext.includes("test-marker: new-version")) process.exit(1);
' "$tmp/selfupdate-fail.json"
check $? "a failing plugin update falls back to the inherited plugin_root, still valid JSON"

# outside a remote session the block never runs at all — no claude call,
# no latency, no dependency, regardless of what a fake claude would report.
# Cleared explicitly for the same reason as in run_hook(): this suite may
# itself be running inside a remote session.
rm -f "$called_marker"
FAKE_CLAUDE_CALLED_MARKER="$called_marker" FAKE_CLAUDE_LIST_VERSION="new-version" \
  CLAUDE_CODE_REMOTE= CLAUDE_PLUGIN_ROOT="$old_root" CLAUDE_PROJECT_DIR="$selfupdate_project" \
  PATH="$fake_bin:$PATH" bash "$old_root/hooks/session-start.sh" >"$tmp/selfupdate-local.json" 2>/dev/null
[ ! -f "$called_marker" ]
check $? "outside CLAUDE_CODE_REMOTE=true the self-update block does not run claude at all"

echo
echo "=== the self-check reports what is really there"

status="$(hook_status "$tmp/happy.json")"
real_skills=$(( $(find "$root/skills" -mindepth 2 -maxdepth 2 -name SKILL.md 2>/dev/null | wc -l | tr -d ' ') \
              + $(find "$root/agents" -mindepth 4 -maxdepth 4 -path '*/skills/*' -name SKILL.md 2>/dev/null | wc -l | tr -d ' ') ))
real_agents=$(find "$root/agents" -mindepth 1 -maxdepth 1 -name '*.md' 2>/dev/null | wc -l | tr -d ' ')

# the happy status names the real counts, the delivered rulebook and
# the set guard, and reports no failure.
case "$status" in
  "Athena self-check: ${real_skills} skills and ${real_agents} agents reachable; rulebook delivered; push guard set; no problems.")
    ok "the status names the real counts, the rulebook and the guard, with no problems" ;;
  *) no "unexpected happy status: $status" ;;
esac

# athena ships the rulebook before its agents and skills, so a tree
# with neither is the deliberate state, not a defect. The counts still have
# to say zero — the rulebook sends the session here to find out what a role
# has behind it.
empty_plugin="$tmp/empty-plugin"
plugin_copy "$empty_plugin"
rm -rf "$empty_plugin/skills" "$empty_plugin/agents"
empty_project="$tmp/empty-project"
project_repo "$empty_project"
status="$(run_hook "$empty_plugin" "$empty_project" >"$tmp/empty.json" && hook_status "$tmp/empty.json")"
case "$status" in
  "Athena self-check: 0 skills and 0 agents reachable;"*"no problems.") ok "no skills and no agents is reported as zero, not as a failure" ;;
  *) no "an empty shelf was not reported cleanly: $status" ;;
esac

# a skill directory that lost its SKILL.md is in the tree and
# invisible to discovery. Half a lost workflow may not be reported as a whole
# one, so it is named and success is withdrawn.
lost_skill="$tmp/lost-skill"
plugin_copy "$lost_skill"
mkdir -p "$lost_skill/skills/orphan"
status="$(run_hook "$lost_skill" "$empty_project" >"$tmp/lost-skill.json" && hook_status "$tmp/lost-skill.json")"
case "$status" in
  *"skill without SKILL.md: orphan;"*"FAILED"*) ok "a skill directory without SKILL.md is named and success withdrawn" ;;
  *"FAILED"*"skill without SKILL.md: orphan;"*) ok "a skill directory without SKILL.md is named and success withdrawn" ;;
  *) no "an unreachable skill went unreported: $status" ;;
esac

# the same for an agent that is a directory instead of a flat .md
# file — discovery reads agents/<name>.md and does not recurse.
lost_agent="$tmp/lost-agent"
plugin_copy "$lost_agent"
mkdir -p "$lost_agent/agents/nested"
status="$(run_hook "$lost_agent" "$empty_project" >"$tmp/lost-agent.json" && hook_status "$tmp/lost-agent.json")"
case "$status" in
  *"agent not reachable: nested"*"FAILED"*) ok "an agent that is not a flat .md file is named and success withdrawn" ;;
  *"FAILED"*"agent not reachable: nested"*) ok "an agent that is not a flat .md file is named and success withdrawn" ;;
  *) no "an unreachable agent went unreported: $status" ;;
esac

# an agent's own directory, <name>/ beside <name>.md, is not a lost agent:
# it holds the skills that agent preloads, and those reach a session through
# plugin.json's skills paths. The skill inside is counted like any other.
own_dir="$tmp/agent-own-dir"
plugin_copy "$own_dir"
mkdir -p "$own_dir/agents/keeper/skills/ledger"
printf -- '---\nname: ledger\ndescription: x\n---\n' >"$own_dir/agents/keeper/skills/ledger/SKILL.md"
printf -- '---\nname: keeper\ndescription: x\n---\n' >"$own_dir/agents/keeper.md"
before_skills=$real_skills
own_project="$tmp/agent-own-project"
project_repo "$own_project"
status="$(run_hook "$own_dir" "$own_project" >"$tmp/own-dir.json" && hook_status "$tmp/own-dir.json")"
case "$status" in
  *"not reachable"*) no "an agent's own directory was mistaken for a lost agent: $status" ;;
  "Athena self-check: $((before_skills + 1)) skills and $((real_agents + 1)) agents reachable; rulebook delivered; push guard set; no problems.")
    ok "an agent's own directory carries its skill into the count and is no defect" ;;
  *) no "unexpected status for an agent with its own directory: $status" ;;
esac

# that exception is bounded: a skill directory under an agent that lost its
# SKILL.md is as invisible as one under skills/, and is named the same way.
own_lost="$tmp/agent-own-lost"
plugin_copy "$own_lost"
mkdir -p "$own_lost/agents/keeper/skills/orphan"
printf -- '---\nname: keeper\ndescription: x\n---\n' >"$own_lost/agents/keeper.md"
status="$(run_hook "$own_lost" "$empty_project" >"$tmp/own-lost.json" && hook_status "$tmp/own-lost.json")"
case "$status" in
  *"skill without SKILL.md: orphan;"*"FAILED"*) ok "an agent's skill directory without SKILL.md is named and success withdrawn" ;;
  *"FAILED"*"skill without SKILL.md: orphan;"*) ok "an agent's skill directory without SKILL.md is named and success withdrawn" ;;
  *) no "an unreachable agent skill went unreported: $status" ;;
esac

# with the rulebook gone there is nothing to deliver, and the status
# has to say so rather than report success.
no_rulebook="$tmp/no-rulebook"
plugin_copy "$no_rulebook"
rm -f "$no_rulebook/CLAUDE.md"
status="$(run_hook "$no_rulebook" "$empty_project" >"$tmp/no-rulebook.json" && hook_status "$tmp/no-rulebook.json")"
case "$status" in
  *"rulebook missing"*"FAILED"*) ok "a missing CLAUDE.md is named and success withdrawn" ;;
  *) no "a missing rulebook went unreported: $status" ;;
esac

echo
echo "=== the push guard"

# in a project with no hooks of its own the guard is taken over.
guard_project="$tmp/guard-project"
project_repo "$guard_project"
run_hook "$happy_plugin" "$guard_project" >/dev/null
[ "$(git -C "$guard_project" config core.hooksPath)" = "$happy_plugin/.githooks" ]
check $? "core.hooksPath points at the plugin's guard"

# a project that manages its own git hooks — husky, lefthook,
# pre-commit — keeps them. Taking core.hooksPath over would silently delete
# every one of them from the next session start onwards.
own_hooks="$tmp/own-hooks"
project_repo "$own_hooks"
git -C "$own_hooks" config core.hooksPath .husky
status="$(run_hook "$happy_plugin" "$own_hooks" >"$tmp/own-hooks.json" && hook_status "$tmp/own-hooks.json")"
[ "$(git -C "$own_hooks" config core.hooksPath)" = ".husky" ]
check $? "a project's own core.hooksPath is left in place"

case "$status" in
  *"project's own hooks at .husky left in place"*"FAILED"*)
    ok "leaving the guard unset is reported as a missing guard, naming the value left alone" ;;
  *) no "an unguarded project reported no problem: $status" ;;
esac

# a project that is no git repository cannot be pushed from, so an
# absent guard there is a note, not a failure.
not_a_repo="$tmp/not-a-repo"
mkdir -p "$not_a_repo"
status="$(run_hook "$happy_plugin" "$not_a_repo" >"$tmp/not-a-repo.json" && hook_status "$tmp/not-a-repo.json")"
case "$status" in
  *"push guard n/a (project is not a git repository)"*"no problems.") ok "outside a git repository the guard is n/a, not a failure" ;;
  *) no "a non-repository project was misreported: $status" ;;
esac

# what the guard is for. With core.hooksPath set the way the hook
# sets it, a push to the default branch is refused by exit code and the
# remote branch is not created; a push to any other branch still succeeds.
remote="$tmp/remote.git"
git init -q --bare -b main "$remote"
git -C "$guard_project" remote add origin "$remote"

git -C "$guard_project" push -q origin main >/dev/null 2>&1
[ $? -ne 0 ]
check $? "a push to main is refused"

git -C "$remote" rev-parse --verify main >/dev/null 2>&1
[ $? -ne 0 ]
check $? "the refused push did not create main on the remote"

git -C "$guard_project" checkout -q -b feature
git -C "$guard_project" push -q origin feature >/dev/null 2>&1
check $? "a push to a branch that is not the default branch succeeds"

echo
if [ "$failed" -eq 0 ]; then
  echo "PASS: $passed cases"
else
  echo "FAIL: $failed of $((passed + failed)) cases"
  exit 1
fi
