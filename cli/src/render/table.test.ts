import assert from 'node:assert/strict';
import test from 'node:test';

import type { PullRequest } from '@jaegertracing/maintainer-tools-checks';

import { classify, type ClassifyContext } from '../buckets.js';
import { NO_PRIORITY_LABEL } from './shared.js';
import { buildTableRows } from './table.js';

const now = new Date('2026-09-20T12:00:00Z');

const context: ClassifyContext = {
  viewer: 'maintainer-a',
  maintainers: new Set(['maintainer-a']),
  priorityAuthors: new Set(['priority-author']),
  codeownerPaths: ['src/**'],
  now,
  ignoreReviewRequestedOnYou: false,
};

function pullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    repo: { owner: 'example', name: 'repo' },
    number: 7,
    title: 'Fix the thing',
    url: 'https://github.com/example/repo/pull/7',
    author: { login: 'priority-author', typename: 'User' },
    authorAssociation: 'CONTRIBUTOR',
    isDraft: false,
    mergeable: 'MERGEABLE',
    createdAt: '2026-09-10T08:00:00Z',
    updatedAt: '2026-09-18T08:00:00Z',
    labels: ['priority:high', 'area/storage'],
    additions: 10,
    deletions: 2,
    changedFiles: 2,
    files: ['src/a.go', 'src/a_test.go'],
    statusCheckRollup: 'FAILURE',
    commits: [
      {
        sha: 'abc',
        messageHeadline: 'Fix the thing',
        messageBody: '',
        authorEmail: 'a@example.com',
        committedDate: '2026-09-18T08:00:00Z',
        parents: 1,
      },
    ],
    reviewRequests: [],
    reviews: [],
    comments: [],
    body: 'Closes #3 and Fixes other/repo#9',
    reviewThreads: [
      { isResolved: false, resolvedBy: null, comments: [] },
      { isResolved: true, resolvedBy: 'x', comments: [] },
    ],
    computed: {
      issueRefs: [
        { owner: 'example', repo: 'repo', number: 3 },
        { owner: 'other', repo: 'repo', number: 9 },
      ],
    },
    ...overrides,
  };
}

test('buildTableRows keeps the overridden signals next to the bucket', () => {
  const classified = classify(pullRequest(), context);
  const [row] = buildTableRows([classified], {
    viewer: 'maintainer-a',
    now,
    priorityLabels: ['priority:high', 'priority:low'],
  });

  assert.ok(row);
  assert.equal(row.repo, 'example/repo');
  assert.equal(row.bucket, 'Blocked on author');
  assert.equal(row.bucketOrder, 8);
  assert.equal(row.repoOrder, 0);
  assert.equal(row.priorityOrder, 0);
  assert.equal(row.isViewer, false);
  assert.equal(row.priorityAuthor, true);
  assert.deepEqual(row.hideReasons, ['DCO-MISSING', 'CI-FAILING']);
  assert.equal(row.dco, 'missing');
  assert.equal(row.ci, 'failure');
  assert.equal(row.mergeable, 'mergeable');
  assert.equal(row.priorityLabel, 'priority:high');
  assert.equal(row.codeownersHit, true);
  assert.equal(row.openThreads, 1);
  assert.equal(row.ageDays, 2);
  assert.equal(row.updatedAt, '2026-09-18');
  assert.deepEqual(row.issues, ['#3', 'other/repo#9']);
  assert.equal(row.copilot, '');
});

test('buildTableRows carries the Copilot verdict and marks the viewer as author', () => {
  const body =
    '<!-- ccr-overview-v2 -->\n### 🟡 Review recommended\n**Findings:** 2 <picture><img alt="High severity"></picture>\n';
  const classified = classify(
    pullRequest({
      author: { login: 'maintainer-a', typename: 'User' },
      reviews: [
        {
          author: 'copilot-pull-request-reviewer',
          state: 'COMMENTED',
          submittedAt: '2026-09-18T09:00:00Z',
          url: 'https://example/review',
          body,
        },
      ],
    }),
    context,
  );
  const [row] = buildTableRows([classified], { viewer: 'maintainer-a', now });

  assert.ok(row);
  assert.equal(row.isViewer, true);
  assert.equal(row.copilot, '🟡 2H');
  assert.equal(row.copilotLight, 'yellow');
  assert.equal(row.copilotUrl, 'https://example/review');
  assert.equal(row.copilotTip, 'Copilot: Review recommended · Findings: 2 high');
});

test('buildTableRows falls back to the no-priority label only when tiers are configured', () => {
  const classified = classify(pullRequest({ labels: [] }), context);
  const [withTiers] = buildTableRows([classified], {
    viewer: 'maintainer-a',
    now,
    priorityLabels: ['priority:high'],
  });
  const [withoutTiers] = buildTableRows([classified], { viewer: 'maintainer-a', now });

  assert.equal(withTiers?.priorityLabel, NO_PRIORITY_LABEL);
  assert.equal(withTiers?.priorityOrder, 1);
  assert.equal(withoutTiers?.priorityLabel, '');
});
