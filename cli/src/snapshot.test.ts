import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { GraphqlClient, PullRequest } from '@jaegertracing/maintainer-tools-checks';

import { type GatherOptions, gatherSnapshot, readSnapshot, writeSnapshot } from './snapshot.js';

function pullRequest(number: number, login: string, body: string): PullRequest {
  return {
    repo: { owner: 'example', name: 'repo' },
    number,
    author: { login, typename: 'User' },
    body,
  } as PullRequest;
}

const pullRequests = [
  pullRequest(1, 'alice', 'Closes #10'),
  pullRequest(2, 'alice', 'Closes #11'),
  pullRequest(3, 'bob', ''),
  pullRequest(4, 'maintainer-b', ''),
  pullRequest(5, 'maintainer-b', ''),
];

const github: GraphqlClient = {
  usage: () => ({ requests: 0, pointsSpent: 0 }),
  fetchViewerLogin: async () => 'maintainer-a',
  listOpenPRs: async () =>
    pullRequests.map((pr) => ({
      number: pr.number,
      updatedAt: '2026-05-01T00:00:00Z',
      headSha: 'abc',
      headRollup: 'SUCCESS',
      linkedIssues: [],
    })),
  listOpenPRsByLabel: async () => [],
  fetchPullRequest: async (_owner, _repo, number) =>
    structuredClone(pullRequests.find((pr) => pr.number === number)!),
  countMergedPRs: async (_owner, _repo, author) => (author === 'alice' ? 2 : 99),
  fetchCollaborators: async () => ({ 'maintainer-b': 'WRITE' }),
};

const options: GatherOptions = {
  repos: ['example/repo'],
  quotaExemptLogins: new Set(['maintainer-b']),
  skipQuota: false,
};

test('the snapshot holds everything that the run takes from GitHub', async () => {
  const startMs = Date.now();
  const snapshot = await gatherSnapshot(github, null, options);

  assert.equal(snapshot.viewer, 'maintainer-a');
  assert.deepEqual(snapshot.pullRequests, pullRequests);
  // Only alice can exceed a quota: bob has one open pull request, and
  // maintainer-b is exempt.
  assert.deepEqual(snapshot.mergedCounts, { 'example/repo|alice': 2 });
  assert.deepEqual(snapshot.collaborators, { 'example/repo': { 'maintainer-b': 'WRITE' } });
  assert.ok(Date.parse(snapshot.now) >= startMs && Date.parse(snapshot.now) <= Date.now());
});

test('the snapshot has no collaborators of a repository when GitHub refuses the list', async () => {
  const snapshot = await gatherSnapshot(
    {
      ...github,
      fetchPullRequest: async (owner, repo, number) => ({
        ...pullRequests.find((pr) => pr.number === number)!,
        repo: { owner, name: repo },
      }),
      fetchCollaborators: async (_owner, repo) => {
        if (repo === 'refused') throw new Error('the token needs push access');
        return { [`maintainer-of-${repo}`]: 'WRITE' };
      },
    },
    null,
    { ...options, repos: ['example/first', 'example/refused', 'example/last'] },
  );

  assert.deepEqual(snapshot.collaborators, {
    'example/first': { 'maintainer-of-first': 'WRITE' },
    'example/last': { 'maintainer-of-last': 'WRITE' },
  });
  assert.equal(snapshot.pullRequests.length, 3 * pullRequests.length);
});

test('the snapshot has no merged counts when the run skips the quota', async () => {
  const snapshot = await gatherSnapshot(
    { ...github, countMergedPRs: async () => assert.fail('the merged counts are skipped') },
    null,
    { ...options, skipQuota: true },
  );

  assert.equal(snapshot.mergedCounts, undefined);
});

test('readSnapshot returns the pull requests in the order of the config repositories', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'snapshot-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const path = join(dir, 'snapshot.json');
  const pullRequestInRepo = (name: string, number: number) => ({
    ...pullRequest(number, 'alice', ''),
    repo: { owner: 'example', name },
  });
  writeSnapshot(path, {
    now: '2026-06-01T12:00:00.000Z',
    viewer: 'maintainer-a',
    pullRequests: [pullRequestInRepo('b', 2), pullRequestInRepo('a', 3), pullRequestInRepo('b', 1)],
  });

  const snapshot = readSnapshot(path, ['example/a', 'example/b']);

  assert.deepEqual(
    snapshot.pullRequests.map((pr) => `${pr.repo.name}#${pr.number}`),
    ['a#3', 'b#2', 'b#1'],
  );
});

test('a viewer from the command line or the config is not asked from GitHub', async () => {
  const snapshot = await gatherSnapshot(
    { ...github, fetchViewerLogin: async () => assert.fail('the viewer is configured') },
    null,
    { ...options, viewer: 'maintainer-c' },
  );

  assert.equal(snapshot.viewer, 'maintainer-c');
});
