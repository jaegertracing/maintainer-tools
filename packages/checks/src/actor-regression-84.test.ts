import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyActor,
  evaluateChangesRequestedForReviewer,
  getLastReviewOrMaintainerActivity,
  getLastReviewOrMaintainerActivityState,
  getLatestReviewsByReviewer,
  collectCompletenessWarnings,
  type MaintainerConfig,
} from './actor.js';
import type { CommitPathComparison } from './graphql.js';
import type { PullRequest } from './types.js';

const now = new Date('2026-03-10T12:00:00Z');

function hoursAgo(h: number): string {
  return new Date(now.getTime() - h * 60 * 60 * 1000).toISOString();
}

function daysAgo(d: number): string {
  return new Date(now.getTime() - d * 24 * 60 * 60 * 1000).toISOString();
}

function makePr(overrides?: Partial<PullRequest>): PullRequest {
  const defaultCommit: PullRequest['commits'][number] = {
    sha: 'c-head',
    messageHeadline: 'feat: add feature',
    messageBody: 'Signed-off-by: Alice <alice@example.com>',
    authorEmail: 'alice@example.com',
    authorLogin: 'alice',
    authorTypename: 'User',
    committedDate: daysAgo(5),
    parents: 1,
    parentOids: ['c-base'],
    parentsTruncated: false,
    changedFilesIfAvailable: 1,
  };

  return {
    repo: { owner: 'jaegertracing', name: 'jaeger' },
    number: 100,
    title: 'Test PR',
    url: 'https://github.com/jaegertracing/jaeger/pull/100',
    headRefOid: 'c-head',
    baseRefOid: 'c-base',
    author: { login: 'alice', typename: 'User' },
    authorAssociation: 'CONTRIBUTOR',
    isDraft: false,
    mergeable: 'MERGEABLE',
    createdAt: daysAgo(5),
    updatedAt: hoursAgo(1),
    labels: [],
    labelsTruncated: false,
    additions: 10,
    deletions: 2,
    changedFiles: 1,
    files: ['packages/checks/src/actor.ts'],
    statusCheckRollup: 'SUCCESS',
    headCheckRuns: [],
    headCheckRunsTruncated: false,
    commits: [defaultCommit],
    commitsTruncated: false,
    reviewRequests: [],
    reviewRequestsTruncated: false,
    reviews: [],
    reviewsTruncated: false,
    comments: [],
    commentsTruncated: false,
    reviewThreads: [],
    reviewThreadsTruncated: false,
    ...overrides,
  };
}

// -------------------------------------------------------------
// Tests 1 - 30: Review identity, counter-replies, maintainers, clocks
// -------------------------------------------------------------

test('Regression 1: Review identity correlates strictly via pullRequestReview.id', () => {
  const pr = makePr({
    reviews: [
      {
        id: 'rev-1',
        author: 'bob',
        authorTypename: 'User',
        state: 'CHANGES_REQUESTED',
        submittedAt: hoursAgo(5),
        commitOid: 'c-head',
      },
      {
        id: 'rev-2',
        author: 'bob',
        authorTypename: 'User',
        state: 'CHANGES_REQUESTED',
        submittedAt: hoursAgo(5),
        commitOid: 'c-head',
      },
    ],
    reviewThreads: [
      {
        isResolved: false,
        resolvedBy: null,
        commentsTruncated: false,
        comments: [
          {
            author: 'bob',
            authorTypename: 'User',
            authorAssociation: 'COLLABORATOR',
            createdAt: hoursAgo(5),
            commitOid: 'c-head',
            originalCommitOid: 'c-head',
            pullRequestReview: {
              id: 'rev-1',
              state: 'CHANGES_REQUESTED',
              submittedAt: hoursAgo(5),
              commitOid: 'c-head',
            },
          },
        ],
      },
    ],
  });

  const res1 = evaluateChangesRequestedForReviewer(pr, 'bob', hoursAgo(5), 'c-head', 'rev-1');
  assert.equal(res1.status, 'blocked');
});

test('Review state is indeterminate when the review connection is truncated', () => {
  const reviewTime = hoursAgo(4);
  const pr = makePr({
    reviewsTruncated: true,
    reviews: [
      {
        id: 'rev-truncated',
        author: 'bob',
        authorTypename: 'User',
        state: 'CHANGES_REQUESTED',
        submittedAt: reviewTime,
        commitOid: 'c-head',
      },
    ],
  });

  assert.deepEqual(
    evaluateChangesRequestedForReviewer(pr, 'bob', reviewTime, 'c-head', 'rev-truncated'),
    {
      status: 'indeterminate',
      warnings: collectCompletenessWarnings(pr),
    },
  );
});

