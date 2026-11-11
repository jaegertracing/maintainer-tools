// Copyright (c) 2026 The Jaeger Authors.
// SPDX-License-Identifier: Apache-2.0

import type { ActorClassification, PullRequest, ReviewState } from './types.js';
import { ciFailing } from './predicates/ci_failing.js';
import { dcoMissing } from './predicates/dco_missing.js';
import { mergeConflict } from './predicates/merge_conflict.js';
import { isBotAuthor, isBotLogin, isDependencyBotAuthor, sameLogin } from './logins.js';

export function parseDateSafe(dateStr: string | null | undefined): number {
  if (!dateStr) return 0;
  const ms = Date.parse(dateStr);
  return Number.isNaN(ms) ? 0 : ms;
}

export function isLater(
  aDate: string | null | undefined,
  bDate: string | null | undefined,
): boolean {
  const aMs = parseDateSafe(aDate);
  const bMs = parseDateSafe(bDate);
  if (aMs === 0) return false;
  if (bMs === 0) return true;
  return aMs > bMs;
}

export function isEarlier(
  aDate: string | null | undefined,
  bDate: string | null | undefined,
): boolean {
  const aMs = parseDateSafe(aDate);
  const bMs = parseDateSafe(bDate);
  if (aMs === 0) return false;
  if (bMs === 0) return true;
  return aMs < bMs;
}

/**
 * Returns the committed date of the PR's head commit.
 * Assumes the final element of pr.commits represents the snapshot head commit
 * as mapped from the GraphQL query. Falls back safely to pr.createdAt if commits
 * are missing or the timestamp cannot be safely parsed.
 */
function getHeadCommitDate(pr: PullRequest): string {
  const last = pr.commits[pr.commits.length - 1];
  if (!last || parseDateSafe(last.committedDate) === 0) {
    return pr.createdAt;
  }
  return last.committedDate;
}

function getAuthorLatestActivity(pr: PullRequest): string {
  const author = pr.author?.login;
  let latest = getHeadCommitDate(pr);

  if (author) {
    for (const c of pr.comments) {
      if (sameLogin(c.author, author) && isLater(c.createdAt, latest)) {
        latest = c.createdAt;
      }
    }
    if (pr.reviewThreads) {
      for (const t of pr.reviewThreads) {
        for (const c of t.comments) {
          if (sameLogin(c.author, author) && isLater(c.createdAt, latest)) {
            latest = c.createdAt;
          }
        }
      }
    }
  }

  return latest;
}

function getCandidateReviewerLogins(pr: PullRequest): Set<string> {
  const authorLogin = pr.author?.login;
  const candidateLogins = new Set<string>();
  for (const r of pr.reviews) {
    if (r.author && !isBotLogin(r.author) && !sameLogin(r.author, authorLogin)) {
      candidateLogins.add(r.author.toLowerCase());
    }
  }
  for (const req of pr.reviewRequests) {
    if (req.kind === 'user' && !isBotLogin(req.login) && !sameLogin(req.login, authorLogin)) {
      candidateLogins.add(req.login.toLowerCase());
    }
  }
  return candidateLogins;
}

function getLastReviewOrMaintainerActivity(pr: PullRequest): string {
  const authorLogin = pr.author?.login;
  let latest = getHeadCommitDate(pr);

  const candidateLogins = getCandidateReviewerLogins(pr);
  for (const r of pr.reviews) {
    if (r.author && candidateLogins.has(r.author.toLowerCase())) {
      if (isLater(r.submittedAt, latest)) {
        latest = r.submittedAt;
      }
    }
  }

  if (pr.reviewThreads) {
    for (const thread of pr.reviewThreads) {
      for (const comment of thread.comments) {
        if (
          comment.author &&
          !isBotLogin(comment.author) &&
          !sameLogin(comment.author, authorLogin) &&
          candidateLogins.has(comment.author.toLowerCase())
        ) {
          if (isLater(comment.createdAt, latest)) {
            latest = comment.createdAt;
          }
        }
      }
    }
  }

  // Approximation: check top-level comments against known reviewers/maintainers
  // because comment-level authorAssociation is not selected in the current GraphQL query.
  for (const comment of pr.comments) {
    if (
      comment.author &&
      !isBotLogin(comment.author) &&
      !sameLogin(comment.author, authorLogin) &&
      candidateLogins.has(comment.author.toLowerCase())
    ) {
      if (isLater(comment.createdAt, latest)) {
        latest = comment.createdAt;
      }
    }
  }

  return latest;
}

