import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  GraphqlClient,
  LinkedIssue,
  OpenPullRequests,
  PullRequest,
} from '@jaegertracing/maintainer-tools-checks';

import { classify, type ClassifyContext } from './buckets.js';
import type { TriageConfig } from './config.js';
import { fetchMergedCounts } from './quota.js';
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

const contextWithCollaborators: ClassifyContext = {
  ...context,
  openPullRequests: {
    pullRequests: [],
    quotaExemptLogins: new Set(),
    collaborators: {
      'example/repo': {
        admin: 'ADMIN',
        maintainer: 'MAINTAIN',
        writer: 'WRITE',
        triager: 'TRIAGE',
        reader: 'READ',
      },
    },
  },
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
        authorLogin: 'contributor',
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

  const openPullRequests: OpenPullRequests = {
    pullRequests: prs,
    mergedCounts: await fetchMergedCounts(prs, client, policy.priorityAuthors),
    quotaExemptLogins: policy.priorityAuthors,
  };

  assert.equal(mergedCountCalls, 0);
  assert.deepEqual(
    classifyAll(openPullRequests, 'maintainer-a', policy, now).map((result) => result.bucket),
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

function linkedIssue(overrides: Partial<LinkedIssue> = {}): LinkedIssue {
  return {
    owner: 'example',
    repo: 'repo',
    number: 100,
    state: 'OPEN',
    labels: ['help wanted'],
    ...overrides,
  };
}

function isFlaggedNoIssue(
  pr: PullRequest,
  ctx: ClassifyContext = contextWithCollaborators,
): boolean {
  const result = classify(pr, ctx);
  const isFlagged = result.flags.includes('NO-APPROVED-ISSUE');
  assert.equal(result.facets.hideReasons.includes('hide:no_approved_issue'), isFlagged);
  return isFlagged;
}

const linkedIssuesCases: Array<[string, LinkedIssue[], boolean]> = [
  ['no issue', [], true],
  ['a closed issue', [linkedIssue({ state: 'CLOSED' })], true],
  ['an issue without `help wanted`', [linkedIssue({ labels: ['bug'] })], true],
  ['an issue of another organization', [linkedIssue({ owner: 'other' })], true],
  [
    'an approved issue whose owner GitHub spells in another case',
    [linkedIssue({ owner: 'Example' })],
    false,
  ],
  ['an open `help wanted` issue of another repository', [linkedIssue({ repo: 'ui' })], false],
  [
    'an approved issue beside a closed one',
    [linkedIssue({ state: 'CLOSED' }), linkedIssue()],
    false,
  ],
];

for (const [linked, linkedIssues, expected] of linkedIssuesCases) {
  test(`a PR of an outside contributor that links ${linked} ${expected ? 'needs' : 'does not need'} an issue`, () => {
    assert.equal(isFlaggedNoIssue(pullRequest({ linkedIssues })), expected);
  });
}

test('a PR whose linked issues were not gathered does not need an issue', () => {
  assert.equal(isFlaggedNoIssue(pullRequest({ labels: ['missing-issue'], body: '' })), false);
});

test('the no-issue-needed label exempts a PR that links no issue', () => {
  const pr = pullRequest({ linkedIssues: [], labels: ['no-issue-needed'] });

  assert.equal(isFlaggedNoIssue(pr), false);
  assert.equal(isFlaggedNoIssue({ ...pr, labels: ['docs'] }), true);
});

test('an author who can write to the repository needs no issue', () => {
  const authorCases: Array<[string, boolean]> = [
    ['admin', false],
    ['MAINTAINER', false],
    ['writer', false],
    ['triager', true],
    ['reader', true],
  ];

  for (const [login, expected] of authorCases) {
    const pr = pullRequest({ linkedIssues: [], author: { login, typename: 'User' } });
    assert.equal(isFlaggedNoIssue(pr), expected, login);
  }
});

test('a dependency bot needs no issue', () => {
  const pr = pullRequest({ linkedIssues: [], author: { login: 'renovate-bot', typename: 'Bot' } });

  assert.equal(isFlaggedNoIssue(pr), false);
});

test('no PR needs an issue when the collaborators of its repository were not gathered', () => {
  const pr = pullRequest({ linkedIssues: [] });
  const otherRepository = { ...pr, repo: { owner: 'example', name: 'ui' } };

  assert.equal(isFlaggedNoIssue(pr, context), false);
  assert.equal(isFlaggedNoIssue(otherRepository), false);
});

function numbersOfDuplicates(pullRequests: PullRequest[]): number[] {
  const openPullRequests: OpenPullRequests = { pullRequests, quotaExemptLogins: new Set() };
  return pullRequests
    .filter((pr) =>
      classify(pr, { ...context, openPullRequests }).facets.hideReasons.includes(
        'hide:is_duplicate',
      ),
    )
    .map((pr) => pr.number);
}

function pullRequestClosing(
  issue: LinkedIssue,
  number: number,
  createdAt: string,
  overrides: Partial<PullRequest> = {},
): PullRequest {
  return pullRequest({ number, createdAt, linkedIssues: [issue], ...overrides });
}

test('every open PR that closes an issue is a duplicate, except the oldest', () => {
  const pullRequests = [
    pullRequestClosing(linkedIssue(), 7, hoursAgo(2)),
    pullRequestClosing(linkedIssue(), 9, hoursAgo(3)),
    pullRequestClosing(linkedIssue(), 8, hoursAgo(1)),
    pullRequestClosing(linkedIssue({ number: 101 }), 10, hoursAgo(1)),
  ];

  assert.deepEqual(numbersOfDuplicates(pullRequests), [7, 8]);
  // A consumer that evaluates each PR alone passes no open PRs.
  for (const pr of pullRequests) {
    assert.deepEqual(classify(pr, context).facets.hideReasons, []);
  }
});

test('the creation times of two PRs are compared as times and not as text', () => {
  const pullRequests = [
    pullRequestClosing(linkedIssue(), 7, '2026-05-01T10:00:00Z'),
    pullRequestClosing(linkedIssue(), 8, '2026-05-01T10:00:00.000Z'),
    pullRequestClosing(linkedIssue(), 9, '2026-05-01T09:59:59.500Z'),
  ];

  assert.deepEqual(numbersOfDuplicates(pullRequests), [7, 8]);
});

test('of two PRs created at the same time, the one with the higher number is the duplicate', () => {
  const createdAt = hoursAgo(1);
  const pullRequests = [
    pullRequestClosing(linkedIssue(), 8, createdAt),
    pullRequestClosing(linkedIssue(), 7, createdAt),
  ];

  assert.deepEqual(numbersOfDuplicates(pullRequests), [8]);
});

test('an issue labelled allow-multiple-prs has no duplicate PR', () => {
  const issue = linkedIssue({ labels: ['help wanted', 'allow-multiple-prs'] });
  const pullRequests = [
    pullRequestClosing(issue, 7, hoursAgo(2)),
    pullRequestClosing(issue, 8, hoursAgo(1)),
  ];

  assert.deepEqual(numbersOfDuplicates(pullRequests), []);
});

test('only PRs of the repository of the issue are duplicates', () => {
  const uiRepository = { owner: 'example', name: 'ui' };
  const pullRequests = [
    pullRequestClosing(linkedIssue(), 7, hoursAgo(3), { repo: uiRepository }),
    pullRequestClosing(linkedIssue(), 8, hoursAgo(2)),
    pullRequestClosing(linkedIssue(), 9, hoursAgo(1), { repo: uiRepository }),
    pullRequestClosing(linkedIssue(), 10, hoursAgo(1)),
  ];

  assert.deepEqual(numbersOfDuplicates(pullRequests), [10]);
});

test('the allow-multiple-prs label of one issue does not exempt another issue of the PR', () => {
  const issueAllowingMultiplePrs = linkedIssue({
    number: 101,
    labels: ['help wanted', 'allow-multiple-prs'],
  });
  const pullRequests = [
    pullRequestClosing(linkedIssue(), 7, hoursAgo(2)),
    pullRequestClosing(issueAllowingMultiplePrs, 8, hoursAgo(2)),
    pullRequestClosing(linkedIssue(), 9, hoursAgo(1), {
      linkedIssues: [issueAllowingMultiplePrs, linkedIssue()],
    }),
    pullRequestClosing(issueAllowingMultiplePrs, 10, hoursAgo(1)),
  ];

  assert.deepEqual(numbersOfDuplicates(pullRequests), [9]);
});

function isAuthorsTurn(overrides: Partial<PullRequest>): boolean {
  const result = classify(pullRequest(overrides), contextWithCollaborators);
  const isFlagged = result.flags.includes('AUTHORS-TURN');
  assert.equal(result.facets.hideReasons.includes('hide:authors_turn'), isFlagged);
  return isFlagged;
}

// The pull request of `pullRequest()` has one commit, made an hour ago by
// its author `contributor`.
const authorsTurnCases: Array<[string, Partial<PullRequest>, boolean]> = [
  ['a maintainer commented after the last push', commentedBy('writer', 0.5), true],
  ['a maintainer commented before the last push', commentedBy('writer', 2), false],
  [
    'a maintainer requested changes after the last push',
    reviewedByWriter('CHANGES_REQUESTED'),
    true,
  ],
  ['a maintainer reviewed with comments after the last push', reviewedByWriter('COMMENTED'), true],
  ['a maintainer approved after the last push', reviewedByWriter('APPROVED'), false],
  [
    'a maintainer approved after their own request for changes and their own comment',
    {
      comments: [{ author: 'writer', createdAt: hoursAgo(0.5) }],
      reviews: [
        { author: 'writer', state: 'CHANGES_REQUESTED', submittedAt: hoursAgo(0.5) },
        { author: 'Writer', state: 'APPROVED', submittedAt: hoursAgo(0.25) },
      ],
    },
    false,
  ],
  [
    'a maintainer approved after the request for changes of another maintainer',
    {
      reviews: [
        { author: 'writer', state: 'CHANGES_REQUESTED', submittedAt: hoursAgo(0.5) },
        { author: 'admin', state: 'APPROVED', submittedAt: hoursAgo(0.25) },
      ],
    },
    true,
  ],
  [
    'a maintainer commented after their own approval',
    {
      comments: [{ author: 'writer', createdAt: hoursAgo(0.25) }],
      reviews: [{ author: 'writer', state: 'APPROVED', submittedAt: hoursAgo(0.5) }],
    },
    true,
  ],
  ['nobody but the author commented', commentedBy('contributor', 0.5), false],
  ['a collaborator without write access commented', commentedBy('triager', 0.5), false],
  ['a person who is not a collaborator commented', commentedBy('passer-by', 0.5), false],
  [
    'the author answered the maintainer',
    {
      comments: [
        { author: 'writer', createdAt: hoursAgo(0.5) },
        { author: 'Contributor', createdAt: hoursAgo(0.25) },
      ],
    },
    false,
  ],
  [
    'the latest comment of the maintainer is a policy comment',
    {
      comments: [
        {
          author: 'writer',
          createdAt: hoursAgo(0.5),
          body: '<!-- jaeger-pr-linked-issue -->\nThis PR is not linked to an issue.',
        },
      ],
    },
    false,
  ],
  [
    'the only answer of the author is a policy comment',
    {
      comments: [
        { author: 'writer', createdAt: hoursAgo(0.5) },
        {
          author: 'contributor',
          createdAt: hoursAgo(0.25),
          body: '<!-- jaeger-pr-linked-issue -->\nThis PR is not linked to an issue.',
        },
      ],
    },
    true,
  ],
  [
    'the author quoted the stale notice in the answer to the maintainer',
    {
      comments: [
        { author: 'writer', createdAt: hoursAgo(0.5) },
        {
          author: 'contributor',
          createdAt: hoursAgo(0.25),
          body: '> This pull request has been automatically marked as stale.\nStill working on it.',
        },
      ],
    },
    false,
  ],
  [
    'the author merged the base branch after the comment of the maintainer',
    {
      comments: [{ author: 'writer', createdAt: hoursAgo(0.5) }],
      commits: [
        { ...pullRequest().commits[0]!, committedDate: hoursAgo(1) },
        {
          ...pullRequest().commits[0]!,
          committedDate: hoursAgo(0.25),
          parents: 2,
          authorLogin: 'Contributor',
        },
      ],
    },
    false,
  ],
  [
    'the maintainer merged the base branch after their own comment',
    {
      comments: [{ author: 'writer', createdAt: hoursAgo(0.5) }],
      commits: [
        { ...pullRequest().commits[0]!, committedDate: hoursAgo(1) },
        {
          ...pullRequest().commits[0]!,
          committedDate: hoursAgo(0.25),
          parents: 2,
          authorLogin: 'writer',
        },
      ],
    },
    true,
  ],
  [
    'a commit of a second account followed the comment of the maintainer',
    {
      comments: [{ author: 'writer', createdAt: hoursAgo(0.5) }],
      commits: [
        {
          ...pullRequest().commits[0]!,
          committedDate: hoursAgo(0.25),
          authorLogin: 'second-account',
        },
      ],
    },
    false,
  ],
  [
    'a commit of no known account followed the comment of the maintainer',
    {
      comments: [{ author: 'writer', createdAt: hoursAgo(0.5) }],
      commits: [{ ...pullRequest().commits[0]!, committedDate: hoursAgo(0.25), authorLogin: null }],
    },
    false,
  ],
  [
    'the author answered in a review thread, which GitHub records as a review',
    {
      reviews: [
        { author: 'writer', state: 'CHANGES_REQUESTED', submittedAt: hoursAgo(0.5) },
        { author: 'contributor', state: 'COMMENTED', submittedAt: hoursAgo(0.25) },
      ],
    },
    false,
  ],
  [
    'a maintainer commented on a PR without a commit or a comment of the author',
    { commits: [], ...commentedBy('writer', 0.5) },
    true,
  ],
  [
    'the author is a maintainer who commented on their own PR',
    { author: { login: 'writer', typename: 'User' }, ...commentedBy('writer', 0.5) },
    false,
  ],
];

function commentedBy(author: string, hours: number): Partial<PullRequest> {
  return { comments: [{ author, createdAt: hoursAgo(hours) }] };
}

function reviewedByWriter(
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED',
): Partial<PullRequest> {
  return { reviews: [{ author: 'writer', state, submittedAt: hoursAgo(0.5) }] };
}

for (const [activity, overrides, expected] of authorsTurnCases) {
  test(`it is ${expected ? '' : 'not '}the turn of the author when ${activity}`, () => {
    assert.equal(isAuthorsTurn(overrides), expected);
  });
}

test('it is the turn of no author when the collaborators were not gathered', () => {
  const result = classify(pullRequest(commentedBy('writer', 0.5)), context);

  assert.deepEqual(result.facets.hideReasons, []);
});

test('the author who answers the requested changes of the viewer in a review thread has revised', () => {
  const pr = pullRequest({
    reviews: [
      { author: 'maintainer-a', state: 'CHANGES_REQUESTED', submittedAt: hoursAgo(0.5) },
      { author: 'contributor', state: 'COMMENTED', submittedAt: hoursAgo(0.25) },
    ],
  });

  for (const contextOfRun of [context, contextWithCollaborators]) {
    assert.equal(classify(pr, contextOfRun).bucket, 'changes-requested-revised');
  }
});

test('the author has not revised when a maintainer merged the base branch after the requested changes of the viewer', () => {
  const pr = pullRequest({
    reviews: [{ author: 'maintainer-a', state: 'CHANGES_REQUESTED', submittedAt: hoursAgo(0.5) }],
    commits: [
      pullRequest().commits[0]!,
      {
        ...pullRequest().commits[0]!,
        committedDate: hoursAgo(0.25),
        parents: 2,
        authorLogin: 'writer',
      },
    ],
  });

  assert.deepEqual(classify(pr, context).facets.hideReasons, ['changes-requested']);
});

test('the author has not revised when the pull request changed after the requested changes of the viewer without a commit of the author', () => {
  const pr = pullRequest({
    reviews: [{ author: 'maintainer-a', state: 'CHANGES_REQUESTED', submittedAt: hoursAgo(0.5) }],
    commits: [],
    updatedAt: hoursAgo(0.25),
  });

  assert.deepEqual(classify(pr, context).facets.hideReasons, ['changes-requested']);
});

test('the author has revised when a commit that is not the last one is newer than the requested changes of the viewer', () => {
  const pr = pullRequest({
    reviews: [{ author: 'maintainer-a', state: 'CHANGES_REQUESTED', submittedAt: hoursAgo(0.5) }],
    commits: [
      { ...pullRequest().commits[0]!, committedDate: hoursAgo(0.25) },
      { ...pullRequest().commits[0]!, committedDate: hoursAgo(1) },
    ],
  });

  assert.equal(classify(pr, context).bucket, 'changes-requested-revised');
});

const hiddenCases: Array<[string, Partial<PullRequest>, string]> = [
  ['draft', { isDraft: true }, 'draft'],
  [
    'waiting for author',
    { comments: [{ author: 'writer', createdAt: hoursAgo(0.5) }] },
    'hide:authors_turn',
  ],
  ['merge conflict', { mergeable: 'CONFLICTING' }, 'hide:merge_conflict'],
  ['missing issue', { linkedIssues: [] }, 'hide:no_approved_issue'],
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

    const result = classify(pr, contextWithCollaborators);

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
  assert.equal(result.facets.dependencyBot, false);
});

for (const [login, typename] of [
  ['dependabot', 'Bot'],
  ['renovate', 'Bot'],
  ['renovate-bot', 'User'],
] as const) {
  test(`dependency bots with an unbracketed login (${login}) get their own bucket`, () => {
    const result = classify(pullRequest({ author: { login, typename } }), context);

    assert.equal(result.bucket, 'dependency-bots');
    assert.equal(result.facets.dependencyBot, true);
    assert.ok(
      result.flags.includes('BOT-AUTHORED'),
      'every dependency bot must carry the BOT-AUTHORED row flag',
    );
  });
}

test('dependency bots land in their own bucket even when draft, conflicted, or CI-red', () => {
  const pr = pullRequest({
    author: { login: 'renovate-bot', typename: 'User' },
    isDraft: true,
    mergeable: 'CONFLICTING',
    statusCheckRollup: 'FAILURE',
  });

  const result = classify(pr, context);

  assert.equal(result.bucket, 'dependency-bots');
  assert.deepEqual(result.reasons, ['dependency bot']);
});

test('dependency bots still hide-check-trigger PRs land in their own bucket, not hidden', () => {
  const pr = pullRequest({
    author: { login: 'renovate-bot', typename: 'User' },
    labels: ['stale'],
  });

  const result = classify(pr, context);

  assert.ok(
    result.facets.hideReasons.includes('hide:stale_on_author'),
    'the stale label must actually trip a predicate that hides for this to test anything',
  );
  assert.equal(result.bucket, 'dependency-bots');
});

test('an explicit review request on a dependency bot PR overrides the bot bucket', () => {
  const pr = pullRequest({
    author: { login: 'renovate-bot', typename: 'User' },
    reviewRequests: [{ kind: 'user', login: 'MAINTAINER-A' }],
  });

  const result = classify(pr, context);

  assert.equal(result.bucket, 'review-requested-on-you');
  assert.equal(result.facets.dependencyBot, true);
});

test('ignoreReviewRequestedOnYou sends a requested dependency bot PR to its own bucket, not to you', () => {
  const pr = pullRequest({
    author: { login: 'renovate-bot', typename: 'User' },
    reviewRequests: [{ kind: 'user', login: 'MAINTAINER-A' }],
  });

  const result = classify(pr, { ...context, ignoreReviewRequestedOnYou: true });

  assert.equal(result.bucket, 'dependency-bots');
});

test('facets record every hide reason even though the bucket stops at the first', () => {
  const pr = pullRequest({
    author: { login: 'priority-author', typename: 'User' },
    isDraft: true,
    mergeable: 'CONFLICTING',
    comments: [{ author: 'writer', createdAt: hoursAgo(0.5) }],
  });

  const result = classify(pr, contextWithCollaborators);

  assert.equal(result.bucket, 'hidden');
  assert.deepEqual(result.reasons, ['draft']);
  assert.deepEqual(result.facets.hideReasons, [
    'draft',
    'hide:merge_conflict',
    'hide:authors_turn',
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

  const exemptLogins = new Set(['Priority-Author']);
  const openPullRequests: OpenPullRequests = {
    pullRequests: prs,
    mergedCounts: await fetchMergedCounts(prs, client, exemptLogins),
    quotaExemptLogins: exemptLogins,
  };

  assert.equal(mergedCountCalls, 0);
  assert.deepEqual(
    prs.map((pr) => classify(pr, { ...context, openPullRequests }).bucket),
    ['priority-authors', 'priority-authors'],
  );
});

test('the newer pull request of an author with a quota of one is hidden', () => {
  const prs = [
    pullRequest({ number: 2, createdAt: hoursAgo(24) }),
    pullRequest({ number: 1, createdAt: hoursAgo(48) }),
  ];
  const openPullRequests: OpenPullRequests = {
    pullRequests: prs,
    mergedCounts: { 'example/repo|contributor': 0 },
    quotaExemptLogins: new Set(),
  };

  // classify() receives a copy of each pull request, because a caller can
  // read a pull request from a source other than `openPullRequests`.
  assert.deepEqual(
    prs.map((pr) =>
      classify(structuredClone(pr), {
        ...context,
        openPullRequests,
      }).facets.hideReasons.includes('hide:over_quota'),
    ),
    [true, false],
  );
});

test('the `pr-quota-reached` label does not put a pull request over the quota', () => {
  const pr = pullRequest({ labels: ['pr-quota-reached'] });
  const openPullRequests: OpenPullRequests = {
    pullRequests: [pr],
    mergedCounts: {},
    quotaExemptLogins: new Set(),
  };

  for (const ctx of [context, { ...context, openPullRequests }]) {
    assert.deepEqual(classify(pr, ctx).facets.hideReasons, []);
  }
});

test('a snapshot without the merged count of a quota candidate is rejected', () => {
  const prs = [pullRequest({ number: 1 }), pullRequest({ number: 2 })];
  const openPullRequests: OpenPullRequests = {
    pullRequests: prs,
    mergedCounts: {},
    quotaExemptLogins: new Set(),
  };
  assert.throws(
    () => classify(prs[0]!, { ...context, openPullRequests }),
    /no merged-PR count for @contributor in example\/repo/,
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

test('the stale check uses the injected clock, not the wall clock', () => {
  const past = new Date('2020-01-10T00:00:00Z');
  const pr = pullRequest({
    createdAt: '2020-01-01T00:00:00Z',
    updatedAt: '2020-01-09T00:00:00Z',
    comments: [],
  });
  const fresh = classify(pr, { ...context, now: past });
  assert.ok(!fresh.facets.hideReasons.includes('hide:stale_on_author'));
  const later = classify(pr, { ...context, now: new Date('2020-03-01T00:00:00Z') });
  assert.ok(later.facets.hideReasons.includes('hide:stale_on_author'));
});