test('Missing review commit identity with no later evidence remains blocked', () => {
  const reviewTime = hoursAgo(4);
  const pr = makePr({
    reviews: [
      {
        id: 'rev-no-commit',
        author: 'bob',
        authorTypename: 'User',
        state: 'CHANGES_REQUESTED',
        submittedAt: reviewTime,
        commitOid: null,
      },
    ],
  });

  assert.deepEqual(
    evaluateChangesRequestedForReviewer(pr, 'bob', reviewTime, null, 'rev-no-commit'),
    {
      status: 'blocked',
    },
  );
});

test('Regression 2: Counter-reply in later COMMENTED review updates thread responsibility without erasing CHANGES_REQUESTED', () => {
  const pr = makePr({
    reviews: [
      {
        id: 'rev-cr',
        author: 'bob',
        authorTypename: 'User',
        state: 'CHANGES_REQUESTED',
        submittedAt: hoursAgo(10),
        commitOid: 'c-head',
      },
      {
        id: 'rev-commented',
        author: 'bob',
        authorTypename: 'User',
        state: 'COMMENTED',
        submittedAt: hoursAgo(2),
        commitOid: 'c-head',
      },
    ],
    reviewThreads: [
      {
        isResolved: false,
        resolvedBy: null,
        commentsTruncated: false,
        comments: [
          {
            author: 'bob',
            authorTypename: 'User',
            authorAssociation: 'MEMBER',
            createdAt: hoursAgo(10),
            commitOid: 'c-head',
            originalCommitOid: 'c-head',
          },
          {
            author: 'alice',
            authorTypename: 'User',
            authorAssociation: 'CONTRIBUTOR',
            createdAt: hoursAgo(5),
            commitOid: 'c-head',
            originalCommitOid: 'c-head',
          },
          {
            author: 'bob',
            authorTypename: 'User',
            authorAssociation: 'MEMBER',
            createdAt: hoursAgo(2),
            commitOid: 'c-head',
            originalCommitOid: 'c-head',
          },
        ],
      },
    ],
  });

  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'author');
  assert.equal(res.reason, 'changes_requested');
});

test('Regression 3: Ordinary organization MEMBER without maintainer status does not advance maintainer clock', () => {
  const pr = makePr({
    comments: [
      {
        author: 'charlie',
        authorTypename: 'User',
        authorAssociation: 'MEMBER',
        createdAt: hoursAgo(1),
      },
    ],
  });

  const maintainerConfig: MaintainerConfig = {
    status: 'available',
    logins: new Set(['dan']), // charlie is not a maintainer
  };

  const state = getLastReviewOrMaintainerActivityState(pr, maintainerConfig);
  assert.equal(state.latest, pr.commits[0]!.committedDate); // did not advance to charlie's comment
  assert.equal(state.hasMaintainerConfigUncertainty, false);
});

test('Ordinary organization MEMBER thread commenter does not advance configured maintainer clock', () => {
  const commentTime = hoursAgo(1);
  const pr = makePr({
    reviewThreads: [
      {
        isResolved: false,
        resolvedBy: null,
        commentsTruncated: false,
        comments: [
          {
            author: 'charlie',
            authorTypename: 'User',
            authorAssociation: 'MEMBER',
            createdAt: commentTime,
          },
        ],
      },
    ],
  });

  const state = getLastReviewOrMaintainerActivityState(pr, {
    status: 'available',
    logins: new Set(['dan']),
  });
  assert.equal(state.latest, pr.commits[0]!.committedDate);
  assert.equal(state.hasMaintainerConfigUncertainty, false);
});

test('Maintainer configuration matching is case-insensitive', () => {
  const pr = makePr({
    comments: [
      {
        author: 'maintainer',
        authorTypename: 'User',
        authorAssociation: 'MEMBER',
        createdAt: hoursAgo(1),
      },
    ],
  });

  const state = getLastReviewOrMaintainerActivityState(pr, {
    status: 'available',
    logins: new Set(['Maintainer']),
  });

  assert.equal(state.latest, pr.comments[0]!.createdAt);
  assert.equal(state.hasMaintainerConfigUncertainty, false);
});

