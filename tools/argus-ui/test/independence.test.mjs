import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT = fileURLToPath(new URL('../', import.meta.url));

/** Every file in this project, node_modules aside. */
function walk(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, found);
    else if (entry.isFile()) found.push(full);
  }
  return found;
}

test('the interface is a project of its own, with everything a project needs', () => {
  for (const relative of [
    'package.json',
    'README.md',
    'CLAUDE.md',
    'bin/argus-ui.mjs',
    'src/config.mjs',
    'src/server.mjs',
    'public/index.html',
    'public/app.js',
    'public/styles.css',
    'test',
  ]) {
    assert.ok(fs.existsSync(path.join(PROJECT, relative)), `tools/argus-ui/${relative} is missing`);
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.test, 'node --test "test/*.test.mjs"');
  // Zero runtime dependencies, like its sibling: it has to run from a checkout
  // without npm install ever having happened.
  assert.deepEqual(pkg.dependencies ?? {}, {});
});

test('nothing in the interface reaches outside the interface', () => {
  // The load-bearing rule: this project knows the collector only through its
  // HTTP API, so it can be lifted out of athena unchanged. A single import of a
  // file next door is what would make that impossible.
  const files = walk(PROJECT);
  const modules = files.filter((file) => file.endsWith('.mjs') || file.endsWith('.js'));
  const covered = modules.map((file) => path.relative(PROJECT, file));
  for (const owned of ['bin/argus-ui.mjs', 'src/config.mjs', 'src/server.mjs', 'public/app.js']) {
    assert.ok(covered.includes(owned), `the scan does not cover ${owned} — it is not there to check`);
  }

  const sibling = ['tools', 'argus'].join('/');
  const problems = [];
  for (const file of modules) {
    const source = fs.readFileSync(file, 'utf8');
    const relative = path.relative(PROJECT, file);
    for (const match of source.matchAll(/(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      if (!specifier.startsWith('.')) continue;
      const resolved = path.resolve(path.dirname(file), specifier);
      if (!resolved.startsWith(PROJECT)) problems.push(`${relative} imports outside the project: ${specifier}`);
    }
    if (source.includes(`${sibling}/`)) problems.push(`${relative} names a path inside ${sibling}`);
  }
  assert.deepEqual(problems, []);
});
