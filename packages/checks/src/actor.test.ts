// Copyright (c) 2026 The Jaeger Authors.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import type { PullRequest } from './types.js';
import { classifyActor, isEarlier, isLater, parseDateSafe } from './actor.js';
import { getActorIdentityKind, isBotLogin, isDependencyBotAuthor, sameLogin } from './logins.js';
import { ciFailing } from './predicates/ci_failing.js';
import { resolvedWithoutReply } from './predicates/resolved_without_reply.js';
import { unresolvedFromReviewer } from './predicates/unresolved_from_reviewer.js';

const now = new Date('2026-10-30T12:00:00.000Z');

function hoursAgo(hours: number): string {
  return new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString();
}

function daysAgo(days: number): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

type PullRequestOverrides = Omit<
  Partial<PullRequest>,
  'commits' | 'reviews' | 'comments' | 'reviewThreads'
> & {
  commits?: Array<Partial<PullRequest['commits'][number]>>;
  reviews?: Array<Partial<PullRequest['reviews'][number]>>;
  comments?: Array<Partial<PullRequest['comments'][number]>>;
  reviewThreads?: Array<
    Partial<Omit<NonNullable<PullRequest['reviewThreads']>[number], 'comments'>> & {
      comments?: Array<
        Partial<NonNullable<PullRequest['reviewThreads']>[number]['comments'][number]>
      >;
    }
  >;
};

