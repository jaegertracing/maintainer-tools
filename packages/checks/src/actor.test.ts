// Copyright (c) 2026 The Jaeger Authors.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import type { PullRequest } from './types.js';
import { classifyActor, isBotAuthor, isDependencyBotAuthor } from './actor.js';

const now = new Date('2026-10-30T12:00:00.000Z');

function hoursAgo(hours: number): string {
  return new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString();
}

function daysAgo(days: number): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function basePr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    repo: { owner: 'jaegertracing', name: 'jaeger' },
    number: 1,
    title: 'Example pull request',
    url: 'https://github.com/jaegertracing/jaeger/pull/1',
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
        messageHeadline: 'feat: example change',
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

test('Rule 1: Dependency bot author routes to nextActor: bot', () => {
  const pr = basePr({
    author: { login: 'dependabot[bot]', typename: 'Bot' },
  });
  const res = classifyActor(pr, now);
  assert.equal(res.nextActor, 'bot');
  assert.equal(res.isDependencyBot, true);
  assert.equal(res.reason, 'dependency_bot');
  assert.equal(res.turnStartedAt, pr.commits[0]!.committedDate);
});

test('Rule 1: Renovate unbracketed and bracketed bot detection', () => {
  assert.equal(isDependencyBotAuthor('renovate'), true);
  assert.equal(isDependencyBotAuthor('renovate[bot]'), true);
  assert.equal(isDependencyBotAuthor('renovate-bot'), true);
  assert.equal(isDependencyBotAuthor('other-bot'), false);
});

test('Rule 2: Draft PR routes to nextActor: author', () => {
  const pr = basePr({
    isDraft: true,
  });
  const res = classifyActor(pr, now);
  assert.equal(res.nextActor, 'author');
  assert.equal(res.isDraft, true);
  assert.equal(res.reason, 'draft');
});

test('Rule 3: CI failure routes to nextActor: author', () => {
  const pr = basePr({
    statusCheckRollup: 'FAILURE',
  });
  const res = classifyActor(pr, now);
  assert.equal(res.nextActor, 'author');
  assert.equal(res.reason, 'ci_failing');
});

test('Rule 3: Merge conflict routes to nextActor: author', () => {
  const pr = basePr({
    mergeable: 'CONFLICTING',
  });
  const res = classifyActor(pr, now);
  assert.equal(res.nextActor, 'author');
  assert.equal(res.reason, 'merge_conflict');
});

test('Rule 3: Missing DCO signoff routes to nextActor: author', () => {
  const pr = basePr({
    commits: [
      {
        sha: 'nodco',
        messageHeadline: 'feat: no signoff',
        messageBody: 'No DCO trailer here',
        authorEmail: 'contributor@example.com',
        committedDate: daysAgo(2),
        parents: 1,
      },
    ],
  });
  const res = classifyActor(pr, now);
  assert.equal(res.nextActor, 'author');
  assert.equal(res.reason, 'dco_missing');
});

test('Rule 4: Active CHANGES_REQUESTED routes to nextActor: author', () => {
  const pr = basePr({
    reviews: [
      {
        author: 'reviewer-alice',
        state: 'CHANGES_REQUESTED',
        submittedAt: hoursAgo(10),
      },
    ],
  });
  const res = classifyActor(pr, now);
  assert.equal(res.nextActor, 'author');
  assert.equal(res.reason, 'changes_requested');
  assert.equal(res.turnStartedAt, pr.reviews[0]!.submittedAt);
});

test('Rule 4: CHANGES_REQUESTED cleared when author pushes newer commit', () => {
  const pr = basePr({
    reviews: [
      {
        author: 'reviewer-alice',
        state: 'CHANGES_REQUESTED',
        submittedAt: hoursAgo(10),
      },
    ],
    commits: [
      {
        sha: 'newer',
        messageHeadline: 'address review comments',
        messageBody: 'Signed-off-by: Contributor <contributor@example.com>',
        authorEmail: 'contributor@example.com',
        committedDate: hoursAgo(2),
        parents: 1,
      },
    ],
  });
  const res = classifyActor(pr, now);
  // Cleared, falls through to default awaiting_review
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'awaiting_review');
});

