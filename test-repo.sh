#!/bin/bash
# Facts about the repository itself that no other suite owns. Exit 0 = all
# cases pass.
set -u

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

passed=0
failed=0

ok() { passed=$((passed + 1)); echo "  ok   — $1"; }
no() { failed=$((failed + 1)); echo "  FAIL — $1"; }

echo "=== the licence"

# Every place that names a licence names the one in LICENSE. Three of them
# said Apache 2.0 over a GPL-3 LICENSE file, each drifting on its own,
# because nothing compared them.
declare -a claims=(
  ".claude-plugin/plugin.json"
  "tools/argus/package.json"
  "README.md"
)

if head -2 "$root/LICENSE" | grep -q "GNU GENERAL PUBLIC LICENSE"; then
  if head -3 "$root/LICENSE" | grep -q "Version 3"; then
    ok "LICENSE is the GNU GPL version 3"
  else
    no "LICENSE is a GNU GPL, but not version 3"
  fi
else
  no "LICENSE is not the GNU GPL — the cases below assume it is"
fi

for file in "${claims[@]}"; do
  if grep -q "GPL-3.0-or-later" "$root/$file"; then
    ok "$file names GPL-3.0-or-later"
  else
    no "$file does not name GPL-3.0-or-later: $(grep -io 'apache[^",]*\|gpl[^",]*' "$root/$file" | head -1)"
  fi
done

# The other direction: no file anywhere claims a licence LICENSE is not.
# The record of past runs under docs/issues/ is out of scope, the way *.sh
# already is: those documents quote this suite — the sentence above about
# three files drifting is itself quoted in one of them — and a quotation is
# not a claim. Nothing there sets the project's licence anyway.
strays="$(grep -rln 'Apache' "$root" \
  --include='*.md' --include='*.json' --include='*.mjs' --include='*.yaml' \
  --exclude='package-lock.json' --exclude-dir=node_modules \
  --exclude-dir=issues 2>/dev/null || true)"
if [ -z "$strays" ]; then
  ok "no file claims the Apache licence"
else
  no "these files still claim the Apache licence:"
  echo "$strays" | sed 's/^/       /'
fi

echo
echo "=== no repository-local rule reaches an agent"

# `.claude/rules/` is not shipped with the plugin, so anything it delivers
# exists in this checkout and nowhere else. An unscoped page loads at launch
# and is inherited by every subagent the session dispatches, which would give
# an agent working here rules it never holds in a project that installed
# uroboros. `paths:` frontmatter is what stops that: inheritance passes on the
# launch context alone, and a scoped page is not in it.
rules_unscoped=""
for page in "$root"/.claude/rules/*.md; do
  [ -e "$page" ] || continue
  if ! head -1 "$page" | grep -q '^---$' || ! sed -n '2,/^---$/p' "$page" | grep -q '^paths:'; then
    rules_unscoped="${rules_unscoped} $(basename "$page")"
  fi
done
if [ -z "$rules_unscoped" ]; then
  ok "every page in .claude/rules/ is path-scoped, so no subagent inherits one"
else
  no "unscoped rule pages would reach every subagent in this checkout alone:$rules_unscoped"
fi

# Scoping is only half the bargain. The page still has to reach whoever opens
# the files it governs — a reader loads it on its own reads, subagents
# included — and a pattern that matches nothing loads for nobody while looking
# deliberate. `agent/**` for `agents/` would read as scoping and be a deleted
# rule. So every pattern has to name files that exist.
scope_tmp="$(mktemp -d)"
cat >"$scope_tmp/scope.js" <<'JS'
const fs = require("fs"), path = require("path");
const root = process.argv[2];
const tracked = fs.readFileSync(process.argv[3], "utf8").split("\n").filter(Boolean);
const dir = path.join(root, ".claude/rules");
const unquote = (s) => s.trim().replace(/^["']|["']$/g, "");
const problems = [];
for (const page of fs.readdirSync(dir).filter((f) => f.endsWith(".md"))) {
  const fm = (fs.readFileSync(path.join(dir, page), "utf8").match(/^---\n([\s\S]*?)\n---/) || [])[1] || "";
  const lines = fm.split("\n");
  const at = lines.findIndex((l) => /^paths:/.test(l));
  if (at < 0) { problems.push(page + ": no paths:"); continue; }
  const patterns = [];
  const inline = unquote(lines[at].replace(/^paths:/, ""));
  if (inline) patterns.push(inline);
  for (let i = at + 1; i < lines.length && /^\s*-\s/.test(lines[i]); i++) {
    patterns.push(unquote(lines[i].replace(/^\s*-\s*/, "")));
  }
  if (!patterns.length) { problems.push(page + ": paths: is empty"); continue; }
  for (const p of patterns) {
    const rx = new RegExp("^" + p
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*+/g, (m) => (m.length > 1 ? ".*" : "[^/]*")) + "$");
    if (!tracked.some((f) => rx.test(f))) problems.push(page + ": " + p + " matches no tracked file");
  }
}
if (problems.length) { console.error(problems.join("; ")); process.exit(1); }
JS
git -C "$root" ls-files >"$scope_tmp/tracked.txt"
node "$scope_tmp/scope.js" "$root" "$scope_tmp/tracked.txt"
scope_status=$?
rm -rf "$scope_tmp"
if [ "$scope_status" -eq 0 ]; then
  ok "every paths: pattern in .claude/rules/ matches files that exist"
