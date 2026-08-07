#!/bin/bash
# Tests for bin/check-commit-signing: the two outcomes it must tell apart —
# signing legitimately not configured for this run, and signing configured
# but the signed commit failing — and the cleanup it owes on every path,
# success and failure alike. Nothing here fakes what the checker really
# does: it runs as a real process against a real git. What is fabricated is
# the signer program and the git configuration it reads.
#
# Every case points the checker at its own throwaway sandbox checkout,
# reached through a symlink at <case>/checkout/bin/check-commit-signing, and
# every git the suite itself runs strips the ambient git environment
# (GIT_CONFIG_COUNT and friends) and neutralises global/system config the
# same way the checker's own run does. Round 0 of this suite pointed the
# checker at the checkout the suite runs from while only neutralising
# GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM, so a repository-local commit.gpgsign
# in that checkout turned three cases red for an environment setting rather
# than for a broken check — group E below is the go-red guard against that
# happening again. Exit 0 = all cases pass.
set -u

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

passed=0
failed=0

ok() { passed=$((passed + 1)); echo "  ok   — $1"; }
no() { failed=$((failed + 1)); echo "  FAIL — $1"; }
check() { if [ "$1" = "0" ]; then ok "$2"; else no "$2"; fi; }

# The ambient environment variables that would otherwise let one git call's
# configuration leak into another — GIT_CONFIG_COUNT in particular, which
# this container sets to 3 at command-line scope, outranking every config
# file. Held in one array so run_checker and the suite's own git calls can
# never drift apart on what they strip.
unset_env=(
  -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_OBJECT_DIRECTORY
  -u GIT_COMMON_DIR -u GIT_NAMESPACE -u GIT_CEILING_DIRECTORIES
  -u GIT_CONFIG -u GIT_CONFIG_COUNT
  -u GIT_AUTHOR_NAME -u GIT_AUTHOR_EMAIL -u GIT_COMMITTER_NAME -u GIT_COMMITTER_EMAIL
)

# Every git the suite itself runs — fixture creation, local-config writes,
# status and tree snapshots — goes through this, so none of them can inherit
# an ambient template, hook or status setting either.
suite_git() {
  env "${unset_env[@]}" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null git "$@"
}

# A directory listing rather than `git status`, so a path added anywhere
# under the sandbox checkout is caught even if it is one `git status`
# itself would not mention — inside .git included.
tree_of() { find "$1" | LC_ALL=C sort; }

# The three fixture files a case needs are the same shape in every case —
# the key the signer is handed, and the two fake signer programs, one that
# fails the way the misconfigured environment this issue is about failed,
# one that succeeds the way `ssh-keygen -Y sign` would. Every case also gets
# its own sandbox checkout, so the checker is never run against the checkout
# this suite itself lives in.
make_fixtures() {
  local dir="$1"
  mkdir -p "$dir/tmp" "$dir/home"
  printf 'ssh-ed25519 AAAAfake signing-check@example.invalid\n' >"$dir/fake_key.pub"
  cat >"$dir/bad-signer" <<'SCRIPT'
#!/bin/bash
echo 'Key file set to "/home/claude/.ssh/commit_signing_key.pub" (ignored, using server key)' >&2
echo 'signing failed' >&2
exit 1
SCRIPT
  chmod +x "$dir/bad-signer"
  cat >"$dir/good-signer" <<'SCRIPT'
#!/bin/bash
for a in "$@"; do last="$a"; done
printf -- '-----BEGIN SSH SIGNATURE-----\nZmFrZQ==\n-----END SSH SIGNATURE-----\n' >"$last.sig"
SCRIPT
  chmod +x "$dir/good-signer"

  : >"$dir/gitconfig"

  suite_git init -q -b main "$dir/checkout" >/dev/null
  mkdir -p "$dir/checkout/bin"
  ln -s "$root/bin/check-commit-signing" "$dir/checkout/bin/check-commit-signing"
  printf 'dirty\n' >"$dir/checkout/dirty.txt"
}

