import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  GraphqlClient,
  LinkedIssue,
  PullRequest,
} from '@jaegertracing/maintainer-tools-checks';
import { openCache } from '@jaegertracing/maintainer-tools-checks/cache';

import { scanRepos } from './scan.js';

test('a cached pull request is fetched again when a linked issue changes', async () => {
  let linkedIssue: LinkedIssue = {
    owner: 'example',
    repo: 'repo',
    number: 10,
    state: 'OPEN',
    labels: ['help wanted'],
  };
  // GitHub does not advance `updatedAt` of a pull request when a linked
  // issue changes, so the stub keeps every other field of the summary.
  const github = {
    listOpenPRs: async () => [
      {
        number: 1,
        updatedAt: '2026-05-01T00:00:00Z',
        headSha: 'abc',
        headRollup: 'SUCCESS',
        linkedIssues: [linkedIssue],
      },
    ],
    fetchPullRequest: async () =>
      ({
        repo: { owner: 'example', name: 'repo' },
        number: 1,
        updatedAt: '2026-05-01T00:00:00Z',
        commits: [{ sha: 'abc' }],
        statusCheckRollup: 'SUCCESS',
        linkedIssues: [linkedIssue],
      }) as PullRequest,
  } as unknown as GraphqlClient;
  const cache = openCache(':memory:');
  const scan = async () => {
    const { prs, cacheHits } = await scanRepos(['example/repo'], github, cache);
    return { cacheHits, linkedIssues: prs[0]!.linkedIssues };
  };

  await scan();
  assert.deepEqual(await scan(), { cacheHits: 1, linkedIssues: [linkedIssue] });

  // The second change keeps the state of the first, so that only the labels
  // differ from what the cache holds.
  const closedIssue = { ...linkedIssue, state: 'CLOSED' as const };
  for (const changedIssue of [closedIssue, { ...closedIssue, labels: [] }]) {
    linkedIssue = changedIssue;
    assert.deepEqual(await scan(), { cacheHits: 0, linkedIssues: [changedIssue] });
  }
});