interface LatestReviewInfo {
  reviewer: string;
  state: ReviewState;
  submittedAt: string;
}

function getLatestReviewsByReviewer(pr: PullRequest): LatestReviewInfo[] {
  const authorLogin = pr.author?.login;
  const latestByReviewer = new Map<string, LatestReviewInfo>();

  for (const r of pr.reviews) {
    if (!r.author || (authorLogin && sameLogin(r.author, authorLogin))) continue;
    if (isBotLogin(r.author)) continue;
    if (parseDateSafe(r.submittedAt) === 0) continue;

    const prev = latestByReviewer.get(r.author.toLowerCase());
    if (!prev || isLater(r.submittedAt, prev.submittedAt)) {
      latestByReviewer.set(r.author.toLowerCase(), {
        reviewer: r.author,
        state: r.state,
        submittedAt: r.submittedAt,
      });
    }
  }

  return Array.from(latestByReviewer.values());
}

function hasAuthorAddressedChangesRequested(
  pr: PullRequest,
  reviewerLogin: string,
  reviewSubmittedAt: string,
): boolean {
  const authorLogin = pr.author?.login;
  const sinceMs = parseDateSafe(reviewSubmittedAt);
  if (sinceMs === 0) return false;

  // 1. Author pushed a new commit after the review was submitted
  const headCommitMs = parseDateSafe(getHeadCommitDate(pr));
  if (headCommitMs > sinceMs) return true;

  // 2. Author replied in review threads where this specific reviewer participated.
  // All threads with this reviewer must have an author reply posted after the review
  // was submitted, and the author must hold the latest comment in each of those threads
  // (reviewer counter-replies and partial replies keep the review blocker active).
  if (authorLogin && pr.reviewThreads && pr.reviewThreads.length > 0) {
    const reviewerThreads = pr.reviewThreads.filter((t) =>
      t.comments.some((c) => sameLogin(c.author, reviewerLogin)),
    );
    if (reviewerThreads.length === 0) return false;

    for (const thread of reviewerThreads) {
      const reviewerComments = thread.comments.filter((c) => sameLogin(c.author, reviewerLogin));
      const reviewerTimes = reviewerComments
        .map((c) => parseDateSafe(c.createdAt))
        .filter((t) => t > 0);
      if (reviewerTimes.length === 0) continue;
      const latestReviewerMs = Math.max(...reviewerTimes);

      const authorComments = thread.comments.filter((c) => sameLogin(c.author, authorLogin));
      const authorTimes = authorComments
        .map((c) => parseDateSafe(c.createdAt))
        .filter((t) => t > 0);
      if (authorTimes.length === 0) return false;
      const latestAuthorMs = Math.max(...authorTimes);

      if (latestAuthorMs <= sinceMs || latestAuthorMs <= latestReviewerMs) {
        return false;
      }
    }

    return true;
  }

  return false;
}

function hasAuthorResolvedWithoutReply(
  pr: PullRequest,
  reviewerLogins: ReadonlySet<string>,
): boolean {
  if (!pr.reviewThreads || !pr.author) return false;
  const authorLogin = pr.author.login;

  for (const t of pr.reviewThreads) {
    if (!t.isResolved) continue;
    if (!sameLogin(t.resolvedBy, authorLogin)) continue;

    // Filter to human reviewer comments (non-bot, non-author)
    const reviewerComments = t.comments.filter(
      (c) =>
        Boolean(c.author) &&
        !isBotLogin(c.author) &&
        !sameLogin(c.author, authorLogin) &&
        reviewerLogins.has(c.author!.toLowerCase()),
    );
    if (reviewerComments.length === 0) continue;

    const reviewerTimes = reviewerComments
      .map((comment) => parseDateSafe(comment.createdAt))
      .filter((timestamp) => timestamp > 0);

    if (reviewerTimes.length === 0) continue;

    const latestReviewerMs = Math.max(...reviewerTimes);

    // Did the author post a comment in this thread after the reviewer's latest?
    const replied = t.comments.some(
      (c) => sameLogin(c.author, authorLogin) && parseDateSafe(c.createdAt) > latestReviewerMs,
    );
    if (!replied) return true;
  }

  return false;
}

