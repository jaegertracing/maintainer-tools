import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { loadConfig, priorityAuthorLogins } from './config.js';

function configFile(t: TestContext, value: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'maintainer-tools-config-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify(value));
  t.after(() => rmSync(dir, { recursive: true }));
  return path;
}

test('priorityAuthors defaults to an empty list', (t) => {
  const config = loadConfig(configFile(t, { repos: ['example/repo'] }));

  assert.deepEqual(config.priorityAuthors, []);
});

test('priorityAuthorLogins combines every configured priority source', (t) => {
  const config = loadConfig(
    configFile(t, {
      repos: ['example/repo'],
      maintainers: ['maintainer'],
      interns: ['intern'],
      priorityAuthors: ['priority-author'],
    }),
  );

  assert.deepEqual([...priorityAuthorLogins(config)], ['maintainer', 'intern', 'priority-author']);
});

test('priorityAuthors rejects malformed values', (t) => {
  const path = configFile(t, { repos: ['example/repo'], priorityAuthors: 'priority-author' });

  assert.throws(() => loadConfig(path), /"priorityAuthors" must be an array of strings/);
});
