import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_POLICY_AGES } from '../types.js';
import type { PullRequest } from '../types.js';
import { approvedIssue, carrying, NOW, pullRequest } from './pull-request-fixture.js';
import { reconcileBeforeWrite } from './reconcile.js';

test('a pull request that the plan closes is decided again from fresh facts', async () => {
  const expired = { linkedIssues: [], ...carrying(8, 'missing-issue', 'waiting-for-author') };
  // The cache holds both pull requests without an issue. The author of the
  // first one has linked an approved issue since.
  const cached = [
    pullRequest({ number: 1, url: 'https://github.com/example/repo/pull/1', ...expired }),
    pullRequest({
      number: 2,
      url: 'https://github.com/example/repo/pull/2',
      author: { login: 'another-contributor', typename: 'User' },
      ...expired,
    }),
    pullRequest({
      number: 3,
      url: 'https://github.com/example/repo/pull/3',
      author: { login: 'third-contributor', typename: 'User' },
      linkedIssues: [{ ...approvedIssue, number: 103 }],
    }),
  ];
  const fetched: number[] = [];
  const reconciliations = await reconcileBeforeWrite(
    {
      pullRequests: cached,
      quotaExemptLogins: new Set(),
      collaborators: { 'example/repo': { maintainer: 'ADMIN' } },
    },
    NOW,
    DEFAULT_POLICY_AGES,
    async (pr: PullRequest) => {
      fetched.push(pr.number);
      return pr.number === 1 ? { ...pr, linkedIssues: [{ ...approvedIssue, number: 101 }] } : pr;
    },
  );

  assert.deepEqual(fetched, [1, 2]);
  assert.deepEqual(
    reconciliations.map(({ plan }) => plan.shouldClose),
    [false, true, false],
  );
});