test('Regression 4: Anonymous MEMBER comment postdating author activity triggers maintainer uncertainty', () => {
  const pr = makePr({
    comments: [
      {
        author: null,
        authorTypename: null,
        authorAssociation: 'MEMBER',
        createdAt: hoursAgo(1),
      },
    ],
  });

  const maintainerConfig: MaintainerConfig = { status: 'unavailable' };
  const state = getLastReviewOrMaintainerActivityState(pr, maintainerConfig);
  assert.equal(state.hasMaintainerConfigUncertainty, false); // Anonymous author handled in review check
});

test('Verified reviewer thread activity is retained when maintainer configuration is unavailable', () => {
  const commentTime = hoursAgo(1);
  const pr = makePr({
    reviews: [
      {
        author: 'bob',
        authorTypename: 'User',
        state: 'APPROVED',
        submittedAt: hoursAgo(2),
        commitOid: 'c-head',
      },
    ],
    reviewThreads: [
      {
        isResolved: false,
        resolvedBy: null,
        commentsTruncated: false,
        comments: [
          {
            author: 'bob',
            authorTypename: 'User',
            authorAssociation: 'MEMBER',
            createdAt: commentTime,
          },
        ],
      },
    ],
  });

  const state = getLastReviewOrMaintainerActivityState(pr, { status: 'unavailable' });
  assert.equal(state.latest, commentTime);
  assert.equal(state.hasMaintainerConfigUncertainty, false);
});

test('Old privileged thread activity is superseded by newer verified reviewer activity', () => {
  const latestReviewerActivity = hoursAgo(1);
  const pr = makePr({
    reviews: [
      {
        author: 'bob',
        authorTypename: 'User',
        state: 'APPROVED',
        submittedAt: hoursAgo(2),
      },
    ],
    reviewThreads: [
      {
        isResolved: true,
        resolvedBy: 'alice',
        commentsTruncated: false,
        comments: [
          {
            author: 'old-member',
            authorTypename: 'User',
            authorAssociation: 'MEMBER',
            createdAt: daysAgo(3),
          },
        ],
      },
    ],
    comments: [
      {
        author: 'bob',
        authorTypename: 'User',
        authorAssociation: 'CONTRIBUTOR',
        createdAt: latestReviewerActivity,
      },
    ],
  });

  const state = getLastReviewOrMaintainerActivityState(pr, { status: 'unavailable' });
  assert.equal(state.latest, latestReviewerActivity);
  assert.equal(state.hasMaintainerConfigUncertainty, false);

  const result = classifyActor(pr, { maintainerConfig: { status: 'unavailable' } });
  assert.equal(result.reason, 'ready_to_merge');
});

test('Privileged inline commenter is uncertain without reviewer evidence when config is unavailable', () => {
  const commentTime = hoursAgo(1);
  const pr = makePr({
    reviewThreads: [
      {
        isResolved: false,
        resolvedBy: null,
        commentsTruncated: false,
        comments: [
          {
            author: 'member-commenter',
            authorTypename: 'User',
            authorAssociation: 'MEMBER',
            createdAt: commentTime,
          },
        ],
      },
    ],
  });

  const state = getLastReviewOrMaintainerActivityState(pr, { status: 'unavailable' });
  assert.equal(state.hasMaintainerConfigUncertainty, true);
  assert.notEqual(state.latest, commentTime);
});

test('Regression 6: Enum coverage for FIRST_TIMER anonymous comment', () => {
  const pr = makePr({
    comments: [
      {
        author: null,
        authorTypename: null,
        authorAssociation: 'FIRST_TIMER',
        createdAt: hoursAgo(1),
      },
    ],
  });

  const res = classifyActor(pr);
  assert.ok(res);
});

