import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { loadConfig } from './config.js';

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

test('an age that the config leaves out has its default', (t) => {
  const config = loadConfig(configFile(t, { repos: ['example/repo'], ages: { idleDays: 90 } }));

  assert.deepEqual(config.ages, {
    idleDays: 90,
    idleNoticeDays: 14,
    flagNoticeDays: 7,
    staleOnAuthorDays: 30,
  });
});

for (const [shape, ages, message] of [
  ['an age of no days', { flagNoticeDays: 0 }, /"ages.flagNoticeDays" must be a whole number/],
  ['a part of a day', { idleDays: 1.5 }, /"ages.idleDays" must be a whole number/],
  ['an age that no policy reads', { staleDays: 30 }, /"ages.staleDays" is not one of idleDays/],
  ['a name that every object inherits', { toString: 5 }, /"ages.toString" is not one of idleDays/],
  ['ages that are not an object', 5, /"ages" must be an object/],
] as const) {
  test(`the config rejects ${shape}`, (t) => {
    const path = configFile(t, { repos: ['example/repo'], ages });

    assert.throws(() => loadConfig(path), message);
  });
}

for (const field of ['maintainers', 'interns', 'priorityAuthors', 'priorityLabels'] as const) {
  test(`${field} preserves null as an empty list`, (t) => {
    const config = loadConfig(configFile(t, { repos: ['example/repo'], [field]: null }));

    assert.deepEqual(config[field], []);
  });
}

for (const field of ['maintainers', 'interns', 'priorityAuthors'] as const) {
  for (const [shape, value] of [
    ['scalar', 'author'],
    ['non-string element', ['author', 42]],
  ] as const) {
    test(`${field} rejects a ${shape}`, (t) => {
      const path = configFile(t, { repos: ['example/repo'], [field]: value });

      assert.throws(() => loadConfig(path), new RegExp(`"${field}" must be an array of strings`));
    });
  }
}