test('Rule 4: CHANGES_REQUESTED is NOT cleared by top-level comments', () => {
  const pr = basePr({
    reviews: [
      {
        author: 'reviewer-alice',
        state: 'CHANGES_REQUESTED',
        submittedAt: hoursAgo(10),
      },
    ],
    comments: [
      {
        author: 'contributor',
        createdAt: hoursAgo(2),
      },
    ],
  });
  const res = classifyActor(pr, now);
  assert.equal(res.nextActor, 'author');
  assert.equal(res.reason, 'changes_requested');
});

test('Rule 4: CHANGES_REQUESTED is NOT cleared by author reply in unrelated review thread', () => {
  const pr = basePr({
    reviews: [
      {
        author: 'reviewer-alice',
        state: 'CHANGES_REQUESTED',
        submittedAt: hoursAgo(10),
      },
    ],
    reviewThreads: [
      {
        isResolved: false,
        resolvedBy: null,
        comments: [
          { author: 'other-reviewer', createdAt: hoursAgo(8) },
          { author: 'contributor', createdAt: hoursAgo(2) },
        ],
      },
    ],
  });
  const res = classifyActor(pr, now);
  assert.equal(res.nextActor, 'author');
  assert.equal(res.reason, 'changes_requested');
});

test('Rule 4: CHANGES_REQUESTED IS cleared when author replies in that reviewer review thread', () => {
  const pr = basePr({
    reviews: [
      {
        author: 'reviewer-alice',
        state: 'CHANGES_REQUESTED',
        submittedAt: hoursAgo(10),
      },
    ],
    reviewThreads: [
      {
        isResolved: false,
        resolvedBy: null,
        comments: [
          { author: 'reviewer-alice', createdAt: hoursAgo(9) },
          { author: 'contributor', createdAt: hoursAgo(2) },
        ],
      },
    ],
  });
  const res = classifyActor(pr, now);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'awaiting_review');
});

test('Rule 5: Unresolved review thread routes to nextActor: author', () => {
  const threadCommentTime = hoursAgo(12);
  const pr = basePr({
    reviewThreads: [
      {
        isResolved: false,
        resolvedBy: null,
        comments: [{ author: 'reviewer-bob', createdAt: threadCommentTime }],
      },
    ],
  });
  const res = classifyActor(pr, now);
  assert.equal(res.nextActor, 'author');
  assert.equal(res.reason, 'unresolved_review_thread');
  assert.equal(res.turnStartedAt, threadCommentTime);
});

test('Rule 5: Bot and deleted-account comments in review threads do not trigger unresolved_from_reviewer', () => {
  const pr = basePr({
    reviewThreads: [
      {
        isResolved: false,
        resolvedBy: null,
        comments: [
          { author: 'contributor', createdAt: hoursAgo(10) },
          { author: 'codecov[bot]', createdAt: hoursAgo(5) },
          { author: null, createdAt: hoursAgo(3) },
        ],
      },
    ],
  });
  const res = classifyActor(pr, now);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'awaiting_review');
});

test('Resolved thread without reply does not block author from review queue', () => {
  const pr = basePr({
    reviewThreads: [
      {
        isResolved: true,
        resolvedBy: 'contributor',
        comments: [{ author: 'reviewer-bob', createdAt: hoursAgo(8) }],
      },
    ],
  });
  const res = classifyActor(pr, now);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'awaiting_review');
});

test('Rule 6: waiting-for-author label routes to nextActor: author', () => {
  const pr = basePr({
    labels: ['waiting-for-author'],
  });
  const res = classifyActor(pr, now);
  assert.equal(res.nextActor, 'author');
  assert.equal(res.reason, 'waiting_for_author_label');
});

test('Rule 7: Pending review requests routes to nextActor: reviewer', () => {
  const pr = basePr({
    reviewRequests: [{ kind: 'user', login: 'maintainer-charlie' }],
  });
  const res = classifyActor(pr, now);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'review_requested');
});

test('Rule 8: Fully approved PR routes to nextActor: maintainer', () => {
  const approvalTime = hoursAgo(5);
  const pr = basePr({
    reviews: [
      {
        author: 'maintainer-charlie',
        state: 'APPROVED',
        submittedAt: approvalTime,
      },
    ],
  });
  const res = classifyActor(pr, now);
  assert.equal(res.nextActor, 'maintainer');
  assert.equal(res.reason, 'ready_to_merge');
  assert.equal(res.turnStartedAt, approvalTime);
});

