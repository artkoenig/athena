# `argus --version` prints the version

## Problem
The argus CLI (`tools/argus/bin/argus.mjs`) has no way to report which version
it is. Every other flag answers a question about a run; none answers "which
argus is this?". This issue is deliberately small — it is the test case for the
issue loop itself.

## Acceptance criteria
- [ ] `argus --version` prints the `version` field from `tools/argus/package.json` and exits with code 0.
- [ ] `argus -V` does the same.
- [ ] The version is read from `package.json`, not duplicated as a literal in the source.
- [ ] The output is the bare version string on one line (e.g. `1.2.3`), no prefix, no banner.
- [ ] The flag is handled before any other work: no config is loaded, no collector is started, no network is touched.
- [ ] The flag appears in the CLI's help output.
- [ ] A test in `tools/argus/test/` covers both spellings and asserts the printed string matches `package.json`.
- [ ] `./test.sh` is green.

## Assumptions taken as defaults (no answer from the human)
- Both `--version` and `-V` are supported; `-v` is left alone in case it means something else.
- Output goes to stdout.