else
  no "a paths: pattern matches nothing, so its page loads for nobody"
fi

echo
echo "=== a correction round reuses the handoff it already has"

# The loop used to hand every round its own file — `researcher-1.md`,
# `implementer-2.md` — so an issue directory of a three-round run held twelve
# handoffs and a reader had to work out which copy was current. One role now
# writes one file for the whole run and a later round appends a section to it,
# so no prompt in the loop may build a round-suffixed handoff name again.
suffixed="$(grep -n -- '-\${round}\.md\|-<X>\.md' \
  "$root"/workflows/*.js "$root"/agents/*.md "$root"/skills/agent-brief/SKILL.md 2>/dev/null || true)"
if [ -z "$suffixed" ]; then
  ok "no round-suffixed handoff file name is left in the loop or the agent pages"
else
  no "these lines still name a per-round handoff file:"
  echo "$suffixed" | sed 's/^/       /'
fi

# The other direction: the loop has to say what a correction round does with
# the file instead, or every agent decides for itself and some overwrite it.
if grep -q 'Append a .*## Round' "$root/workflows/loop.js"; then
  ok "the loop tells a correction round to append its section"
else
  no "the loop no longer tells a correction round to append its section"
fi

# Same bargain in the incremental loop, where the section names an increment
# as well as a round.
if grep -q 'Append a .*## Increment\|Append a .*heading(' "$root/workflows/agile-loop.js"; then
  ok "the incremental loop tells every dispatch to append its section"
else
  no "the incremental loop no longer tells a dispatch to append its section"
fi

echo
echo "=== the two workflows coexist"

# `loop` and `agile-loop` are two files rather than one with a switch, and the
# plugin ships the directory, so a new one is live the moment it is written —
# including one that does not parse. A workflow script is only ever compiled at
# dispatch, minutes into a run, so nothing else in this repository would catch
# a syntax error before an agent chain had already been paid for. Compiling
# them here is that check: `new AsyncFunction` parses the body without running
# a line of it.
node -e '
  const fs = require("fs"), path = require("path");
  const root = process.argv[1];
  const dir = path.join(root, "workflows");
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const problems = [];
  const names = new Map();
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".js")).sort();
  for (const file of files) {
    const src = fs.readFileSync(path.join(dir, file), "utf8");
    // Top-level `return` and `await` are what the workflow runtime gives a
    // script, so the body only parses inside an async function — and `export`
    // only parses outside one. Trading the keyword away leaves the syntax the
    // check is for.
    try { new AsyncFunction(src.replace(/^export const meta =/m, "const meta =")); }
    catch (e) { problems.push(file + " does not parse: " + e.message); continue; }
    const meta = /export const meta = \{[\s\S]*?\bname:\s*.([\w-]+)./.exec(src);
    if (!meta) { problems.push(file + ": no meta.name"); continue; }
    if (names.has(meta[1])) problems.push(meta[1] + " is declared by " + names.get(meta[1]) + " and " + file);
    names.set(meta[1], file);
  }
  for (const wanted of ["loop", "agile-loop"]) {
    if (!names.has(wanted)) problems.push("no workflow declares the name " + wanted);
  }
  if (problems.length) { console.error(problems.join("; ")); process.exit(1); }
' "$root"
if [ $? -eq 0 ]; then
  ok "every workflow script parses and declares its own name, loop and agile-loop among them"
else
  no "a workflow script does not parse, or two of them claim one name"
fi

# Parsing is not enough to be loadable. The loader reads `meta` with a parser
# instead of running it, and rejects the whole script when any value there is
# built rather than written out — a description joined from two strings is a
# `BinaryExpression`, and the workflow it names then resolves nowhere. That
# failure is invisible from the file: it parses, the suite above passes, and
# only a dispatch months later reports the name as unknown. `agile-loop`
# shipped that way. So the values are checked for being literal, here, where a
# wrapped line is cheap to fix.
node -e '
  const fs = require("fs"), path = require("path");
  const dir = path.join(process.argv[1], "workflows");
  const APOS = String.fromCharCode(39);
  const TICK = String.fromCharCode(96);
  const QUOTES = "\"" + APOS + TICK;
  // The two string forms a meta value may take, so they can be removed before
  // what is left is judged. Built here rather than written out, because the
  // pattern needs the very quote characters this script cannot spell.
  const STRINGS = new RegExp(
    APOS + "(?:[^" + APOS + "\\\\]|\\\\.)*" + APOS + "|\"(?:[^\"\\\\]|\\\\.)*\"",
    "g",
  );
  const problems = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".js")).sort()) {
    const src = fs.readFileSync(path.join(dir, file), "utf8");
    const start = src.indexOf("export const meta = {");
    if (start < 0) { problems.push(file + ": no meta object literal"); continue; }
    // Brace matching, blind to braces inside strings, gives the object source
    // without a parser this repository does not depend on.
    let depth = 0, end = -1, quote = null;
    for (let i = src.indexOf("{", start); i < src.length; i++) {
      const c = src[i];
      if (quote) { if (c === "\\") i++; else if (c === quote) quote = null; continue; }
      if (QUOTES.indexOf(c) >= 0) { quote = c; continue; }
      if (c === "{") depth++;
      else if (c === "}" && --depth === 0) { end = i; break; }
    }
    if (end < 0) { problems.push(file + ": meta object is not closed"); continue; }
    // What may remain once every literal and key is taken out is punctuation
    // and nothing else. A leftover plus sign, backtick or bracket pair is the
    // build the loader refuses; a leftover word is a variable it cannot
    // resolve either.
    const rest = src
      .slice(start, end + 1)
      .replace(/\/\/[^\n]*/g, "")
      .replace(STRINGS, "")
      .replace(/^export const meta =/, "")
      .replace(/[A-Za-z_$][\w$]*\s*:/g, "")
      .replace(/\b(?:true|false|null|\d+(?:\.\d+)?)\b/g, "")
      .trim();
    if (!/^[\s{}\[\],]*$/.test(rest)) {
      problems.push(file + ": meta is not a pure literal, at " + JSON.stringify(rest.slice(0, 40)));
    }
  }
  if (problems.length) { console.error(problems.join("; ")); process.exit(1); }
