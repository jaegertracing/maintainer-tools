import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { PullRequest } from '@jaegertracing/maintainer-tools-checks';

import {
  type GitHubAnswers,
  recordingClient,
  snapshotClient,
  snapshotSource,
  sourceSavingSnapshot,
  type TriageSnapshot,
} from './snapshot.js';

function pullRequest(repo: string, number: number, labels: string[] = []): PullRequest {
  return {
    repo: { owner: 'example', name: repo },
    number,
    updatedAt: `2026-05-0${number}T00:00:00Z`,
    commits: [{ sha: `sha-${number}` }],
    statusCheckRollup: 'SUCCESS',
    labels,
  } as PullRequest;
}

const issue10 = { author: 'bob', state: 'OPEN', title: 'A bug', isPullRequest: false } as const;

const snapshot: TriageSnapshot = {
  now: '2026-06-01T12:00:00.000Z',
  viewer: 'maintainer-a',
  pullRequests: [
    pullRequest('repo', 2),
    pullRequest('other', 3),
    pullRequest('repo', 1, ['waiting-for-author']),
  ],
  mergedCounts: { 'example/repo|alice': 2 },
  issues: { 'example/repo#10': issue10 },
};

test('the snapshot client answers each lookup from the data of the snapshot', async () => {
  const client = snapshotClient(snapshot);

  assert.equal(await client.fetchViewerLogin(), 'maintainer-a');
  assert.deepEqual(await client.listOpenPRs('example', 'repo'), [
    { number: 2, updatedAt: '2026-05-02T00:00:00Z', headSha: 'sha-2', headRollup: 'SUCCESS' },
    { number: 1, updatedAt: '2026-05-01T00:00:00Z', headSha: 'sha-1', headRollup: 'SUCCESS' },
  ]);
  assert.deepEqual(
    (await client.listOpenPRsByLabel('example', 'repo', 'waiting-for-author')).map((s) => s.number),
    [1],
  );
  assert.deepEqual(await client.listOpenPRs('example', 'absent'), []);
  assert.equal(await client.fetchPullRequest('example', 'other', 3), snapshot.pullRequests[1]);
  assert.equal(await client.countMergedPRs('example', 'repo', 'alice'), 2);
});

test('the snapshot client leaves out an issue that GitHub did not resolve', async () => {
  const issues = await snapshotClient(snapshot).fetchIssues([
    { owner: 'example', repo: 'repo', number: 10 },
    { owner: 'example', repo: 'repo', number: 11 },
  ]);

  assert.deepEqual([...issues], [['example/repo#10', issue10]]);
});

test('the snapshot client rejects a lookup that the snapshot cannot answer', async () => {
  const client = snapshotClient(snapshot);

  await assert.rejects(
    client.countMergedPRs('example', 'repo', 'carol'),
    /the snapshot has no merged-PR count for @carol in example\/repo/,
  );
  await assert.rejects(
    client.fetchPullRequest('example', 'repo', 3),
    /the snapshot has no pull request example\/repo#3/,
  );
});

const REPOS = ['example/repo', 'example/other'];

test('a run from a snapshot skips the passes that the saving run skipped', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'snapshot-'));
  t.after(() => rmSync(dir, { recursive: true }));

  for (const skippedPasses of [
    { skipQuota: true, skipIssues: false },
    { skipQuota: false, skipIssues: true },
  ]) {
    const path = join(dir, 'snapshot.json');
    const savingSource = sourceSavingSnapshot(
      {
        client: snapshotClient(snapshot),
        clock: () => new Date(),
        useCache: true,
        ...skippedPasses,
      },
      path,
    );
    savingSource.saveSnapshot!('maintainer-a', new Date(snapshot.now));

    const { skipQuota, skipIssues } = snapshotSource(path, REPOS);
    assert.deepEqual({ skipQuota, skipIssues }, skippedPasses);
  }
});

test('recordingClient stores every answer that a snapshot needs', async () => {
  const github = snapshotClient(structuredClone(snapshot));
  const answers: GitHubAnswers = { pullRequests: [], mergedCounts: {}, issues: {} };
  const client = recordingClient(github, answers);

  const fetchedPR = await client.fetchPullRequest('example', 'repo', 1);
  // A run annotates the pull request that it fetched.
  fetchedPR.computed = { quotaExceeded: true };
  await client.countMergedPRs('example', 'repo', 'alice');
  await client.fetchIssues([
    { owner: 'example', repo: 'repo', number: 10 },
    { owner: 'example', repo: 'repo', number: 11 },
  ]);

  assert.deepEqual(answers, {
    pullRequests: [pullRequest('repo', 1, ['waiting-for-author'])],
    mergedCounts: snapshot.mergedCounts,
    issues: snapshot.issues,
  });
});
