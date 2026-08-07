#!/bin/bash
# Tests for bin/check-commit-signing: the two outcomes it must tell apart —
# signing legitimately not configured for this run, and signing configured
# but the signed commit failing — and the cleanup it owes on every path,
# success and failure alike. Nothing here fakes what the checker really
# does: it runs as a real process against a real git. What is fabricated is
# the signer program and the git configuration it reads, so the checkout
# this suite runs from is left exactly as it was. Exit 0 = all cases pass.
set -u

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

passed=0
failed=0

ok() { passed=$((passed + 1)); echo "  ok   — $1"; }
no() { failed=$((failed + 1)); echo "  FAIL — $1"; }
check() { if [ "$1" = "0" ]; then ok "$2"; else no "$2"; fi; }

# One sandbox for the whole suite, with a subdirectory per case, so one
# case's leftovers can never be mistaken for another case's and a single
# trap covers every case this suite ever creates.
sandbox_root="$(mktemp -d)"
trap 'rm -rf "$sandbox_root"' EXIT

# The three fixture files a case needs are the same shape in every case —
# the key the signer is handed, and the two fake signer programs, one that
# fails the way the misconfigured environment this issue is about failed,
# one that succeeds the way `ssh-keygen -Y sign` would. Building them once
# per case directory keeps that repetition out of the cases themselves.
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
}

# Spawns the real checker once under the case's fabricated environment and
# captures its combined output and exit code into the caller's $out and
# $code. Several cases below assert on one run rather than paying for the
# checker again per assertion, and GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM are
# what make the run hermetic — they govern every git the checker starts,
# including the one it runs against this checkout.
run_checker() {
  local case_dir="$1"
  out="$(env HOME="$case_dir/home" TMPDIR="$case_dir/tmp" \
    GIT_CONFIG_GLOBAL="$case_dir/gitconfig" GIT_CONFIG_SYSTEM=/dev/null \
    bash "$root/bin/check-commit-signing" 2>&1)"
  code=$?
}

echo
echo "=== the check passes over an environment where signing is not configured"

# The ordinary agent environment: no signing key, nothing asking for one.
# The check must not invent a reason to fail here — this is the baseline
# the "legitimately not configured" half of the distinction is judged
# against.
case1="$sandbox_root/unconfigured"
make_fixtures "$case1"
cat >"$case1/gitconfig" <<CONF
[user]
	name = Signing Check
	email = signing-check@example.invalid
CONF
run_checker "$case1"
out1="$out"; code1="$code"

if [ "$code1" = "0" ]; then
  ok "an environment without commit.gpgsign passes the check"
else
  no "an environment without commit.gpgsign passes the check — got code=$code1 out=$out1"
fi

# A check that fails silently, or that stops naming the setting it keyed
# its decision on, is no longer distinguishable from one that is simply
# broken — this is what goes red first if that happens.
if printf '%s' "$out1" | grep -qF -- 'SKIP:' && printf '%s' "$out1" | grep -qF -- 'commit.gpgsign'; then
  ok "the skipped check says why it skipped"
else
  no "the skipped check output does not say SKIP: and name commit.gpgsign: $out1"
fi

# The skip path still has to honour the same no-leftovers promise as every
# other path — it is one of the outcomes "leaves nothing behind" covers.
if [ -z "$(ls -A "$case1/tmp" 2>/dev/null)" ]; then
  ok "the skipped check leaves no temporary directory behind"
else
  no "the skipped check left files behind in TMPDIR: $(ls -A "$case1/tmp")"
fi

# The edge that actually pins the distinction: a developer machine can carry
# a signing key in its global config with signing switched off for this
# run. A checker keyed on user.signingkey being present, or on gpg.format,
# would cry wolf here while case 5 below still passes — only keying on
# commit.gpgsign itself survives both.
case4="$sandbox_root/key-present-signing-off"
make_fixtures "$case4"
cat >"$case4/gitconfig" <<CONF
[user]
	name = Signing Check
	email = signing-check@example.invalid
	signingkey = $case4/fake_key.pub
[gpg]
	format = ssh
[gpg "ssh"]
	program = $case4/bad-signer
[commit]
	gpgsign = false
CONF
run_checker "$case4"
if [ "$code" = "0" ] && printf '%s' "$out" | grep -qF -- 'SKIP:'; then
  ok "a signing key with commit.gpgsign false is not an environment the check fails"
else
  no "a signing key with commit.gpgsign false failed the check: code=$code out=$out"
fi

echo
echo "=== the check fails loudly when a configured signer cannot sign"

# The failure this whole issue exists for: a signer program that exits 1,
# reproduced with the same key-file complaint and the same "signing
# failed" line a real agent commit hit.
case5="$sandbox_root/configured-bad"
make_fixtures "$case5"
cat >"$case5/gitconfig" <<CONF
[user]
	name = Signing Check
	email = signing-check@example.invalid
	signingkey = $case5/fake_key.pub