test('Rule 9: Default queue routes to nextActor: reviewer', () => {
  const pr = basePr();
  const res = classifyActor(pr, now);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'awaiting_review');
});

test('Maintainer verification: Aging flag independence from updatedAt', () => {
  // Author turn started 10 days ago (failing CI), but updatedAt was modified 30 minutes ago
  const commitDate = daysAgo(10);
  const recentUpdated = hoursAgo(0.5);

  const pr = basePr({
    statusCheckRollup: 'FAILURE',
    updatedAt: recentUpdated,
    commits: [
      {
        sha: 'aging01',
        messageHeadline: 'test aging',
        messageBody: 'Signed-off-by: Contributor <contributor@example.com>',
        authorEmail: 'contributor@example.com',
        committedDate: commitDate,
        parents: 1,
      },
    ],
  });

  const res = classifyActor(pr, now);
  assert.equal(res.nextActor, 'author');
  assert.equal(res.reason, 'ci_failing');
  // turnStartedAt must strictly reflect the blocker commit date, NOT updatedAt
  assert.equal(res.turnStartedAt, commitDate);
  assert.notEqual(res.turnStartedAt, recentUpdated);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

test('Static fixture PR #111 from disk verifies age flag independence from updatedAt', () => {
  const fixturesPath = join(__dirname, '../test/fixtures/sample_prs.json');
  const samplePrs = JSON.parse(readFileSync(fixturesPath, 'utf-8')) as PullRequest[];
  const pr111 = samplePrs.find((p) => p.number === 111);
  assert.ok(pr111, 'PR 111 must exist in sample_prs.json');

  const res = classifyActor(pr111, now);
  assert.equal(res.nextActor, 'author');
  assert.equal(res.reason, 'ci_failing');
  assert.equal(res.turnStartedAt, '2026-10-15T09:00:00.000Z');
  assert.notEqual(res.turnStartedAt, pr111.updatedAt);

  const waitingMs = now.getTime() - Date.parse(res.turnStartedAt);
  assert.ok(waitingMs >= 7 * 24 * 60 * 60 * 1000);
});

test('Static fixtures: all sample_prs.json records classify deterministically', () => {
  const fixturesPath = join(__dirname, '../test/fixtures/sample_prs.json');
  const samplePrs = JSON.parse(readFileSync(fixturesPath, 'utf-8')) as PullRequest[];
  assert.equal(samplePrs.length, 11);

  for (const pr of samplePrs) {
    const res = classifyActor(pr, now);
    assert.ok(res.nextActor);
    assert.ok(res.reason);
    assert.ok(res.turnStartedAt);
  }
});

test('Approved PR with a pending review request routes to nextActor: reviewer (Precedence 7 > 8)', () => {
  const pr = basePr({
    reviews: [
      {
        author: 'reviewer-alice',
        state: 'APPROVED',
        submittedAt: hoursAgo(5),
      },
    ],
    reviewRequests: [{ kind: 'user', login: 'reviewer-bob' }],
  });
  const res = classifyActor(pr, now);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'review_requested');
});

test('Review superseding: CHANGES_REQUESTED followed by newer APPROVED from same reviewer routes to maintainer', () => {
  const pr = basePr({
    reviews: [
      {
        author: 'reviewer-alice',
        state: 'CHANGES_REQUESTED',
        submittedAt: hoursAgo(10),
      },
      {
        author: 'reviewer-alice',
        state: 'APPROVED',
        submittedAt: hoursAgo(2),
      },
    ],
  });
  const res = classifyActor(pr, now);
  assert.equal(res.nextActor, 'maintainer');
  assert.equal(res.reason, 'ready_to_merge');
  assert.equal(res.turnStartedAt, hoursAgo(2));
});

test('Multiple unresolved review threads pick the earliest blocker timestamp', () => {
  const earlierComment = hoursAgo(15);
  const laterComment = hoursAgo(4);
  const pr = basePr({
    reviewThreads: [
      {
        isResolved: false,
        resolvedBy: null,
        comments: [{ author: 'reviewer-bob', createdAt: laterComment }],
      },
      {
        isResolved: false,
        resolvedBy: null,
        comments: [{ author: 'reviewer-charlie', createdAt: earlierComment }],
      },
    ],
  });
  const res = classifyActor(pr, now);
  assert.equal(res.nextActor, 'author');
  assert.equal(res.reason, 'unresolved_review_thread');
  assert.equal(res.turnStartedAt, earlierComment);
});

test('Reviewer replying after author keeps ball in authors court with latest reviewer comment timestamp', () => {
  const latestReviewerTime = hoursAgo(2);
  const pr = basePr({
    reviewThreads: [
      {
        isResolved: false,
        resolvedBy: null,
        comments: [
          { author: 'reviewer-alice', createdAt: hoursAgo(10) },
          { author: 'contributor', createdAt: hoursAgo(5) },
          { author: 'reviewer-alice', createdAt: latestReviewerTime },
        ],
      },
    ],
  });
  const res = classifyActor(pr, now);
  assert.equal(res.nextActor, 'author');
  assert.equal(res.reason, 'unresolved_review_thread');
  assert.equal(res.turnStartedAt, latestReviewerTime);
});

test('Non-dependency bot (e.g. release-please) routes to standard reviewer queue with isBotAuthored: true', () => {
  const pr = basePr({
    author: { login: 'release-please[bot]', typename: 'Bot' },
  });
  const res = classifyActor(pr, now);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.isDependencyBot, false);
  assert.equal(res.isBotAuthored, true);
  assert.equal(res.reason, 'awaiting_review');
});

