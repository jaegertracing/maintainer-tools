// Copyright (c) 2026 The Jaeger Authors.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import type { PullRequest } from './types.js';
import { classifyActor, isEarlier, isLater, parseDateSafe } from './actor.js';
import { isBotAuthor, isBotLogin, isDependencyBotAuthor, KNOWN_BOT_LOGINS } from './logins.js';
import { unresolvedFromReviewer } from './predicates/unresolved_from_reviewer.js';

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
    author: { login: 'dependabot', typename: 'Bot' },
  });
  const res = classifyActor(pr);
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
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'author');
  assert.equal(res.isDraft, true);
  assert.equal(res.reason, 'draft');
});

test('Rule 3: CI failure routes to nextActor: author', () => {
  const pr = basePr({
    statusCheckRollup: 'FAILURE',
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'author');
  assert.equal(res.reason, 'ci_failing');
});

test('Rule 3: Merge conflict routes to nextActor: author', () => {
  const pr = basePr({
    mergeable: 'CONFLICTING',
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'author');
  assert.equal(res.reason, 'merge_conflict');
});

test('Rule 3: Merge conflict clock uses later of head commit and reviewer/maintainer activity', () => {
  // Head commit pushed 20 days ago, sat in review, reviewer commented 2 days ago, merge conflict today
  const headCommitDate = daysAgo(20);
  const reviewerActivityDate = daysAgo(2);
  const pr = basePr({
    mergeable: 'CONFLICTING',
    commits: [
      {
        sha: 'oldhead',
        messageHeadline: 'feat: old change',
        messageBody: 'Signed-off-by: Contributor <contributor@example.com>',
        authorEmail: 'contributor@example.com',
        committedDate: headCommitDate,
        parents: 1,
      },
    ],
    reviews: [
      {
        author: 'reviewer-alice',
        state: 'COMMENTED',
        submittedAt: reviewerActivityDate,
      },
    ],
  });

  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'author');
  assert.equal(res.reason, 'merge_conflict');
  // Clock must reflect reviewerActivityDate (2 days ago), NOT headCommitDate (20 days ago)
  assert.equal(res.turnStartedAt, reviewerActivityDate);
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
  const res = classifyActor(pr);
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
  const res = classifyActor(pr);
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
  const res = classifyActor(pr);
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
  const res = classifyActor(pr);
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
  const res = classifyActor(pr);
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
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'awaiting_review');
});

test('Rule 4: CHANGES_REQUESTED is NOT cleared when reviewer counter-replies after author reply', () => {
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
          { author: 'contributor', createdAt: hoursAgo(5) },
          { author: 'reviewer-alice', createdAt: hoursAgo(2) },
        ],
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'author');
  assert.equal(res.reason, 'changes_requested');
});

test('Rule 4: CHANGES_REQUESTED is NOT cleared when author replies to only one of multiple reviewer threads', () => {
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
      {
        isResolved: false,
        resolvedBy: null,
        comments: [{ author: 'reviewer-alice', createdAt: hoursAgo(8) }],
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'author');
  assert.equal(res.reason, 'changes_requested');
});

test('Rule 4: CHANGES_REQUESTED IS cleared when author replies to all threads for that reviewer and has last word in each', () => {
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
          { author: 'contributor', createdAt: hoursAgo(3) },
        ],
      },
      {
        isResolved: false,
        resolvedBy: null,
        comments: [
          { author: 'reviewer-alice', createdAt: hoursAgo(8) },
          { author: 'contributor', createdAt: hoursAgo(2) },
        ],
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'awaiting_review');
});

