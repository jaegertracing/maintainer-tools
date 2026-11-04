// Copyright (c) 2026 The Jaeger Authors.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import type { PullRequest } from '../types.js';
import { escapeMarkdown, formatAge, groupDashboardItems, renderDashboard } from './dashboard.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const now = new Date('2026-10-30T12:00:00.000Z');

function daysAgo(days: number): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function hoursAgo(hours: number): string {
  return new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString();
}

function makePr(overrides: Partial<PullRequest> = {}): PullRequest {
  const number = overrides.number ?? 1;
  return {
    repo: { owner: 'jaegertracing', name: 'jaeger' },
    number,
    title: 'Sample pull request',
    url: overrides.url ?? `https://github.com/jaegertracing/jaeger/pull/${number}`,
    author: { login: 'contributor', typename: 'User' },
    authorAssociation: 'CONTRIBUTOR',
    isDraft: false,
    mergeable: 'MERGEABLE',
    createdAt: daysAgo(5),
    updatedAt: hoursAgo(2),
    labels: [],
    additions: 10,
    deletions: 2,
    changedFiles: 1,
    files: ['pkg/test.go'],
    statusCheckRollup: 'SUCCESS',
    commits: [
      {
        sha: 'abc1234',
        messageHeadline: 'feat: sample',
        messageBody: 'Signed-off-by: Contributor <contributor@example.com>',
        authorEmail: 'contributor@example.com',
        committedDate: daysAgo(5),
        parents: 1,
      },
    ],
    reviewRequests: [],
    reviews: [],
    comments: [],
    ...overrides,
  };
}

test('formatAge renders durations cleanly', () => {
  assert.equal(formatAge(30_000), '< 1m');
  assert.equal(formatAge(5 * 60_000), '5m');
  assert.equal(formatAge(3 * 60 * 60_000), '3h');
  assert.equal(formatAge(2 * 24 * 60 * 60_000), '2d');
  assert.equal(formatAge(10 * 24 * 60 * 60_000), '10d');
});

test('escapeMarkdown sanitizes pipe characters and HTML', () => {
  assert.equal(
    escapeMarkdown('feat(ui)| fix table <script>'),
    'feat(ui)\\| fix table &lt;script&gt;',
  );
  assert.equal(escapeMarkdown('line1\nline2'), 'line1 line2');
});

test('renderDashboard suppresses @ mentions in all sections', () => {
  const prs: PullRequest[] = [
    makePr({
      number: 1,
      author: { login: 'author-alice', typename: 'User' },
      reviewRequests: [{ kind: 'user', login: 'reviewer-bob' }],
    }),
    makePr({
      number: 2,
      author: { login: 'author-charlie', typename: 'User' },
      statusCheckRollup: 'FAILURE',
    }),
  ];

  const data = groupDashboardItems(prs, now);
  const markdown = renderDashboard(data);

  // Must not contain '@author-alice' or '@reviewer-bob'
  assert.equal(markdown.includes('@author-alice'), false);
  assert.equal(markdown.includes('@reviewer-bob'), false);
  assert.equal(markdown.includes('@author-charlie'), false);

  // Must format logins as Markdown links
  assert.ok(markdown.includes('[author-alice](https://github.com/author-alice)'));
  assert.ok(markdown.includes('[reviewer-bob](https://github.com/reviewer-bob)'));
});

test('renderDashboard formats 7d+ inactive author aging indicator and header count', () => {
  const activeBlockerPr = makePr({
    number: 10,
    title: 'Active blocker under 7 days',
    author: { login: 'author-active', typename: 'User' },
    statusCheckRollup: 'FAILURE',
    commits: [
      {
        sha: 'active1',
        messageHeadline: 'active',
        messageBody: 'Signed-off-by: Author <a@example.com>',
        authorEmail: 'a@example.com',
        committedDate: daysAgo(3),
        parents: 1,
      },
    ],
  });

  const inactiveBlockerPr = makePr({
    number: 11,
    title: 'Inactive blocker older than 7 days',
    author: { login: 'author-inactive', typename: 'User' },
    statusCheckRollup: 'FAILURE',
    commits: [
      {
        sha: 'inactive1',
        messageHeadline: 'inactive',
        messageBody: 'Signed-off-by: Author <a@example.com>',
        authorEmail: 'a@example.com',
        committedDate: daysAgo(10),
        parents: 1,
      },
    ],
  });

  const data = groupDashboardItems([activeBlockerPr, inactiveBlockerPr], now);
  const markdown = renderDashboard(data);

  // Section header must report total count and inactive 7d+ count
  assert.ok(markdown.includes('### Waiting on authors (2 - 1 inactive 7d+)'));

  // Inactive PR row must have `7d+` badge
  assert.ok(markdown.includes('`7d+`'));
});

