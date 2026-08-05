/**
 * `argus --version` / `argus -V`.
 *
 * What the criteria fix: the bare `version` field of the package manifest, on
 * one line on stdout, exit 0, answered before any configuration is resolved,
 * any collector is started or any port is taken — and listed in the help.
 *
 * The expected string is never a literal here. It is read from
 * `tools/argus/package.json` at test time, and the "not a literal in the
 * source" criterion is put under test by running a copy of the package whose
 * manifest says something else: a version welded into the source keeps printing
 * the real one and goes red.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/argus.mjs', import.meta.url));
const PKG_DIR = fileURLToPath(new URL('..', import.meta.url));
const MANIFEST = fileURLToPath(new URL('../package.json', import.meta.url));
const execFileP = promisify(execFile);

/** The one true answer, read from the manifest rather than written down here. */
const VERSION = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')).version;

const tempDir = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

/** A directory with nothing in it, so anything found there was left by the run. */
const emptyDir = () => tempDir('argus-version-');

/**
 * Run the CLI and come back with a plain result whatever happened, so a case
 * can say what went wrong instead of dying on a rejected promise. The
 * per-command timeout is the only clock in this file: `tools/argus/CLAUDE.md`
 * forbids asserting wall-clock durations.
 */
async function runArgus(args, { cwd, env = {}, bin = BIN } = {}) {
  const options = {
    cwd,
    timeout: 10_000,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  };
  return execFileP(process.execPath, [bin, ...args], options).then(
    ({ stdout, stderr }) => ({ stdout, stderr, code: 0, killed: false }),
    (error) => ({
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
      code: error.code ?? null,
      killed: error.killed === true,
      signal: error.signal ?? null,
    }),
  );
}

/** Everything the run said, for a failure message that is worth reading. */
const said = (result) =>
  `exit ${result.code}${result.killed ? ` (killed, signal ${result.signal})` : ''}` +
  `, stdout: ${JSON.stringify(result.stdout)}, stderr: ${JSON.stringify(result.stderr.trim())}`;

/**
 * The whole of the criterion "prints the version and exits 0", in one place:
 * exit 0, the command came back on its own, and stdout is that string and
 * nothing else.
 */
function assertPrintsVersion(result, expected, label) {
  assert.equal(
    result.killed,
    false,
    `${label}: the command has to answer and return by itself, not be killed by the timeout — ${said(result)}`,
  );
  assert.equal(result.code, 0, `${label}: has to exit 0 — ${said(result)}`);
  assert.equal(
    result.stdout.trim(),
    expected,
    `${label}: stdout has to be the bare version ${JSON.stringify(expected)} — ${said(result)}`,
  );
}

/** A port nobody is on right now, asked of the OS rather than picked. */
async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** Whether this process can take that port — i.e. nothing else holds it. */
async function portIsFree(port) {
  const probe = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(port, '127.0.0.1', resolve);
    });
  } catch {
    return false;
  }
  await new Promise((resolve) => probe.close(resolve));
  return true;
}

/** What a run left under `.uroboros-telemetry` in that directory. */
function measurementsIn(cwd) {
  const root = path.join(cwd, '.uroboros-telemetry');
  return fs.existsSync(root) ? fs.readdirSync(root).filter((name) => name !== '.gitignore') : [];
}

/**
 * A runnable copy of the package — `bin`, `src` and a manifest whose version is
 * whatever the case wants it to be. The tool has zero runtime dependencies, so
 * the copy runs exactly like the original; only its manifest differs.
 */
