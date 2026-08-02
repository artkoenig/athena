#!/bin/bash
# Tests for the rulebook as the session's system prompt: the launcher athena
# ships, the two branches of the hook's rulebook check, what the hook still
# puts into the session, and the documents that describe all of it.
#
# Everything runs against scratch copies of the repository. No real session is
# started: a stub `claude` on PATH records how the launcher invoked it and,
# where a session's context is what is under test, runs the SessionStart hook
# the way a session would. Exit 0 = all cases pass.
set -u

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

passed=0
failed=0

ok() { passed=$((passed + 1)); echo "  ok   — $1"; }
no() { failed=$((failed + 1)); echo "  FAIL — $1"; }
check() { if [ "$1" = "0" ]; then ok "$2"; else no "$2"; fi; }

# A case whose verdict is a node script: it exits non-zero and writes what is
# wrong, which is then the failure line instead of a stack trace.
node_check() {
  local msg="$1" out
  shift
  if out="$(node "$@" 2>&1)"; then
    ok "$msg"
  else
    no "$msg"
    printf '%s\n' "$out" | grep -v '^ *at \|^Node.js\|^ *\^' | head -5 | sed 's/^/       /'
  fi
}

mkdir -p "$tmp/home"

# --------------------------------------------------------------------------
# Finding what the repository ships, without assuming what it is called.
# The names of the launcher and of the rulebook file are the change's own
# choice; these tests identify both by what they are.
# --------------------------------------------------------------------------

# A scratch copy of the whole working tree, free to mutate. The working tree
# rather than the index: a launcher that is written but not yet added is still
# the launcher this suite is about.
copy_tree() {
  local dest="$1"
  mkdir -p "$dest"
  (cd "$root" && tar -cf - --exclude=.git --exclude=node_modules .) | (cd "$dest" && tar -xf -)
}

# The rulebook is the page that carries athena's run. Its headings are what
# identify it — assembled here at run time so this file is not itself a match.
rulebook_of() {
  local base="$1" h='## '
  find "$base" -name '*.md' \
    -not -path '*/.git/*' -not -path '*/node_modules/*' -not -path '*/docs/issues/*' \
    -print0 2>/dev/null |
  while IFS= read -r -d '' f; do
    grep -qF "${h}The run" "$f" || continue
    grep -qF "${h}The shelf" "$f" || continue
    grep -qF "${h}Bookkeeping" "$f" || continue
    echo "$f"
  done
}

# The launcher is the script this repository ships to start a session. The
# suites, the git hooks and the tools have their own homes and are not it.
launcher_of() {
  local base="$1"
  find "$base" -type f \
    -not -path '*/.git/*' -not -path '*/node_modules/*' \
    -not -path '*/hooks/*' -not -path '*/.githooks/*' \
    -not -path '*/tools/*' -not -path '*/docs/*' \
    -not -name 'test*.sh' \
    -print0 2>/dev/null |
  while IFS= read -r -d '' f; do
    head -c 2 "$f" 2>/dev/null | grep -q '#!' || continue
    grep -qE '(^|[^[:alnum:]_./-])claude([^[:alnum:]_.-]|$)' "$f" || continue
    echo "$f"
  done
}

# --------------------------------------------------------------------------
# The stub `claude`, and how a launch is run.
# --------------------------------------------------------------------------

stub_dir="$tmp/stub"
mkdir -p "$stub_dir"
cat >"$stub_dir/claude" <<'STUB'
#!/bin/bash
# Stands in for the real `claude`. It records its arguments NUL-separated, and
# runs the plugin's SessionStart hook with the environment it was started in —
# which is the environment the launcher handed to `claude`.
set -u
: >"$STUB_ARGV"
for a in "$@"; do printf '%s\0' "$a" >>"$STUB_ARGV"; done
if [ -n "${STUB_HOOK_OUT:-}" ] && [ -f "${STUB_PLUGIN_ROOT:-}/hooks/session-start.sh" ]; then
  CLAUDE_PLUGIN_ROOT="$STUB_PLUGIN_ROOT" CLAUDE_PROJECT_DIR="$STUB_PROJECT_DIR" \
    bash "$STUB_PLUGIN_ROOT/hooks/session-start.sh" >"$STUB_HOOK_OUT" 2>/dev/null