# Spawns the real checker once under the case's fabricated environment,
# through the symlink in the sandbox checkout's own bin/, and captures its
# combined output and exit code into the caller's $out and $code. Several
# cases below assert on one run rather than paying for the checker again per
# assertion. Invoking through the symlink is what makes the checker's own
# BASH_SOURCE-derived root resolve to the sandbox checkout rather than to
# this repository: bash does not resolve symlinks in BASH_SOURCE, and
# bin/ itself is a real directory, so bin/check-commit-signing's
# `dirname "${BASH_SOURCE[0]}"/..` lands on <case>/checkout.
run_checker() {
  local case_dir="$1"
  out="$(env "${unset_env[@]}" \
    HOME="$case_dir/home" TMPDIR="$case_dir/tmp" \
    GIT_CONFIG_GLOBAL="$case_dir/gitconfig" GIT_CONFIG_SYSTEM=/dev/null \
    bash "$case_dir/checkout/bin/check-commit-signing" 2>&1)"
  code=$?
}

# The first thing the suite does, under the same neutralised environment
# every other git call here uses, so the very last case (F2) can prove the
# suite never wrote into the checkout it runs from.
root_status_before="$(suite_git -C "$root" status --porcelain)"

# One sandbox for the whole suite, with a subdirectory per case, so one
# case's leftovers can never be mistaken for another case's and a single
# trap covers every case this suite ever creates.
sandbox_root="$(mktemp -d)"
trap 'rm -rf "$sandbox_root"' EXIT

echo
echo "=== the check passes over an environment where signing is not configured"

# The ordinary agent environment: no signing key, nothing asking for one.
# The check must not invent a reason to fail here — this is the baseline
# the "legitimately not configured" half of the distinction is judged
# against.
caseA="$sandbox_root/unconfigured"
make_fixtures "$caseA"
cat >"$caseA/gitconfig" <<CONF
[user]
	name = Signing Check
	email = signing-check@example.invalid
CONF
run_checker "$caseA"
outA="$out"; codeA="$code"

if [ "$codeA" = "0" ]; then
  ok "an environment without commit.gpgsign passes the check"
else
  no "an environment without commit.gpgsign passes the check — got code=$codeA out=$outA"
fi

# A check that fails silently, or that stops naming the setting it keyed
# its decision on, is no longer distinguishable from one that is simply
# broken — this is what goes red first if that happens.
if printf '%s' "$outA" | grep -qF -- 'SKIP:' && printf '%s' "$outA" | grep -qF -- 'commit.gpgsign'; then
  ok "the skipped check says why it skipped"
else
  no "the skipped check output does not say SKIP: and name commit.gpgsign: $outA"
fi

# The skip path still has to honour the same no-leftovers promise as every
# other path — it is one of the outcomes "leaves nothing behind" covers.
if [ -z "$(ls -A "$caseA/tmp" 2>/dev/null)" ]; then
  ok "the skipped check leaves no temporary directory behind"
else
  no "the skipped check left files behind in TMPDIR: $(ls -A "$caseA/tmp")"
fi

echo
echo "=== a signing key that is present but not switched on for this run"

# The edge that actually pins the distinction: a developer machine can carry
# a signing key in its global config with signing switched off for this
# run. A checker keyed on user.signingkey being present, or on gpg.format,
# would cry wolf here while case D below still passes — only keying on
# commit.gpgsign itself survives both.
caseB="$sandbox_root/key-present-signing-off"
make_fixtures "$caseB"
cat >"$caseB/gitconfig" <<CONF
[user]
	name = Signing Check
	email = signing-check@example.invalid
	signingkey = $caseB/fake_key.pub
[gpg]
	format = ssh
[gpg "ssh"]
	program = $caseB/bad-signer
[commit]
	gpgsign = false
CONF
run_checker "$caseB"
outB="$out"; codeB="$code"

if [ "$codeB" = "0" ] && printf '%s' "$outB" | grep -qF -- 'SKIP:'; then
  ok "a signing key with commit.gpgsign false is not an environment the check fails"
else
  no "a signing key with commit.gpgsign false failed the check: code=$codeB out=$outB"
fi

echo
echo "=== the check fails loudly when a configured signer cannot sign"

# The failure this whole issue exists for: a signer program that exits 1,
# reproduced with the same key-file complaint and the same "signing
# failed" line a real agent commit hit.
caseC="$sandbox_root/configured-bad"
make_fixtures "$caseC"
cat >"$caseC/gitconfig" <<CONF
[user]
	name = Signing Check
	email = signing-check@example.invalid
	signingkey = $caseC/fake_key.pub
[gpg]
	format = ssh
[gpg "ssh"]
	program = $caseC/bad-signer
[commit]
	gpgsign = true
CONF