function packageCopyWithVersion(version) {
  const dir = tempDir('argus-manifest-');
  fs.cpSync(path.join(PKG_DIR, 'bin'), path.join(dir, 'bin'), { recursive: true });
  fs.cpSync(path.join(PKG_DIR, 'src'), path.join(dir, 'src'), { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  manifest.version = version;
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { dir, bin: path.join(dir, 'bin', 'argus.mjs') };
}

const rmAll = (...dirs) => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
};

/* ------------------------- the version that is expected ------------------ */

test('the manifest carries a version at all, so nothing below can pass vacuously', () => {
  assert.equal(typeof VERSION, 'string', `tools/argus/package.json has no string "version": ${VERSION}`);
  assert.notEqual(VERSION.trim(), '', 'tools/argus/package.json has an empty "version"');
  assert.equal(VERSION, VERSION.trim(), 'the manifest version must not carry surrounding whitespace');
});

/* ------------------------------ both spellings --------------------------- */

test('argus --version prints the version from package.json and exits 0', async () => {
  const cwd = emptyDir();
  try {
    assertPrintsVersion(await runArgus(['--version'], { cwd }), VERSION, 'argus --version');
  } finally {
    rmAll(cwd);
  }
});

test('argus -V prints the very same thing', async () => {
  const cwd = emptyDir();
  try {
    assertPrintsVersion(await runArgus(['-V'], { cwd }), VERSION, 'argus -V');
  } finally {
    rmAll(cwd);
  }
});

test('the two spellings are indistinguishable in their output', async () => {
  const long = emptyDir();
  const short = emptyDir();
  try {
    const withLong = await runArgus(['--version'], { cwd: long });
    const withShort = await runArgus(['-V'], { cwd: short });
    assertPrintsVersion(withLong, VERSION, 'argus --version');
    assertPrintsVersion(withShort, VERSION, 'argus -V');
    assert.equal(
      withShort.stdout,
      withLong.stdout,
      '-V is the same flag as --version, so byte for byte the same output',
    );
    assert.equal(withShort.stderr, withLong.stderr, 'and the same silence beside it');
  } finally {
    rmAll(long, short);
  }
});

/* ---------------------- the bare string, one line, no banner ------------- */

test('the output is the bare version on one line: no prefix, no banner, nothing on stderr', async () => {
  const dirs = [];
  try {
    for (const spelling of ['--version', '-V']) {
      const cwd = emptyDir();
      dirs.push(cwd);
      const result = await runArgus([spelling], { cwd });
      assertPrintsVersion(result, VERSION, `argus ${spelling}`);

      const lines = result.stdout.split('\n').filter((line) => line.trim() !== '');
      assert.deepEqual(
        lines,
        [VERSION],
        `argus ${spelling}: exactly one non-empty line, and it is the version itself — ${said(result)}`,
      );
      assert.equal(
        lines[0],
        lines[0].trim(),
        `argus ${spelling}: no indentation in front of the version — ${said(result)}`,
      );
      assert.ok(
        !/argus/i.test(result.stdout),
        `argus ${spelling}: a bare version string carries no program name — ${said(result)}`,
      );
      assert.ok(
        !/^v/i.test(result.stdout.trim()),
        `argus ${spelling}: no "v" prefix in front of the version — ${said(result)}`,
      );
      assert.equal(
        result.stderr,
        '',
        `argus ${spelling}: the version goes to stdout alone; stderr stays empty, warnings included — ${said(result)}`,
      );
    }
  } finally {
    rmAll(...dirs);
  }
});

/* --------------------- read from the manifest, not from a literal -------- */

test('the printed version follows package.json rather than a literal in the source', async () => {
  // Three manifests that the real one cannot be mistaken for, the loose shapes
  // of a version string included: whatever the manifest says is what comes out.
  const pretendVersions = ['9.99.99-test', '0.0.0', '1.2.3-rc.1+build.5'];
  const made = [];
  try {
    for (const pretend of pretendVersions) {
      assert.notEqual(pretend, VERSION, 'the stand-in has to differ from the real version for this to prove anything');
      const copy = packageCopyWithVersion(pretend);
      const cwd = emptyDir();
      made.push(copy.dir, cwd);
      const result = await runArgus(['--version'], { cwd, bin: copy.bin });
      assertPrintsVersion(result, pretend, `a copy whose manifest says ${pretend}`);
    }
  } finally {
    rmAll(...made);
  }
});

test('the manifest that is read is the program’s own, not one lying in the working directory', async () => {
  const cwd = emptyDir();
  try {
    // A decoy next to the caller, not next to the program. Reading `./package.json`
    // would pick this up and print 6.6.6.
    fs.writeFileSync(
      path.join(cwd, 'package.json'),
      `${JSON.stringify({ name: 'decoy', version: '6.6.6' }, null, 2)}\n`,
    );
    assertPrintsVersion(await runArgus(['--version'], { cwd }), VERSION, 'argus --version beside a decoy manifest');
  } finally {
    rmAll(cwd);
  }
});

/* --------------------- handled before any other work --------------------- */

test('--version is answered although the environment would make configuration throw', async () => {
  const cwd = emptyDir();
  try {
    // `UROBOROS_OBS_RETENTION` is read while the configuration is resolved and
    // this value cannot be parsed, so resolving it at all ends the run at exit 1.
    // Coming back with the version is the proof that nothing was resolved.
    const result = await runArgus(['--version'], {
      cwd,
      env: { UROBOROS_OBS_RETENTION: 'not-a-duration' },
    });
    assertPrintsVersion(result, VERSION, 'argus --version with an unusable UROBOROS_OBS_RETENTION');
    assert.deepEqual(
      measurementsIn(cwd),
      [],
      'and no measurement directory: nothing was started either',
    );
    for (const trace of [/\bargus:/i, /listening/i, /persisting/i]) {
      assert.doesNotMatch(
        result.stderr,
        trace,
        `neither an error path nor a collector start may run for --version — ${said(result)}`,
      );
    }
  } finally {
    rmAll(cwd);
  }
});

test('--version is answered although the flags beside it would make configuration throw', async () => {
  const cwd = emptyDir();
  try {
    const result = await runArgus(['--retention', 'not-a-duration', '--version'], { cwd });
    assertPrintsVersion(result, VERSION, 'argus --retention not-a-duration --version');
    assert.deepEqual(measurementsIn(cwd), [], 'and no measurement directory');
  } finally {
    rmAll(cwd);
  }
});

test('-V too is answered ahead of an unusable configuration', async () => {
  const cwd = emptyDir();
  try {
    const result = await runArgus(['-V'], { cwd, env: { UROBOROS_OBS_RETENTION: 'not-a-duration' } });
    assertPrintsVersion(result, VERSION, 'argus -V with an unusable UROBOROS_OBS_RETENTION');
    assert.deepEqual(measurementsIn(cwd), [], 'and no measurement directory');
  } finally {
    rmAll(cwd);
  }
});

test('no collector is started and no port is taken by a --version run', async () => {
  const cwd = emptyDir();
  const port = await freePort();
  try {
    const result = await runArgus(['--port', String(port), '--version'], { cwd });
    assertPrintsVersion(result, VERSION, `argus --port ${port} --version`);
    assert.deepEqual(measurementsIn(cwd), [], 'a version question leaves no measurement behind');
    assert.ok(
      await portIsFree(port),
      `nothing may be listening on ${port} after a --version run: the flag is answered before anything is started`,
    );
  } finally {
    rmAll(cwd);
  }
});

/* --------------------------------- repeats ------------------------------- */

test('asking three times in the same directory says the same thing three times and leaves nothing', async () => {
  const cwd = emptyDir();
  try {
    const outputs = [];
    for (const spelling of ['--version', '-V', '--version']) {
      const result = await runArgus([spelling], { cwd });
      assertPrintsVersion(result, VERSION, `argus ${spelling} (repeat ${outputs.length + 1})`);
      outputs.push(result.stdout);
    }
    assert.deepEqual(new Set(outputs).size, 1, 'the answer does not drift between runs');
    assert.deepEqual(measurementsIn(cwd), [], 'and three runs leave the directory as empty as they found it');
    assert.deepEqual(
      fs.readdirSync(cwd),
      [],
      'nothing at all is written into the working directory by a version question',
    );
  } finally {
    rmAll(cwd);
  }
});

/* ------------------------------ the help output -------------------------- */

test('the help output lists the flag in both spellings', async () => {
  const cwd = emptyDir();
  try {
    const result = await runArgus(['--help'], { cwd });
    assert.equal(result.code, 0, `argus --help has to exit 0 — ${said(result)}`);
    const help = `${result.stdout}${result.stderr}`;
    assert.ok(help.includes('--version'), `--version has to appear in the help — got:\n${help}`);
    assert.ok(help.includes('-V'), `-V has to appear in the help — got:\n${help}`);
  } finally {
    rmAll(cwd);
  }
});
