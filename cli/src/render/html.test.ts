import assert from 'node:assert/strict';
import test from 'node:test';

import type { PullRequest } from '@jaegertracing/maintainer-tools-checks';

import { classify, type ClassifyContext } from '../buckets.js';
import { renderHtml } from './html.js';

const now = new Date('2026-09-20T12:00:00Z');

const context: ClassifyContext = {
  viewer: 'maintainer-a',
  maintainers: new Set(['maintainer-a']),
  priorityAuthors: new Set(),
  codeownerPaths: [],
  now,
  ignoreReviewRequestedOnYou: false,
};

function pullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    repo: { owner: 'acme', name: 'widgets' },
    number: 1,
    title: 'Example PR',
    url: 'https://github.com/acme/widgets/pull/1',
    author: { login: 'contributor', typename: 'User' },
    authorAssociation: 'CONTRIBUTOR',
    isDraft: false,
    mergeable: 'MERGEABLE',
    createdAt: '2026-09-19T12:00:00Z',
    updatedAt: '2026-09-19T18:00:00Z',
    labels: [],
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    files: ['src/example.test.ts'],
    statusCheckRollup: 'SUCCESS',
    commits: [
      {
        sha: 'abc1234',
        messageHeadline: 'Example PR',
        messageBody: 'Signed-off-by: Contributor <contributor@example.com>',
        authorEmail: 'contributor@example.com',
        committedDate: '2026-09-19T18:00:00Z',
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

test('Expand/Collapse All render inside the bucket view, not the header toolbar', () => {
  const html = renderHtml([], {
    viewer: 'maintainer-a',
    now: new Date('2026-09-20T12:00:00Z'),
    authorOpenCounts: new Map(),
  });

  const find = (marker: string): number => {
    const index = html.indexOf(marker);
    assert.notEqual(index, -1, `expected to find marker ${marker}`);
    return index;
  };

  const bucketViewStart = find('id="view-buckets"');
  const tableViewStart = find('id="view-table"');
  const expandIndex = find('id="expand-all"');
  const collapseIndex = find('id="collapse-all"');

  assert.ok(
    expandIndex > bucketViewStart && expandIndex < tableViewStart,
    'Expand All must render inside the bucket view, not the table view',
  );
  assert.ok(
    collapseIndex > bucketViewStart && collapseIndex < tableViewStart,
    'Collapse All must render inside the bucket view, not the table view',
  );
});

test('the summary table renders once, shared above both views', () => {
  const classified = [pullRequest()].map((pr) => classify(pr, context));
  const html = renderHtml(classified, {
    viewer: 'maintainer-a',
    now,
    authorOpenCounts: new Map(),
  });

  const summaryIndex = html.indexOf('<section class="summary">');
  const bucketViewIndex = html.indexOf('id="view-buckets"');

  assert.notEqual(summaryIndex, -1, 'expected a summary section');
  assert.equal(
    html.indexOf('<section class="summary">', summaryIndex + 1),
    -1,
    'expected exactly one summary section',
  );
  assert.ok(
    summaryIndex < bucketViewIndex,
    'the summary must render before the bucket view, not nested inside it',
  );
});

test('dependency bots get their own excluded row and are dropped from the subtotal', () => {
  const classified = [
    pullRequest({ number: 1 }), // fyi — the only PR counted in the subtotal
    pullRequest({ number: 2, isDraft: true }), // hidden
    pullRequest({ number: 3, author: { login: 'renovate-bot', typename: 'User' } }), // dependency-bots
  ].map((pr) => classify(pr, context));

  assert.equal(
    classified[0]?.bucket,
    'fyi',
    'PR #1 must land in fyi for the subtotal assertion below to test anything',
  );

  const html = renderHtml(classified, {
    viewer: 'maintainer-a',
    now,
    authorOpenCounts: new Map(),
  });

  assert.match(
    html,
    /<tr class="grand"><th scope="row">subtotal<\/th><td>1<\/td><td class="row-total"><span[^>]*>1<\/span><a[^>]*>1<\/a><\/td><\/tr>/,
    'subtotal must count only the fyi PR',
  );
  assert.match(
    html,
    /Dependency bots<span class="note"> \(excluded\)<\/span><\/th><td><a[^>]*data-repo="acme\/widgets"[^>]*data-bucket="Dependency bots"[^>]*>1<\/a><\/td><td class="row-total"><span[^>]*>1<\/span><a[^>]*>1<\/a><\/td><\/tr>/,
    'dependency bots must get their own excluded row, separate from Blocked-on-author',
  );
  assert.match(
    html,
    /Blocked on author<span class="note"> \(excluded\)<\/span><\/th><td><a[^>]*data-repo="acme\/widgets"[^>]*data-bucket="Blocked on author"[^>]*>1<\/a><\/td><td class="row-total"><span[^>]*>1<\/span><a[^>]*>1<\/a><\/td><\/tr>/,
    'Blocked-on-author must still show only the draft PR, not the bot',
  );
  assert.match(
    html,
    /<tr class="all-total"><th scope="row">Total<\/th><td>3<\/td><td class="row-total"><span[^>]*>3<\/span><a[^>]*>3<\/a><\/td><\/tr>/,
    'Total must add the subtotal, Blocked-on-author, and Dependency-bots counts back together',
  );
});

test('subtotal/excluded/Total math lines up per repo when only some repos have bots', () => {
  const classified = [
    pullRequest({ number: 1, repo: { owner: 'acme', name: 'widgets' } }), // acme: fyi
    pullRequest({
      number: 2,
      repo: { owner: 'acme', name: 'widgets' },
      author: { login: 'renovate-bot', typename: 'User' },
    }), // acme: dependency-bots
    pullRequest({ number: 3, repo: { owner: 'other', name: 'repo2' } }), // other: fyi
    pullRequest({ number: 4, repo: { owner: 'other', name: 'repo2' }, isDraft: true }), // other: hidden
  ].map((pr) => classify(pr, context));

  const html = renderHtml(classified, {
    viewer: 'maintainer-a',
    now,
    authorOpenCounts: new Map(),
  });

  assert.match(
    html,
    /<tr class="grand"><th scope="row">subtotal<\/th><td>1<\/td><td>1<\/td><td class="row-total"><span[^>]*>2<\/span><a[^>]*>2<\/a><\/td><\/tr>/,
    'each repo contributes its own fyi PR to the subtotal, in column order',
  );
  assert.match(
    html,
    /Dependency bots<span class="note"> \(excluded\)<\/span><\/th><td><a[^>]*data-repo="acme\/widgets"[^>]*>1<\/a><\/td><td class="zero">0<\/td><td class="row-total"><span[^>]*>1<\/span><a[^>]*>1<\/a><\/td><\/tr>/,
    'only acme/widgets has a dependency-bot PR',
  );
  assert.match(
    html,
    /Blocked on author<span class="note"> \(excluded\)<\/span><\/th><td class="zero">0<\/td><td><a[^>]*data-repo="other\/repo2"[^>]*>1<\/a><\/td><td class="row-total"><span[^>]*>1<\/span><a[^>]*>1<\/a><\/td><\/tr>/,
    'only other/repo2 has a hidden PR',
  );
  assert.match(
    html,
    /<tr class="all-total"><th scope="row">Total<\/th><td>2<\/td><td>2<\/td><td class="row-total"><span[^>]*>4<\/span><a[^>]*>4<\/a><\/td><\/tr>/,
    "each column's Total is that repo's subtotal plus its own excluded counts, not the other repo's",
  );
});

test('summary totals select matching buckets across repositories in Table view', () => {
  const classified = [
    pullRequest({ number: 1 }),
    pullRequest({ number: 2, repo: { owner: 'other', name: 'repo2' } }),
    pullRequest({ number: 3, isDraft: true }),
    pullRequest({ number: 4, author: { login: 'renovate-bot', typename: 'User' } }),
  ].map((pr) => classify(pr, context));
  const html = renderHtml(classified, { viewer: 'maintainer-a', now, authorOpenCounts: new Map() });
  const summary = html.slice(
    html.indexOf('<table class="summary-table">'),
    html.indexOf('</table>'),
  );
  const links = [
    ...summary.matchAll(/<a class="table-total" href="#table" data-buckets="([^"]*)">(\d+)<\/a>/g),
  ];
  assert.equal(links.length, 5);
  const selections = links.map((link) => ({
    buckets: JSON.parse(link[1]!.replaceAll('&quot;', '"')) as string[],
    count: Number(link[2]),
  }));
  assert.deepEqual(selections[0], { buckets: ['Needs triage'], count: 2 });
  assert.equal(selections[1]!.count, 2);
  assert.ok(selections[1]!.buckets.includes('Needs triage'));
  assert.ok(!selections[1]!.buckets.includes('Dependency bots'));
  assert.ok(!selections[1]!.buckets.includes('Blocked on author'));
  assert.deepEqual(selections[2], { buckets: ['Dependency bots'], count: 1 });
  assert.deepEqual(selections[3], { buckets: ['Blocked on author'], count: 1 });
  assert.deepEqual(selections[4], { buckets: [], count: 4 });
});