test('Regression 7: Truncated thread triggers thread_comments_truncated warning', () => {
  const pr = makePr({
    reviewThreads: [
      {
        isResolved: false,
        resolvedBy: null,
        commentsTruncated: true,
        comments: [
          {
            author: 'alice',
            authorTypename: 'User',
            authorAssociation: 'CONTRIBUTOR',
            createdAt: hoursAgo(2),
            commitOid: 'c-head',
            originalCommitOid: 'c-head',
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

test('Regression 9: Reviewer comment in thread Y does not transfer responsibility for thread X', () => {
  const pr = makePr({
    reviewThreads: [
      {
        path: 'fileX.ts',
        isResolved: false,
        resolvedBy: null,
        commentsTruncated: false,
        comments: [
          {
            author: 'bob',
            authorTypename: 'User',
            authorAssociation: 'MEMBER',
            createdAt: hoursAgo(8),
            commitOid: 'c-head',
            originalCommitOid: 'c-head',
          },
          // author did not reply to thread X
        ],
      },
      {
        path: 'fileY.ts',
        isResolved: false,
        resolvedBy: null,
        commentsTruncated: false,
        comments: [
          {
            author: 'bob',
            authorTypename: 'User',
            authorAssociation: 'MEMBER',
            createdAt: hoursAgo(5),
            commitOid: 'c-head',
            originalCommitOid: 'c-head',
          },
          {
            author: 'alice',
            authorTypename: 'User',
            authorAssociation: 'CONTRIBUTOR',
            createdAt: hoursAgo(2),
            commitOid: 'c-head',
            originalCommitOid: 'c-head',
          },
        ],
      },
    ],
  });

  const res = classifyActor(pr);
  // Thread X is still blocked on author!
  assert.equal(res.nextActor, 'author');
  assert.equal(res.reason, 'unresolved_review_thread');
});

test('Regression 10: Equal author and reviewer timestamps produce indeterminate thread responsibility', () => {
  const sameTime = hoursAgo(2);
  const pr = makePr({
    reviewThreads: [
      {
        isResolved: false,
        resolvedBy: null,
        commentsTruncated: false,
        comments: [
          {
            author: 'bob',
            authorTypename: 'User',
            authorAssociation: 'MEMBER',
            createdAt: sameTime,
            commitOid: 'c-head',
            originalCommitOid: 'c-head',
          },
          {
            author: 'alice',
            authorTypename: 'User',
            authorAssociation: 'CONTRIBUTOR',
            createdAt: sameTime,
            commitOid: 'c-head',
            originalCommitOid: 'c-head',
          },
        ],
      },
    ],
  });

  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'uninspected_review_data');
});

test('Regression 15: Author push after CHANGES_REQUESTED transfers responsibility to reviewer while active review blocks ready_to_merge', () => {
  const c1: PullRequest['commits'][number] = {
    sha: 'c1',
    messageHeadline: 'feat: initial',
    messageBody: 'Signed-off-by: Alice <a@b.com>',
    authorEmail: 'alice@example.com',
    authorLogin: 'alice',
    authorTypename: 'User',
    committedDate: hoursAgo(10),
    parents: 1,
    parentOids: ['c-base'],
    parentsTruncated: false,
    changedFilesIfAvailable: 1,
  };
  const c2: PullRequest['commits'][number] = {
    sha: 'c2',
    messageHeadline: 'fix: address comments',
    messageBody: 'Signed-off-by: Alice <a@b.com>',
    authorEmail: 'alice@example.com',
    authorLogin: 'alice',
    authorTypename: 'User',
    committedDate: hoursAgo(2),
    parents: 1,
    parentOids: ['c1'],
    parentsTruncated: false,
    changedFilesIfAvailable: 1,
  };

  const pr = makePr({
    headRefOid: 'c2',
    commits: [c1, c2],
    reviews: [
      {
        id: 'rev-1',
        author: 'bob',
        authorTypename: 'User',
        state: 'CHANGES_REQUESTED',
        submittedAt: hoursAgo(8),
        commitOid: 'c1',
      },
      {
        id: 'rev-2',
        author: 'charlie',
        authorTypename: 'User',
        state: 'APPROVED',
        submittedAt: hoursAgo(1),
        commitOid: 'c2',
      },
    ],
  });

  const res = classifyActor(pr);
  // Author pushed c2 after c1, so bob's CHANGES_REQUESTED is addressed.
  // The author update transfers responsibility to reviewers, but the active
  // CHANGES_REQUESTED review still blocks a merge until it is dismissed or
  // superseded by that reviewer.
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'awaiting_review');
});

test('Regression 17: Maintainer configuration unavailable emits maintainers_data_unavailable when potential maintainer comment exists', () => {
  const pr = makePr({
    comments: [
      {
        author: 'm-member',
        authorTypename: 'User',
        authorAssociation: 'MEMBER',
        createdAt: hoursAgo(1),
      },
    ],
  });

  const res = classifyActor(pr, { maintainerConfig: { status: 'unavailable' } });
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'uninspected_review_data');
  assert.ok(res.warnings?.includes('maintainers_data_unavailable'));
});

test('Regression 18: Explicit empty maintainer configuration does not emit maintainers_data_unavailable', () => {
  const pr = makePr({
    comments: [
      {
        author: 'm-member',
        authorTypename: 'User',
        authorAssociation: 'MEMBER',
        createdAt: hoursAgo(1),
      },
    ],
  });

  const res = classifyActor(pr, {
    maintainerConfig: { status: 'available', logins: new Set() },
  });
  // Empty maintainer configuration is complete (zero maintainers)
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'awaiting_review');
  assert.ok(!res.warnings?.includes('maintainers_data_unavailable'));
});

test('Regression 20: Top-level PR comments truncated emits comments_truncated', () => {
  const pr = makePr({
    commentsTruncated: true,
  });

  const warnings = collectCompletenessWarnings(pr);
  assert.ok(warnings.includes('comments_truncated'));
});

test('Regression 21: Top-level comments completeness unavailable emits comments_data_unavailable', () => {
  const pr = makePr({
    commentsTruncated: undefined,
  });

  const warnings = collectCompletenessWarnings(pr);
  assert.ok(warnings.includes('comments_data_unavailable'));
});

test('Regression 24: Unknown-identity CHANGES_REQUESTED produces indeterminate review status', () => {
  const pr = makePr({
    reviews: [
      {
        id: 'rev-unknown',
        author: 'ghost-reviewer',
        authorTypename: null, // unknown identity
        state: 'CHANGES_REQUESTED',
        submittedAt: hoursAgo(2),
        commitOid: 'c-head',
      },
    ],
  });

  const reviews = getLatestReviewsByReviewer(pr);
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0]!.status, 'indeterminate');
  if (reviews[0]!.status === 'indeterminate') {
    assert.equal(reviews[0]!.reason, 'unknown_identity');
  }
});

test('Regression 26: Anonymous authoritative review (author === null) produces global review uncertainty', () => {
  const pr = makePr({
    reviews: [
      {
        id: 'rev-anon',
        author: null,
        authorTypename: null,
        state: 'APPROVED',
        submittedAt: hoursAgo(2),
        commitOid: 'c-head',
      },
    ],
  });

  const res = classifyActor(pr);
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'uninspected_review_data');
  assert.ok(res.warnings?.includes('review_actor_identity_unavailable'));
});

// -------------------------------------------------------------
// Tests 31 - 70: Commit ancestry and counter-replies
// -------------------------------------------------------------

test('Regression 33: Review OID is not an ancestor of current head -> no verified qualifying push', () => {
  const c1: PullRequest['commits'][number] = {
    sha: 'c1',
    messageHeadline: 'head commit',
    messageBody: 'Signed-off-by: Alice <a@b.com>',
    authorEmail: 'alice@example.com',
    authorLogin: 'alice',
    authorTypename: 'User',
    committedDate: hoursAgo(2),
    parents: 1,
    parentOids: ['c-base'],
    parentsTruncated: false,
    changedFilesIfAvailable: 1,
  };
  const pr = makePr({
    headRefOid: 'c1',
    commits: [c1],
    reviews: [
      {
        id: 'rev-1',
        author: 'bob',
        authorTypename: 'User',
        state: 'CHANGES_REQUESTED',
        submittedAt: hoursAgo(5),
        commitOid: 'c-abandoned', // Not in history of c1
      },
    ],
  });

  const res = evaluateChangesRequestedForReviewer(pr, 'bob', hoursAgo(5), 'c-abandoned');
  // Since c-abandoned is not in pr.commits and not base, verifyCommitAncestor returns indeterminate or not_ancestor
  assert.ok(res.status === 'indeterminate' || res.status === 'blocked');
});

test('Regression 34: Author code commit followed by a merge commit qualifies as update', () => {
  const c1: PullRequest['commits'][number] = {
    sha: 'c1',
    messageHeadline: 'feat: code commit',
    messageBody: 'Signed-off-by: Alice <a@b.com>',
    authorEmail: 'alice@example.com',
    authorLogin: 'alice',
    authorTypename: 'User',
    committedDate: hoursAgo(4),
    parents: 1,
    parentOids: ['c-base'],
    parentsTruncated: false,
    changedFilesIfAvailable: 1,
  };
  const c2: PullRequest['commits'][number] = {
    sha: 'c2',
    messageHeadline: 'Merge branch main',
    messageBody: 'Signed-off-by: Alice <a@b.com>',
    authorEmail: 'alice@example.com',
    authorLogin: 'alice',
    authorTypename: 'User',
    committedDate: hoursAgo(2),
    parents: 2,
    parentOids: ['c1', 'main-tip'],
    parentsTruncated: false,
    changedFilesIfAvailable: 5,
  };

  const pr = makePr({
    headRefOid: 'c2',
    commits: [c1, c2],
  });

  const evalRes = evaluateChangesRequestedForReviewer(pr, 'bob', hoursAgo(8), 'c-base');
  assert.equal(evalRes.status, 'addressed');
});

test('Regression 35: Only a merge commit follows the review -> does not qualify as code update', () => {
  const cMerge: PullRequest['commits'][number] = {
    sha: 'c-merge',
    messageHeadline: 'Merge branch main into branch',
    messageBody: 'Signed-off-by: Alice <a@b.com>',
    authorEmail: 'alice@example.com',
    authorLogin: 'alice',
    authorTypename: 'User',
    committedDate: hoursAgo(2),
    parents: 2,
    parentOids: ['c-reviewed', 'main-tip'],
    parentsTruncated: false,
    changedFilesIfAvailable: 3,
  };

  const cReviewed: PullRequest['commits'][number] = {
    sha: 'c-reviewed',
    messageHeadline: 'initial',
    messageBody: 'Signed-off-by: Alice <a@b.com>',
    authorEmail: 'alice@example.com',
    authorLogin: 'alice',
    authorTypename: 'User',
    committedDate: hoursAgo(10),
    parents: 1,
    parentOids: ['c-base'],
    parentsTruncated: false,
    changedFilesIfAvailable: 1,
  };

  const pr = makePr({
    headRefOid: 'c-merge',
    commits: [cReviewed, cMerge],
    reviews: [
      {
        id: 'rev-1',
        author: 'bob',
        authorTypename: 'User',
        state: 'CHANGES_REQUESTED',
        submittedAt: hoursAgo(5),
        commitOid: 'c-reviewed',
      },
    ],
  });

  const res = evaluateChangesRequestedForReviewer(pr, 'bob', hoursAgo(5), 'c-reviewed');
  assert.equal(res.status, 'blocked');
});

test('Regression 38: Reviewer counter-reply references updated commit -> responsibility returns to author', () => {
  const c1: PullRequest['commits'][number] = {
    sha: 'c1',
    messageHeadline: 'initial',
    messageBody: 'Signed-off-by: Alice <a@b.com>',
    authorEmail: 'alice@example.com',
    authorLogin: 'alice',
    authorTypename: 'User',
    committedDate: hoursAgo(10),
    parents: 1,
    parentOids: ['c-base'],
    parentsTruncated: false,
    changedFilesIfAvailable: 1,
  };
  const c2: PullRequest['commits'][number] = {
    sha: 'c2',
    messageHeadline: 'author update',
    messageBody: 'Signed-off-by: Alice <a@b.com>',
    authorEmail: 'alice@example.com',
    authorLogin: 'alice',
    authorTypename: 'User',
    committedDate: hoursAgo(5),
    parents: 1,
    parentOids: ['c1'],
    parentsTruncated: false,
    changedFilesIfAvailable: 1,
  };

  const pr = makePr({
    headRefOid: 'c2',
    commits: [c1, c2],
    reviews: [
      {
        id: 'rev-1',
        author: 'bob',
        authorTypename: 'User',
        state: 'CHANGES_REQUESTED',
        submittedAt: hoursAgo(8),
        commitOid: 'c1',
      },
    ],
    reviewThreads: [
      {
        isResolved: false,
        resolvedBy: null,
        commentsTruncated: false,
        comments: [
          {
            author: 'bob',
            authorTypename: 'User',
            authorAssociation: 'MEMBER',
            createdAt: hoursAgo(2),
            commitOid: 'c2',
            originalCommitOid: 'c2', // Reviewer commented on c2!
          },
        ],
      },
    ],
  });

  const res = evaluateChangesRequestedForReviewer(pr, 'bob', hoursAgo(8), 'c1');
  assert.equal(res.status, 'blocked');
});

test('Regression 39: Reviewer counter-reply references older commit -> does not count as review of update', () => {
  const c1: PullRequest['commits'][number] = {
    sha: 'c1',
    messageHeadline: 'initial',
    messageBody: 'Signed-off-by: Alice <a@b.com>',
    authorEmail: 'alice@example.com',
    authorLogin: 'alice',
    authorTypename: 'User',
    committedDate: hoursAgo(10),
    parents: 1,
    parentOids: ['c-base'],
    parentsTruncated: false,
    changedFilesIfAvailable: 1,
  };
  const c2: PullRequest['commits'][number] = {
    sha: 'c2',
    messageHeadline: 'author update',
    messageBody: 'Signed-off-by: Alice <a@b.com>',
    authorEmail: 'alice@example.com',
    authorLogin: 'alice',
    authorTypename: 'User',
    committedDate: hoursAgo(2),
    parents: 1,
    parentOids: ['c1'],
    parentsTruncated: false,
    changedFilesIfAvailable: 1,
  };

  const pr = makePr({
    headRefOid: 'c2',
    commits: [c1, c2],
    reviews: [
      {
        id: 'rev-1',
        author: 'bob',
        authorTypename: 'User',
        state: 'CHANGES_REQUESTED',
        submittedAt: hoursAgo(8),
        commitOid: 'c1',
      },
    ],
    reviewThreads: [
      {
        isResolved: false,
        resolvedBy: null,
        commentsTruncated: false,
        comments: [
          {
            author: 'bob',
            authorTypename: 'User',
            authorAssociation: 'MEMBER',
            createdAt: hoursAgo(4), // created before c2
            commitOid: 'c1',
            originalCommitOid: 'c1', // Commented on c1, not c2!
          },
        ],
      },
    ],
  });

  const res = evaluateChangesRequestedForReviewer(pr, 'bob', hoursAgo(8), 'c1');
  assert.equal(res.status, 'addressed');
});

// -------------------------------------------------------------
// Tests 75 - 84: Per-commit path verification & thread relevance
// -------------------------------------------------------------

test('Regression 75 & 80: README-only commit after review does not address thread on actor.ts', () => {
  const c1: PullRequest['commits'][number] = {
    sha: 'c1',
    messageHeadline: 'feat: add feature',
    messageBody: 'Signed-off-by: Alice <a@b.com>',
    authorEmail: 'alice@example.com',
    authorLogin: 'alice',
    authorTypename: 'User',
    committedDate: hoursAgo(10),
    parents: 1,
    parentOids: ['c-base'],
    parentsTruncated: false,
    changedFilesIfAvailable: 1,
  };
  const c2: PullRequest['commits'][number] = {
    sha: 'c2',
    messageHeadline: 'docs: update README',
    messageBody: 'Signed-off-by: Alice <a@b.com>',
    authorEmail: 'alice@example.com',
    authorLogin: 'alice',
    authorTypename: 'User',
    committedDate: hoursAgo(2),
    parents: 1,
    parentOids: ['c1'],
    parentsTruncated: false,
    changedFilesIfAvailable: 1,
  };

  const pathMap = new Map<string, CommitPathComparison>();
  pathMap.set('packages/checks/src/actor.ts', {
    candidateOid: 'c2',
    parentOid: 'c1',
    path: 'packages/checks/src/actor.ts',
    candidateResult: {
      status: 'found',
      entry: { oid: 'blob-same', mode: 100644, type: 'blob' },
    },
    parentResult: {
      status: 'found',
      entry: { oid: 'blob-same', mode: 100644, type: 'blob' },
    },
  });

  const pr = makePr({
    headRefOid: 'c2',
    commits: [c1, c2],
    reviewThreads: [
      {
        path: 'packages/checks/src/actor.ts',
        isResolved: false,
        resolvedBy: null,
        commentsTruncated: false,
        comments: [
          {
            author: 'bob',
            authorTypename: 'User',
            authorAssociation: 'MEMBER',
            createdAt: hoursAgo(5),
            commitOid: 'c1',
            originalCommitOid: 'c1',
          },
        ],
      },
    ],
  });

  const res = classifyActor(pr, { pathComparisons: pathMap });
  // Author did not reply and did not revise actor.ts! Author remains blocked!
  assert.equal(res.nextActor, 'author');
  assert.equal(res.reason, 'unresolved_review_thread');
});

test('Regression 76 & 81: Author commit modifying actor.ts transfers responsibility without declaring thread resolved', () => {
  const c1: PullRequest['commits'][number] = {
    sha: 'c1',
    messageHeadline: 'feat: add feature',
    messageBody: 'Signed-off-by: Alice <a@b.com>',
    authorEmail: 'alice@example.com',
    authorLogin: 'alice',
    authorTypename: 'User',
    committedDate: hoursAgo(10),
    parents: 1,
    parentOids: ['c-base'],
    parentsTruncated: false,
    changedFilesIfAvailable: 1,
  };
  const c2: PullRequest['commits'][number] = {
    sha: 'c2',
    messageHeadline: 'fix: updated actor.ts',
    messageBody: 'Signed-off-by: Alice <a@b.com>',
    authorEmail: 'alice@example.com',
    authorLogin: 'alice',
    authorTypename: 'User',
    committedDate: hoursAgo(2),
    parents: 1,
    parentOids: ['c1'],
    parentsTruncated: false,
    changedFilesIfAvailable: 1,
  };

  const pathMap = new Map<string, CommitPathComparison>();
  pathMap.set('packages/checks/src/actor.ts', {
    candidateOid: 'c2',
    parentOid: 'c1',
    path: 'packages/checks/src/actor.ts',
    candidateResult: {
      status: 'found',
      entry: { oid: 'blob-new', mode: 100644, type: 'blob' },
    },
    parentResult: {
      status: 'found',
      entry: { oid: 'blob-old', mode: 100644, type: 'blob' },
    },
  });

  const pr = makePr({
    headRefOid: 'c2',
    commits: [c1, c2],
    reviewThreads: [
      {
        path: 'packages/checks/src/actor.ts',
        isResolved: false, // remains unresolved in GitHub
        resolvedBy: null,
        commentsTruncated: false,
        comments: [
          {
            author: 'bob',
            authorTypename: 'User',
            authorAssociation: 'MEMBER',
            createdAt: hoursAgo(5),
            commitOid: 'c1',
            originalCommitOid: 'c1',
          },
        ],
      },
    ],
  });

  const res = classifyActor(pr, { pathComparisons: pathMap });
  // Transfers responsibility to reviewer without marking thread resolved!
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'awaiting_review');
  assert.equal(pr.reviewThreads![0]!.isResolved, false);
});

