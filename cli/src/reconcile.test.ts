import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const TRIAGE_TESTDATA = fileURLToPath(new URL('../testdata/triage/', import.meta.url));
const REPORT = fileURLToPath(new URL('../testdata/reconcile/report.json', import.meta.url));

function reconcile(...args: string[]): SpawnSyncReturns<string> {
  return spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      fileURLToPath(new URL('./index.ts', import.meta.url)),
      'reconcile',
      '--config',
      `${TRIAGE_TESTDATA}config.json`,
      '--snapshot',
      `${TRIAGE_TESTDATA}snapshot.json`,
      '--output',
      '-',
      ...args,
    ],
    // A run from a snapshot must not look for a token.
    { encoding: 'utf8', env: { ...process.env, GH_TOKEN: '', GITHUB_TOKEN: '', PATH: '' } },
  );
}

// The snapshot is the one of the triage report. After an intended change of
// the rules or of the plan, regenerate the report:
//
//   pnpm exec tsx cli/src/index.ts reconcile --config cli/testdata/triage/config.json \
//     --snapshot cli/testdata/triage/snapshot.json --format json \
//     --output cli/testdata/reconcile/report.json
test('reconcile --snapshot writes the same JSON report for the same snapshot', () => {
  const run = reconcile('--format', 'json');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, readFileSync(REPORT, 'utf8'));
});

test('the HTML report links each changed pull request and shows its comment', () => {
  const run = reconcile();
  assert.equal(run.status, 0, run.stderr);
  const changed = (
    JSON.parse(readFileSync(REPORT, 'utf8')) as Array<{
      repo: string;
      number: number;
      changes: Array<{ kind: string }>;
    }>
  ).filter(({ changes }) => changes.length > 0);
  assert.ok(changed.length > 0);
  for (const { repo, number } of changed) {
    assert.ok(
      run.stdout.includes(`<a href="https://github.com/${repo}/pull/${number}">`),
      `${repo}#${number}`,
    );
  }
  assert.equal(run.stdout.split('<article').length - 1, changed.length);
  assert.ok(run.stdout.includes('Comment that would be posted, which notifies the author'));
  assert.ok(run.stdout.includes('this pull request needs attention.'));
});

test('the Markdown report lists the changes of each changed pull request', () => {
  const run = reconcile('--format', 'md');
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^# Shadow run of the reconciler/);
  assert.match(run.stdout, /- Changes: add label `/);
});

test('the Markdown report shows the comment that a change posts', () => {
  const run = reconcile('--format', 'md');
  assert.match(run.stdout, /Comment that would be posted:\n\n> <!-- jaeger-pr-lifecycle -->/);
});

test('reconcile refuses to write the report over the snapshot', () => {
  const run = reconcile('--output', `${TRIAGE_TESTDATA}snapshot.json`);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /The snapshot and the report cannot be the same file/);
});

test('reconcile refuses a snapshot that was gathered without the quota', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'reconcile-'));
  t.after(() => rmSync(directory, { recursive: true }));
  const snapshot = JSON.parse(readFileSync(`${TRIAGE_TESTDATA}snapshot.json`, 'utf8')) as {
    mergedCounts?: unknown;
  };
  delete snapshot.mergedCounts;
  const path = join(directory, 'snapshot.json');
  writeFileSync(path, JSON.stringify(snapshot));

  const run = reconcile('--snapshot', path);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /was gathered with --no-quota/);
});

test('reconcile refuses a snapshot that does not hold every open pull request', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'reconcile-'));
  t.after(() => rmSync(directory, { recursive: true }));
  const snapshot = JSON.parse(readFileSync(`${TRIAGE_TESTDATA}snapshot.json`, 'utf8')) as object;
  const path = join(directory, 'snapshot.json');
  writeFileSync(path, JSON.stringify({ ...snapshot, isPartial: true }));

  const run = reconcile('--snapshot', path);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /was gathered with --pr or --limit/);
});

test('reconcile --repo reports one repository of a snapshot of several', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'reconcile-'));
  t.after(() => rmSync(directory, { recursive: true }));
  const config = JSON.parse(readFileSync(`${TRIAGE_TESTDATA}config.json`, 'utf8')) as {
    repos: string[];
  };
  const path = join(directory, 'config.json');
  writeFileSync(path, JSON.stringify({ ...config, repos: [...config.repos, 'example/other'] }));

  const run = reconcile('--config', path, '--repo', 'example/other', '--format', 'json');
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), []);
});

test('reconcile refuses to write the changes of a saved snapshot', () => {
  const run = reconcile('--write');
  assert.equal(run.status, 1);
  assert.match(run.stderr, /--snapshot excludes --write/);
});

function reconcileInWriteModeAs(viewerLogin: string): SpawnSyncReturns<string> {
  return spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--import',
      fileURLToPath(new URL('../testdata/reconcile/github-as-viewer.mjs', import.meta.url)),
      fileURLToPath(new URL('./index.ts', import.meta.url)),
      'reconcile',
      '--config',
      `${TRIAGE_TESTDATA}config.json`,
      '--no-cache',
      '--output',
      '-',
      '--write',
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, GH_TOKEN: 'token-of-the-test', VIEWER_LOGIN: viewerLogin },
    },
  );
}

test('reconcile --write refuses a token that is not of a workflow', () => {
  const run = reconcileInWriteModeAs('some-maintainer');
  assert.equal(run.status, 1);
  assert.match(run.stderr, /--write needs the token of a GitHub Actions workflow/);
  assert.doesNotMatch(run.stderr, /scanning/);
});

test('reconcile --write gathers with the token of a workflow', () => {
  const run = reconcileInWriteModeAs('github-actions[bot]');
  assert.match(run.stderr, /scanning/);
  assert.doesNotMatch(run.stderr, /--write needs the token/);
});

test('reconcile refuses a format that it does not write', () => {
  const run = reconcile('--format', 'xlsx');
  assert.equal(run.status, 1);
  assert.match(run.stderr, /--format must be/);
});
