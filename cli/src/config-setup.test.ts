import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { copySampleConfig } from './config-setup.js';
import { loadConfig } from './config.js';

function targetPath(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'maintainer-tools-config-setup-'));
  t.after(() => rmSync(dir, { recursive: true }));
  return join(dir, 'nested', 'config.json');
}

for (const kind of ['generic', 'jaeger'] as const) {
  test(`copySampleConfig writes the ${kind} sample, creating parent directories`, (t) => {
    const path = targetPath(t);

    const written = copySampleConfig(kind, path);

    assert.equal(written, path);
    const config = loadConfig(path);
    assert.ok(config.repos.length > 0, 'the copied sample must load as a valid config');
    if (kind === 'jaeger') {
      assert.ok(config.repos.includes('jaegertracing/jaeger'));
    }
  });
}

test('copySampleConfig overwrites an existing file with the sample content', (t) => {
  const path = targetPath(t);
  copySampleConfig('jaeger', path);
  copySampleConfig('generic', path);

  const written = JSON.parse(readFileSync(path, 'utf8')) as { repos: string[] };
  assert.deepEqual(written.repos, ['owner/repo-a', 'owner/repo-b']);
});