test('Rule 5: Unresolved review thread routes to nextActor: author', () => {
  const threadCommentTime = hoursAgo(12);
  const pr = basePr({
    reviews: [{ author: 'reviewer-bob', state: 'COMMENTED', submittedAt: threadCommentTime }],
    reviewThreads: [
      {
        isResolved: false,
        resolvedBy: null,
        comments: [{ author: 'reviewer-bob', createdAt: threadCommentTime }],
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'author');
  assert.equal(res.reason, 'unresolved_review_thread');
  assert.equal(res.turnStartedAt, threadCommentTime);
});

test('Rule 5: Bot and deleted-account comments in review threads do not trigger unresolved_from_reviewer', () => {
  const pr = basePr({
    reviews: [{ author: 'reviewer-bob', state: 'COMMENTED', submittedAt: hoursAgo(8) }],
    reviewThreads: [
      {
        isResolved: false,
        resolvedBy: null,
        comments: [
          { author: 'contributor', createdAt: hoursAgo(10) },
          { author: 'codecov', createdAt: hoursAgo(5) },
          { author: null, createdAt: hoursAgo(3) },
        ],
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'awaiting_review');
});

test('Resolved thread without reply does not block author from review queue', () => {
  const pr = basePr({
    reviews: [{ author: 'reviewer-bob', state: 'COMMENTED', submittedAt: hoursAgo(8) }],
    reviewThreads: [
      {
        isResolved: true,
        resolvedBy: 'contributor',
        comments: [{ author: 'reviewer-bob', createdAt: hoursAgo(8) }],
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'awaiting_review');
});

test('Rule 6: waiting-for-author label routes to nextActor: author', () => {
  const pr = basePr({
    labels: ['waiting-for-author'],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'author');
  assert.equal(res.reason, 'waiting_for_author_label');
});

test('Rule 7: Pending review requests routes to nextActor: reviewer', () => {
  const pr = basePr({
    reviewRequests: [{ kind: 'user', login: 'maintainer-charlie' }],
  });
  const res = classifyActor(pr);
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
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'maintainer');
  assert.equal(res.reason, 'ready_to_merge');
  assert.equal(res.turnStartedAt, approvalTime);
});

test('Rule 8: One reviewer approves, another has active CHANGES_REQUESTED, author pushes commit -> routes to reviewer', () => {
  // Reviewer A approved, Reviewer B requested changes, author pushed a newer commit addressing it.
  // Because Reviewer B still has CHANGES_REQUESTED as their latest review, GitHub blocks merge.
  // Must NOT route to maintainer; must route to reviewer.
  const pr = basePr({
    commits: [
      {
        sha: 'addr001',
        messageHeadline: 'address comments',
        messageBody: 'Signed-off-by: Contributor <contributor@example.com>',
        authorEmail: 'contributor@example.com',
        committedDate: hoursAgo(1),
        parents: 1,
      },
    ],
    reviews: [
      {
        author: 'reviewer-a',
        state: 'APPROVED',
        submittedAt: hoursAgo(6),
      },
      {
        author: 'reviewer-b',
        state: 'CHANGES_REQUESTED',
        submittedAt: hoursAgo(4),
      },
    ],
  });

  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'awaiting_review');
});

test('Rule 8: Approved PR with CI PENDING routes to reviewer, not maintainer', () => {
  const pr = basePr({
    statusCheckRollup: 'PENDING',
    reviews: [
      {
        author: 'reviewer-a',
        state: 'APPROVED',
        submittedAt: hoursAgo(3),
      },
    ],
  });

  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'awaiting_review');
});

test('Rule 8: Approved PR with CI EXPECTED routes to reviewer, not maintainer', () => {
  const pr = basePr({
    statusCheckRollup: 'EXPECTED',
    reviews: [
      {
        author: 'reviewer-a',
        state: 'APPROVED',
        submittedAt: hoursAgo(3),
      },
    ],
  });

  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'awaiting_review');
});

test('Rule 8: Approved PR with missing/null CI routes to reviewer, not maintainer', () => {
  const pr = basePr({
    statusCheckRollup: null,
    reviews: [
      {
        author: 'reviewer-a',
        state: 'APPROVED',
        submittedAt: hoursAgo(3),
      },
    ],
  });

  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'awaiting_review');
});

test('Review state supersession: Approval superseded by newer COMMENTED review', () => {
  const pr = basePr({
    reviews: [
      {
        author: 'reviewer-a',
        state: 'APPROVED',
        submittedAt: hoursAgo(8),
      },
      {
        author: 'reviewer-a',
        state: 'COMMENTED',
        submittedAt: hoursAgo(2),
      },
    ],
  });

  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'awaiting_review');
});

test('Review state supersession: Approval superseded by newer DISMISSED review', () => {
  const pr = basePr({
    reviews: [
      {
        author: 'reviewer-a',
        state: 'APPROVED',
        submittedAt: hoursAgo(8),
      },
      {
        author: 'reviewer-a',
        state: 'DISMISSED',
        submittedAt: hoursAgo(2),
      },
    ],
  });

  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'awaiting_review');
});

test('Review state supersession: CHANGES_REQUESTED superseded by newer APPROVED review', () => {
  const pr = basePr({
    reviews: [
      {
        author: 'reviewer-a',
        state: 'CHANGES_REQUESTED',
        submittedAt: hoursAgo(8),
      },
      {
        author: 'reviewer-a',
        state: 'APPROVED',
        submittedAt: hoursAgo(2),
      },
    ],
  });

  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'maintainer');
  assert.equal(res.reason, 'ready_to_merge');
});

test('Rule 9: Default queue routes to nextActor: reviewer', () => {
  const pr = basePr();
  const res = classifyActor(pr);
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

  const res = classifyActor(pr);
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

  const res = classifyActor(pr111);
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
    const res = classifyActor(pr);
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
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'review_requested');
});

test('Multiple unresolved review threads pick the earliest blocker timestamp', () => {
  const earlierComment = hoursAgo(15);
  const laterComment = hoursAgo(4);
  const pr = basePr({
    reviews: [
      { author: 'reviewer-bob', state: 'COMMENTED', submittedAt: laterComment },
      { author: 'reviewer-charlie', state: 'COMMENTED', submittedAt: earlierComment },
    ],
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
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'author');
  assert.equal(res.reason, 'unresolved_review_thread');
  assert.equal(res.turnStartedAt, earlierComment);
});

test('Reviewer replying after author keeps ball in authors court with latest reviewer comment timestamp', () => {
  const latestReviewerTime = hoursAgo(2);
  const pr = basePr({
    reviews: [{ author: 'reviewer-alice', state: 'COMMENTED', submittedAt: latestReviewerTime }],
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
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'author');
  assert.equal(res.reason, 'unresolved_review_thread');
  assert.equal(res.turnStartedAt, latestReviewerTime);
});

test('Review thread with comments out of chronological order selects latest comment by createdAt', () => {
  const latestCommentTime = hoursAgo(2);
  const earlierCommentTime = hoursAgo(8);
  const pr = basePr({
    reviews: [{ author: 'reviewer-alice', state: 'COMMENTED', submittedAt: latestCommentTime }],
    reviewThreads: [
      {
        isResolved: false,
        resolvedBy: null,
        // Provided out of order in the comments array
        comments: [
          { author: 'reviewer-alice', createdAt: latestCommentTime },
          { author: 'reviewer-alice', createdAt: earlierCommentTime },
        ],
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'author');
  assert.equal(res.reason, 'unresolved_review_thread');
  assert.equal(res.turnStartedAt, latestCommentTime);
});

test('Non-dependency bot (e.g. release-please) routes to standard reviewer queue with isBotAuthored: true', () => {
  const pr = basePr({
    author: { login: 'release-please', typename: 'Bot' },
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.isDependencyBot, false);
  assert.equal(res.isBotAuthored, true);
  assert.equal(res.reason, 'awaiting_review');
});

test('Real GraphQL bot logins without [bot] are recognized by isBotLogin', () => {
  assert.equal(isBotLogin('copilot-pull-request-reviewer'), true);
  assert.equal(isBotLogin('github-actions'), true);
  assert.equal(isBotLogin('codecov'), true);
  assert.equal(isBotLogin('release-please'), true);
  assert.equal(isBotLogin('dependabot'), true);
  assert.equal(isBotLogin('renovate'), true);
  assert.equal(isBotLogin('renovate-bot'), true);
  assert.equal(isBotLogin('human-contributor'), false);
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
  const res = classifyActor(pr);
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
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'maintainer');
  assert.equal(res.reason, 'ready_to_merge');
  assert.equal(res.turnStartedAt, newerCommitTime);
});

test('Timestamp validation: parseDateSafe handles valid, null, undefined, and malformed strings', () => {
  assert.equal(parseDateSafe('2026-10-30T12:00:00.000Z'), 1793361600000);
  assert.equal(parseDateSafe(null), 0);
  assert.equal(parseDateSafe(undefined), 0);
  assert.equal(parseDateSafe(''), 0);
  assert.equal(parseDateSafe('invalid-date-string'), 0);
});

test('Timestamp validation: isLater and isEarlier handle valid and invalid dates gracefully', () => {
  const earlier = '2026-10-29T12:00:00.000Z';
  const later = '2026-10-30T12:00:00.000Z';
  const malformed = 'not-a-valid-timestamp';

  assert.equal(isLater(later, earlier), true);
  assert.equal(isLater(earlier, later), false);
  assert.equal(isLater(later, later), false);
  assert.equal(isLater(later, malformed), true);
  assert.equal(isLater(malformed, later), false);
  assert.equal(isLater(malformed, malformed), false);

  assert.equal(isEarlier(earlier, later), true);
  assert.equal(isEarlier(later, earlier), false);
  assert.equal(isEarlier(earlier, earlier), false);
  assert.equal(isEarlier(earlier, malformed), true);
  assert.equal(isEarlier(malformed, earlier), false);
  assert.equal(isEarlier(malformed, malformed), false);
});

test('Timestamp validation: latest review selection ignores malformed timestamps', () => {
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
        submittedAt: 'malformed-date',
      },
    ],
  });
  const res = classifyActor(pr);
  // Valid review with CHANGES_REQUESTED takes precedence over malformed submittedAt
  assert.equal(res.nextActor, 'author');
  assert.equal(res.reason, 'changes_requested');
  assert.equal(res.turnStartedAt, hoursAgo(10));
});

test('Timestamp validation: earliest changes-requested blocker ignores malformed dates', () => {
  const validEarlier = hoursAgo(20);
  const pr = basePr({
    reviews: [
      {
        author: 'reviewer-alice',
        state: 'CHANGES_REQUESTED',
        submittedAt: 'invalid-date',
      },
      {
        author: 'reviewer-bob',
        state: 'CHANGES_REQUESTED',
        submittedAt: validEarlier,
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'author');
  assert.equal(res.reason, 'changes_requested');
  assert.equal(res.turnStartedAt, validEarlier);
});

test('Timestamp validation: latest approval selection ignores malformed timestamps', () => {
  const validApproval = hoursAgo(5);
  const pr = basePr({
    commits: [
      {
        sha: 'head1',
        messageHeadline: 'feat: valid signed commit',
        messageBody: 'Signed-off-by: Contributor <contributor@example.com>',
        authorEmail: 'contributor@example.com',
        committedDate: hoursAgo(10),
        parents: 1,
      },
    ],
    reviews: [
      {
        author: 'reviewer-alice',
        state: 'APPROVED',
        submittedAt: validApproval,
      },
      {
        author: 'reviewer-bob',
        state: 'APPROVED',
        submittedAt: 'corrupt-timestamp',
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'maintainer');
  assert.equal(res.reason, 'ready_to_merge');
  assert.equal(res.turnStartedAt, validApproval);
});

test('Timestamp validation: thread comment selection ignores malformed timestamps', () => {
  const validThreadComment = hoursAgo(4);
  const pr = basePr({
    reviews: [{ author: 'reviewer-alice', state: 'COMMENTED', submittedAt: validThreadComment }],
    reviewThreads: [
      {
        isResolved: false,
        resolvedBy: null,
        comments: [
          { author: 'contributor', createdAt: hoursAgo(10) },
          { author: 'reviewer-alice', createdAt: 'corrupt-date' },
          { author: 'reviewer-alice', createdAt: validThreadComment },
        ],
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'author');
  assert.equal(res.reason, 'unresolved_review_thread');
  assert.equal(res.turnStartedAt, validThreadComment);
});

test('Timestamp validation: unresolved thread with only malformed timestamps is ignored', () => {
  const pr = basePr({
    reviews: [{ author: 'reviewer-alice', state: 'COMMENTED', submittedAt: hoursAgo(4) }],
    reviewThreads: [
      {
        isResolved: false,
        resolvedBy: null,
        comments: [
          { author: 'reviewer-alice', createdAt: 'invalid-review-date' },
          { author: 'contributor', createdAt: 'invalid-author-date' },
        ],
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'awaiting_review');
  assert.equal(res.turnStartedAt, pr.commits[pr.commits.length - 1]!.committedDate);
});

test('Timestamp validation: review with malformed submittedAt is explicitly rejected', () => {
  const pr = basePr({
    reviews: [
      {
        author: 'reviewer-alice',
        state: 'CHANGES_REQUESTED',
        submittedAt: 'unparseable-timestamp',
      },
    ],
  });
  const res = classifyActor(pr);
  // Malformed review is rejected, so it does not block the PR as CHANGES_REQUESTED
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'awaiting_review');
});

test('Unresolved review thread on PR with deleted/null author routes to author', () => {
  const threadCommentTime = hoursAgo(3);
  const pr = basePr({
    author: null,
    reviews: [{ author: 'reviewer-alice', state: 'COMMENTED', submittedAt: threadCommentTime }],
    reviewThreads: [
      {
        isResolved: false,
        resolvedBy: null,
        comments: [{ author: 'reviewer-alice', createdAt: threadCommentTime }],
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'author');
  assert.equal(res.reason, 'unresolved_review_thread');
  assert.equal(res.turnStartedAt, threadCommentTime);
});

test('resolvedWithoutReply does not route to nextActor: author and attaches warning', () => {
  const pr = basePr({
    reviews: [{ author: 'reviewer-alice', state: 'COMMENTED', submittedAt: hoursAgo(6) }],
    reviewThreads: [
      {
        isResolved: true,
        resolvedBy: 'contributor',
        comments: [{ author: 'reviewer-alice', createdAt: hoursAgo(6) }],
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'awaiting_review');
  assert.deepEqual(res.warnings, ['resolved_without_reply']);

  // Verify warning attaches on early returns (e.g. draft)
  const draftPr = basePr({
    isDraft: true,
    reviews: pr.reviews,
    reviewThreads: pr.reviewThreads,
  });
  const draftRes = classifyActor(draftPr);
  assert.equal(draftRes.nextActor, 'author');
  assert.equal(draftRes.reason, 'draft');
  assert.deepEqual(draftRes.warnings, ['resolved_without_reply']);
});

test('resolvedWithoutReply local filtering is case-insensitive for author logins', () => {
  const pr = basePr({
    author: { login: 'Contributor', typename: 'User' },
    reviews: [{ author: 'reviewer-alice', state: 'COMMENTED', submittedAt: hoursAgo(6) }],
    reviewThreads: [
      {
        isResolved: true,
        resolvedBy: 'contributor',
        comments: [{ author: 'reviewer-alice', createdAt: hoursAgo(6) }],
      },
    ],
  });
  const res = classifyActor(pr);
  assert.deepEqual(res.warnings, ['resolved_without_reply']);
});

test('resolvedWithoutReply local filtering ignores bot comments in resolved thread', () => {
  const pr = basePr({
    reviews: [{ author: 'reviewer-alice', state: 'COMMENTED', submittedAt: hoursAgo(5) }],
    reviewThreads: [
      {
        isResolved: true,
        resolvedBy: 'contributor',
        comments: [{ author: 'codecov[bot]', createdAt: hoursAgo(6) }],
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.warnings, undefined);
});

test('resolvedWithoutReply ignores outside contributor comments', () => {
  const pr = basePr({
    reviews: [{ author: 'reviewer-alice', state: 'COMMENTED', submittedAt: hoursAgo(5) }],
    reviewThreads: [
      {
        isResolved: true,
        resolvedBy: 'contributor',
        comments: [{ author: 'outside-contributor', createdAt: hoursAgo(6) }],
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.warnings, undefined);
});

test('resolvedWithoutReply recognizes a reviewer despite a later outside comment', () => {
  const pr = basePr({
    reviews: [
      {
        author: 'reviewer-alice',
        state: 'COMMENTED',
        submittedAt: hoursAgo(8),
      },
    ],
    reviewThreads: [
      {
        isResolved: true,
        resolvedBy: 'contributor',
        comments: [
          { author: 'reviewer-alice', createdAt: hoursAgo(8) },
          { author: 'outside-contributor', createdAt: hoursAgo(2) },
        ],
      },
    ],
  });
  const res = classifyActor(pr);
  assert.deepEqual(res.warnings, ['resolved_without_reply']);
});

test('resolvedWithoutReply skips thread when reviewer comments have no valid timestamps', () => {
  const pr = basePr({
    reviewThreads: [
      {
        isResolved: true,
        resolvedBy: 'contributor',
        comments: [
          { author: 'reviewer-alice', createdAt: 'invalid-date' },
          { author: 'contributor', createdAt: hoursAgo(1) },
        ],
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.warnings, undefined);
});

test('resolvedWithoutReply triggers warning when author timestamp is invalid after valid reviewer comment', () => {
  const pr = basePr({
    reviews: [{ author: 'reviewer-alice', state: 'COMMENTED', submittedAt: hoursAgo(5) }],
    reviewThreads: [
      {
        isResolved: true,
        resolvedBy: 'contributor',
        comments: [
          { author: 'reviewer-alice', createdAt: hoursAgo(5) },
          { author: 'contributor', createdAt: 'invalid-date' },
        ],
      },
    ],
  });
  const res = classifyActor(pr);
  assert.deepEqual(res.warnings, ['resolved_without_reply']);
});

test('resolvedWithoutReply with mixed reviewer timestamps uses the valid timestamp', () => {
  // Case A: Author replied after the valid reviewer timestamp -> warning suppressed
  const prReplied = basePr({
    reviews: [{ author: 'reviewer-bob', state: 'COMMENTED', submittedAt: hoursAgo(5) }],
    reviewThreads: [
      {
        isResolved: true,
        resolvedBy: 'contributor',
        comments: [
          { author: 'reviewer-alice', createdAt: 'invalid-date' },
          { author: 'reviewer-bob', createdAt: hoursAgo(5) },
          { author: 'contributor', createdAt: hoursAgo(2) },
        ],
      },
    ],
  });
  const resReplied = classifyActor(prReplied);
  assert.equal(resReplied.warnings, undefined);

  // Case B: Author replied before the valid reviewer timestamp -> warning attached
  const prNotReplied = basePr({
    reviews: [{ author: 'reviewer-bob', state: 'COMMENTED', submittedAt: hoursAgo(5) }],
    reviewThreads: [
      {
        isResolved: true,
        resolvedBy: 'contributor',
        comments: [
          { author: 'reviewer-alice', createdAt: 'invalid-date' },
          { author: 'reviewer-bob', createdAt: hoursAgo(5) },
          { author: 'contributor', createdAt: hoursAgo(8) },
        ],
      },
    ],
  });
  const resNotReplied = classifyActor(prNotReplied);
  assert.deepEqual(resNotReplied.warnings, ['resolved_without_reply']);
});

test('Unresolved thread with only bot comments is ignored and does not route to author', () => {
  const pr = basePr({
    reviewThreads: [
      {
        isResolved: false,
        resolvedBy: null,
        comments: [
          { author: 'codecov[bot]', createdAt: hoursAgo(3) },
          { author: 'github-actions[bot]', createdAt: hoursAgo(2) },
        ],
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'awaiting_review');
});

test('Unresolved review thread routes to author even when author comment has unparseable timestamp', () => {
  const pr = basePr({
    reviewThreads: [
      {
        isResolved: false,
        resolvedBy: null,
        comments: [
          { author: 'contributor', createdAt: 'invalid-date' },
          { author: 'reviewer-alice', createdAt: hoursAgo(5) },
        ],
      },
    ],
    reviews: [
      {
        author: 'reviewer-alice',
        state: 'COMMENTED',
        submittedAt: hoursAgo(6),
      },
    ],
  });

  // Directly assert the premise: the upstream predicate fails to trigger due to Date.parse NaN
  assert.equal(unresolvedFromReviewer(pr).triggered, false);

  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'author');
  assert.equal(res.reason, 'unresolved_review_thread');
});

test('Unresolved thread with only outside contributor comments does not block author', () => {
  const pr = basePr({
    reviews: [
      {
        author: 'reviewer-alice',
        state: 'COMMENTED',
        submittedAt: hoursAgo(10),
      },
    ],
    reviewThreads: [
      {
        isResolved: false,
        resolvedBy: null,
        comments: [{ author: 'outside-contributor', createdAt: hoursAgo(2) }],
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'awaiting_review');
});

test('Recognized reviewer blocker is not overridden by later outside contributor comment', () => {
  const reviewerTime = hoursAgo(10);
  const pr = basePr({
    reviews: [
      {
        author: 'reviewer-alice',
        state: 'COMMENTED',
        submittedAt: reviewerTime,
      },
    ],
    reviewThreads: [
      {
        isResolved: false,
        resolvedBy: null,
        comments: [
          { author: 'reviewer-alice', createdAt: reviewerTime },
          { author: 'outside-contributor', createdAt: hoursAgo(2) },
        ],
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'author');
  assert.equal(res.reason, 'unresolved_review_thread');
  assert.equal(res.turnStartedAt, reviewerTime);
});

test('getHeadCommitDate falls back safely to pr.createdAt when head commit has unparseable date', () => {
  const createTime = hoursAgo(20);
  const pr = basePr({
    createdAt: createTime,
    commits: [
      {
        sha: 'c1',
        messageHeadline: 'invalid date commit',
        messageBody: 'Signed-off-by: Contributor <contributor@example.com>',
        authorEmail: 'contributor@example.com',
        committedDate: 'invalid-date',
        parents: 1,
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.turnStartedAt, createTime);
});

test('Conflict clock activity ignores comments from outside contributors', () => {
  const reviewTime = hoursAgo(10);
  const outsideCommentTime = hoursAgo(2);
  const pr = basePr({
    mergeable: 'CONFLICTING',
    reviews: [
      {
        author: 'reviewer-alice',
        state: 'COMMENTED',
        submittedAt: reviewTime,
      },
    ],
    reviewThreads: [
      {
        isResolved: false,
        resolvedBy: null,
        comments: [
          { author: 'reviewer-alice', createdAt: reviewTime },
          { author: 'outside-contributor', createdAt: outsideCommentTime },
        ],
      },
    ],
    comments: [{ author: 'outside-contributor', createdAt: outsideCommentTime }],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'author');
  assert.equal(res.reason, 'merge_conflict');
  assert.equal(res.turnStartedAt, reviewTime);
});

test('Classifier input test: >100 commits evaluated for DCO missing', () => {
  const commits = [];
  for (let i = 0; i < 105; i++) {
    commits.push({
      sha: `sha${i}`,
      messageHeadline: `commit ${i}`,
      messageBody:
        i === 102 ? 'Missing DCO' : 'Signed-off-by: Contributor <contributor@example.com>',
      authorEmail: 'contributor@example.com',
      committedDate: hoursAgo(105 - i),
      parents: 1,
    });
  }
  const pr = basePr({ commits });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'author');
  assert.equal(res.reason, 'dco_missing');
});

test('Classifier input test: >50 comments in one review thread evaluated for latest author response', () => {
  const comments = [];
  for (let i = 0; i < 56; i++) {
    comments.push({
      author: i % 2 === 0 ? 'reviewer-alice' : 'contributor',
      createdAt: hoursAgo(56 - i),
    });
  }
  const pr = basePr({
    reviewThreads: [
      {
        isResolved: false,
        resolvedBy: null,
        comments,
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'awaiting_review');
});

test('Classifier input test: >50 reviews evaluated with oldest review as sole blocker', () => {
  // In-memory classifier test: verifies that an in-memory review list exceeding the GraphQL
  // reviews(last: 50) snapshot limit evaluates all reviews back to index 0. If an implementation
  // truncated to the last 50 reviews, it would miss reviewer-0 and fail this assertion.
  const states: Array<'COMMENTED' | 'APPROVED' | 'DISMISSED' | 'PENDING'> = [
    'COMMENTED',
    'APPROVED',
    'DISMISSED',
    'PENDING',
  ];
  const reviews = [];
  // Reviewer 0 is the oldest review (outside the last-50 window) and the only blocker
  reviews.push({
    author: 'reviewer-0',
    state: 'CHANGES_REQUESTED' as const,
    submittedAt: hoursAgo(60),
  });

  // Reviewers 1 through 55 are newer and cycle through non-blocking states
  for (let i = 1; i < 56; i++) {
    reviews.push({
      author: `reviewer-${i}`,
      state: states[(i - 1) % states.length]!,
      submittedAt: hoursAgo(60 - i),
    });
  }

  const pr = basePr({ reviews });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'author');
  assert.equal(res.reason, 'changes_requested');
});
