import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const TESTDATA = fileURLToPath(new URL('../testdata/triage/', import.meta.url));

function triage(...args: string[]): SpawnSyncReturns<string> {
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', fileURLToPath(new URL('./index.ts', import.meta.url)), 'triage', ...args],
    // A run from a snapshot must not look for a token.
    { encoding: 'utf8', env: { ...process.env, GH_TOKEN: '', GITHUB_TOKEN: '', PATH: '' } },
  );
}

// testdata/triage/snapshot.json holds one pull request for each bucket and
// for each state of each predicate. report.json is the report of that
// snapshot. After an intended change of the classification, regenerate it:
//
//   pnpm exec tsx cli/src/index.ts triage --config cli/testdata/triage/config.json \
//     --snapshot cli/testdata/triage/snapshot.json --format json \
//     --output cli/testdata/triage/report.json
test('triage --snapshot writes the same JSON report for the same snapshot', () => {
  const run = triage(
    '--config',
    `${TESTDATA}config.json`,
    '--snapshot',
    `${TESTDATA}snapshot.json`,
    '--format',
    'json',
    '--output',
    '-',
  );
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, readFileSync(`${TESTDATA}report.json`, 'utf8'));
});

test('triage refuses to write the report over the snapshot', () => {
  const snapshot = `${TESTDATA}snapshot.json`;
  const run = triage('--snapshot', snapshot, '--format', 'json', '--output', snapshot);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /cannot be the same file/);
});

test('triage --snapshot rejects a config that leaves out a repository of the snapshot', () => {
  const run = triage(
    '--config',
    `${TESTDATA}config.other-repo.json`,
    '--snapshot',
    `${TESTDATA}snapshot.json`,
    '--output',
    '-',
  );
  assert.equal(run.status, 1);
  assert.match(run.stderr, /pull requests of example\/repo, which the config does not list/);
});

test('triage --snapshot rejects a file that is not a snapshot', () => {
  const run = triage(
    '--config',
    `${TESTDATA}config.json`,
    '--snapshot',
    `${TESTDATA}report.json`,
    '--output',
    '-',
  );
  assert.equal(run.status, 1);
  assert.match(run.stderr, /report\.json is not a snapshot written by --save-snapshot/);
});

test('triage --snapshot rejects a flag that controls what the run fetches', () => {
  const run = triage('--snapshot', `${TESTDATA}snapshot.json`, '--limit', '5');
  assert.equal(run.status, 1);
  assert.match(run.stderr, /--snapshot cannot be combined with --limit/);
});
