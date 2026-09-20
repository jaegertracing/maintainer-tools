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
  test(`${role} PRs remain prioritized after a maintainer responds`, () => {
    const pr = pullRequest({
      author: { login, typename: 'User' },
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

test('trusted authors outrank explicit review requests', () => {
  const pr = pullRequest({
    author: { login: 'trusted-author', typename: 'User' },
    reviewRequests: [{ kind: 'user', login: 'maintainer-a' }],
  });

  const result = classify(pr, context);

  assert.equal(result.bucket, 'trusted-authors');
  assert.deepEqual(result.reasons, ['trusted author']);
});

test("the viewer's own PRs do not enter the trusted-author bucket", () => {
  const pr = pullRequest({
    author: { login: 'maintainer-a', typename: 'User' },
  });

  const result = classify(pr, { ...context, viewer: 'Maintainer-A' });

  assert.equal(result.bucket, 'codeowners-hits');
});

test('a review request makes a blocked trusted-author PR actionable', () => {
  const pr = pullRequest({
    author: { login: 'trusted-author', typename: 'User' },
    isDraft: true,
    reviewRequests: [{ kind: 'user', login: 'maintainer-a' }],
  });

  assert.equal(classify(pr, context).bucket, 'trusted-authors');
  assert.equal(classify(pr, { ...context, ignoreReviewRequestedOnYou: true }).bucket, 'hidden');
});

const hiddenCases: Array<[string, Partial<PullRequest>, string]> = [
  ['draft', { isDraft: true }, 'draft'],
  ['waiting for author', { labels: ['waiting-for-author'] }, 'waiting-for-author'],
  ['merge conflict', { mergeable: 'CONFLICTING' }, 'hide:merge_conflict'],
  [
    'requested changes still await the author',
    {
      reviews: [
        {
          author: 'maintainer-a',
          state: 'CHANGES_REQUESTED',
          submittedAt: '2026-09-20T12:00:00Z',
        },
      ],
    },
    'changes-requested',
  ],
];

for (const [state, overrides, reason] of hiddenCases) {
  test(`trusted-author PRs remain hidden when ${state}`, () => {
    const pr = pullRequest({
      author: { login: 'trusted-author', typename: 'User' },
      ...overrides,
    });

    const result = classify(pr, context);

    assert.equal(result.bucket, 'hidden');
    assert.deepEqual(result.reasons, [reason]);
  });
}