/**
 * Classifies the next actor for a PullRequest in the triage workflow.
 *
 * Data snapshot bounds:
 * - Commits: DCO detection evaluates the bounded snapshot of pr.commits (the last 100 commits fetched
 *   by the GraphQL query). PRs with more than 100 commits are not exhaustively checked.
 * - Review thread comments: Evaluates the bounded snapshot of thread comments (first 50 comments
 *   per thread). Author replies past comment 50 in a single thread are omitted by the query.
 * - Review history: Review states evaluate the bounded snapshot of pr.reviews (the last 50 reviews
 *   fetched by the GraphQL query). Older reviews are not available to the classifier.
 * - Author/maintainer comments: Top-level issue comments evaluate the bounded snapshot of pr.comments
 *   (the last 50 comments fetched by the GraphQL query). Older top-level comments are not available.
 * - Commit author identity: `pr.commits` does not identify the commit author
 *   login; it only provides `authorEmail` from GraphQL. The classifier treats
 *   any newer commit on the PR head as an author revision until commit author
 *   login is added to the data contract.
 * - Thread blocker routing: Thread evaluation is handled authoritatively by the local
 *   filtered scan rather than delegating to unresolved_from_reviewer. This provides
 *   case-insensitive login matching, bot comment exclusion, and safe timestamp parsing
 *   without altering the upstream predicate, preserving byte-for-byte fidelity in shipped
 *   action bundles.
 * - Review thread reviewers: Unresolved thread blockers are recognized from reviewers
 *   in `pr.reviews` and `pr.reviewRequests`. Inline commenters who never submitted a review
 *   or review request are not captured as reviewers due to GraphQL snapshot constraints.
 */
