import assert from 'node:assert/strict';
import test from 'node:test';

import type { PullRequest } from '@jaegertracing/maintainer-tools-checks';

import { classify, type ClassifyContext } from '../buckets.js';
import { renderHtml } from './html.js';

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
    labels: [],
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
    body: 'Closes #3',
    reviewThreads: [],
    computed: { issueRefs: [] },
    ...overrides,
  };
}

test('Expand/Collapse All render inside the bucket view, not the header toolbar', () => {
  const classified = [classify(pullRequest(), context)];
  const html = renderHtml(classified, {
    viewer: 'maintainer-a',
    now,
    authorOpenCounts: new Map([['example/repo', new Map()]]),
  });

  const headerEnd = html.indexOf('</header>');
  const bucketViewStart = html.indexOf('id="view-buckets"');
  const expandIndex = html.indexOf('id="expand-all"');
  const collapseIndex = html.indexOf('id="collapse-all"');

  assert.ok(headerEnd > 0 && bucketViewStart > headerEnd);
  assert.ok(expandIndex > bucketViewStart, 'Expand All must render after the bucket view opens');
  assert.ok(
    collapseIndex > bucketViewStart,
    'Collapse All must render after the bucket view opens',
  );
});