fi
exit 0
STUB
chmod +x "$stub_dir/claude"

# Set before each launch: where it is run from, and what the stub should stand
# in for.
L_CWD="$tmp"
L_PLUGIN=""
L_PROJECT=""

argv_file="$tmp/argv"
launch_hook_out="$tmp/launched-hook.json"
: >"$argv_file"
: >"$launch_hook_out"

# Runs the launcher the way a human would, with nothing of this suite's own
# environment carried in: whatever reaches `claude` was put there by the
# launcher itself. That matters — this suite must not hand the hook the very
# signal it is checking for.
launch() {
  local launcher="$1"
  shift
  : >"$argv_file"
  : >"$launch_hook_out"
  (
    cd "$L_CWD" || exit 1
    if [ -x "$launcher" ]; then set -- "$launcher" "$@"; else set -- bash "$launcher" "$@"; fi
    env -i \
      PATH="$stub_dir:$PATH" HOME="$tmp/home" TERM=dumb \
      STUB_ARGV="$argv_file" STUB_HOOK_OUT="$launch_hook_out" \
      STUB_PLUGIN_ROOT="$L_PLUGIN" STUB_PROJECT_DIR="$L_PROJECT" \
      "$@"
  )
}

# A session started with `claude` directly: the plugin is active, so the hook
# runs, but nothing the launcher would have set is in the environment.
run_hook_plain() {
  local plugin="$1" project="$2"
  env -i PATH="$PATH" HOME="$tmp/home" TERM=dumb \
    CLAUDE_PLUGIN_ROOT="$plugin" CLAUDE_PROJECT_DIR="$project" \
    bash "$plugin/hooks/session-start.sh" 2>/dev/null
}

hook_context() {
  node -e '
    const out = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    process.stdout.write(out.hookSpecificOutput.additionalContext);
  ' "$1" 2>/dev/null
}

hook_status() {
  hook_context "$1" | grep '^Athena self-check:' | tail -1
}

# A scratch git repository standing in for a project a session runs in.
project_repo() {
  local dest="$1" branch="${2:-main}"
  mkdir -p "$dest"
  git -C "$dest" init -q -b "$branch"
  git -C "$dest" config user.email test@example.com
  git -C "$dest" config user.name test
  echo hello >"$dest/file.txt"
  git -C "$dest" add file.txt
  git -C "$dest" commit -qm init
}

# --------------------------------------------------------------------------
echo "=== the launcher"

launchers="$(launcher_of "$root")"
launcher_count="$(printf '%s' "$launchers" | grep -c . || true)"
launcher="$(printf '%s\n' "$launchers" | head -1)"

if [ "$launcher_count" = "1" ] && [ -x "$launcher" ]; then
  ok "the repository ships exactly one launcher, and it is executable"
elif [ "$launcher_count" = "1" ]; then
  no "the launcher is not executable: $launcher"
elif [ "$launcher_count" = "0" ]; then
  no "no launcher found: no executable script outside the suites, the hooks and tools/ starts claude"
else
  no "more than one launcher found:"
  printf '%s\n' "$launchers" | sed 's/^/       /'
fi

# Two copies with different rulebooks: every case below can then say which
# copy the system prompt came from.
copy_a="$tmp/copy-a"
copy_b="$tmp/copy-b"
copy_tree "$copy_a"
copy_tree "$copy_b"
rulebook_a="$(rulebook_of "$copy_a" | head -1)"
rulebook_b="$(rulebook_of "$copy_b" | head -1)"
if [ -n "$rulebook_b" ]; then printf '\nCOPY-B-MARKER-7731\n' >>"$rulebook_b"; fi
launcher_a="$(launcher_of "$copy_a" | head -1)"
launcher_b="$(launcher_of "$copy_b" | head -1)"