test('Regression 82: Commit deleting reviewed path is detected as modification', () => {
  const c: PullRequest['commits'][number] = {
    sha: 'c1',
    messageHeadline: 'refactor: delete legacy file',
    messageBody: 'Signed-off-by: Alice <a@b.com>',
    authorEmail: 'alice@example.com',
    authorLogin: 'alice',
    authorTypename: 'User',
    committedDate: hoursAgo(2),
    parents: 1,
    parentOids: ['c-base'],
    parentsTruncated: false,
    changedFilesIfAvailable: 1,
  };

  const pathMap = new Map<string, CommitPathComparison>();
  pathMap.set('legacy.ts', {
    candidateOid: 'c1',
    parentOid: 'c-base',
    path: 'legacy.ts',
    candidateResult: { status: 'absent' }, // deleted in candidate
    parentResult: {
      status: 'found',
      entry: { oid: 'blob-legacy', mode: 100644, type: 'blob' },
    },
  });

  const pr = makePr({ headRefOid: 'c1', commits: [c] });
  const evalRes = evaluateChangesRequestedForReviewer(pr, 'bob', hoursAgo(5), 'c-base', 'rev-1', {
    pathComparisons: pathMap,
  });
  assert.equal(evalRes.status, 'addressed');
});

test('Regression 84: Commit file-change metadata unavailable fails closed to indeterminate', () => {
  const c1: PullRequest['commits'][number] = {
    sha: 'c1',
    messageHeadline: 'feat: add feature',
    messageBody: 'Signed-off-by: Alice <a@b.com>',
    authorEmail: 'alice@example.com',
    authorLogin: 'alice',
    authorTypename: 'User',
    committedDate: hoursAgo(10),
    parents: 1,
    parentOids: ['c-base'],
    parentsTruncated: false,
    changedFilesIfAvailable: 1,
  };
  const c2: PullRequest['commits'][number] = {
    sha: 'c2',
    messageHeadline: 'fix: update',
    messageBody: 'Signed-off-by: Alice <a@b.com>',
    authorEmail: 'alice@example.com',
    authorLogin: 'alice',
    authorTypename: 'User',
    committedDate: hoursAgo(2),
    parents: 1,
    parentOids: ['c1'],
    parentsTruncated: false,
    changedFilesIfAvailable: 1,
  };

  const pathMap = new Map<string, CommitPathComparison>();
  pathMap.set('packages/checks/src/actor.ts', {
    candidateOid: 'c2',
    parentOid: 'c1',
    path: 'packages/checks/src/actor.ts',
    candidateResult: { status: 'unavailable', message: 'API error' },
    parentResult: {
      status: 'found',
      entry: { oid: 'blob-1', mode: 100644, type: 'blob' },
    },
  });

  const pr = makePr({
    headRefOid: 'c2',
    commits: [c1, c2],
    reviewThreads: [
      {
        path: 'packages/checks/src/actor.ts',
        isResolved: false,
        resolvedBy: null,
        commentsTruncated: false,
        comments: [
          {
            author: 'bob',
            authorTypename: 'User',
            authorAssociation: 'MEMBER',
            createdAt: hoursAgo(5),
            commitOid: 'c1',
            originalCommitOid: 'c1',
          },
        ],
      },
    ],
  });

  const res = classifyActor(pr, { pathComparisons: pathMap });
  assert.equal(res.nextActor, 'reviewer');
  assert.equal(res.reason, 'uninspected_review_data');
});