function basePr(overrides: PullRequestOverrides = {}): PullRequest {
  const defaultCommit: PullRequest['commits'][number] = {
    sha: 'abc1234',
    messageHeadline: 'feat: example change',
    messageBody: 'Signed-off-by: Contributor <contributor@example.com>',
    authorEmail: 'contributor@example.com',
    authorLogin: 'contributor',
    authorTypename: 'User',
    committedDate: daysAgo(5),
    parents: 1,
    parentOids: ['sha-parent'],
    parentsTruncated: false,
    changedFilesIfAvailable: 1,
  };

  const commits: PullRequest['commits'] = (overrides.commits ?? [defaultCommit]).map((c) => ({
    sha: c.sha ?? 'abc1234',
    messageHeadline: c.messageHeadline ?? 'feat: example change',
    messageBody: c.messageBody ?? 'Signed-off-by: Contributor <contributor@example.com>',
    authorEmail: c.authorEmail !== undefined ? c.authorEmail : 'contributor@example.com',
    authorLogin: c.authorLogin !== undefined ? c.authorLogin : 'contributor',
    authorTypename: c.authorTypename !== undefined ? c.authorTypename : 'User',
    committedDate: c.committedDate ?? daysAgo(5),
    parents: c.parents ?? 1,
    parentOids: c.parentOids ?? ['sha-parent'],
    parentsTruncated: c.parentsTruncated ?? false,
    changedFilesIfAvailable:
      c.changedFilesIfAvailable !== undefined ? c.changedFilesIfAvailable : 1,
  }));

  const headRefOid = overrides.headRefOid ?? commits[commits.length - 1]?.sha ?? 'sha-head';
  const reviews: PullRequest['reviews'] = (overrides.reviews ?? []).map((r) => {
    const author = r.author !== undefined ? r.author : 'reviewer';
    const authorTypename =
      r.authorTypename !== undefined
        ? r.authorTypename
        : author === null
          ? null
          : isBotLogin(author)
            ? 'Bot'
            : 'User';
    return {
      id: r.id ?? 'PRR_test',
      author,
      authorTypename,
      state: r.state ?? 'APPROVED',
      submittedAt: r.submittedAt ?? hoursAgo(1),
      commitOid:
        r.commitOid !== undefined
          ? r.commitOid
          : (commits
              .filter(
                (c) =>
                  parseDateSafe(c.committedDate) <= parseDateSafe(r.submittedAt ?? hoursAgo(1)),
              )
              .at(-1)?.sha ?? null),
      ...(r.url !== undefined ? { url: r.url } : {}),
      ...(r.body !== undefined ? { body: r.body } : {}),
    };
  });

  const comments: PullRequest['comments'] = (overrides.comments ?? []).map((c) => {
    const author = c.author !== undefined ? c.author : 'contributor';
    const authorTypename =
      c.authorTypename !== undefined
        ? c.authorTypename
        : author === null
          ? null
          : isBotLogin(author)
            ? 'Bot'
            : 'User';
    return {
      author,
      authorTypename,
      authorAssociation: c.authorAssociation !== undefined ? c.authorAssociation : 'CONTRIBUTOR',
      createdAt: c.createdAt ?? hoursAgo(1),
    };
  });

  const requestedReviewerLogins = new Set(
    (overrides.reviewRequests ?? [])
      .filter((request) => request.kind === 'user')
      .map((request) => request.login.trim().toLowerCase()),
  );

  const reviewThreads: PullRequest['reviewThreads'] = Object.hasOwn(overrides, 'reviewThreads')
    ? overrides.reviewThreads === undefined
      ? undefined
      : overrides.reviewThreads.map((t) => ({
          path: t.path,
          isResolved: t.isResolved ?? false,
          resolvedBy: t.resolvedBy !== undefined ? t.resolvedBy : null,
          commentsTruncated: t.commentsTruncated !== undefined ? t.commentsTruncated : false,
          comments: (t.comments ?? []).map((c) => {
            const author = c.author !== undefined ? c.author : null;
            const matchingReview = reviews.find((review) => sameLogin(review.author, author));
            const isRequestedReviewer =
              author !== null && requestedReviewerLogins.has(author.trim().toLowerCase());
            const defaultAnchor = isRequestedReviewer ? headRefOid : null;
            const authorTypename =
              c.authorTypename !== undefined
                ? c.authorTypename
                : author === null
                  ? null
                  : isBotLogin(author)
                    ? 'Bot'
                    : 'User';
            return {
              author,
              authorTypename,
              authorAssociation:
                c.authorAssociation !== undefined ? c.authorAssociation : 'CONTRIBUTOR',
              createdAt: c.createdAt ?? hoursAgo(1),
              commitOid:
                c.commitOid !== undefined
                  ? c.commitOid
                  : (matchingReview?.commitOid ?? defaultAnchor),
              originalCommitOid:
                c.originalCommitOid !== undefined
                  ? c.originalCommitOid
                  : (matchingReview?.commitOid ?? defaultAnchor),
              pullRequestReview:
                c.pullRequestReview !== undefined
                  ? c.pullRequestReview
                  : matchingReview
                    ? {
                        id: matchingReview.id,
                        state: matchingReview.state,
                        submittedAt: matchingReview.submittedAt,
                        commitOid: matchingReview.commitOid,
                      }
                    : null,
            };
          }),
        }))
    : [];

  return {
    repo: { owner: 'jaegertracing', name: 'jaeger' },
    number: 1,
    title: 'Example pull request',
    url: 'https://github.com/jaegertracing/jaeger/pull/1',
    headRefOid,
    baseRefOid: overrides.baseRefOid ?? 'sha-base',
    author: { login: 'contributor', typename: 'User' },
    authorAssociation: 'CONTRIBUTOR',
    isDraft: false,
    mergeable: 'MERGEABLE',
    createdAt: daysAgo(5),
    updatedAt: hoursAgo(2),
    labels: [],
    labelsTruncated: false,
    additions: 10,
    deletions: 2,
    changedFiles: 1,
    files: ['pkg/test.go'],
    statusCheckRollup: 'SUCCESS',
    headCheckRuns: Object.hasOwn(overrides, 'headCheckRuns') ? overrides.headCheckRuns : [],
    commitsTruncated: false,
    commentsTruncated: Object.hasOwn(overrides, 'commentsTruncated')
      ? (overrides.commentsTruncated as boolean)
      : false,
    reviewRequests: [],
    reviewRequestsTruncated: false,
    reviewsTruncated: false,
    reviewThreadsTruncated: Object.hasOwn(overrides, 'reviewThreadsTruncated')
      ? (overrides.reviewThreadsTruncated as boolean)
      : false,
    headCheckRunsTruncated: Object.hasOwn(overrides, 'headCheckRunsTruncated')
      ? (overrides.headCheckRunsTruncated as boolean)
      : false,
    ...overrides,
    commits,
    reviews,
    comments,
    reviewThreads,
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

test('Rule 1: Known dependency bot logins remain recognized across actor typenames', () => {
  assert.equal(isDependencyBotAuthor('renovate'), true);
  assert.equal(isDependencyBotAuthor('renovate[bot]'), true);
  assert.equal(isDependencyBotAuthor('renovate-bot'), true);
  assert.equal(isDependencyBotAuthor('other-bot'), false);
  assert.equal(isDependencyBotAuthor('dependabot', 'User'), true);
  assert.equal(isDependencyBotAuthor('renovate', 'EnterpriseUserAccount'), true);
  assert.equal(isDependencyBotAuthor('dependabot', 'Bot'), true);
  assert.equal(isDependencyBotAuthor('dependabot', null), true);
  assert.equal(isDependencyBotAuthor('dependabot', undefined), true);
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
    headCheckRuns: [{ name: 'build', conclusion: 'failure' }],
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
        id: 'review-current',
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
        sha: 'old',
        messageHeadline: 'initial commit',
        messageBody: 'Signed-off-by: Contributor <contributor@example.com>',
        authorEmail: 'contributor@example.com',
        committedDate: hoursAgo(20),
        parents: 1,
        parentOids: ['sha-base'],
      },
      {
        sha: 'newer',
        messageHeadline: 'address review comments',
        messageBody: 'Signed-off-by: Contributor <contributor@example.com>',
        authorEmail: 'contributor@example.com',
        committedDate: hoursAgo(2),
        parents: 1,
        parentOids: ['old'],
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
          { author: 'contributor', authorTypename: 'User', createdAt: hoursAgo(10) },
          { author: 'codecov', authorTypename: 'Bot', createdAt: hoursAgo(5) },
          { author: null, authorTypename: null, createdAt: hoursAgo(3) },
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

test('Rule 8: Successful rollup remains mergeable when check contexts are truncated', () => {
  const pr = basePr({
    statusCheckRollup: 'SUCCESS',
    headCheckRuns: undefined,
    headCheckRunsTruncated: true,
    reviews: [
      {
        author: 'maintainer-charlie',
        state: 'APPROVED',
        submittedAt: hoursAgo(5),
      },
    ],
    mergeable: 'MERGEABLE',
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'maintainer');
  assert.equal(res.reason, 'ready_to_merge');
});

test('Rule 8: One reviewer approves, another has active CHANGES_REQUESTED, author pushes commit -> routes to reviewer', () => {
  // Reviewer A approved, Reviewer B requested changes, author pushed a newer commit addressing it.
  // Because Reviewer B still has CHANGES_REQUESTED as their latest review, GitHub blocks merge.
  // Must NOT route to maintainer; must route to reviewer.
  const pr = basePr({
    commits: [
      {
        sha: 'reviewed001',
        messageHeadline: 'initial commit',
        messageBody: 'Signed-off-by: Contributor <contributor@example.com>',
        authorEmail: 'contributor@example.com',
        committedDate: hoursAgo(10),
        parents: 1,
        parentOids: ['sha-base'],
      },
      {
        sha: 'addr001',
        messageHeadline: 'address comments',
        messageBody: 'Signed-off-by: Contributor <contributor@example.com>',
        authorEmail: 'contributor@example.com',
        committedDate: hoursAgo(1),
        parents: 1,
        parentOids: ['reviewed001'],
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
        commitOid: 'reviewed001',
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

test('Review state supersession: Approval NOT superseded by newer COMMENTED review', () => {
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
  assert.equal(res.nextActor, 'maintainer');
  assert.equal(res.reason, 'ready_to_merge');
});

test('Review state supersession: CHANGES_REQUESTED NOT superseded by newer COMMENTED review', () => {
  const pr = basePr({
    reviews: [
      {
        author: 'reviewer-a',
        state: 'CHANGES_REQUESTED',
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
  assert.equal(res.nextActor, 'author');
  assert.equal(res.reason, 'changes_requested');
});

test('Review state supersession: Approval NOT superseded by newer PENDING review', () => {
  const pr = basePr({
    reviews: [
      {
        author: 'reviewer-a',
        state: 'APPROVED',
        submittedAt: hoursAgo(8),
      },
      {
        author: 'reviewer-a',
        state: 'PENDING',
        submittedAt: hoursAgo(2),
      },
    ],
  });

  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'maintainer');
  assert.equal(res.reason, 'ready_to_merge');
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
    createdAt: daysAgo(12),
    statusCheckRollup: 'FAILURE',
    headCheckRuns: [{ name: 'build', conclusion: 'failure' }],
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

test('Rule 8: Approval predating a newer head commit requires re-review', () => {
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
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'awaiting_review');
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

test('Timestamp validation: reviewer with valid and malformed reviews fails closed to indeterminate', () => {
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
  // An invalid review timestamp prevents treating older review states as authoritative
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'uninspected_review_data');
  assert.ok(res.warnings?.includes('review_timestamps_invalid'));
  assert.ok(res.warnings?.includes('review_data_incomplete'));
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

test('Timestamp validation: corrupt approval timestamp fails closed to indeterminate', () => {
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
        parentOids: ['sha-base'],
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
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'uninspected_review_data');
  assert.ok(res.warnings?.includes('review_timestamps_invalid'));
  assert.ok(res.warnings?.includes('review_data_incomplete'));
});

test('Timestamp validation: thread comment selection with partially malformed reviewer timestamps fails closed to indeterminate', () => {
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
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'uninspected_review_data');
});

test('Timestamp validation: unresolved thread with only malformed timestamps fails closed to indeterminate', () => {
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
  assert.equal(res.reason, 'uninspected_review_data');
});

test('Timestamp validation: review with malformed submittedAt is explicitly rejected and fails closed to indeterminate', () => {
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
  // Malformed review cannot block author nor clear review; fails closed to indeterminate
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'uninspected_review_data');
  assert.ok(res.warnings?.includes('review_timestamps_invalid'));
  assert.ok(res.warnings?.includes('review_data_incomplete'));
});

test('Unresolved review thread on PR with deleted/null author does not route to author', () => {
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
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'uninspected_review_data');
  assert.ok(res.warnings?.includes('author_identity_unavailable'));
  assert.ok(res.warnings?.includes('review_data_incomplete'));
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
        comments: [{ author: 'codecov[bot]', authorTypename: 'Bot', createdAt: hoursAgo(6) }],
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

test('classifyActor ignores malformed timestamps alongside human reviewer comments in resolved threads', () => {
  const pr = basePr({
    reviewThreads: [
      {
        isResolved: true,
        resolvedBy: 'contributor',
        comments: [
          {
            author: 'reviewer-alice',
            authorTypename: 'User',
            authorAssociation: 'MEMBER',
            createdAt: 'invalid-date',
          },
          {
            author: 'reviewer-bob',
            authorTypename: 'User',
            authorAssociation: 'MEMBER',
            createdAt: hoursAgo(5),
          },
          {
            author: 'contributor',
            authorTypename: 'User',
            authorAssociation: 'CONTRIBUTOR',
            createdAt: hoursAgo(1),
          },
        ],
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.warnings?.includes('resolved_without_reply'), false);
  assert.ok(res.warnings?.includes('activity_data_incomplete'));
  assert.ok(res.warnings?.includes('review_data_incomplete'));
});

test('resolvedWithoutReply does not trigger warning when author timestamp is invalid', () => {
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
  assert.equal(res.warnings, undefined);
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
          { author: 'codecov[bot]', authorTypename: 'Bot', createdAt: hoursAgo(3) },
          { author: 'github-actions[bot]', authorTypename: 'Bot', createdAt: hoursAgo(2) },
        ],
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'awaiting_review');
});

test('Unresolved review thread routes to reviewer uninspected_review_data when author comment has unparseable timestamp', () => {
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

  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'uninspected_review_data');
  assert.ok(res.warnings?.includes('review_timestamps_invalid'));
  assert.ok(res.warnings?.includes('review_data_incomplete'));
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

test('Classifier input test: >50 comments in one review thread evaluated past pagination boundary (author clears blocker in tail)', () => {
  // If only the first 50 comments (indices 0..49) were inspected, comment 49 is from reviewer-alice
  // without an author reply, which would block the PR on author (unresolved_review_thread).
  // Evaluating past comment 50 reveals author replies (indices 50..55), clearing the thread blocker.
  // With an active review request for reviewer-alice, it routes to reviewer (review_requested).
  const comments = [];
  for (let i = 0; i < 50; i++) {
    comments.push({
      author: i % 2 === 0 ? 'contributor' : 'reviewer-alice',
      createdAt: hoursAgo(60 - i),
    });
  }
  for (let i = 50; i < 56; i++) {
    comments.push({
      author: 'contributor',
      createdAt: hoursAgo(60 - i),
    });
  }
  const pr = basePr({
    reviewRequests: [{ kind: 'user', login: 'reviewer-alice' }],
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
  assert.equal(res.reason, 'review_requested');
});

test('Classifier input test: >50 comments in one review thread evaluated past pagination boundary (reviewer counter-reply in tail creates blocker)', () => {
  // If only the first 50 comments (indices 0..49) were inspected, author has replied at index 49,
  // which would clear the thread blocker and leave the PR waiting on reviewer.
  // Evaluating past comment 50 reveals a reviewer counter-reply at comment 55, which creates
  // a confirmed thread blocker routing to author (unresolved_review_thread).
  const comments = [];
  for (let i = 0; i < 50; i++) {
    comments.push({
      author: i % 2 === 0 ? 'reviewer-alice' : 'contributor',
      createdAt: hoursAgo(60 - i),
    });
  }
  for (let i = 50; i < 55; i++) {
    comments.push({
      author: 'contributor',
      createdAt: hoursAgo(60 - i),
    });
  }
  comments.push({
    author: 'reviewer-alice',
    createdAt: hoursAgo(1),
  });

  const pr = basePr({
    reviews: [{ author: 'reviewer-alice', state: 'COMMENTED', submittedAt: hoursAgo(65) }],
    reviewThreads: [
      {
        isResolved: false,
        resolvedBy: null,
        comments,
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'author');
  assert.equal(res.reason, 'unresolved_review_thread');
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

test('Rule 8: Approved PR with mergeable UNKNOWN routes to reviewer, not maintainer', () => {
  const pr = basePr({
    mergeable: 'UNKNOWN',
    reviews: [
      {
        author: 'maintainer-charlie',
        state: 'APPROVED',
        submittedAt: hoursAgo(5),
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'awaiting_review');
});

test('Rule 8: Approved PR with mergeable MERGEABLE routes to maintainer ready_to_merge', () => {
  const pr = basePr({
    mergeable: 'MERGEABLE',
    reviews: [
      {
        author: 'maintainer-charlie',
        state: 'APPROVED',
        submittedAt: hoursAgo(5),
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'maintainer');
  assert.equal(res.reason, 'ready_to_merge');
});

test('Rule 8: Truncated labels do not block an otherwise complete approval', () => {
  const pr = basePr({
    labelsTruncated: true,
    reviews: [
      {
        author: 'maintainer-charlie',
        state: 'APPROVED',
        submittedAt: hoursAgo(5),
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'maintainer');
  assert.equal(res.reason, 'ready_to_merge');
});

test('Bot review comments do not count as unresolved reviewer feedback', () => {
  const pr = basePr({
    reviewThreads: [
      {
        isResolved: false,
        resolvedBy: null,
        commentsTruncated: false,
        comments: [
          {
            author: 'unlisted-bot',
            authorTypename: 'Bot',
            authorAssociation: 'NONE',
            createdAt: hoursAgo(1),
          },
        ],
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'awaiting_review');
});

test('classifyActor flags truncated thread comments as uninspected review data', () => {
  const commit = basePr().commits[0]!;
  const pr = basePr({
    commits: [{ ...commit, committedDate: hoursAgo(0.5) }],
    reviewThreads: [
      {
        isResolved: false,
        resolvedBy: null,
        commentsTruncated: true,
        comments: [
          {
            author: 'reviewer-alice',
            authorTypename: 'User',
            authorAssociation: 'MEMBER',
            createdAt: hoursAgo(1),
          },
        ],
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'uninspected_review_data');
  assert.ok(res.warnings?.includes('thread_comments_truncated'));
});

test('classifyActor ignores non-human actors in thread resolution and reviewer feedback', () => {
  const commit = basePr().commits[0]!;
  const unresolvedPr = basePr({
    commits: [{ ...commit, committedDate: hoursAgo(0.5) }],
    reviewThreads: [
      {
        isResolved: false,
        resolvedBy: null,
        commentsTruncated: false,
        comments: [
          {
            author: 'deleted-reviewer',
            authorTypename: 'Mannequin',
            authorAssociation: 'MEMBER',
            createdAt: hoursAgo(1),
          },
        ],
      },
    ],
  });
  const unresolvedRes = classifyActor(unresolvedPr);
  assert.equal(unresolvedRes.reason, 'awaiting_review');

  const resolvedPr = basePr({
    reviewThreads: [
      {
        isResolved: true,
        resolvedBy: 'contributor',
        commentsTruncated: false,
        comments: [
          {
            author: 'org-reviewer',
            authorTypename: 'Organization',
            authorAssociation: 'MEMBER',
            createdAt: hoursAgo(1),
          },
        ],
      },
    ],
  });
  const resolvedRes = classifyActor(resolvedPr);
  assert.equal(resolvedRes.warnings, undefined);
});

test('Unresolved reviewer predicate triggers when reviewer comment is unreplied', () => {
  const commit = basePr().commits[0]!;
  const pr = basePr({
    commits: [{ ...commit, committedDate: hoursAgo(0.5) }],
    reviewThreads: [
      {
        isResolved: false,
        resolvedBy: null,
        commentsTruncated: false,
        comments: [
          {
            author: 'reviewer-alice',
            authorTypename: 'User',
            authorAssociation: 'MEMBER',
            createdAt: hoursAgo(1),
          },
        ],
      },
    ],
  });
  const result = unresolvedFromReviewer(pr);
  assert.equal(result.triggered, true);
  assert.equal(result.hidesFromTriage, true);
  assert.equal(
    result.summary,
    "1 review thread(s) unresolved \u2014 the reviewer's comment hasn't been replied to",
  );
});

test('classifyActor flags truncated thread comments in resolved threads', () => {
  const pr = basePr({
    reviewThreads: [
      {
        isResolved: true,
        resolvedBy: 'contributor',
        commentsTruncated: true,
        comments: [
          {
            author: 'reviewer-alice',
            authorTypename: 'User',
            authorAssociation: 'MEMBER',
            createdAt: hoursAgo(1),
          },
        ],
      },
    ],
  });
  const res = classifyActor(pr);
  assert.ok(res.warnings?.includes('thread_comments_truncated'));
});

test('A bot comment matching the author login is not an author reply in classifyActor', () => {
  const pr = basePr({
    reviewThreads: [
      {
        isResolved: true,
        resolvedBy: 'contributor',
        commentsTruncated: false,
        comments: [
          {
            author: 'reviewer-alice',
            authorTypename: 'User',
            authorAssociation: 'MEMBER',
            createdAt: hoursAgo(2),
          },
          {
            author: 'contributor',
            authorTypename: 'Bot',
            authorAssociation: 'NONE',
            createdAt: hoursAgo(1),
          },
        ],
      },
    ],
  });
  const res = classifyActor(pr);
  assert.ok(res.warnings?.includes('resolved_without_reply'));
});

test('Bot review comments do not count as unresolved feedback when a thread is resolved', () => {
  const pr = basePr({
    reviewThreads: [
      {
        isResolved: true,
        resolvedBy: 'contributor',
        commentsTruncated: false,
        comments: [
          {
            author: 'unlisted-bot',
            authorTypename: 'Bot',
            authorAssociation: 'NONE',
            createdAt: hoursAgo(1),
          },
        ],
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.warnings?.includes('resolved_without_reply') ?? false, false);
});

test('Rule 8: Approved PR with label-only CI failure routes to reviewer needs_label', () => {
  const pr = basePr({
    statusCheckRollup: 'FAILURE',
    headCheckRuns: [
      {
        name: 'check-labels',
        conclusion: 'failure',
      },
    ],
    headCheckRunsTruncated: false,
    reviews: [
      {
        author: 'maintainer-charlie',
        state: 'APPROVED',
        submittedAt: hoursAgo(5),
      },
    ],
    mergeable: 'MERGEABLE',
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'needs_label');
});

test('Rule 8: Approved PR with label-only failure but pending CI checks routes to reviewer, not maintainer', () => {
  const pr = basePr({
    statusCheckRollup: 'FAILURE',
    headCheckRuns: [
      {
        name: 'check-labels',
        conclusion: 'failure',
      },
      {
        name: 'unit-tests',
        conclusion: null, // still running in background
      },
    ],
    headCheckRunsTruncated: false,
    reviews: [
      {
        author: 'maintainer-charlie',
        state: 'APPROVED',
        submittedAt: hoursAgo(5),
      },
    ],
    mergeable: 'MERGEABLE',
  });
  const res = classifyActor(pr);
  // Tests are still in progress; must not route to maintainer as ready to merge
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'awaiting_review');
});

test('Rule 8: Approved PR with mixed failure (label gate + test failure) routes to author ci_failing', () => {
  const pr = basePr({
    statusCheckRollup: 'FAILURE',
    headCheckRuns: [
      {
        name: 'check-labels',
        conclusion: 'failure',
      },
      {
        name: 'unit-tests',
        conclusion: 'failure',
      },
    ],
    headCheckRunsTruncated: false,
    reviews: [
      {
        author: 'maintainer-charlie',
        state: 'APPROVED',
        submittedAt: hoursAgo(5),
      },
    ],
    mergeable: 'MERGEABLE',
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'author');
  assert.equal(res.reason, 'ci_failing');
});

test('Rule 8: Approved PR with truncated checks and visible label failure routes to author ci_failing', () => {
  const pr = basePr({
    statusCheckRollup: 'FAILURE',
    headCheckRuns: [
      {
        name: 'check-labels',
        conclusion: 'failure',
      },
    ],
    headCheckRunsTruncated: true,
    reviews: [
      {
        author: 'maintainer-charlie',
        state: 'APPROVED',
        submittedAt: hoursAgo(5),
      },
    ],
    mergeable: 'MERGEABLE',
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'author');
  assert.equal(res.reason, 'ci_failing');
});

test('Rule 8: Approved PR with label-only CI failure and merge conflict routes to author merge_conflict', () => {
  const pr = basePr({
    statusCheckRollup: 'FAILURE',
    headCheckRuns: [
      {
        name: 'check-labels',
        conclusion: 'failure',
      },
    ],
    headCheckRunsTruncated: false,
    mergeable: 'CONFLICTING',
    reviews: [
      {
        author: 'maintainer-charlie',
        state: 'APPROVED',
        submittedAt: hoursAgo(5),
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'author');
  assert.equal(res.reason, 'merge_conflict');
});

test('Rule 8: Approved PR with label-only CI failure and active CHANGES_REQUESTED routes to author changes_requested', () => {
  const pr = basePr({
    statusCheckRollup: 'FAILURE',
    headCheckRuns: [
      {
        name: 'check-labels',
        conclusion: 'failure',
      },
    ],
    headCheckRunsTruncated: false,
    mergeable: 'MERGEABLE',
    reviews: [
      {
        author: 'reviewer-a',
        state: 'APPROVED',
        submittedAt: hoursAgo(5),
      },
      {
        author: 'reviewer-b',
        state: 'CHANGES_REQUESTED',
        submittedAt: hoursAgo(3),
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'author');
  assert.equal(res.reason, 'changes_requested');
});

test('Bot detection: Review from coderabbitai is ignored and does not count as human approval', () => {
  const pr = basePr({
    reviews: [
      {
        author: 'coderabbitai',
        state: 'APPROVED',
        submittedAt: hoursAgo(5),
      },
    ],
    mergeable: 'MERGEABLE',
  });
  const res = classifyActor(pr);
  // No human approval exists, so it cannot be ready_to_merge
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'awaiting_review');
});

test('Bot detection: Review from coderabbitai requesting changes does not block author', () => {
  const pr = basePr({
    reviews: [
      {
        author: 'coderabbitai',
        state: 'CHANGES_REQUESTED',
        submittedAt: hoursAgo(5),
      },
    ],
  });
  const res = classifyActor(pr);
  // Bot change request does not block author
  assert.notEqual(res.nextActor, 'author');
});

test('Author addressing changes: Merge commit (parents > 1) does NOT clear changes requested blocker', () => {
  const pr = basePr({
    commits: [
      {
        sha: 'base001',
        messageHeadline: 'initial commit',
        messageBody: 'Signed-off-by: Contributor <contributor@example.com>',
        authorEmail: 'contributor@example.com',
        committedDate: hoursAgo(10),
        parents: 1,
        parentOids: ['sha-base'],
      },
      {
        sha: 'merge002',
        messageHeadline: 'Merge branch main into feat',
        messageBody: 'Merge commit',
        authorEmail: 'contributor@example.com',
        committedDate: hoursAgo(1),
        parents: 2,
        parentOids: ['base001', 'sha-base'],
      },
    ],
    reviews: [
      {
        author: 'reviewer-b',
        commitOid: 'base001',
        state: 'CHANGES_REQUESTED',
        submittedAt: hoursAgo(4),
      },
    ],
  });

  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'author');
  assert.equal(res.reason, 'changes_requested');
});

test('Author addressing changes: Code commit (parents <= 1) DOES clear changes requested blocker', () => {
  const pr = basePr({
    commits: [
      {
        sha: 'base001',
        messageHeadline: 'initial commit',
        messageBody: 'Signed-off-by: Contributor <contributor@example.com>',
        authorEmail: 'contributor@example.com',
        committedDate: hoursAgo(10),
        parents: 1,
      },
      {
        sha: 'code002',
        messageHeadline: 'fix: address reviewer comments',
        messageBody: 'Signed-off-by: Contributor <contributor@example.com>',
        authorEmail: 'contributor@example.com',
        committedDate: hoursAgo(1),
        parents: 1,
        parentOids: ['base001'],
      },
    ],
    reviews: [
      {
        author: 'reviewer-b',
        state: 'CHANGES_REQUESTED',
        submittedAt: hoursAgo(4),
      },
    ],
  });

  const res = classifyActor(pr);
  // Blocker cleared by code commit; moves back to reviewer
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'awaiting_review');
});

test('Truncation gating: PR with 50 reviews does not fail open into ready_to_merge', () => {
  const reviews = [];
  for (let i = 0; i < 50; i++) {
    reviews.push({
      author: `reviewer-${i}`,
      state: 'APPROVED' as const,
      submittedAt: hoursAgo(50 - i),
    });
  }
  const pr = basePr({
    reviews,
    reviewsTruncated: true,
    mergeable: 'MERGEABLE',
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'uninspected_review_data');
  assert.ok(res.warnings?.includes('reviews_truncated'));
  assert.ok(res.warnings?.includes('review_data_incomplete'));
});

test('Truncation gating: PR with 50 thread comments does not fail open into ready_to_merge', () => {
  const comments = [];
  for (let i = 0; i < 50; i++) {
    comments.push({
      author: 'contributor',
      createdAt: hoursAgo(50 - i),
    });
  }
  const pr = basePr({
    reviews: [
      {
        author: 'reviewer-a',
        state: 'APPROVED',
        submittedAt: hoursAgo(5),
      },
    ],
    reviewThreads: [
      {
        isResolved: false,
        resolvedBy: null,
        comments,
        commentsTruncated: true,
      },
    ],
    mergeable: 'MERGEABLE',
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'uninspected_review_data');
  assert.ok(res.warnings?.includes('thread_comments_truncated'));
  assert.ok(res.warnings?.includes('review_data_incomplete'));
});

test('Head commit date clamping: Commit older than createdAt is clamped to createdAt', () => {
  const pr = basePr({
    createdAt: daysAgo(2),
    commits: [
      {
        sha: 'c1',
        messageHeadline: 'old commit rebased',
        messageBody: 'Signed-off-by: Contributor <contributor@example.com>',
        authorEmail: 'contributor@example.com',
        committedDate: daysAgo(10), // older than createdAt
        parents: 1,
      },
    ],
    statusCheckRollup: 'FAILURE',
    headCheckRuns: [{ name: 'build', conclusion: 'failure' }],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'author');
  assert.equal(res.reason, 'ci_failing');
  // Clamped to createdAt instead of daysAgo(10)
  assert.equal(res.turnStartedAt, pr.createdAt);
});

test('Resolved thread filtering: Author reply to unresolved thread clears CHANGES_REQUESTED despite historical resolved thread', () => {
  const pr = basePr({
    commits: [
      {
        sha: 'c1',
        messageHeadline: 'initial commit',
        messageBody: 'Signed-off-by: Contributor <contributor@example.com>',
        authorEmail: 'contributor@example.com',
        committedDate: hoursAgo(10),
        parents: 1,
      },
    ],
    reviews: [
      {
        id: 'review-current',
        author: 'reviewer-alice',
        state: 'CHANGES_REQUESTED',
        submittedAt: hoursAgo(4),
      },
    ],
    reviewThreads: [
      {
        // Historical resolved thread from earlier
        isResolved: true,
        resolvedBy: 'reviewer-alice',
        comments: [
          { author: 'reviewer-alice', createdAt: hoursAgo(8) },
          { author: 'contributor', createdAt: hoursAgo(7) },
        ],
      },
      {
        // Active thread for current review
        isResolved: false,
        resolvedBy: null,
        comments: [
          { author: 'reviewer-alice', createdAt: hoursAgo(4) },
          { author: 'contributor', createdAt: hoursAgo(2) },
        ],
      },
    ],
  });

  const res = classifyActor(pr);
  // Author replied to the only active thread; blocker is addressed
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'awaiting_review');
});

test('Resolved thread filtering: Author reply to review thread clears CHANGES_REQUESTED when thread is subsequently resolved', () => {
  // If author replies after the review was submitted, and then the thread is marked resolved,
  // the PR must remain addressed (routes to reviewer, not author).
  const pr = basePr({
    commits: [
      {
        sha: 'c1',
        messageHeadline: 'initial commit',
        messageBody: 'Signed-off-by: Contributor <contributor@example.com>',
        authorEmail: 'contributor@example.com',
        committedDate: hoursAgo(10),
        parents: 1,
      },
    ],
    reviews: [
      {
        id: 'review-current',
        author: 'reviewer-alice',
        state: 'CHANGES_REQUESTED',
        submittedAt: hoursAgo(4),
      },
    ],
    reviewThreads: [
      {
        isResolved: true,
        resolvedBy: 'reviewer-alice',
        comments: [
          {
            author: 'reviewer-alice',
            createdAt: hoursAgo(4),
            pullRequestReview: {
              id: 'review-current',
              state: 'CHANGES_REQUESTED',
              submittedAt: hoursAgo(4),
              commitOid: null,
            },
          },
          { author: 'contributor', createdAt: hoursAgo(2) },
        ],
      },
    ],
  });

  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'awaiting_review');
});

test('sameLogin rejects invalid types, empty strings, and trims whitespace safely', () => {
  assert.equal(sameLogin(null, 'alice'), false);
  assert.equal(sameLogin(undefined, 'alice'), false);
  assert.equal(sameLogin('', ''), false);
  assert.equal(sameLogin('   ', '   '), false);
  assert.equal(sameLogin('  alice  ', 'alice'), true);
  assert.equal(sameLogin('Alice', 'alice'), true);
  assert.equal(sameLogin({ login: 'alice' } as any, 'alice'), false);
  assert.equal(sameLogin(123 as any, 123 as any), false);
});

test('Outer thread truncation (reviewThreadsTruncated: true) routes to uninspected_review_data with review_threads_truncated', () => {
  const pr = basePr({
    reviewThreadsTruncated: true,
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'uninspected_review_data');
  assert.ok(res.warnings?.includes('review_threads_truncated'));
  assert.ok(res.warnings?.includes('review_data_incomplete'));
});

test('Label-only CI failure with complete check data routes to reviewer needs_label when approved and mergeable', () => {
  const pr = basePr({
    statusCheckRollup: 'FAILURE',
    headCheckRuns: [
      {
        name: 'check-labels',
        conclusion: 'failure',
      },
    ],
    headCheckRunsTruncated: false,
    reviews: [
      {
        author: 'maintainer-charlie',
        state: 'APPROVED',
        submittedAt: hoursAgo(5),
      },
    ],
    mergeable: 'MERGEABLE',
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'needs_label');
});

test('Multiple completeness warnings collected in single classification', () => {
  const pr = basePr({
    commitsTruncated: true,
    reviewRequestsTruncated: true,
    reviewsTruncated: true,
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'uninspected_review_data');
  assert.ok(res.warnings?.includes('commits_truncated'));
  assert.ok(res.warnings?.includes('review_requests_truncated'));
  assert.ok(res.warnings?.includes('reviews_truncated'));
  assert.ok(res.warnings?.includes('review_data_incomplete'));
});

test('Maintainer top-level comment activity advances turnStartedAt in getLastReviewOrMaintainerActivity', () => {
  const pr = basePr({
    mergeable: 'CONFLICTING',
    comments: [
      {
        author: 'maintainer-sam',
        authorAssociation: 'MEMBER',
        createdAt: hoursAgo(1),
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'author');
  assert.equal(res.reason, 'merge_conflict');
  assert.equal(res.turnStartedAt, hoursAgo(1));
});

test('Missing headCheckRuns with FAILURE rollup routes to author ci_failing', () => {
  const pr = basePr({
    statusCheckRollup: 'FAILURE',
    headCheckRuns: undefined,
    headCheckRunsTruncated: undefined as any,
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'author');
  assert.equal(res.reason, 'ci_failing');
});

test('Partially invalid reviewer timestamps in CHANGES_REQUESTED fail closed to indeterminate', () => {
  const pr = basePr({
    reviews: [
      {
        author: 'reviewer-alice',
        state: 'CHANGES_REQUESTED',
        submittedAt: hoursAgo(4),
      },
    ],
    reviewThreads: [
      {
        isResolved: false,
        resolvedBy: null,
        comments: [
          { author: 'reviewer-alice', createdAt: hoursAgo(3) },
          { author: 'reviewer-alice', createdAt: 'corrupted-timestamp' },
          { author: 'contributor', createdAt: hoursAgo(2) },
        ],
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'uninspected_review_data');
  assert.ok(res.warnings?.includes('review_timestamps_invalid'));
  assert.ok(res.warnings?.includes('review_data_incomplete'));
});

test('Missing PR author identity prevents human approval from qualifying for ready_to_merge', () => {
  const pr = basePr({
    author: null,
    reviews: [
      {
        author: 'maintainer-charlie',
        state: 'APPROVED',
        submittedAt: hoursAgo(2),
      },
    ],
    mergeable: 'MERGEABLE',
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'uninspected_review_data');
  assert.ok(res.warnings?.includes('author_identity_unavailable'));
  assert.ok(res.warnings?.includes('review_data_incomplete'));
});

test('Multiple open threads in CHANGES_REQUESTED: confirmed blocker wins over indeterminate thread', () => {
  const pr = basePr({
    reviews: [
      {
        author: 'reviewer-alice',
        state: 'CHANGES_REQUESTED',
        submittedAt: hoursAgo(5),
      },
    ],
    reviewThreads: [
      {
        // Thread 1: Indeterminate due to invalid timestamp
        isResolved: false,
        resolvedBy: null,
        comments: [{ author: 'reviewer-alice', createdAt: 'invalid-timestamp' }],
      },
      {
        // Thread 2: Confirmed blocker (reviewer comment complete, no author reply)
        isResolved: false,
        resolvedBy: null,
        comments: [{ author: 'reviewer-alice', createdAt: hoursAgo(4) }],
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'author');
  assert.equal(res.reason, 'changes_requested');
});

test('Multiple open threads in CHANGES_REQUESTED: indeterminate when no confirmed blocker exists', () => {
  const pr = basePr({
    reviews: [
      {
        author: 'reviewer-alice',
        state: 'CHANGES_REQUESTED',
        submittedAt: hoursAgo(5),
      },
    ],
    reviewThreads: [
      {
        // Thread 1: Indeterminate due to invalid timestamp
        isResolved: false,
        resolvedBy: null,
        comments: [{ author: 'reviewer-alice', createdAt: 'invalid-timestamp' }],
      },
      {
        // Thread 2: Verified replied by author
        isResolved: false,
        resolvedBy: null,
        comments: [
          { author: 'reviewer-alice', createdAt: hoursAgo(4) },
          { author: 'contributor', createdAt: hoursAgo(2) },
        ],
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'uninspected_review_data');
  assert.ok(res.warnings?.includes('review_timestamps_invalid'));
  assert.ok(res.warnings?.includes('review_data_incomplete'));
});

test('Precedence 5: Multiple threads where confirmed blocker wins over indeterminate thread', () => {
  const pr = basePr({
    reviewRequests: [{ kind: 'user', login: 'reviewer-alice' }],
    reviewThreads: [
      {
        // Thread 1: Indeterminate due to invalid reviewer timestamp
        isResolved: false,
        resolvedBy: null,
        comments: [{ author: 'reviewer-alice', createdAt: 'invalid-timestamp' }],
      },
      {
        // Thread 2: Confirmed blocker (unanswered reviewer comment)
        isResolved: false,
        resolvedBy: null,
        comments: [{ author: 'reviewer-alice', createdAt: hoursAgo(4) }],
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'author');
  assert.equal(res.reason, 'unresolved_review_thread');
});

test('Precedence 5: Multiple threads where indeterminate evidence routes to reviewer when no blocker exists', () => {
  const pr = basePr({
    reviewRequests: [{ kind: 'user', login: 'reviewer-alice' }],
    reviewThreads: [
      {
        // Thread 1: Indeterminate due to invalid reviewer timestamp
        isResolved: false,
        resolvedBy: null,
        comments: [{ author: 'reviewer-alice', createdAt: 'invalid-timestamp' }],
      },
      {
        // Thread 2: Addressed (author replied)
        isResolved: false,
        resolvedBy: null,
        comments: [
          { author: 'reviewer-alice', createdAt: hoursAgo(4) },
          { author: 'contributor', createdAt: hoursAgo(2) },
        ],
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'uninspected_review_data');
  assert.ok(res.warnings?.includes('review_timestamps_invalid'));
  assert.ok(res.warnings?.includes('review_data_incomplete'));
});

test('Precedence 5: Incomplete thread (commentsTruncated: true) routes to reviewer before waiting-for-author label', () => {
  const pr = basePr({
    labels: ['waiting-for-author'],
    reviewRequests: [{ kind: 'user', login: 'reviewer-alice' }],
    reviewThreads: [
      {
        isResolved: false,
        resolvedBy: null,
        commentsTruncated: true,
        comments: [
          { author: 'reviewer-alice', createdAt: hoursAgo(3) },
          { author: 'contributor', createdAt: hoursAgo(2) },
        ],
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'uninspected_review_data');
  assert.ok(res.warnings?.includes('thread_comments_truncated'));
});

test('CHANGES_REQUESTED with invalid reviewSubmittedAt fails closed to indeterminate', () => {
  const pr = basePr({
    reviews: [
      {
        author: 'reviewer-alice',
        state: 'CHANGES_REQUESTED',
        submittedAt: 'corrupted-timestamp',
      },
    ],
    reviewThreads: [],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'uninspected_review_data');
  assert.ok(res.warnings?.includes('review_timestamps_invalid'));
  assert.ok(res.warnings?.includes('review_data_incomplete'));
});

test('Missing PR author identity in thread does not classify as author blocker', () => {
  const pr = basePr({
    author: null,
    reviewRequests: [{ kind: 'user', login: 'reviewer-alice' }],
    reviewThreads: [
      {
        isResolved: false,
        resolvedBy: null,
        comments: [{ author: 'reviewer-alice', createdAt: hoursAgo(3) }],
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'uninspected_review_data');
  assert.ok(res.warnings?.includes('author_identity_unavailable'));
  assert.ok(res.warnings?.includes('review_data_incomplete'));
});

test('Truncated comments hiding reviewer participation prevents false addressed state', () => {
  const pr = basePr({
    reviews: [
      {
        author: 'reviewer-alice',
        state: 'CHANGES_REQUESTED',
        submittedAt: hoursAgo(5),
      },
    ],
    reviewThreads: [
      {
        // Thread does not visibly list reviewer-alice, but comments are truncated
        isResolved: false,
        resolvedBy: null,
        commentsTruncated: true,
        comments: [{ author: 'other-user', createdAt: hoursAgo(4) }],
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'uninspected_review_data');
  assert.ok(res.warnings?.includes('thread_comments_truncated'));
});

test('hasAuthorResolvedWithoutReply: Partially invalid reviewer timestamp does not attach resolved_without_reply', () => {
  const pr = basePr({
    reviewRequests: [{ kind: 'user', login: 'reviewer-alice' }],
    reviewThreads: [
      {
        isResolved: true,
        resolvedBy: 'contributor',
        comments: [
          { author: 'reviewer-alice', createdAt: hoursAgo(4) },
          { author: 'reviewer-alice', createdAt: 'corrupted-date' },
        ],
      },
    ],
  });
  const res = classifyActor(pr);
  assert.ok(!res.warnings?.includes('resolved_without_reply'));
});

test('hasAuthorResolvedWithoutReply: Partially invalid author timestamp does not attach resolved_without_reply', () => {
  const pr = basePr({
    reviewRequests: [{ kind: 'user', login: 'reviewer-alice' }],
    reviewThreads: [
      {
        isResolved: true,
        resolvedBy: 'contributor',
        comments: [
          { author: 'reviewer-alice', createdAt: hoursAgo(4) },
          { author: 'contributor', createdAt: 'corrupted-date' },
        ],
      },
    ],
  });
  const res = classifyActor(pr);
  assert.ok(!res.warnings?.includes('resolved_without_reply'));
});

test('hasAuthorResolvedWithoutReply: All valid timestamps with no author reply attaches resolved_without_reply', () => {
  const pr = basePr({
    reviewRequests: [{ kind: 'user', login: 'reviewer-alice' }],
    reviewThreads: [
      {
        isResolved: true,
        resolvedBy: 'contributor',
        comments: [{ author: 'reviewer-alice', createdAt: hoursAgo(4) }],
      },
    ],
  });
  const res = classifyActor(pr);
  assert.ok(res.warnings?.includes('resolved_without_reply'));
});

test('Precedence 5: Unresolved thread with 0 comments and commentsTruncated: true routes to reviewer uninspected_review_data', () => {
  const pr = basePr({
    reviewRequests: [{ kind: 'user', login: 'reviewer-alice' }],
    reviewThreads: [
      {
        isResolved: false,
        resolvedBy: null,
        commentsTruncated: true,
        comments: [],
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'uninspected_review_data');
  assert.ok(res.warnings?.includes('thread_comments_truncated'));
});

test('Precedence 5: Unresolved thread with comments not from reviewer and commentsTruncated: true routes to reviewer uninspected_review_data', () => {
  const pr = basePr({
    reviewRequests: [{ kind: 'user', login: 'reviewer-alice' }],
    reviewThreads: [
      {
        isResolved: false,
        resolvedBy: null,
        commentsTruncated: true,
        comments: [{ author: 'other-user', createdAt: hoursAgo(2) }],
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'uninspected_review_data');
  assert.ok(res.warnings?.includes('thread_comments_truncated'));
});

test('Precedence 5: Incomplete thread alongside confirmed blocker routes to author unresolved_review_thread', () => {
  const pr = basePr({
    reviewRequests: [{ kind: 'user', login: 'reviewer-alice' }],
    reviewThreads: [
      {
        // Thread 1: Incomplete with zero comments
        isResolved: false,
        resolvedBy: null,
        commentsTruncated: true,
        comments: [],
      },
      {
        // Thread 2: Complete confirmed blocker
        isResolved: false,
        resolvedBy: null,
        commentsTruncated: false,
        comments: [{ author: 'reviewer-alice', createdAt: hoursAgo(3) }],
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'author');
  assert.equal(res.reason, 'unresolved_review_thread');
});

test('Readiness / Precedence 8: SUCCESS rollup with missing headCheckRuns can reach ready_to_merge', () => {
  const pr = basePr({
    statusCheckRollup: 'SUCCESS',
    headCheckRuns: undefined,
    headCheckRunsTruncated: undefined as any,
    reviews: [
      {
        author: 'maintainer-charlie',
        state: 'APPROVED',
        submittedAt: hoursAgo(5),
      },
    ],
    mergeable: 'MERGEABLE',
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'maintainer');
  assert.equal(res.reason, 'ready_to_merge');
});

test('Missing PR author identity with matching user re-request fails closed to indeterminate', () => {
  const pr = basePr({
    author: null,
    reviews: [
      {
        author: 'reviewer-alice',
        state: 'CHANGES_REQUESTED',
        submittedAt: hoursAgo(5),
      },
    ],
    reviewThreads: [],
    reviewRequests: [{ kind: 'user', login: 'reviewer-alice' }],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'uninspected_review_data');
  assert.ok(res.warnings?.includes('author_identity_unavailable'));
  assert.ok(res.warnings?.includes('review_data_incomplete'));
});

test('Review timestamp ordering: valid APPROVED followed by malformed CHANGES_REQUESTED produces indeterminate', () => {
  const pr = basePr({
    reviews: [
      {
        author: 'reviewer-alice',
        state: 'APPROVED',
        submittedAt: hoursAgo(8),
      },
      {
        author: 'reviewer-alice',
        state: 'CHANGES_REQUESTED',
        submittedAt: 'invalid-date',
      },
    ],
    statusCheckRollup: 'SUCCESS',
    mergeable: 'MERGEABLE',
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'uninspected_review_data');
  assert.ok(res.warnings?.includes('review_timestamps_invalid'));
  assert.ok(res.warnings?.includes('review_data_incomplete'));
});

test('Review timestamp ordering: malformed CHANGES_REQUESTED followed by valid APPROVED produces indeterminate', () => {
  const pr = basePr({
    reviews: [
      {
        author: 'reviewer-alice',
        state: 'CHANGES_REQUESTED',
        submittedAt: 'invalid-date',
      },
      {
        author: 'reviewer-alice',
        state: 'APPROVED',
        submittedAt: hoursAgo(8),
      },
    ],
    statusCheckRollup: 'SUCCESS',
    mergeable: 'MERGEABLE',
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'uninspected_review_data');
  assert.ok(res.warnings?.includes('review_timestamps_invalid'));
  assert.ok(res.warnings?.includes('review_data_incomplete'));
});

test('Valid CHANGES_REQUESTED from reviewer A + invalid review timestamp from reviewer B routes to author', () => {
  const pr = basePr({
    reviews: [
      {
        author: 'reviewer-alice',
        state: 'CHANGES_REQUESTED',
        submittedAt: hoursAgo(4),
      },
      {
        author: 'reviewer-bob',
        state: 'APPROVED',
        submittedAt: 'invalid-date',
      },
    ],
    reviewThreads: [
      {
        isResolved: false,
        resolvedBy: null,
        commentsTruncated: false,
        comments: [{ author: 'reviewer-alice', createdAt: hoursAgo(3) }],
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'author');
  assert.equal(res.reason, 'changes_requested');
});

test('Invalid review timestamp from reviewer A + valid APPROVED from reviewer B routes to reviewer indeterminate', () => {
  const pr = basePr({
    reviews: [
      {
        author: 'reviewer-alice',
        state: 'CHANGES_REQUESTED',
        submittedAt: 'invalid-date',
      },
      {
        author: 'reviewer-bob',
        state: 'APPROVED',
        submittedAt: hoursAgo(4),
      },
    ],
    statusCheckRollup: 'SUCCESS',
    mergeable: 'MERGEABLE',
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'uninspected_review_data');
  assert.ok(res.warnings?.includes('review_timestamps_invalid'));
  assert.ok(res.warnings?.includes('review_data_incomplete'));
});

test('Missing author identity + confirmed CHANGES_REQUESTED routes conservatively to reviewer indeterminate', () => {
  const pr = basePr({
    author: null,
    reviews: [
      {
        author: 'reviewer-alice',
        state: 'CHANGES_REQUESTED',
        submittedAt: hoursAgo(4),
      },
    ],
    reviewThreads: [
      {
        isResolved: false,
        resolvedBy: null,
        commentsTruncated: false,
        comments: [{ author: 'reviewer-alice', createdAt: hoursAgo(3) }],
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'uninspected_review_data');
  assert.ok(res.warnings?.includes('author_identity_unavailable'));
  assert.ok(res.warnings?.includes('review_data_incomplete'));
});

test('Missing author identity + unidentified commenter in an open thread routes to reviewer indeterminate', () => {
  // With pr.author === null, the commenter 'someone' cannot be verified as the PR author.
  // Missing author identity prevents classifying changes requested as addressed or attributing
  // responsibility, failing closed into reviewer indeterminate.
  const pr = basePr({
    author: null,
    reviews: [
      {
        author: 'reviewer-alice',
        state: 'CHANGES_REQUESTED',
        submittedAt: hoursAgo(4),
      },
    ],
    reviewThreads: [
      {
        isResolved: false,
        resolvedBy: null,
        commentsTruncated: false,
        comments: [
          { author: 'reviewer-alice', createdAt: hoursAgo(3) },
          { author: 'someone', createdAt: hoursAgo(2) },
        ],
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'uninspected_review_data');
  assert.ok(res.warnings?.includes('author_identity_unavailable'));
  assert.ok(res.warnings?.includes('review_data_incomplete'));
});

test('Invalid timestamp on a bot review must not create human-review uncertainty', () => {
  const pr = basePr({
    reviews: [
      {
        author: 'codecov',
        authorTypename: 'Bot',
        state: 'CHANGES_REQUESTED',
        submittedAt: 'invalid-date',
      },
      {
        author: 'reviewer-alice',
        authorTypename: 'User',
        state: 'APPROVED',
        submittedAt: hoursAgo(4),
      },
    ],
    statusCheckRollup: 'SUCCESS',
    mergeable: 'MERGEABLE',
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'maintainer');
  assert.equal(res.reason, 'ready_to_merge');
});

test('Invalid timestamp on a PR-author review must not create reviewer-state uncertainty', () => {
  const pr = basePr({
    author: { login: 'contributor', typename: 'User' },
    reviews: [
      {
        author: 'contributor',
        authorTypename: 'User',
        state: 'CHANGES_REQUESTED',
        submittedAt: 'invalid-date',
      },
      {
        author: 'reviewer-alice',
        authorTypename: 'User',
        state: 'APPROVED',
        submittedAt: hoursAgo(4),
      },
    ],
    statusCheckRollup: 'SUCCESS',
    mergeable: 'MERGEABLE',
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'maintainer');
  assert.equal(res.reason, 'ready_to_merge');
});

test('Valid reviewer blocker + unrelated truncated thread routes to author unresolved_review_thread', () => {
  const pr = basePr({
    reviewRequests: [{ kind: 'user', login: 'reviewer-alice' }],
    reviewThreads: [
      {
        isResolved: false,
        resolvedBy: null,
        commentsTruncated: true,
        comments: [],
      },
      {
        isResolved: false,
        resolvedBy: null,
        commentsTruncated: false,
        comments: [{ author: 'reviewer-alice', createdAt: hoursAgo(3) }],
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'author');
  assert.equal(res.reason, 'unresolved_review_thread');
});

test('Precedence 8: Missing PR author identity on complete PR routes to reviewer uninspected_review_data', () => {
  const pr = basePr({
    author: null,
    reviews: [],
    reviewThreads: [],
    reviewRequests: [],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'uninspected_review_data');
  assert.ok(res.warnings?.includes('author_identity_unavailable'));
  assert.ok(res.warnings?.includes('review_data_incomplete'));
});

test('Malformed human DISMISSED review produces indeterminate reviewer review state', () => {
  // A DISMISSED review from a human reviewer supersedes earlier reviews from that reviewer.
  // If submittedAt is malformed, that reviewer cannot be resolved, creating review-state uncertainty
  // and routing to reviewer uninspected_review_data with review_timestamps_invalid.
  const pr = basePr({
    reviews: [
      {
        author: 'reviewer-alice',
        authorTypename: 'User',
        state: 'APPROVED',
        submittedAt: hoursAgo(5),
      },
      {
        author: 'reviewer-alice',
        authorTypename: 'User',
        state: 'DISMISSED',
        submittedAt: 'invalid-date',
      },
    ],
    statusCheckRollup: 'SUCCESS',
    mergeable: 'MERGEABLE',
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'uninspected_review_data');
  assert.ok(res.warnings?.includes('review_timestamps_invalid'));
  assert.ok(res.warnings?.includes('review_data_incomplete'));
});

test('Missing author + waiting-for-author label routes to reviewer uninspected_review_data', () => {
  const pr = basePr({
    author: null,
    labels: ['waiting-for-author'],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'uninspected_review_data');
  assert.ok(res.warnings?.includes('author_identity_unavailable'));
  assert.ok(res.warnings?.includes('review_data_incomplete'));
});

test('Missing author + pending review request routes to reviewer uninspected_review_data', () => {
  const pr = basePr({
    author: null,
    reviewRequests: [{ kind: 'user', login: 'reviewer-alice' }],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'uninspected_review_data');
  assert.ok(res.warnings?.includes('author_identity_unavailable'));
  assert.ok(res.warnings?.includes('review_data_incomplete'));
});

test('Missing author + draft PR routes to reviewer uninspected_review_data', () => {
  const pr = basePr({
    author: null,
    isDraft: true,
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'uninspected_review_data');
  assert.ok(res.warnings?.includes('author_identity_unavailable'));
  assert.ok(res.warnings?.includes('review_data_incomplete'));
});

test('Explicit GraphQL User typename on known dependabot login still routes to dependency bot', () => {
  const pr = basePr({
    author: { login: 'dependabot', typename: 'User' },
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'bot');
  assert.equal(res.isDependencyBot, true);
});

test('Explicit GraphQL Bot typename on dependabot author routes to dependency bot', () => {
  const pr = basePr({
    author: { login: 'dependabot', typename: 'Bot' },
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'bot');
  assert.equal(res.isDependencyBot, true);
  assert.equal(res.reason, 'dependency_bot');
});

test('Confirmed merge conflict + truncated CI routes to author ci_failing', () => {
  const pr = basePr({
    mergeable: 'CONFLICTING',
    statusCheckRollup: 'FAILURE',
    headCheckRuns: undefined,
    headCheckRunsTruncated: true,
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'author');
  assert.equal(res.reason, 'ci_failing');
});

test('Confirmed DCO missing + truncated CI routes to author ci_failing', () => {
  const pr = basePr({
    statusCheckRollup: 'FAILURE',
    headCheckRuns: undefined,
    headCheckRunsTruncated: true,
    commits: [
      {
        sha: 'abc1234',
        messageHeadline: 'feat: missing dco',
        messageBody: 'No signoff here',
        authorEmail: 'contributor@example.com',
        committedDate: daysAgo(5),
        parents: 1,
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'author');
  assert.equal(res.reason, 'ci_failing');
});

test('Confirmed changes requested + truncated CI routes to author ci_failing', () => {
  const pr = basePr({
    statusCheckRollup: 'FAILURE',
    headCheckRuns: undefined,
    headCheckRunsTruncated: true,
    reviews: [
      {
        author: 'reviewer-alice',
        authorTypename: 'User',
        state: 'CHANGES_REQUESTED',
        submittedAt: hoursAgo(4),
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'author');
  assert.equal(res.reason, 'ci_failing');
});

test('Confirmed thread blocker + truncated CI routes to author ci_failing', () => {
  const pr = basePr({
    statusCheckRollup: 'FAILURE',
    headCheckRuns: undefined,
    headCheckRunsTruncated: true,
    reviewRequests: [{ kind: 'user', login: 'reviewer-alice' }],
    reviewThreads: [
      {
        isResolved: false,
        resolvedBy: null,
        comments: [{ author: 'reviewer-alice', authorTypename: 'User', createdAt: hoursAgo(3) }],
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'author');
  assert.equal(res.reason, 'ci_failing');
});

test('Indeterminate CHANGES_REQUESTED evidence from reviewer A + confirmed unresolved thread from reviewer B routes to author', () => {
  // Reviewer A has changes requested with an indeterminate thread (truncated comments).
  // Reviewer B has an active review request and a complete unresolved thread with an unreplied comment.
  // Precedence 4 indeterminate review evidence must NOT return early; it must proceed to
  // Precedence 5 where Reviewer B's confirmed blocker wins, routing to author unresolved_review_thread.
  const pr = basePr({
    reviewRequests: [{ kind: 'user', login: 'reviewer-bob' }],
    reviews: [
      {
        author: 'reviewer-alice',
        authorTypename: 'User',
        state: 'CHANGES_REQUESTED',
        submittedAt: hoursAgo(6),
      },
    ],
    reviewThreads: [
      {
        // Reviewer A's thread: indeterminate due to truncated comments
        isResolved: false,
        resolvedBy: null,
        commentsTruncated: true,
        comments: [{ author: 'reviewer-alice', authorTypename: 'User', createdAt: hoursAgo(5) }],
      },
      {
        // Reviewer B's thread: confirmed blocker in complete thread
        isResolved: false,
        resolvedBy: null,
        commentsTruncated: false,
        comments: [{ author: 'reviewer-bob', authorTypename: 'User', createdAt: hoursAgo(3) }],
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'author');
  assert.equal(res.reason, 'unresolved_review_thread');
});

test('Bot comment carrying author login in resolved thread does not count as human author reply in hasAuthorResolvedWithoutReply', () => {
  // A bot comment with author login but authorTypename: 'Bot' must not count as a verified human reply,
  // attaching the resolved_without_reply warning.
  const pr = basePr({
    reviews: [
      {
        author: 'reviewer-alice',
        authorTypename: 'User',
        state: 'COMMENTED',
        submittedAt: hoursAgo(8),
      },
    ],
    reviewThreads: [
      {
        isResolved: true,
        resolvedBy: 'contributor',
        comments: [
          { author: 'reviewer-alice', authorTypename: 'User', createdAt: hoursAgo(8) },
          { author: 'contributor', authorTypename: 'Bot', createdAt: hoursAgo(6) },
        ],
      },
    ],
  });
  const res = classifyActor(pr);
  assert.ok(res.warnings?.includes('resolved_without_reply'));
});

test('Bot comment carrying reviewer login in review thread does not count as reviewer participation', () => {
  // A bot comment matching reviewer login but having authorTypename: 'Bot' must not be treated as human reviewer comment
  const pr = basePr({
    reviews: [
      {
        author: 'reviewer-alice',
        authorTypename: 'User',
        state: 'COMMENTED',
        submittedAt: hoursAgo(5),
      },
    ],
    reviewThreads: [
      {
        isResolved: false,
        resolvedBy: null,
        comments: [
          { author: 'contributor', authorTypename: 'User', createdAt: hoursAgo(10) },
          { author: 'reviewer-alice', authorTypename: 'Bot', createdAt: hoursAgo(2) },
        ],
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'awaiting_review');
});

test('Shared predicate false + locally confirmed blocker routes to author unresolved_review_thread', () => {
  // In unresolvedFromReviewer, latest comment is from author login (contributor), so unresolvedFromReviewer is false.
  // But that comment has authorTypename: 'Bot', which is rejected by local identity validation.
  // The local scan recognizes reviewer-alice as the latest verified human comment unreplied, routing to author.
  const pr = basePr({
    reviewRequests: [{ kind: 'user', login: 'reviewer-alice' }],
    reviewThreads: [
      {
        isResolved: false,
        resolvedBy: null,
        comments: [
          {
            author: 'reviewer-alice',
            authorTypename: 'User',
            createdAt: hoursAgo(4),
            commitOid: 'abc1234',
            originalCommitOid: 'abc1234',
          },
          { author: 'contributor', authorTypename: 'Bot', createdAt: hoursAgo(2) },
        ],
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'author');
  assert.equal(res.reason, 'unresolved_review_thread');
});

test('Bot-only thread participation does not create an author blocker', () => {
  // The shared predicate and local identity scan both reject bot comments as reviewer activity.
  const pr = basePr({
    reviewThreads: [
      {
        isResolved: false,
        resolvedBy: null,
        comments: [
          { author: 'contributor', authorTypename: 'User', createdAt: hoursAgo(5) },
          { author: 'codecov', authorTypename: 'Bot', createdAt: hoursAgo(2) },
        ],
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'awaiting_review');
});

test('Invalid review timestamp + truncated commits preserves both review_timestamps_invalid and commits_truncated', () => {
  const pr = basePr({
    commitsTruncated: true,
    reviews: [
      {
        author: 'reviewer-alice',
        authorTypename: 'User',
        state: 'CHANGES_REQUESTED',
        submittedAt: 'invalid-date',
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'uninspected_review_data');
  assert.ok(res.warnings?.includes('review_timestamps_invalid'));
  assert.ok(res.warnings?.includes('commits_truncated'));
  assert.ok(res.warnings?.includes('review_data_incomplete'));
});

test('isBotLogin relies on explicit [bot] suffix and KNOWN_BOT_LOGINS allowlist without broad -bot matching', () => {
  assert.equal(isBotLogin('codecov'), true);
  assert.equal(isBotLogin('codecov[bot]'), true);
  assert.equal(isBotLogin('snyk-bot'), true);
  assert.equal(isBotLogin('renovate-bot'), true);
  assert.equal(isBotLogin('developer-bot'), false);
});

test('Missing author + confirmed CI failure routes to reviewer ci_failing with completeness warnings', () => {
  const pr = basePr({
    author: null,
    statusCheckRollup: 'FAILURE',
    headCheckRuns: [
      {
        name: 'build',
        conclusion: 'failure',
      },
    ],
    headCheckRunsTruncated: false,
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'ci_failing');
  assert.ok(res.warnings?.includes('author_identity_unavailable'));
  assert.ok(res.warnings?.includes('review_data_incomplete'));
});

test('Missing author + confirmed merge conflict routes to reviewer merge_conflict with completeness warnings', () => {
  const pr = basePr({
    author: null,
    mergeable: 'CONFLICTING',
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'merge_conflict');
  assert.ok(res.warnings?.includes('author_identity_unavailable'));
  assert.ok(res.warnings?.includes('review_data_incomplete'));
});

test('Missing author + confirmed DCO missing routes to reviewer dco_missing with completeness warnings', () => {
  const pr = basePr({
    author: null,
    commits: [
      {
        sha: 'abc1234',
        messageHeadline: 'feat: change without signoff',
        messageBody: 'No DCO signoff here',
        authorEmail: 'contributor@example.com',
        committedDate: daysAgo(3),
        parents: 1,
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'dco_missing');
  assert.ok(res.warnings?.includes('author_identity_unavailable'));
  assert.ok(res.warnings?.includes('review_data_incomplete'));
});

test('Case-differing author login in resolved thread attaches resolved_without_reply independently', () => {
  // Author login is 'Contributor' (User), thread resolvedBy is 'CONTRIBUTOR'.
  // The shared predicate resolvedWithoutReply checks t.resolvedBy === authorLogin (case-sensitive),
  // which returns false. The local identity-verified scan performs case-insensitive matching
  // and attaches resolved_without_reply.
  const pr = basePr({
    author: { login: 'Contributor', typename: 'User' },
    reviews: [
      {
        author: 'reviewer-alice',
        authorTypename: 'User',
        state: 'COMMENTED',
        submittedAt: hoursAgo(8),
      },
    ],
    reviewThreads: [
      {
        isResolved: true,
        resolvedBy: 'CONTRIBUTOR',
        comments: [{ author: 'reviewer-alice', authorTypename: 'User', createdAt: hoursAgo(6) }],
      },
    ],
  });
  const res = classifyActor(pr);
  assert.ok(res.warnings?.includes('resolved_without_reply'));
});

test('Tri-state actor identity: typename authority and bot fallback', () => {
  // Missing typename + known bot login ('codecov') -> non_human
  assert.equal(getActorIdentityKind(null, 'codecov'), 'non_human');
  assert.equal(getActorIdentityKind(undefined, 'codecov[bot]'), 'non_human');

  // Missing typename + unknown ordinary login -> unknown
  assert.equal(getActorIdentityKind(null, 'contributor'), 'unknown');
  assert.equal(getActorIdentityKind(undefined, 'reviewer-alice'), 'unknown');

  // Known bot logins remain non-human even when GraphQL reports User.
  assert.equal(getActorIdentityKind('User', 'codecov'), 'non_human');
  assert.equal(getActorIdentityKind('EnterpriseUserAccount', 'dependabot'), 'non_human');

  // Explicit Bot + ordinary login -> non_human
  assert.equal(getActorIdentityKind('Bot', 'contributor'), 'non_human');
});

test('Unknown-identity reviewer comment in open thread produces indeterminate classification', () => {
  const pr = basePr({
    reviewRequests: [{ kind: 'user', login: 'reviewer-alice' }],
    reviewThreads: [
      {
        isResolved: false,
        resolvedBy: null,
        comments: [{ author: 'reviewer-alice', authorTypename: null, createdAt: hoursAgo(5) }],
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'uninspected_review_data');
  assert.ok(res.warnings?.includes('review_data_incomplete'));
});

test('Unknown-identity author comment after reviewer produces indeterminate classification (not confirmed blocker)', () => {
  const pr = basePr({
    reviewRequests: [{ kind: 'user', login: 'reviewer-alice' }],
    reviewThreads: [
      {
        isResolved: false,
        resolvedBy: null,
        comments: [
          { author: 'reviewer-alice', authorTypename: 'User', createdAt: hoursAgo(5) },
          { author: 'contributor', authorTypename: null, createdAt: hoursAgo(2) },
        ],
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'uninspected_review_data');
  assert.ok(res.warnings?.includes('review_data_incomplete'));
});

test('Unknown-identity author comment with invalid timestamp in resolved thread does not attach resolved_without_reply', () => {
  const pr = basePr({
    author: { login: 'contributor', typename: 'User' },
    reviews: [
      {
        author: 'reviewer-alice',
        authorTypename: 'User',
        state: 'COMMENTED',
        submittedAt: hoursAgo(8),
      },
    ],
    reviewThreads: [
      {
        isResolved: true,
        resolvedBy: 'contributor',
        comments: [
          { author: 'reviewer-alice', authorTypename: 'User', createdAt: hoursAgo(6) },
          { author: 'contributor', authorTypename: null, createdAt: 'invalid-date' },
        ],
      },
    ],
  });
  const res = classifyActor(pr);
  assert.ok(!res.warnings?.includes('resolved_without_reply'));
});

test('Historical reviewer thread complete + unrelated historical thread with truncated comments produces indeterminate in evaluateChangesRequestedForReviewer', () => {
  const pr = basePr({
    reviews: [
      {
        author: 'reviewer-alice',
        authorTypename: 'User',
        state: 'CHANGES_REQUESTED',
        submittedAt: hoursAgo(10),
      },
    ],
    reviewThreads: [
      {
        // Thread A: resolved, complete, reviewer participated, author replied
        isResolved: true,
        resolvedBy: 'contributor',
        commentsTruncated: false,
        comments: [
          { author: 'reviewer-alice', authorTypename: 'User', createdAt: hoursAgo(9) },
          { author: 'contributor', authorTypename: 'User', createdAt: hoursAgo(7) },
        ],
      },
      {
        // Thread B: resolved, but comments truncated (could hide unreplied reviewer-alice participation)
        isResolved: true,
        resolvedBy: 'someone-else',
        commentsTruncated: true,
        comments: [{ author: 'bob', authorTypename: 'User', createdAt: hoursAgo(5) }],
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'uninspected_review_data');
  assert.ok(res.warnings?.includes('thread_comments_truncated'));
  assert.ok(res.warnings?.includes('review_data_incomplete'));
});

test('Confirmed blocker plus unrelated truncated historical thread: confirmed blocker wins', () => {
  const pr = basePr({
    reviews: [
      {
        author: 'reviewer-alice',
        authorTypename: 'User',
        state: 'CHANGES_REQUESTED',
        submittedAt: hoursAgo(10),
      },
    ],
    reviewThreads: [
      {
        // Thread A: open confirmed blocker for reviewer-alice
        isResolved: false,
        resolvedBy: null,
        commentsTruncated: false,
        comments: [{ author: 'reviewer-alice', authorTypename: 'User', createdAt: hoursAgo(9) }],
      },
      {
        // Thread B: unrelated historical resolved thread with truncated comments
        isResolved: true,
        resolvedBy: 'contributor',
        commentsTruncated: true,
        comments: [{ author: 'bob', authorTypename: 'User', createdAt: hoursAgo(5) }],
      },
    ],
  });
  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'author');
  assert.equal(res.reason, 'changes_requested');
});

test('ciFailing: undefined headCheckRunsTruncated is not treated as verified complete label-only', () => {
  const pr = basePr({
    statusCheckRollup: 'FAILURE',
    headCheckRuns: [{ name: 'check-label', conclusion: 'failure' }],
    headCheckRunsTruncated: undefined,
  });
  const res = ciFailing(pr);
  assert.equal(res.triggered, true);
  assert.equal(res.labelOnlyFailure, false);
});

test('Known dependency bot login remains classified as dependency bot with User typename', () => {
  assert.equal(isDependencyBotAuthor('renovate', 'User'), true);
  assert.equal(isDependencyBotAuthor('renovate', 'Bot'), true);
  assert.equal(isDependencyBotAuthor('renovate'), true);
});