# Both snapshots are taken around the single run, on the sandbox checkout the
# checker was actually pointed at rather than on the checkout this suite
# lives in — that is what makes the guard exercise the checker's promise
# instead of standing in as a proxy for it.
statusC_before="$(suite_git -C "$caseC/checkout" status --porcelain)"
treeC_before="$(tree_of "$caseC/checkout")"
run_checker "$caseC"
outC="$out"; codeC="$code"
treeC_after="$(tree_of "$caseC/checkout")"
statusC_after="$(suite_git -C "$caseC/checkout" status --porcelain)"

if [ "$codeC" = "1" ]; then
  ok "a configured signer that cannot sign fails the check"
else
  no "a configured signer that cannot sign returned code=$codeC, not 1 — out=$outC"
fi

# Each substring is its own case so a dropped line names itself instead of
# hiding behind a single "the message looks right" assertion.
if printf '%s' "$outC" | grep -qF -- 'FAIL:'; then
  ok "the failure says FAIL"
else
  no "the failure output does not say FAIL: $outC"
fi

if printf '%s' "$outC" | grep -qF -- "user.signingkey = $caseC/fake_key.pub"; then
  ok "the failure names the signing key"
else
  no "the failure output does not name the signing key: $outC"
fi

if printf '%s' "$outC" | grep -qF -- "gpg.ssh.program = $caseC/bad-signer"; then
  ok "the failure names the signer program"
else
  no "the failure output does not name the signer program: $outC"
fi

if printf '%s' "$outC" | grep -qF -- 'signing failed'; then
  ok "the failure carries what git said"
else
  no "the failure output does not carry what git said: $outC"
fi

# "Leaves nothing behind" is a criterion of its own on the failing path, not
# just the passing ones — a fixture that promises this and still leaves an
# empty directory per run is exactly what this pins.
if [ -z "$(ls -A "$caseC/tmp" 2>/dev/null)" ]; then
  ok "the failing check leaves no throwaway repository behind"
else
  no "the failing check left files behind in TMPDIR: $(ls -A "$caseC/tmp")"
fi

# A checker that leaves a child process running after it reports failure is
# a leak the caller has no way to see; pgrep's absence must be loud rather
# than a silent pass, so the guard reports FAIL naming the missing tool
# instead of skipping the assertion.
if command -v pgrep >/dev/null 2>&1; then
  if [ -z "$(pgrep -f "$caseC" 2>/dev/null)" ]; then
    ok "the failing check leaves no process behind"
  else
    no "a process matching $caseC is still running: $(pgrep -fa "$caseC" 2>/dev/null)"
  fi
else
  no "pgrep is not installed, so a leftover process cannot be ruled out"
fi

# Comparing before with after, rather than expecting an empty status, is
# what makes this survive being run against a sandbox checkout that already
# has uncommitted changes of its own (the seeded dirty.txt).
if [ "$statusC_before" = "$statusC_after" ]; then
  ok "the failing check writes nothing into the repository it was pointed at"
else
  no "the status of the repository the checker was pointed at changed across the run — before=[$statusC_before] after=[$statusC_after]"
fi

# The guard above is worth nothing if it is comparing empty with empty — this
# pins that the seeded untracked file makes status_before non-empty, so the
# comparison actually exercises something.
if [ -n "$statusC_before" ]; then
  ok "the writes-nothing guard compares a status that is not empty"
else
  no "status_before was empty before the run, so the writes-nothing guard above could pass vacuously: [$statusC_before]"
fi

# git status alone would miss a path added outside the index — e.g. into
# .git itself — so this compares a full directory listing, .git included,
# taken between the two status snapshots so the suite's own index refresh
# falls outside what is being compared.
if [ "$treeC_before" = "$treeC_after" ]; then
  ok "the failing check adds no path anywhere in the repository it was pointed at"
else
  no "the directory listing of the repository the checker was pointed at changed across the run"
fi

echo
echo "=== the check passes when a configured signer works"

# The other half of "fails loudly": a check that always fails when
# configured is as useless as one that never does, so this proves the
# check does not cry wolf against a signer that actually works.
caseD="$sandbox_root/configured-good"
make_fixtures "$caseD"
cat >"$caseD/gitconfig" <<CONF
[user]
	name = Signing Check
	email = signing-check@example.invalid
	signingkey = $caseD/fake_key.pub
[gpg]
	format = ssh
[gpg "ssh"]
	program = $caseD/good-signer
[commit]
	gpgsign = true