export function classifyActor(pr: PullRequest): ActorClassification {
  const isDraft = pr.isDraft;
  const isBot = isBotAuthor(pr);
  const isDepBot = isDependencyBotAuthor(pr.author?.login);
  const reviewerLogins = getCandidateReviewerLogins(pr);
  const hasResolvedWithoutReply = hasAuthorResolvedWithoutReply(pr, reviewerLogins);
  const mk = (classification: ActorClassification): ActorClassification => {
    if (!hasResolvedWithoutReply) return classification;
    const existing = classification.warnings ?? [];
    if (existing.includes('resolved_without_reply')) return classification;
    return { ...classification, warnings: [...existing, 'resolved_without_reply'] };
  };

  // Precedence 1: Dependency bot author
  if (isDepBot) {
    return mk({
      nextActor: 'bot',
      isDraft,
      isBotAuthored: isBot,
      isDependencyBot: true,
      reason: 'dependency_bot',
      turnStartedAt: getHeadCommitDate(pr),
    });
  }

  // Precedence 2: Draft PR
  if (isDraft) {
    return mk({
      nextActor: 'author',
      isDraft: true,
      isBotAuthored: isBot,
      isDependencyBot: false,
      reason: 'draft',
      turnStartedAt: getHeadCommitDate(pr),
    });
  }

  // Precedence 3: Hard blockers (CI failing, merge conflict, DCO missing)
  // Note: DCO check evaluates the bounded snapshot of pr.commits (last 100 commits) from GraphQL.
  const ci = ciFailing(pr);
  if (ci.triggered && !ci.labelOnlyFailure) {
    return mk({
      nextActor: 'author',
      isDraft: false,
      isBotAuthored: isBot,
      isDependencyBot: false,
      reason: 'ci_failing',
      turnStartedAt: getHeadCommitDate(pr),
    });
  }

  const conflict = mergeConflict(pr);
  if (conflict.triggered) {
    return mk({
      nextActor: 'author',
      isDraft: false,
      isBotAuthored: isBot,
      isDependencyBot: false,
      reason: 'merge_conflict',
      turnStartedAt: getLastReviewOrMaintainerActivity(pr),
    });
  }

  const dco = dcoMissing(pr);
  if (dco.triggered) {
    return mk({
      nextActor: 'author',
      isDraft: false,
      isBotAuthored: isBot,
      isDependencyBot: false,
      reason: 'dco_missing',
      turnStartedAt: getHeadCommitDate(pr),
    });
  }

  // Precedence 4: Active changes requested
  const latestReviews = getLatestReviewsByReviewer(pr);
  const blockingChangesRequested = latestReviews.filter((r) => r.state === 'CHANGES_REQUESTED');
  const activeChangesRequested = blockingChangesRequested.filter(
    (r) => !hasAuthorAddressedChangesRequested(pr, r.reviewer, r.submittedAt),
  );

  if (activeChangesRequested.length > 0) {
    const earliestBlocker = activeChangesRequested.reduce((prev, curr) =>
      isEarlier(curr.submittedAt, prev.submittedAt) ? curr : prev,
    );
    return mk({
      nextActor: 'author',
      isDraft: false,
      isBotAuthored: isBot,
      isDependencyBot: false,
      reason: 'changes_requested',
      turnStartedAt: earliestBlocker.submittedAt,
    });
  }

  // Precedence 5: Review thread blockers
  // The local filtered thread inspection (ignoring bot and deleted comments, timestamp-based
  // latest comment, case-insensitive comparison) is authoritative for routing to author.
  // Thread comments are filtered to recognized reviewers and the author so outside contributors
  // cannot block the author or override a reviewer's blocker.
  if (pr.reviewThreads) {
    const authorLogin = pr.author?.login;
    let earliestThreadComment: string | null = null;
    let hasUnresolvedHumanThread = false;

    for (const t of pr.reviewThreads) {
      if (!t.isResolved && t.comments.length > 0) {
        const relevantComments = t.comments.filter(
          (c) =>
            Boolean(c.author) &&
            !isBotLogin(c.author) &&
            (sameLogin(c.author, authorLogin) || reviewerLogins.has(c.author!.toLowerCase())),
        );
        if (relevantComments.length === 0) continue;
        const timestampedComments = relevantComments.filter(
          (comment) => parseDateSafe(comment.createdAt) > 0,
        );
        if (timestampedComments.length === 0) continue;
        const lastComment = timestampedComments.reduce((latest, curr) =>
          isLater(curr.createdAt, latest.createdAt) ? curr : latest,
        );
        if (lastComment && (!authorLogin || !sameLogin(lastComment.author, authorLogin))) {
          hasUnresolvedHumanThread = true;
          if (!earliestThreadComment || isEarlier(lastComment.createdAt, earliestThreadComment)) {
            earliestThreadComment = lastComment.createdAt;
          }
        }
      }
    }

    if (hasUnresolvedHumanThread) {
      return mk({
        nextActor: 'author',
        isDraft: false,
        isBotAuthored: isBot,
        isDependencyBot: false,
        reason: 'unresolved_review_thread',
        turnStartedAt: earliestThreadComment ?? pr.createdAt,
      });
    }
  }

  // Precedence 6: Compatibility label
  // Note: GraphQL PullRequest does not supply the labeledEvent timestamp indicating when
  // 'waiting-for-author' was added. Using getAuthorLatestActivity(pr) is an approximation
  // of the author turn duration under this label.
  if (pr.labels.includes('waiting-for-author')) {
    return mk({
      nextActor: 'author',
      isDraft: false,
      isBotAuthored: isBot,
      isDependencyBot: false,
      reason: 'waiting_for_author_label',
      turnStartedAt: getAuthorLatestActivity(pr),
    });
  }

  // Precedence 7: Pending review requests
  if (pr.reviewRequests.length > 0) {
    return mk({
      nextActor: 'reviewer',
      isDraft: false,
      isBotAuthored: isBot,
      isDependencyBot: false,
      reason: 'review_requested',
      turnStartedAt: getAuthorLatestActivity(pr),
    });
  }

  // Precedence 8: Fully approved
  // Requires: at least one approval, no active CHANGES_REQUESTED from any reviewer,
  // clean SUCCESS CI rollup, and no pending review requests.
  const approvals = latestReviews.filter((r) => r.state === 'APPROVED');
  const hasApproval = approvals.length > 0;
  const hasChangesRequested = latestReviews.some((r) => r.state === 'CHANGES_REQUESTED');
  const isCiSuccess = pr.statusCheckRollup === 'SUCCESS';
  const hasPendingReviewRequests = pr.reviewRequests.length > 0;

  if (hasApproval && !hasChangesRequested && isCiSuccess && !hasPendingReviewRequests) {
    const latestApproval = approvals.reduce((prev, curr) =>
      isLater(curr.submittedAt, prev.submittedAt) ? curr : prev,
    );
    const headCommitDate = getHeadCommitDate(pr);
    const turnStartedAt = isLater(headCommitDate, latestApproval.submittedAt)
      ? headCommitDate
      : latestApproval.submittedAt;

    return mk({
      nextActor: 'maintainer',
      isDraft: false,
      isBotAuthored: isBot,
      isDependencyBot: false,
      reason: 'ready_to_merge',
      turnStartedAt,
    });
  }

  // Precedence 9: Default queue
  return mk({
    nextActor: 'reviewer',
    isDraft: false,
    isBotAuthored: isBot,
    isDependencyBot: false,
    reason: 'awaiting_review',
    turnStartedAt: getAuthorLatestActivity(pr),
  });
}
