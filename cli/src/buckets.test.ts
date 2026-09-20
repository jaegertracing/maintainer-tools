import assert from 'node:assert/strict';
import test from 'node:test';

import type { GraphqlClient, PullRequest } from '@jaegertracing/maintainer-tools-checks';

import { classify, type ClassifyContext } from './buckets.js';
import type { TriageConfig } from './config.js';
import { enrichQuotaState } from './quota.js';
import { renderHtml } from './render/html.js';
import { buildTriagePolicy, classifyAll } from './triage-policy.js';

const now = new Date();

function hoursAgo(hours: number): string {
  return new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString();
}

const context: ClassifyContext = {
  viewer: 'maintainer-a',
  maintainers: new Set(['Maintainer-A', 'Priority-Maintainer']),
  priorityAuthors: new Set(['Priority-Maintainer', 'Priority-Intern', 'Priority-Author']),
  codeownerPaths: ['src/**'],
  now,
  ignoreReviewRequestedOnYou: false,
};

function pullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    repo: { owner: 'example', name: 'repo' },
    number: 1,
    title: 'Test priority-author classification',
    url: 'https://github.com/example/repo/pull/1',
    author: { login: 'contributor', typename: 'User' },
    authorAssociation: 'CONTRIBUTOR',
    isDraft: false,
    mergeable: 'MERGEABLE',
    createdAt: hoursAgo(24),
    updatedAt: hoursAgo(1),
    labels: [],
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    files: ['src/example.test.ts'],
    statusCheckRollup: 'SUCCESS',
    commits: [
      {
        sha: 'abc1234',
        messageHeadline: 'Test priority-author classification',
        messageBody: 'Signed-off-by: Contributor <contributor@example.com>',
        authorEmail: 'contributor@example.com',
        committedDate: hoursAgo(1),
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

const triageConfig: TriageConfig = {
  repos: ['example/repo'],
  maintainers: ['Maintainer-B'],
  interns: ['Priority-Intern'],
  priorityAuthors: ['Priority-Author'],
  codeowners: {},
  cachePath: ':memory:',
  priorityLabels: [],
  ignoreReviewRequestedOnYou: false,
};

test('triage policy wires every priority source into classification and quota', async () => {
  const prs = [
    pullRequest({ number: 1, author: { login: 'priority-author', typename: 'User' } }),
    pullRequest({ number: 2, author: { login: 'priority-author', typename: 'User' } }),
    pullRequest({ number: 3, author: { login: 'maintainer-b', typename: 'User' } }),
    pullRequest({ number: 4, author: { login: 'maintainer-b', typename: 'User' } }),
    pullRequest({ number: 5, author: { login: 'priority-intern', typename: 'User' } }),
    pullRequest({ number: 6, author: { login: 'priority-intern', typename: 'User' } }),
  ];
  const policy = buildTriagePolicy(triageConfig);
  let mergedCountCalls = 0;
  const client = {
    countMergedPRs: async () => {
      mergedCountCalls++;
      return 0;
    },
  } as unknown as GraphqlClient;

  await enrichQuotaState(prs, client, { exemptLogins: policy.priorityAuthors });

  assert.equal(mergedCountCalls, 0);
  assert.deepEqual(
    classifyAll(prs, 'maintainer-a', policy, now).map((result) => result.bucket),
    [
      'priority-authors',
      'priority-authors',
      'priority-authors',
      'priority-authors',
      'priority-authors',
      'priority-authors',
    ],
  );
});

for (const [role, login] of [
  ['maintainer', 'priority-maintainer'],
  ['intern', 'priority-intern'],
  ['priority author', 'priority-author'],
] as const) {
  test(`${role} PRs remain prioritized after a maintainer responds`, () => {
    const pr = pullRequest({
      author: { login, typename: 'User' },
      reviews: [
        {
          author: 'maintainer-a',
          state: 'COMMENTED',
          submittedAt: hoursAgo(3),
        },
      ],
      comments: [{ author: 'maintainer-a', createdAt: hoursAgo(2) }],
      files: ['src/example.ts', 'src/example.test.ts'],
    });

    const result = classify(pr, context);

    assert.equal(result.bucket, 'priority-authors');
    assert.deepEqual(result.reasons, ['priority author']);
  });
}

test('priority authors outrank explicit review requests', () => {
  const pr = pullRequest({
    author: { login: 'priority-author', typename: 'User' },
    reviewRequests: [{ kind: 'user', login: 'MAINTAINER-A' }],
  });

  const result = classify(pr, context);

  assert.equal(result.bucket, 'priority-authors');
  assert.deepEqual(result.reasons, ['priority author']);
});

test('priority authors remain prioritized after revising requested changes', () => {
  const pr = pullRequest({
    author: { login: 'priority-author', typename: 'User' },
    reviews: [
      {
        author: 'MAINTAINER-A',
        state: 'CHANGES_REQUESTED',
        submittedAt: hoursAgo(3),
      },
    ],
  });

  assert.equal(classify(pr, context).bucket, 'priority-authors');
});

test("the viewer's own PRs do not enter the priority-author bucket", () => {
  const pr = pullRequest({
    author: { login: 'maintainer-a', typename: 'User' },
  });

  const result = classify(pr, { ...context, viewer: 'Maintainer-A' });

  assert.equal(result.bucket, 'codeowners-hits');
  assert.match(
    renderHtml([result], {
      viewer: 'Maintainer-A',
      now,
      authorOpenCounts: new Map(),
    }),
    /@maintainer-a<\/a> <span class="role-tag">you<\/span>/,
  );
});

test('a review request makes a blocked priority-author PR actionable', () => {
  const pr = pullRequest({
    author: { login: 'priority-author', typename: 'User' },
    isDraft: true,
    reviewRequests: [{ kind: 'user', login: 'MAINTAINER-A' }],
  });

  assert.equal(classify(pr, context).bucket, 'priority-authors');
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
          author: 'MAINTAINER-A',
          state: 'CHANGES_REQUESTED',
          submittedAt: hoursAgo(0.5),
        },
      ],
    },
    'changes-requested',
  ],
];