project="$tmp/project"
project_repo "$project" main
L_PLUGIN="$copy_a"
L_PROJECT="$project"
L_CWD="$project"

# how a system prompt reaches `claude`: the flag that replaces the default
# prompt carries the rulebook, and none of the appending flags does. Appending
# would leave Claude Code's own prompt in place, which is exactly what the
# change drops. That the replacement really leaves no default section behind
# can only be seen in a live session, and is not asserted here.
system_prompt_check() {
  node -e '
    const fs = require("fs");
    if (!fs.existsSync(process.argv[2])) { console.error("no rulebook file found in the tree"); process.exit(1); }
    const argv = fs.readFileSync(process.argv[1], "utf8").split("\0");
    if (argv.length && argv[argv.length - 1] === "") argv.pop();
    const want = fs.readFileSync(process.argv[2], "utf8").trim();
    const problems = [];
    const valueOf = (i, flag) => {
      const a = argv[i];
      if (a === flag) return argv[i + 1];
      if (a.startsWith(flag + "=")) return a.slice(flag.length + 1);
      return undefined;
    };
    let carried = null;
    for (let i = 0; i < argv.length; i++) {
      for (const flag of ["--system-prompt", "--system-prompt-file", "--append-system-prompt", "--append-system-prompt-file"]) {
        const v = valueOf(i, flag);
        if (v === undefined) continue;
        const text = flag.endsWith("-file")
          ? (fs.existsSync(v) ? fs.readFileSync(v, "utf8") : "")
          : v;
        if (text.trim() === want) carried = flag;
      }
    }
    if (!carried) problems.push("no argument carries the rulebook text as a system prompt");
    else if (carried.startsWith("--append")) problems.push("the rulebook is appended to the default prompt via " + carried);
    if (problems.length) { console.error(problems.join("; ")); process.exit(1); }
  ' "$1" "$2" 2>&1 | head -3
}

if [ -n "$launcher_a" ]; then launch "$launcher_a" >/dev/null 2>&1; fi
out="$(system_prompt_check "$argv_file" "${rulebook_a:-/nonexistent}")"
if [ -z "$out" ]; then
  ok "the launcher starts claude with the rulebook as the session's system prompt, not appended to the default one"
else
  no "the launcher does not replace the default system prompt with the rulebook: $out"
fi

# every argument reaches `claude`, in the order it was given, with the
# spaces and the empty one intact.
if [ -n "$launcher_a" ]; then
  launch "$launcher_a" --model opus "two words" "" -p "last" >/dev/null 2>&1
fi
node_check "every argument is passed through to claude, in order, spaces and the empty one intact" -e '
  const fs = require("fs");
  const argv = fs.readFileSync(process.argv[1], "utf8").split("\0");
  if (argv.length && argv[argv.length - 1] === "") argv.pop();
  const want = ["--model", "opus", "two words", "", "-p", "last"];
  const at = argv.findIndex((_, i) => want.every((w, j) => argv[i + j] === w));
  if (at < 0) { console.error("the arguments given to the launcher are not in what reached claude: " + JSON.stringify(argv)); process.exit(1); }
' "$argv_file"

# with no arguments at all the launcher still starts a session — the
# boundary of the pass-through, not a special case.
if [ -n "$launcher_a" ]; then launch "$launcher_a" >/dev/null 2>&1; fi
node_check "with no arguments the launcher still starts claude" -e '
  const fs = require("fs");
  const argv = fs.readFileSync(process.argv[1], "utf8").split("\0");
  if (argv.length && argv[argv.length - 1] === "") argv.pop();
  if (!argv.length) { console.error("claude was not started, or was started with no arguments at all"); process.exit(1); }
' "$argv_file"

# the launcher resolves its own location: run from inside another copy of
# the repository, it must still use its own copy's rulebook. Copy B's rulebook
# carries a marker; copy A's launcher may not deliver it.
L_CWD="$copy_b"
L_PLUGIN="$copy_a"
if [ -n "$launcher_a" ]; then launch "$launcher_a" >/dev/null 2>&1; fi
out="$(system_prompt_check "$argv_file" "${rulebook_a:-/nonexistent}")"
if [ -z "$out" ] && ! grep -qa 'COPY-B-MARKER-7731' "$argv_file"; then
  ok "run from inside another copy, the launcher still uses its own copy's rulebook"
