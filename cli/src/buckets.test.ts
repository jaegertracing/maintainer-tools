import assert from 'node:assert/strict';
import test from 'node:test';

import type { PullRequest } from '@jaegertracing/maintainer-tools-checks';

import { classify, type ClassifyContext } from './buckets.js';

const now = new Date('2026-09-20T12:00:00Z');

const context: ClassifyContext = {
  viewer: 'maintainer-a',
  maintainers: new Set(['maintainer-a', 'trusted-maintainer']),
  interns: new Set(['trusted-author']),
  codeownerPaths: ['src/**'],
  now,
  ignoreReviewRequestedOnYou: false,
};

function pullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    repo: { owner: 'example', name: 'repo' },
    number: 1,
    title: 'Test trusted-author priority',
    url: 'https://github.com/example/repo/pull/1',
    author: { login: 'contributor', typename: 'User' },
    authorAssociation: 'CONTRIBUTOR',
    isDraft: false,
    mergeable: 'MERGEABLE',
    createdAt: '2026-09-19T12:00:00Z',
    updatedAt: '2026-09-20T11:00:00Z',
    labels: [],
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    files: ['src/example.test.ts'],
    statusCheckRollup: 'SUCCESS',
    commits: [
      {
        sha: 'abc1234',
        messageHeadline: 'Test trusted-author priority',
        messageBody: 'Signed-off-by: Contributor <contributor@example.com>',
        authorEmail: 'contributor@example.com',
        committedDate: '2026-09-20T11:00:00Z',
        parents: 1,
      },
    ],
    reviewRequests: [],
    reviews: [],
    comments: [],
    body: 'This pull request has a complete description.\n\nCloses #1',
    ...overrides,
  };
}

for (const [role, login] of [
  ['maintainer', 'trusted-maintainer'],
  ['intern', 'trusted-author'],
] as const) {
  test(`${role} PRs outrank other actionable categories after a maintainer responds`, () => {
    const pr = pullRequest({
      author: { login, typename: 'User' },
      reviewRequests: [{ kind: 'user', login: 'maintainer-a' }],
      reviews: [
        {
          author: 'maintainer-a',
          state: 'COMMENTED',
          submittedAt: '2026-09-20T09:00:00Z',
        },
      ],
      comments: [{ author: 'maintainer-a', createdAt: '2026-09-20T10:00:00Z' }],
      files: ['src/example.ts', 'src/example.test.ts'],
    });

    const result = classify(pr, context);

    assert.equal(result.bucket, 'trusted-authors');
    assert.deepEqual(result.reasons, ['trusted author']);
  });
}

test('trusted-author drafts remain hidden', () => {
  const pr = pullRequest({
    author: { login: 'trusted-author', typename: 'User' },
    isDraft: true,
  });

  const result = classify(pr, context);

  assert.equal(result.bucket, 'hidden');
  assert.deepEqual(result.reasons, ['draft']);
});