test('renderDashboard renders all 5 sections in correct order', () => {
  const prs: PullRequest[] = [
    // 1. Ready to merge
    makePr({
      number: 21,
      title: 'Approved PR',
      reviews: [{ author: 'reviewer1', state: 'APPROVED', submittedAt: hoursAgo(2) }],
    }),
    // 2. Waiting on reviewers
    makePr({
      number: 22,
      title: 'Review requested PR',
      reviewRequests: [{ kind: 'user', login: 'reviewer1' }],
    }),
    // 3. Waiting on authors
    makePr({
      number: 23,
      title: 'Failing CI PR',
      statusCheckRollup: 'FAILURE',
    }),
    // 4. Drafts
    makePr({
      number: 24,
      title: 'Draft PR',
      isDraft: true,
    }),
    // 5. Dependency bot
    makePr({
      number: 25,
      title: 'Dependabot PR',
      author: { login: 'dependabot[bot]', typename: 'Bot' },
    }),
  ];

  const data = groupDashboardItems(prs, now);
  const markdown = renderDashboard(data);

  const idxReady = markdown.indexOf('### Ready to merge');
  const idxReviewers = markdown.indexOf('### Waiting on reviewers');
  const idxAuthors = markdown.indexOf('### Waiting on authors');
  const idxDrafts = markdown.indexOf('Draft pull requests');
  const idxDeps = markdown.indexOf('Dependency updates');

  assert.ok(
    idxReady !== -1 &&
      idxReviewers !== -1 &&
      idxAuthors !== -1 &&
      idxDrafts !== -1 &&
      idxDeps !== -1,
  );
  assert.ok(idxReady < idxReviewers);
  assert.ok(idxReviewers < idxAuthors);
  assert.ok(idxAuthors < idxDrafts);
  assert.ok(idxDrafts < idxDeps);
});

test('renderDashboard outputs clean markdown without comment footers', () => {
  const prs = [makePr()];
  const data = groupDashboardItems(prs, now);
  const markdown = renderDashboard(data);

  assert.ok(!markdown.includes('<!-- maintainer-tools:'));
  assert.ok(markdown.includes('# Pull Request Triage Dashboard'));
});

test('groupDashboardItems sorts descending by duration with pr.number ascending tie-breaker', () => {
  const commonTime = daysAgo(2);
  const prA = makePr({
    number: 50,
    commits: [
      {
        sha: 'a50',
        messageHeadline: 'PR 50',
        messageBody: 'Signed-off-by: A <a@example.com>',
        authorEmail: 'a@example.com',
        committedDate: commonTime,
        parents: 1,
      },
    ],
  });
  const prB = makePr({
    number: 10,
    commits: [
      {
        sha: 'b10',
        messageHeadline: 'PR 10',
        messageBody: 'Signed-off-by: B <b@example.com>',
        authorEmail: 'b@example.com',
        committedDate: commonTime,
        parents: 1,
      },
    ],
  });
  const prC = makePr({
    number: 30,
    commits: [
      {
        sha: 'c30',
        messageHeadline: 'PR 30',
        messageBody: 'Signed-off-by: C <c@example.com>',
        authorEmail: 'c@example.com',
        committedDate: commonTime,
        parents: 1,
      },
    ],
  });

  const data = groupDashboardItems([prA, prB, prC], now);
  const reviewersSection = data.sections.find((s) => s.key === 'waiting_on_reviewers')!;
  const numbers = reviewersSection.items.map((i) => i.pr.number);

  // Equal durations must be sorted ascending by pr.number: 10, 30, 50
  assert.deepEqual(numbers, [10, 30, 50]);
});

test('renderDashboard enforces budget compression under 65,000 bytes', () => {
  // Generate 200 large PRs to trigger budget compression
  const largePrs: PullRequest[] = [];
  for (let i = 1; i <= 200; i++) {
    largePrs.push(
      makePr({
        number: i,
        title: `Comprehensive PR description and metadata for item ${i} with long descriptive text`,
        statusCheckRollup: 'FAILURE',
        commits: [
          {
            sha: `sha${i}`,
            messageHeadline: `feat: change number ${i}`,
            messageBody: `Signed-off-by: User${i} <u${i}@example.com>`,
            authorEmail: `u${i}@example.com`,
            committedDate: daysAgo(i % 14),
            parents: 1,
          },
        ],
      }),
    );
  }

  const data = groupDashboardItems(largePrs, now);
  const markdown = renderDashboard(data);
  const byteLength = Buffer.byteLength(markdown, 'utf-8');

  assert.ok(byteLength <= 65_000, `Expected byteLength <= 65000, got ${byteLength}`);
  assert.ok(!markdown.includes('<!-- maintainer-tools:'));
});