' "$root"
if [ $? -eq 0 ]; then
  ok "every workflow declares meta as a pure literal, so the loader registers it"
else
  no "a workflow builds a meta value instead of writing it out; the loader registers nothing"
fi

# The incremental loop is the one that hands an agent a slice of the issue, and
# the rule that makes that safe — the named increment is the whole of what the
# agent is asked for — has to reach the agent, not just the script. The shared
# brief is the only channel that does so in every project alike.
if grep -q 'increment' "$root/skills/agent-brief/SKILL.md"; then
  ok "the shared brief tells an agent what a prompt naming one increment means"
else
  no "nothing in the shared brief bounds an agent to the increment its prompt names"
fi

echo
echo "=== every agent page is declared"

# Agent discovery for a plugin scans `agents/` recursively, so `plugin.json`
# declares the pages instead — and nothing compares the two. A page missing
# from the list is an agent that is simply not there in any session, which the
# workflow calling it discovers only at dispatch.
node -e '
  const fs = require("fs"), path = require("path");
  const root = process.argv[1];
  const declared = JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin/plugin.json"), "utf8")).agents || [];
  const onDisk = fs.readdirSync(path.join(root, "agents")).filter((f) => f.endsWith(".md")).sort();
  const problems = [];
  for (const page of onDisk) {
    if (!declared.includes("./agents/" + page)) problems.push("agents/" + page + " is not declared in plugin.json");
  }
  for (const entry of declared) {
    if (!fs.existsSync(path.join(root, entry))) problems.push(entry + " is declared but does not exist");
  }
  if (problems.length) { console.error(problems.join("; ")); process.exit(1); }
' "$root"
if [ $? -eq 0 ]; then
  ok "plugin.json declares every page in agents/ and nothing that is not there"
else
  no "plugin.json and agents/ disagree about which agents exist"
fi

echo
echo "=== remote operation deploys the collector alone"

# Dockerfile, compose.yaml and render.yaml build and run argus. The interface
# is local only: it is never packaged into the image, never named by the
# blueprint, and the collector no longer carries the files it serves.
node -e '
  const fs = require("fs"), path = require("path");
  const root = process.argv[1];
  const problems = [];
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "tools/argus/package.json"), "utf8"));
  if ((pkg.files || []).includes("public")) problems.push("tools/argus/package.json still ships public/");
  if (fs.existsSync(path.join(root, "tools/argus/public"))) problems.push("tools/argus/public still exists");
  for (const file of ["tools/argus/Dockerfile", "tools/argus/compose.yaml", "render.yaml"]) {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    if (/argus-ui/.test(text)) problems.push(file + " deploys the interface");
    if (/public\//.test(text)) problems.push(file + " still references public/");
  }
  if (problems.length) { console.error(problems.join("; ")); process.exit(1); }
' "$root"
if [ $? -eq 0 ]; then
  ok "the image, the compose file and the blueprint carry the collector and no interface"
else
  no "the deployment still carries the interface"
fi

echo
if [ "$failed" -eq 0 ]; then
  echo "PASS: $passed cases"
else
  echo "FAIL: $failed of $((passed + failed)) cases"
  exit 1
fi