for (const [state, overrides, reason] of hiddenCases) {
  test(`priority-author PRs remain hidden when ${state}`, () => {
    const pr = pullRequest({
      author: { login: 'priority-author', typename: 'User' },
      ...overrides,
    });

    const result = classify(pr, context);

    assert.equal(result.bucket, 'hidden');
    assert.deepEqual(result.reasons, [reason]);
    assert.equal(result.facets.priorityAuthor, true);
    assert.deepEqual(result.facets.hideReasons, [reason]);
  });
}

test('facets flag non-dependency bots as a hide reason', () => {
  const result = classify(
    pullRequest({ author: { login: 'some-helper[bot]', typename: 'Bot' } }),
    context,
  );

  assert.equal(result.bucket, 'hidden');
  assert.deepEqual(result.facets.hideReasons, ['bot-authored']);
  assert.equal(result.facets.bot, true);
  assert.equal(result.facets.dependencyBot, false);
});

test('facets record every hide reason even though the bucket stops at the first', () => {
  const pr = pullRequest({
    author: { login: 'priority-author', typename: 'User' },
    isDraft: true,
    mergeable: 'CONFLICTING',
    labels: ['waiting-for-author'],
  });

  const result = classify(pr, context);

  assert.equal(result.bucket, 'hidden');
  assert.deepEqual(result.reasons, ['draft']);
  assert.deepEqual(result.facets.hideReasons, [
    'draft',
    'hide:merge_conflict',
    'waiting-for-author',
  ]);
  assert.equal(result.facets.priorityAuthor, true);
  assert.equal(result.copilot, null);
});

test('priority-author quota exemptions are case-insensitive', async () => {
  const prs = [
    pullRequest({ number: 1, author: { login: 'priority-author', typename: 'User' } }),
    pullRequest({ number: 2, author: { login: 'priority-author', typename: 'User' } }),
  ];
  let mergedCountCalls = 0;
  const client = {
    countMergedPRs: async () => {
      mergedCountCalls++;
      return 0;
    },
  } as unknown as GraphqlClient;

  await enrichQuotaState(prs, client, { exemptLogins: new Set(['Priority-Author']) });

  assert.equal(mergedCountCalls, 0);
  assert.deepEqual(
    prs.map((pr) => classify(pr, context).bucket),
    ['priority-authors', 'priority-authors'],
  );
});

test('maintainer activity is case-insensitive for first-response buckets', () => {
  const pr = pullRequest({
    authorAssociation: 'FIRST_TIMER',
    comments: [{ author: 'maintainer-a', createdAt: hoursAgo(2) }],
  });

  assert.equal(classify(pr, context).bucket, 'codeowners-hits');
});

test('priority-author activity does not count as a maintainer response', () => {
  const pr = pullRequest({
    authorAssociation: 'FIRST_TIMER',
    comments: [{ author: 'priority-author', createdAt: hoursAgo(2) }],
    files: ['docs/example.md'],
  });

  assert.equal(classify(pr, context).bucket, 'first-timer-awaiting');
});

test('author replies are case-insensitive for bottleneck detection', () => {
  const pr = pullRequest({
    reviews: [
      {
        author: 'MAINTAINER-A',
        state: 'COMMENTED',
        submittedAt: hoursAgo(3),
      },
    ],
    commits: [
      {
        sha: 'abc1234',
        messageHeadline: 'Test priority-author classification',
        messageBody: 'Signed-off-by: Contributor <contributor@example.com>',
        authorEmail: 'contributor@example.com',
        committedDate: hoursAgo(4),
        parents: 1,
      },
    ],
    comments: [{ author: 'CONTRIBUTOR', createdAt: hoursAgo(2) }],
  });

  assert.equal(classify(pr, context).bucket, 'youre-the-bottleneck');
});

test('priority-author issue flags use case-insensitive membership', () => {
  const ref = { owner: 'example', repo: 'repo', number: 1 };
  const pr = pullRequest({
    author: { login: 'priority-author', typename: 'User' },
    computed: {
      issueRefs: [ref],
      issueMeta: {
        'example/repo#1': {
          author: 'priority-author',
          state: 'OPEN',
          title: 'Example issue',
          isPullRequest: false,
        },
      },
    },
  });

  assert.equal(classify(pr, context).flags.includes('SELF-FILED'), false);
});
