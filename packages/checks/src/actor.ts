// Copyright (c) 2026 The Jaeger Authors.
// SPDX-License-Identifier: Apache-2.0

import type { ActorClassification, NextActor, PullRequest, ReviewState } from './types.js';
import { ciFailing } from './predicates/ci_failing.js';
import { dcoMissing } from './predicates/dco_missing.js';
import { mergeConflict } from './predicates/merge_conflict.js';
import { unresolvedFromReviewer } from './predicates/unresolved_from_reviewer.js';

export const DEPENDENCY_BOT_LOGINS: ReadonlySet<string> = new Set<string>([
  'dependabot',
  'dependabot[bot]',
  'renovate',
  'renovate[bot]',
  'renovate-bot',
  'renovate-bot[bot]',
]);

function sameLogin(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

export function isDependencyBotAuthor(login: string | null | undefined): boolean {
  if (!login) return false;
  return DEPENDENCY_BOT_LOGINS.has(login.toLowerCase());
}

export function isBotAuthor(pr: PullRequest): boolean {
  if (!pr.author) return false;
  if (pr.author.typename === 'Bot') return true;
  const login = pr.author.login.toLowerCase();
  return login.endsWith('[bot]') || DEPENDENCY_BOT_LOGINS.has(login);
}

function getHeadCommitDate(pr: PullRequest): string {
  const last = pr.commits[pr.commits.length - 1];
  return last?.committedDate ?? pr.createdAt;
}

function getAuthorLatestActivity(pr: PullRequest): string {
  const author = pr.author?.login;
  let latest = getHeadCommitDate(pr);
  let latestMs = Date.parse(latest);

  if (author) {
    for (const c of pr.comments) {
      if (sameLogin(c.author, author)) {
        const ms = Date.parse(c.createdAt);
        if (isNaN(latestMs) || (!isNaN(ms) && ms > latestMs)) {
          latest = c.createdAt;
          latestMs = ms;
        }
      }
    }
    if (pr.reviewThreads) {
      for (const t of pr.reviewThreads) {
        for (const c of t.comments) {
          if (sameLogin(c.author, author)) {
            const ms = Date.parse(c.createdAt);
            if (isNaN(latestMs) || (!isNaN(ms) && ms > latestMs)) {
              latest = c.createdAt;
              latestMs = ms;
            }
          }
        }
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

function getLatestOpinionatedReviews(pr: PullRequest): LatestReviewInfo[] {
  const authorLogin = pr.author?.login;
  const latestByReviewer = new Map<string, LatestReviewInfo>();

  for (const r of pr.reviews) {
    if (!r.author || (authorLogin && sameLogin(r.author, authorLogin))) continue;
    if (r.author.endsWith('[bot]') || DEPENDENCY_BOT_LOGINS.has(r.author.toLowerCase())) continue;
    if (r.state !== 'APPROVED' && r.state !== 'CHANGES_REQUESTED' && r.state !== 'DISMISSED') {
      continue;
    }

    const prev = latestByReviewer.get(r.author.toLowerCase());
    if (!prev || Date.parse(r.submittedAt) > Date.parse(prev.submittedAt)) {
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
  const sinceMs = Date.parse(reviewSubmittedAt);
  if (isNaN(sinceMs)) return false;

  // 1. Author pushed a new commit after the review was submitted
  const headCommitMs = Date.parse(getHeadCommitDate(pr));
  if (!isNaN(headCommitMs) && headCommitMs > sinceMs) return true;

  // 2. Author replied in a review thread where this specific reviewer participated
  if (authorLogin && pr.reviewThreads) {
    for (const thread of pr.reviewThreads) {
      const hasReviewerComment = thread.comments.some((c) => sameLogin(c.author, reviewerLogin));
      if (hasReviewerComment) {
        const hasAuthorReplyAfter = thread.comments.some(
          (c) => sameLogin(c.author, authorLogin) && Date.parse(c.createdAt) > sinceMs,
        );
        if (hasAuthorReplyAfter) {
          return true;
        }
      }
    }
  }

  return false;
}

export function classifyActor(pr: PullRequest, _now: Date = new Date()): ActorClassification {
  const isDraft = pr.isDraft;
  const isBot = isBotAuthor(pr);
  const isDepBot = isDependencyBotAuthor(pr.author?.login);

  // Precedence 1: Dependency bot author
  if (isDepBot) {
    return {
      nextActor: 'bot',
      isDraft,
      isBotAuthored: isBot,
      isDependencyBot: true,
      reason: 'dependency_bot',
      turnStartedAt: getHeadCommitDate(pr),
    };
  }

  // Precedence 2: Draft PR
  if (isDraft) {
    return {
      nextActor: 'author',
      isDraft: true,
      isBotAuthored: isBot,
      isDependencyBot: false,
      reason: 'draft',
      turnStartedAt: getHeadCommitDate(pr),
    };
  }

  // Precedence 3: Hard blockers (CI failing, merge conflict, DCO missing)
  const ci = ciFailing(pr);
  if (ci.triggered && !ci.labelOnlyFailure) {
    return {
      nextActor: 'author',
      isDraft: false,
      isBotAuthored: isBot,
      isDependencyBot: false,
      reason: 'ci_failing',
      turnStartedAt: getHeadCommitDate(pr),
    };
  }

  const conflict = mergeConflict(pr);
  if (conflict.triggered) {
    return {
      nextActor: 'author',
      isDraft: false,
      isBotAuthored: isBot,
      isDependencyBot: false,
      reason: 'merge_conflict',
      turnStartedAt: getHeadCommitDate(pr),
    };
  }

  const dco = dcoMissing(pr);
  if (dco.triggered) {
    return {
      nextActor: 'author',
      isDraft: false,
      isBotAuthored: isBot,
      isDependencyBot: false,
      reason: 'dco_missing',
      turnStartedAt: getHeadCommitDate(pr),
    };
  }

  // Precedence 4: Active changes requested
  const latestReviews = getLatestOpinionatedReviews(pr);
  const blockingChangesRequested = latestReviews.filter((r) => r.state === 'CHANGES_REQUESTED');
  const activeChangesRequested = blockingChangesRequested.filter(
    (r) => !hasAuthorAddressedChangesRequested(pr, r.reviewer, r.submittedAt),
  );

  if (activeChangesRequested.length > 0) {
    const earliestBlocker = activeChangesRequested.reduce((prev, curr) =>
      Date.parse(curr.submittedAt) < Date.parse(prev.submittedAt) ? curr : prev,
    );
    return {
      nextActor: 'author',
      isDraft: false,
      isBotAuthored: isBot,
      isDependencyBot: false,
      reason: 'changes_requested',
      turnStartedAt: earliestBlocker.submittedAt,
    };
  }

  // Precedence 5: Review thread blockers
  const unresolved = unresolvedFromReviewer(pr);
  if (unresolved.triggered) {
    let earliestThreadComment: string | null = null;
    if (pr.reviewThreads) {
      const authorLogin = pr.author?.login;
      for (const t of pr.reviewThreads) {
        if (!t.isResolved && t.comments.length > 0) {
          const humanComments = t.comments.filter(
            (c) =>
              c.author &&
              !c.author.endsWith('[bot]') &&
              !DEPENDENCY_BOT_LOGINS.has(c.author.toLowerCase()),
          );
          const lastComment = humanComments[humanComments.length - 1];
          if (lastComment && (!authorLogin || !sameLogin(lastComment.author, authorLogin))) {
            if (
              !earliestThreadComment ||
              Date.parse(lastComment.createdAt) < Date.parse(earliestThreadComment)
            ) {
              earliestThreadComment = lastComment.createdAt;
            }
          }
        }
      }
    }
    return {
      nextActor: 'author',
      isDraft: false,
      isBotAuthored: isBot,
      isDependencyBot: false,
      reason: 'unresolved_review_thread',
      turnStartedAt: earliestThreadComment ?? pr.createdAt,
    };
  }

  // Precedence 6: Compatibility label
  if (pr.labels.includes('waiting-for-author')) {
    return {
      nextActor: 'author',
      isDraft: false,
      isBotAuthored: isBot,
      isDependencyBot: false,
      reason: 'waiting_for_author_label',
      turnStartedAt: getAuthorLatestActivity(pr),
    };
  }

  // Precedence 7: Pending review requests
  if (pr.reviewRequests.length > 0) {
    return {
      nextActor: 'reviewer',
      isDraft: false,
      isBotAuthored: isBot,
      isDependencyBot: false,
      reason: 'review_requested',
      turnStartedAt: getAuthorLatestActivity(pr),
    };
  }

  // Precedence 8: Fully approved
  const approvals = latestReviews.filter((r) => r.state === 'APPROVED');
  const hasApproval = approvals.length > 0;

  if (hasApproval) {
    const latestApproval = approvals.reduce((prev, curr) =>
      Date.parse(curr.submittedAt) > Date.parse(prev.submittedAt) ? curr : prev,
    );
    const headCommitDate = getHeadCommitDate(pr);
    const turnStartedAt =
      Date.parse(headCommitDate) > Date.parse(latestApproval.submittedAt)
        ? headCommitDate
        : latestApproval.submittedAt;

    return {
      nextActor: 'maintainer',
      isDraft: false,
      isBotAuthored: isBot,
      isDependencyBot: false,
      reason: 'ready_to_merge',
      turnStartedAt,
    };
  }

  // Precedence 9: Default queue
  return {
    nextActor: 'reviewer',
    isDraft: false,
    isBotAuthored: isBot,
    isDependencyBot: false,
    reason: 'awaiting_review',
    turnStartedAt: getAuthorLatestActivity(pr),
  };
}