test('Dependency updates section renders draft vs ready status correctly', () => {
  const readyBotPr = makePr({
    number: 101,
    author: { login: 'dependabot[bot]', typename: 'Bot' },
    isDraft: false,
  });
  const draftBotPr = makePr({
    number: 102,
    author: { login: 'renovate[bot]', typename: 'Bot' },
    isDraft: true,
  });

  const data = groupDashboardItems([readyBotPr, draftBotPr], now);
  const markdown = renderDashboard(data);

  // Ready PR row displays `ready`, Draft PR row displays `draft`
  assert.ok(markdown.includes('`ready`'));
  assert.ok(markdown.includes('`draft`'));
});

test('Exact 7-day boundary for inactive author flag', () => {
  const exact7dMs = 7 * 24 * 60 * 60 * 1000;
  // PR 1: exactly 7 days old turn
  const prExact7d = makePr({
    number: 201,
    statusCheckRollup: 'FAILURE',
    commits: [
      {
        sha: 'exact7d',
        messageHeadline: 'exact 7d',
        messageBody: 'Signed-off-by: A <a@example.com>',
        authorEmail: 'a@example.com',
        committedDate: new Date(now.getTime() - exact7dMs).toISOString(),
        parents: 1,
      },
    ],
  });
  // PR 2: 7 days minus 1 second
  const prUnder7d = makePr({
    number: 202,
    statusCheckRollup: 'FAILURE',
    commits: [
      {
        sha: 'under7d',
        messageHeadline: 'under 7d',
        messageBody: 'Signed-off-by: B <b@example.com>',
        authorEmail: 'b@example.com',
        committedDate: new Date(now.getTime() - (exact7dMs - 1000)).toISOString(),
        parents: 1,
      },
    ],
  });

  const data = groupDashboardItems([prExact7d, prUnder7d], now);
  const authorsSection = data.sections.find((s) => s.key === 'waiting_on_authors')!;
  assert.equal(authorsSection.totalCount, 2);
  assert.equal(authorsSection.inactiveAuthorCount, 1);

  const markdown = renderDashboard(data);
  assert.ok(markdown.includes('### Waiting on authors (2 - 1 inactive 7d+)'));
  assert.ok(markdown.includes('[#201](https://github.com/jaegertracing/jaeger/pull/201)'));
});

test('Invalid or future timestamps gracefully clamp duration to 0 and render < 1m', () => {
  const futurePr = makePr({
    number: 301,
    createdAt: new Date(now.getTime() + 3600_000).toISOString(),
    commits: [
      {
        sha: 'future',
        messageHeadline: 'future commit',
        messageBody: 'Signed-off-by: C <c@example.com>',
        authorEmail: 'c@example.com',
        committedDate: new Date(now.getTime() + 3600_000).toISOString(),
        parents: 1,
      },
    ],
  });

  const invalidDatePr = makePr({
    number: 302,
    createdAt: 'not-a-valid-date',
    commits: [
      {
        sha: 'invalid',
        messageHeadline: 'invalid date',
        messageBody: 'Signed-off-by: D <d@example.com>',
        authorEmail: 'd@example.com',
        committedDate: 'not-a-valid-date',
        parents: 1,
      },
    ],
  });

  const data = groupDashboardItems([futurePr, invalidDatePr], now);
  assert.equal(data.sections[1]!.items[0]!.waitingDurationMs, 0);
  assert.equal(data.sections[1]!.items[1]!.waitingDurationMs, 0);

  const markdown = renderDashboard(data);
  assert.ok(markdown.includes('< 1m'));
});

test('Preview script writes to GITHUB_STEP_SUMMARY when environment variable is set', () => {
  const summaryFile = join(tmpdir(), `test-step-summary-${Date.now()}.md`);
  try {
    const tsxCli = join(__dirname, '../../../../node_modules/tsx/dist/cli.mjs');
    const previewScript = join(__dirname, '../preview.ts');

    execFileSync(process.execPath, [tsxCli, previewScript], {
      env: { ...process.env, GITHUB_STEP_SUMMARY: summaryFile },
    });

    const content = readFileSync(summaryFile, 'utf-8');
    assert.ok(content.includes('# Pull Request Triage Dashboard for jaegertracing/jaeger'));
    assert.ok(!content.includes('<!-- maintainer-tools:'));
  } finally {
    rmSync(summaryFile, { force: true });
  }
});