test('Dismissed review clears previous CHANGES_REQUESTED blocker and routes to reviewer', () => {
  const pr = basePr({
    reviews: [
      {
        author: 'maintainer-alice',
        state: 'CHANGES_REQUESTED',
        submittedAt: hoursAgo(10),
      },
      {
        author: 'maintainer-alice',
        state: 'DISMISSED',
        submittedAt: hoursAgo(2),
      },
    ],
  });
  const res = classifyActor(pr, now);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'awaiting_review');
});

test('DCO missing detected across multiple commits with merge commits ignored', () => {
  const pr = basePr({
    commits: [
      {
        sha: 'aaa1111',
        messageHeadline: 'feat: signed commit',
        messageBody: 'Signed-off-by: Contributor <contributor@example.com>',
        authorEmail: 'contributor@example.com',
        committedDate: daysAgo(3),
        parents: 1,
      },
      {
        sha: 'bbb2222',
        messageHeadline: 'Merge branch main into feature',
        messageBody: 'Merge commit without trailer',
        authorEmail: 'contributor@example.com',
        committedDate: daysAgo(2),
        parents: 2,
      },
      {
        sha: 'ccc3333',
        messageHeadline: 'fix: unsigned follow-up commit',
        messageBody: 'Missing DCO trailer',
        authorEmail: 'contributor@example.com',
        committedDate: daysAgo(1),
        parents: 1,
      },
    ],
  });
  const res = classifyActor(pr, now);
  assert.equal(res.nextActor, 'author');
  assert.equal(res.reason, 'dco_missing');
  assert.equal(res.turnStartedAt, daysAgo(1));
});

test('Rule 8: Approved PR with newer head commit uses commit timestamp instead of older approval', () => {
  const approvalTime = hoursAgo(6);
  const newerCommitTime = hoursAgo(2);
  const pr = basePr({
    commits: [
      {
        sha: 'head123',
        messageHeadline: 'fix: address post-approval typo',
        messageBody: 'Signed-off-by: Contributor <contributor@example.com>',
        authorEmail: 'contributor@example.com',
        committedDate: newerCommitTime,
        parents: 1,
      },
    ],
    reviews: [
      {
        author: 'maintainer-bob',
        state: 'APPROVED',
        submittedAt: approvalTime,
      },
    ],
  });
  const res = classifyActor(pr, now);
  assert.equal(res.nextActor, 'maintainer');
  assert.equal(res.reason, 'ready_to_merge');
  assert.equal(res.turnStartedAt, newerCommitTime);
});