CONF
run_checker "$caseD"
outD="$out"; codeD="$code"

if [ "$codeD" = "0" ]; then
  ok "a configured signer that works passes the check"
else
  no "a configured signer that works returned code=$codeD, not 0 — out=$outD"
fi

if printf '%s' "$outD" | grep -qF -- 'OK:'; then
  ok "the passing check says so"
else
  no "the passing check output does not say OK: $outD"
fi

# The passing path owes the same cleanup as every other path.
if [ -z "$(ls -A "$caseD/tmp" 2>/dev/null)" ]; then
  ok "the passing check leaves no temporary directory behind"
else
  no "the passing check left files behind in TMPDIR: $(ls -A "$caseD/tmp")"
fi

echo
echo "=== the repository the checker was pointed at is what decides"

# Signing configured only in the sandbox checkout's own local config, with
# nothing in the global file: if run_checker were ever pointed back at the
# checkout this suite runs from instead of at the sandbox, this would find no
# signing configuration there either and skip — so this case only passes
# when the checker is genuinely reading the repository it was pointed at.
# It also pins that the checker copies that repository's config into its
# throwaway repository: without the copy the throwaway commit is unsigned
# and the checker would exit 1 with a no-signature message instead of OK.
caseE1="$sandbox_root/local-good"
make_fixtures "$caseE1"
suite_git -C "$caseE1/checkout" config user.name "Signing Check"
suite_git -C "$caseE1/checkout" config user.email "signing-check@example.invalid"
suite_git -C "$caseE1/checkout" config commit.gpgsign true
suite_git -C "$caseE1/checkout" config gpg.format ssh
suite_git -C "$caseE1/checkout" config user.signingkey "$caseE1/fake_key.pub"
suite_git -C "$caseE1/checkout" config gpg.ssh.program "$caseE1/good-signer"
run_checker "$caseE1"
outE1="$out"; codeE1="$code"

if [ "$codeE1" = "0" ] && printf '%s' "$outE1" | grep -qF -- 'OK:'; then
  ok "signing configured only in the inspected repository's own config passes the check"
else
  no "signing configured only in the inspected repository's own config did not pass: code=$codeE1 out=$outE1"
fi

# The mirror image: a global file that says commit.gpgsign=true with a
# working signer, overridden locally to false. If run_checker were ever
# pointed back at the checkout this suite runs from, this global-true config
# would make the checker sign instead of skip, whatever that checkout's own
# local config says — so this only passes when the local override is what
# the checker actually obeyed.
caseE2="$sandbox_root/local-off"
make_fixtures "$caseE2"
cat >"$caseE2/gitconfig" <<CONF
[user]
	name = Signing Check
	email = signing-check@example.invalid
	signingkey = $caseE2/fake_key.pub
[gpg]
	format = ssh
[gpg "ssh"]
	program = $caseE2/good-signer
[commit]
	gpgsign = true
CONF
suite_git -C "$caseE2/checkout" config commit.gpgsign false
run_checker "$caseE2"
outE2="$out"; codeE2="$code"

if [ "$codeE2" = "0" ] && printf '%s' "$outE2" | grep -qF -- 'SKIP:'; then
  ok "the inspected repository's own commit.gpgsign=false wins over a global true"
else
  no "the inspected repository's own commit.gpgsign=false did not win over the global true: code=$codeE2 out=$outE2"
fi

echo
echo "=== test.sh runs the check, and the suite leaves this checkout untouched"

# Mirrors the existing test-repo.sh case for the recorder suite: a check
# that only ever runs on its own is not a check the one green command
# proves, so this is what stops the checker being quietly dropped from
# ./test.sh.
grep -qF 'bin/check-commit-signing' "$root/test.sh"
check $? "test.sh runs bin/check-commit-signing"

# The very last case before the summary: every case above ran against its
# own sandbox, never against this checkout, and this is what proves it —
# comparing against the snapshot taken before the first case ran.
root_status_after="$(suite_git -C "$root" status --porcelain)"
if [ "$root_status_before" = "$root_status_after" ]; then
  ok "the suite writes nothing into the checkout it runs from"
else
  no "the checkout this suite runs from changed across the run — before=[$root_status_before] after=[$root_status_after]"
fi

echo
if [ "$failed" -eq 0 ]; then
  echo "PASS: $passed cases"
else
  echo "FAIL: $failed of $((passed + failed)) cases"
  exit 1
fi
