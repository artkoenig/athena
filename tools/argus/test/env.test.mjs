/**
 * `argus env`, every output format.
 *
 * What the criteria fix: the content flags — user prompts, tool details, tool
 * content, and the flag the CLI needs for `api_request_body`/
 * `api_response_body` events — are on by default in every rendering `argus
 * env` offers (shell, dotenv, json, settings), not only the default one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/argus.mjs', import.meta.url));
const execFileP = promisify(execFile);

const tempDir = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const rmAll = (...dirs) => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
};

/**
 * Run the CLI and come back with a plain result whatever happened, so a case
 * can say what went wrong instead of dying on a rejected promise. The
 * per-command timeout is the only clock in this file: `tools/argus/CLAUDE.md`
 * forbids asserting wall-clock durations.
 *
 * UROBOROS_OBS_PORT is pinned so the printed collector endpoint does not
 * depend on whatever the running machine happens to have free.
 */
async function runArgus(args, { cwd, env = {} } = {}) {
  const options = {
    cwd,
    timeout: 10_000,
    encoding: 'utf8',
    env: { ...process.env, UROBOROS_OBS_PORT: '4318', ...env },
  };
  return execFileP(process.execPath, [BIN, ...args], options).then(
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

const said = (result) =>
  `exit ${result.code}${result.killed ? ` (killed, signal ${result.signal})` : ''}` +
  `, stdout: ${JSON.stringify(result.stdout)}, stderr: ${JSON.stringify(result.stderr.trim())}`;

const CONTENT_FLAGS = ['OTEL_LOG_USER_PROMPTS', 'OTEL_LOG_TOOL_DETAILS', 'OTEL_LOG_TOOL_CONTENT', 'OTEL_LOG_RAW_API_BODIES'];

test('the shell format (the default) exports all four content flags as "1"', async () => {
  const cwd = tempDir('argus-env-');
  try {
    const result = await runArgus(['env'], { cwd });
    assert.equal(result.code, 0, `argus env has to exit 0 — ${said(result)}`);
    for (const flag of CONTENT_FLAGS) {
      assert.ok(
        result.stdout.includes(`export ${flag}="1"`),
        `expected the shell output to contain export ${flag}="1" — ${said(result)}`,
      );
    }
  } finally {
    rmAll(cwd);
  }
});

test('the dotenv format sets all four content flags to 1', async () => {
  const cwd = tempDir('argus-env-');
  try {
    const result = await runArgus(['env', '--format', 'dotenv'], { cwd });
    assert.equal(result.code, 0, `argus env --format dotenv has to exit 0 — ${said(result)}`);
    for (const flag of CONTENT_FLAGS) {
      assert.ok(
        result.stdout.includes(`${flag}=1`),
        `expected the dotenv output to contain ${flag}=1 — ${said(result)}`,
      );
    }
  } finally {
    rmAll(cwd);
  }
});

test('the json format carries all four content flags as top-level keys', async () => {
  const cwd = tempDir('argus-env-');
  try {
    const result = await runArgus(['env', '--format', 'json'], { cwd });
    assert.equal(result.code, 0, `argus env --format json has to exit 0 — ${said(result)}`);
    const parsed = JSON.parse(result.stdout);
    for (const flag of CONTENT_FLAGS) {
      assert.equal(parsed[flag], '1', `expected top-level ${flag} to be "1" — ${said(result)}`);
    }
  } finally {
    rmAll(cwd);
  }
});

test('the settings format carries all four content flags one level down, under "env"', async () => {
  // settings is the one rendering whose keys sit under `env` rather than at the
  // top level — the only shape this can go wrong in without the others noticing.
  const cwd = tempDir('argus-env-');
  try {
    const result = await runArgus(['env', '--format', 'settings'], { cwd });
    assert.equal(result.code, 0, `argus env --format settings has to exit 0 — ${said(result)}`);
    const parsed = JSON.parse(result.stdout);
    for (const flag of CONTENT_FLAGS) {
      assert.equal(parsed.env?.[flag], '1', `expected settings.env.${flag} to be "1" — ${said(result)}`);
    }
  } finally {
    rmAll(cwd);
  }
});