[gpg]
	format = ssh
[gpg "ssh"]
	program = $case5/bad-signer
[commit]
	gpgsign = true
CONF

# Snapshotting the repository under test's own status around the run — with
# the plain ambient environment, not the fabricated one — is what proves
# the failing path writes nothing into the checkout an agent is about to
# commit in, on a checkout that may already be dirty.
status_before="$(git -C "$root" status --porcelain)"
run_checker "$case5"
status_after="$(git -C "$root" status --porcelain)"
out5="$out"; code5="$code"

if [ "$code5" = "1" ]; then
  ok "a configured signer that cannot sign fails the check"
else
  no "a configured signer that cannot sign returned code=$code5, not 1 — out=$out5"
fi

# Each substring is its own case so a dropped line names itself instead of
# hiding behind a single "the message looks right" assertion.
if printf '%s' "$out5" | grep -qF -- 'FAIL:'; then
  ok "the failure says FAIL"
else
  no "the failure output does not say FAIL: $out5"
fi

if printf '%s' "$out5" | grep -qF -- "user.signingkey = $case5/fake_key.pub"; then
  ok "the failure names the signing key"
else
  no "the failure output does not name the signing key: $out5"
fi

if printf '%s' "$out5" | grep -qF -- "gpg.ssh.program = $case5/bad-signer"; then
  ok "the failure names the signer program"
else
  no "the failure output does not name the signer program: $out5"
fi

if printf '%s' "$out5" | grep -qF -- 'signing failed'; then
  ok "the failure carries what git said"
else
  no "the failure output does not carry what git said: $out5"
fi

# "Leaves nothing behind" is a criterion of its own on the failing path, not
# just the passing ones — a fixture that promises this and still leaves an
# empty directory per run is exactly what this pins.
if [ -z "$(ls -A "$case5/tmp" 2>/dev/null)" ]; then
  ok "the failing check leaves no throwaway repository behind"
else
  no "the failing check left files behind in TMPDIR: $(ls -A "$case5/tmp")"
fi

# A checker that leaves a child process running after it reports failure is
# a leak the caller has no way to see; pgrep's absence must be loud rather
# than a silent pass, so the guard reports FAIL naming the missing tool
# instead of skipping the assertion.
if command -v pgrep >/dev/null 2>&1; then
  if [ -z "$(pgrep -f "$case5" 2>/dev/null)" ]; then
    ok "the failing check leaves no process behind"
  else
    no "a process matching $case5 is still running: $(pgrep -fa "$case5" 2>/dev/null)"
  fi
else
  no "pgrep is not installed, so a leftover process cannot be ruled out"
fi

# Comparing before with after, rather than expecting an empty status, is
# what makes this survive being run against a checkout that already has
# uncommitted changes of its own.
if [ "$status_before" = "$status_after" ]; then
  ok "the failing check writes nothing into the repository under test"
else
  no "the repository under test's status changed across the run — before=[$status_before] after=[$status_after]"
fi

echo
echo "=== the check passes when a configured signer works"

# The other half of "fails loudly": a check that always fails when
# configured is as useless as one that never does, so this proves the
# check does not cry wolf against a signer that actually works.
case10="$sandbox_root/configured-good"
make_fixtures "$case10"
cat >"$case10/gitconfig" <<CONF
[user]
	name = Signing Check
	email = signing-check@example.invalid
	signingkey = $case10/fake_key.pub
[gpg]
	format = ssh
[gpg "ssh"]
	program = $case10/good-signer
[commit]
	gpgsign = true
CONF
run_checker "$case10"
out10="$out"; code10="$code"

if [ "$code10" = "0" ]; then
  ok "a configured signer that works passes the check"
else
  no "a configured signer that works returned code=$code10, not 0 — out=$out10"
fi

if printf '%s' "$out10" | grep -qF -- 'OK:'; then
  ok "the passing check says so"
else
  no "the passing check output does not say OK: $out10"
fi

# The passing path owes the same cleanup as every other path.
if [ -z "$(ls -A "$case10/tmp" 2>/dev/null)" ]; then
  ok "the passing check leaves no temporary directory behind"
else
  no "the passing check left files behind in TMPDIR: $(ls -A "$case10/tmp")"
fi

echo
echo "=== test.sh runs the check"

# Mirrors the existing test-repo.sh case for the recorder suite: a check
# that only ever runs on its own is not a check the one green command
# proves, so this is what stops the checker being quietly dropped from
# ./test.sh.
grep -qF 'bin/check-commit-signing' "$root/test.sh"
check $? "test.sh runs bin/check-commit-signing"

echo
if [ "$failed" -eq 0 ]; then
  echo "PASS: $passed cases"
else
  echo "FAIL: $failed of $((passed + failed)) cases"
  exit 1
fi