else
  no "the launcher took the rulebook from the current directory: ${out:-the marker of copy B reached claude}"
fi

# the same through a symlink on PATH, which is how a launcher gets
# installed: "always the same copy" has to hold when the name a human types is
# not the file itself.
mkdir -p "$tmp/bin"
if [ -n "$launcher_a" ]; then
  ln -sf "$launcher_a" "$tmp/bin/$(basename "$launcher_a")"
  L_CWD="$copy_b"
  launch "$tmp/bin/$(basename "$launcher_a")" >/dev/null 2>&1
fi
out="$(system_prompt_check "$argv_file" "${rulebook_a:-/nonexistent}")"
if [ -z "$out" ] && ! grep -qa 'COPY-B-MARKER-7731' "$argv_file"; then
  ok "invoked through a symlink, the launcher still uses its own copy's rulebook"
else
  no "through a symlink the launcher did not find its own rulebook: ${out:-the marker of copy B reached claude}"
fi

echo
echo "=== the rulebook file"

# the rulebook text exists once and under a name Claude Code does not load
# as project memory — a second copy, or a name that is loaded, is the double
# context this change removes. The forbidden names are the ones the CLI reads
# by itself: CLAUDE.md, its local variant, AGENTS.md, and anything under
# .claude/, whose rules pages load the same way.
node_check "the rulebook text exists exactly once, under a name Claude Code does not load as project memory" -e '
  const fs = require("fs"), path = require("path");
  const root = process.argv[1], rulebook = process.argv[2];
  if (!rulebook) { console.error("no rulebook file found in the tree"); process.exit(1); }
  const text = fs.readFileSync(rulebook, "utf8").trim();
  const memory = new Set(["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", "AGENTS.local.md"]);
  const holders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.isFile()) continue;
      let body;
      try { body = fs.readFileSync(p, "utf8"); } catch { continue; }
      if (body.includes(text)) holders.push(path.relative(root, p));
    }
  };
  walk(root);
  const problems = [];
  if (holders.length !== 1) problems.push("the rulebook text is in " + holders.length + " file(s): " + holders.join(", "));
  for (const h of holders) {
    if (memory.has(path.basename(h))) problems.push("the rulebook is at " + h + ", a name Claude Code loads as project memory");
    if (h.split(path.sep)[0] === ".claude") problems.push("the rulebook is at " + h + ", which Claude Code loads by itself");
  }
  if (problems.length) { console.error(problems.join("; ")); process.exit(1); }
' "$root" "$(rulebook_of "$root" | head -1)"

# what the dropped default prompt was still needed for. Two of the five
# things the criterion names have words of their own and are asserted here: a
# denied tool call, and that a slash name invokes a skill. The other three —
# the opening, the tool preferences, how output reaches the human — are
# wording, and a test for them would only be a guess at phrasing.
node_check "the rulebook says what a denied tool call means and that /<name> invokes a skill" -e '
  const fs = require("fs");
  const rulebook = process.argv[1];
  if (!rulebook) { console.error("no rulebook file found in the tree"); process.exit(1); }
  const text = fs.readFileSync(rulebook, "utf8");
  const sentences = text.split(/\n\s*\n/).map(p => p.replace(/\s+/g, " ")).flatMap(p => p.split(/(?<=[.!?])["’”)]*\s+/));
  const problems = [];
  if (!sentences.some(s => /\b(denied|deny|denies)\b/i.test(s) && /\btools?\b|\bpermission/i.test(s)))
    problems.push("nothing says what a denied tool call means");
  if (!sentences.some(s => (/\/<name>/.test(s) || /`\/[A-Za-z<]/.test(s)) && /\bskill/i.test(s)))
    problems.push("nothing says that /<name> invokes a skill");
  if (problems.length) { console.error(problems.join("; ")); process.exit(1); }
' "$(rulebook_of "$root" | head -1)"

echo
echo "=== the session knows whether it has the rulebook"

hook_project="$tmp/hook-project"
project_repo "$hook_project" main

# started through the launcher, the session has the rulebook, and the
# self-check says so without withdrawing success.
L_CWD="$hook_project"
L_PLUGIN="$copy_a"
L_PROJECT="$hook_project"
if [ -n "$launcher_a" ]; then launch "$launcher_a" >/dev/null 2>&1; fi
status="$(hook_status "$launch_hook_out")"
case "$status" in
  "") no "a launcher-started session produced no self-check status" ;;
  *FAILED*) no "a launcher-started session was reported as failing: $status" ;;
  *[Rr]ulebook*) ok "a launcher-started session is reported as having the rulebook, success intact" ;;
  *) no "the status of a launcher-started session says nothing about the rulebook: $status" ;;
esac

# started with `claude` directly the session has no rulebook at all —
# neither as a system prompt nor from the hook. It has to be told, and success
# withdrawn: a run on rules it does not have is worse than no run.
plain_project="$tmp/plain-project"
project_repo "$plain_project" main
run_hook_plain "$copy_a" "$plain_project" >"$tmp/plain.json"
status="$(hook_status "$tmp/plain.json")"
case "$status" in
  "") no "a plain claude session produced no self-check status" ;;
  *[Rr]ulebook*FAILED*|*FAILED*[Rr]ulebook*) ok "a plain claude session is told it has no rulebook, and success is withdrawn" ;;
  *) no "a plain claude session was not told that it has no rulebook: $status" ;;
esac

echo
echo "=== what the hook still puts into the session"

env_project="$tmp/env-project"
project_repo "$env_project" athena-branch-9271
run_hook_plain "$copy_a" "$env_project" >"$tmp/env.json"
context="$(hook_context "$tmp/env.json")"

# the rulebook text is not in there any more — it is the system prompt now,
# and a second copy in the first user message is the duplication this change
# removes.
printf '%s' "$context" >"$tmp/env-context.txt"
node_check "additionalContext no longer carries the rulebook text" -e '
  const fs = require("fs");
  const ctx = fs.readFileSync(process.argv[1], "utf8"), rulebook = process.argv[2];
  if (!rulebook) { console.error("no rulebook file found in the tree"); process.exit(1); }
  const text = fs.readFileSync(rulebook, "utf8");
  const chunks = text.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 60);
  const leaked = chunks.filter(c => ctx.includes(c));
  if (leaked.length) { console.error(leaked.length + " passage(s) of the rulebook are still in additionalContext"); process.exit(1); }
' "$tmp/env-context.txt" "$(rulebook_of "$root" | head -1)"

# what it carries instead: the status line, and an environment block with
# where the session is, whether that is a git repository, and which branch it
# is on. The branch is named at run time here, so nothing but the hook can
# have produced it.
problems=""
case "$context" in *"Athena self-check:"*) ;; *) problems="${problems} there is no self-check status line;";; esac
case "$context" in *"$env_project"*) ;; *) problems="${problems} the working directory is not named;";; esac
case "$context" in *athena-branch-9271*) ;; *) problems="${problems} the current branch is not named;";; esac
if ! printf '%s' "$context" | grep -qi 'git'; then problems="${problems} nothing says whether it is a git repository;"; fi
if [ -z "$problems" ]; then
  ok "additionalContext carries the status line and an environment block: directory, git repository, branch"
else
  no "additionalContext is missing part of what it has to carry:$problems"
fi

# outside a git repository there is no branch to name, and the block still
# has to say where the session is and that this is no repository.
plain_dir="$tmp/no-repo"
mkdir -p "$plain_dir"
run_hook_plain "$copy_a" "$plain_dir" >"$tmp/no-repo.json"
context="$(hook_context "$tmp/no-repo.json")"
problems=""
case "$context" in *"$plain_dir"*) ;; *) problems="${problems} the working directory is not named;";; esac
if ! printf '%s' "$context" | grep -qiE '(not|no)[^\n]*git repository'; then
  problems="${problems} nothing says that this is not a git repository;"
fi
if [ -z "$problems" ]; then
  ok "outside a git repository the block names the directory and says so"
else
  no "the environment block outside a git repository is incomplete:$problems"
fi

# a repository whose first commit is still missing has no branch to report
# either, and must not cost the session its context: stdout stays one valid
# hook object.
unborn="$tmp/unborn"
mkdir -p "$unborn"
git -C "$unborn" init -q -b main
run_hook_plain "$copy_a" "$unborn" >"$tmp/unborn.json"
node_check "a repository without a first commit still gets one valid hook object naming its directory" -e '
  const fs = require("fs");
  let out;
  try { out = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); }
  catch (e) { console.error("stdout is not one valid JSON object: " + e.message); process.exit(1); }
  const problems = [];
  if (!out.hookSpecificOutput || out.hookSpecificOutput.hookEventName !== "SessionStart") problems.push("not a SessionStart hook object");
  const ctx = (out.hookSpecificOutput || {}).additionalContext;
  if (typeof ctx !== "string") problems.push("no additionalContext string");
  else {
    if (!ctx.includes(process.argv[2])) problems.push("the working directory is not named");
    if (!/Athena self-check:/.test(ctx)) problems.push("no self-check status line");
  }
  if (problems.length) { console.error(problems.join("; ")); process.exit(1); }
' "$tmp/unborn.json" "$unborn"

echo
echo "=== what the documents still say"

# no document may still say that the hook delivers the rulebook text, or
# that CLAUDE.md is the rulebook. Two exclusions: the issues under docs/issues/
# state the problem a run is solving, not the current behaviour, and a finding
# that carries a "Since measured" note is history the record already corrects.
node_check "no document says that the hook delivers the rulebook text or that CLAUDE.md is the rulebook" -e '
  const fs = require("fs"), path = require("path");
  const root = process.argv[1];
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (p.endsWith(path.join("docs", "issues"))) continue; walk(p); continue; }
      if (e.isFile() && e.name.endsWith(".md")) files.push(p);
    }
  };
  walk(root);
  const hookWord = /hook|SessionStart|session-start|additionalContext/i;
  const delivers = /(deliver|put|puts|push|pushes|carr|hand|hands|inject)\w*[^.!?]{0,120}(rulebook|CLAUDE\.md)/i;
  const deliveredTo = /(rulebook|CLAUDE\.md)[^.!?]{0,120}(into|to|in) (the|its|a) (session|context)/i;
  const claimsName = (s) => /CLAUDE\.md/.test(s) && /rulebook|\bthe rules\b/i.test(s);
  const denies = /\bno longer\b|\bnot\b|\bnever\b|\binstead of\b/i;
  // A sentence about the launcher or about the system prompt describes where
  // the rulebook comes from now, not what the hook delivers.
  const newPath = /launcher|system prompt/i;
  const problems = [];
  for (const f of files) {
    const body = fs.readFileSync(f, "utf8");
    for (const section of body.split(/^#{1,6} /m)) {
      if (/Since measured/i.test(section)) continue;
      for (const para of section.split(/\n\s*\n/)) {
        const flat = para.replace(/\s+/g, " ").trim();
        if (!flat) continue;
        const sentences = flat.split(/(?<=[.!?])["’”)]*\s+/);
        for (const s of sentences) {
          if (denies.test(s) || newPath.test(s)) continue;
          if (hookWord.test(flat) && (delivers.test(s) || deliveredTo.test(s)))
            problems.push(path.relative(root, f) + ": " + s.slice(0, 100));
          else if (claimsName(s))
            problems.push(path.relative(root, f) + ": " + s.slice(0, 100));
        }
      }
    }
  }
  if (problems.length) { console.error(problems.join("\n       ")); process.exit(1); }
' "$root"

echo
if [ "$failed" -eq 0 ]; then
  echo "PASS: $passed cases"
else
  echo "FAIL: $failed of $((passed + failed)) cases"
  exit 1
fi
