// Copyright (c) 2026 The Jaeger Authors.
// SPDX-License-Identifier: Apache-2.0

import type {
  ActorClassification,
  AuthorTypename,
  MaintainerConfig,
  NextActor,
  PullRequest,
  ReviewState,
} from './types.js';
import type { CommitPathComparison } from './graphql.js';
import {
  verifyCommitAncestor,
  hasQualifyingAuthorAuthoredCommit,
  type ExternalCommitNode,
  type TraversalLimits,
} from './graph.js';
import { ciFailing } from './predicates/ci_failing.js';
import { dcoMissing } from './predicates/dco_missing.js';
import { mergeConflict } from './predicates/merge_conflict.js';
import {
  getActorIdentityKind,
  hasLogin,
  isBotAuthor,
  isDependencyBotAuthor,
  isHumanActor,
  isHumanApprover,
  sameLogin,
} from './logins.js';

export type { MaintainerConfig } from './types.js';

export interface ClassifyActorOptions {
  pathComparisons?: Map<string, CommitPathComparison>;
  maintainerConfig?: MaintainerConfig;
  externalParents?: Map<string, ExternalCommitNode>;
  limits?: TraversalLimits;
}

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
  const commitMs = parseDateSafe(last.committedDate);
  const createdMs = parseDateSafe(pr.createdAt);
  if (createdMs > 0 && commitMs < createdMs) {
    return pr.createdAt;
  }
  return last.committedDate;
}

function getAuthorLatestActivity(pr: PullRequest): string {
  const author = pr.author?.login;
  let latest = getHeadCommitDate(pr);

  if (author) {
    for (const c of pr.comments) {
      if (
        sameLogin(c.author, author) &&
        isHumanActor(c.authorTypename, c.author) &&
        isLater(c.createdAt, latest)
      ) {
        latest = c.createdAt;
      }
    }
    if (pr.reviewThreads) {
      for (const t of pr.reviewThreads) {
        for (const c of t.comments) {
          if (
            sameLogin(c.author, author) &&
            isHumanActor(c.authorTypename, c.author) &&
            isLater(c.createdAt, latest)
          ) {
            latest = c.createdAt;
          }
        }
      }
    }
  }

  return latest;
}

export function getCandidateReviewerLogins(
  pr: PullRequest,
  includeThreadCommenters = true,
): Set<string> {
  const authorLogin = pr.author?.login;
  const candidateLogins = new Set<string>();
  for (const r of pr.reviews) {
    if (r.author && !sameLogin(r.author, authorLogin)) {
      const identityKind = getActorIdentityKind(r.authorTypename, r.author);
      if (identityKind === 'human' || identityKind === 'unknown') {
        candidateLogins.add(r.author.toLowerCase());
      }
    }
  }
  for (const req of pr.reviewRequests) {
    if (req.kind === 'user' && !sameLogin(req.login, authorLogin)) {
      candidateLogins.add(req.login.toLowerCase());
    }
  }
  if (includeThreadCommenters && pr.reviewThreads) {
    for (const thread of pr.reviewThreads) {
      for (const comment of thread.comments) {
        if (
          comment.author &&
          !sameLogin(comment.author, authorLogin) &&
          (comment.authorAssociation === 'MEMBER' ||
            comment.authorAssociation === 'OWNER' ||
            comment.authorAssociation === 'COLLABORATOR')
        ) {
          const identityKind = getActorIdentityKind(comment.authorTypename, comment.author);
          if (identityKind !== 'non_human') candidateLogins.add(comment.author.toLowerCase());
        }
      }
    }
  }
  return candidateLogins;
}

export function getLastReviewOrMaintainerActivityState(
  pr: PullRequest,
  maintainerConfig?: MaintainerConfig,
): {
  latest: string;
  hasMaintainerConfigUncertainty: boolean;
  hasActivityDataUncertainty: boolean;
} {
  const authorLogin = pr.author?.login;
  let latest = getHeadCommitDate(pr);
  let hasMaintainerConfigUncertainty = false;
  let hasInvalidActivityTimestamp = false;

  const candidateLogins = getCandidateReviewerLogins(pr, maintainerConfig === undefined);
  const potentialMaintainerActivity: string[] = [];
  for (const r of pr.reviews) {
    if (
      r.author &&
      isHumanActor(r.authorTypename, r.author) &&
      candidateLogins.has(r.author.toLowerCase())
    ) {
      if (parseDateSafe(r.submittedAt) === 0) {
        hasInvalidActivityTimestamp = true;
        continue;
      }
      if (r.submittedAt && isLater(r.submittedAt, latest)) {
        latest = r.submittedAt;
      }
    }
  }

  if (pr.reviewThreads) {
    for (const thread of pr.reviewThreads) {
      for (const comment of thread.comments) {
        const privilegedAssociation =
          comment.authorAssociation === 'OWNER' ||
          comment.authorAssociation === 'MEMBER' ||
          comment.authorAssociation === 'COLLABORATOR';
        if (
          comment.author &&
          isHumanActor(comment.authorTypename, comment.author) &&
          !sameLogin(comment.author, authorLogin) &&
          (candidateLogins.has(comment.author.toLowerCase()) ||
            (maintainerConfig?.status === 'available' &&
              hasLogin(maintainerConfig.logins, comment.author)) ||
            (maintainerConfig?.status === 'unavailable' && privilegedAssociation))
        ) {
          const isReviewer = candidateLogins.has(comment.author.toLowerCase());
          if (parseDateSafe(comment.createdAt) === 0) {
            hasInvalidActivityTimestamp = true;
            continue;
          }
          if (maintainerConfig?.status === 'unavailable' && privilegedAssociation && !isReviewer) {
            potentialMaintainerActivity.push(comment.createdAt);
            continue;
          }
          if (isLater(comment.createdAt, latest)) latest = comment.createdAt;
        }
      }
    }
  }

  for (const comment of pr.comments) {
    if (
      comment.author &&
      isHumanActor(comment.authorTypename, comment.author) &&
      !sameLogin(comment.author, authorLogin)
    ) {
      const isReviewer = candidateLogins.has(comment.author.toLowerCase());
      let isMaintainer = false;
      const privilegedAssociation =
        comment.authorAssociation === 'OWNER' ||
        comment.authorAssociation === 'MEMBER' ||
        comment.authorAssociation === 'COLLABORATOR';

      if (parseDateSafe(comment.createdAt) === 0) {
        hasInvalidActivityTimestamp = true;
        continue;
      }

      if (maintainerConfig) {
        if (maintainerConfig.status === 'available') {
          isMaintainer = hasLogin(maintainerConfig.logins, comment.author);
        } else if (!isReviewer && privilegedAssociation) {
          potentialMaintainerActivity.push(comment.createdAt);
        }
      } else {
        isMaintainer = privilegedAssociation;
      }

      if (isReviewer || isMaintainer) {
        if (isLater(comment.createdAt, latest)) {
          latest = comment.createdAt;
        }
      }
    }
  }

  if (potentialMaintainerActivity.some((createdAt) => isLater(createdAt, latest))) {
    hasMaintainerConfigUncertainty = true;
  }

  const activityWarnings = collectCompletenessWarnings(pr);
  const hasActivityDataUncertainty =
    hasInvalidActivityTimestamp ||
    activityWarnings.some((warning) =>
      ['reviews_truncated', 'review_threads_truncated', 'thread_comments_truncated'].includes(
        warning,
      ),
    );

  return { latest, hasMaintainerConfigUncertainty, hasActivityDataUncertainty };
}

export function getLastReviewOrMaintainerActivity(
  pr: PullRequest,
  maintainerConfig?: MaintainerConfig,
): string {
  return getLastReviewOrMaintainerActivityState(pr, maintainerConfig).latest;
}

export type ReviewerReviewResult =
  | {
      status: 'valid';
      reviewer: string;
      author: string;
      authorTypename: AuthorTypename | null;
      state: ReviewState;
      submittedAt: string;
      commitOid: string | null;
      id: string;
    }
  | {
      status: 'indeterminate';
      reviewer: string;
      reason: 'invalid_timestamp' | 'unknown_identity' | 'conflicting_review_state';
    };

export function getLatestReviewsByReviewer(pr: PullRequest): ReviewerReviewResult[] {
  const authorLogin = pr.author?.login;
  type Candidate = { result: ReviewerReviewResult; timestamp: number | null };
  const latestByReviewer = new Map<string, Candidate>();

  for (const r of pr.reviews) {
    if (!r.author || (authorLogin && sameLogin(r.author, authorLogin))) continue;
    // COMMENTED and PENDING do not change the authoritative review decision.
    if (r.state === 'COMMENTED' || r.state === 'PENDING') continue;

    const reviewerKey = r.author.toLowerCase();
    const prev = latestByReviewer.get(reviewerKey);

    const identityKind = getActorIdentityKind(r.authorTypename, r.author);
    if (identityKind === 'non_human') {
      continue;
    }

    const timestamp = parseDateSafe(r.submittedAt);
    if (timestamp === 0) {
      latestByReviewer.set(reviewerKey, {
        result: {
          status: 'indeterminate',
          reviewer: r.author,
          reason: 'invalid_timestamp',
        },
        timestamp: null,
      });
      continue;
    }

    // An invalid timestamp cannot be ordered against another review. Keep the
    // reviewer indeterminate rather than guessing which review is latest.
    if (prev?.timestamp === null) continue;
    if (prev && timestamp < prev.timestamp) continue;

    if (identityKind === 'unknown') {
      latestByReviewer.set(reviewerKey, {
        result: { status: 'indeterminate', reviewer: r.author, reason: 'unknown_identity' },
        timestamp,
      });
      continue;
    }

    if (prev && timestamp === prev.timestamp) {
      if (prev.result.status === 'indeterminate' || prev.result.state !== r.state) {
        latestByReviewer.set(reviewerKey, {
          result: {
            status: 'indeterminate',
            reviewer: r.author,
            reason:
              prev.result.status === 'indeterminate'
                ? prev.result.reason
                : 'conflicting_review_state',
          },
          timestamp,
        });
      }
      continue;
    }

    latestByReviewer.set(reviewerKey, {
      result: {
        status: 'valid',
        reviewer: r.author,
        author: r.author,
        authorTypename: r.authorTypename ?? null,
        state: r.state,
        submittedAt: r.submittedAt as string,
        commitOid: r.commitOid ?? null,
        id: r.id ?? '',
      },
      timestamp,
    });
  }

  return Array.from(latestByReviewer.values(), (candidate) => candidate.result);
}

export function collectCompletenessWarnings(pr: PullRequest): string[] {
  const warnings: string[] = [];
  if (pr.author === null || !pr.author?.login) warnings.push('author_identity_unavailable');
  if (pr.commitsTruncated !== false) warnings.push('commits_truncated');
  if (pr.reviewsTruncated !== false) warnings.push('reviews_truncated');
  if (pr.reviewRequestsTruncated !== false) warnings.push('review_requests_truncated');
  if (pr.reviewThreadsTruncated !== false || pr.reviewThreads === undefined) {
    warnings.push('review_threads_truncated');
  }
  if (pr.reviewThreads && pr.reviewThreads.some((t) => t.commentsTruncated !== false)) {
    warnings.push('thread_comments_truncated');
  }
  if (pr.headCheckRunsTruncated !== false || pr.headCheckRuns === undefined) {
    warnings.push('ci_runs_truncated');
  }
  if (!pr.headRefOid || pr.commits[pr.commits.length - 1]?.sha !== pr.headRefOid) {
    warnings.push('head_commit_mismatch');
  }
  if (pr.labelsTruncated !== false) warnings.push('labels_truncated');
  if (pr.commentsTruncated === true) {
    warnings.push('comments_truncated');
  } else if (pr.commentsTruncated === undefined) {
    warnings.push('comments_data_unavailable');
  }
  if (warnings.length > 0 && !warnings.includes('review_data_incomplete')) {
    warnings.push('review_data_incomplete');
  }
  return warnings;
}

function collectReviewCompletenessWarnings(pr: PullRequest): string[] {
  const warnings = collectCompletenessWarnings(pr).filter(
    (warning) =>
      warning !== 'labels_truncated' &&
      warning !== 'comments_data_unavailable' &&
      warning !== 'comments_truncated' &&
      (warning !== 'ci_runs_truncated' || pr.statusCheckRollup !== 'SUCCESS'),
  );
  return warnings.length === 1 && warnings[0] === 'review_data_incomplete' ? [] : warnings;
}

export function collectAuthorIdentityWarnings(
  pr: PullRequest,
  extraWarnings: string[] = [],
): string[] {
  const warnings = collectCompletenessWarnings(pr);
  if (!warnings.includes('author_identity_unavailable')) {
    warnings.push('author_identity_unavailable');
  }
  for (const w of extraWarnings) {
    if (!warnings.includes(w)) {
      warnings.push(w);
    }
  }
  if (!warnings.includes('review_data_incomplete')) {
    warnings.push('review_data_incomplete');
  }
  return warnings;
}

export function collectTimestampWarnings(pr: PullRequest, extraWarnings: string[] = []): string[] {
  const warnings = collectCompletenessWarnings(pr);
  if (!warnings.includes('review_timestamps_invalid')) {
    warnings.push('review_timestamps_invalid');
  }
  for (const w of extraWarnings) {
    if (!warnings.includes(w)) {
      warnings.push(w);
    }
  }
  if (!warnings.includes('review_data_incomplete')) {
    warnings.push('review_data_incomplete');
  }
  return warnings;
}

export interface IndeterminateEvaluation {
  status: 'indeterminate';
  warnings: string[];
}

export type ChangesRequestedEvaluation =
  { status: 'blocked' } | IndeterminateEvaluation | { status: 'addressed' };

export function evaluateChangesRequestedForReviewer(
  pr: PullRequest,
  reviewerLogin: string,
  reviewSubmittedAt: string,
  reviewCommitOid?: string | null,
  reviewId?: string,
  options?: ClassifyActorOptions,
): ChangesRequestedEvaluation {
  const authorLogin = pr.author?.login;
  if (!authorLogin) {
    return { status: 'indeterminate', warnings: collectAuthorIdentityWarnings(pr) };
  }

  const sinceMs = parseDateSafe(reviewSubmittedAt);
  if (sinceMs === 0) {
    return { status: 'indeterminate', warnings: collectTimestampWarnings(pr) };
  }

  // A visible review is not authoritative while the review connection is
  // truncated: an unseen review may be the reviewer's actual latest state.
  if (pr.reviewsTruncated !== false) {
    return { status: 'indeterminate', warnings: collectCompletenessWarnings(pr) };
  }

  let commitOid = reviewCommitOid;
  let id = reviewId;
  if (commitOid === undefined || id === undefined) {
    const matchingReview = pr.reviews.find(
      (r) =>
        r.author &&
        sameLogin(r.author, reviewerLogin) &&
        r.submittedAt === reviewSubmittedAt &&
        r.state === 'CHANGES_REQUESTED',
    );
    if (matchingReview) {
      if (commitOid === undefined) commitOid = matchingReview.commitOid;
      if (id === undefined) id = matchingReview.id;
    }
  }

  const threads = pr.reviewThreads ?? [];
  const candidateReviewerThreads = threads.filter((t) =>
    t.comments.some((c) => sameLogin(c.author, reviewerLogin)),
  );
  const openReviewerThreads = candidateReviewerThreads.filter((t) => !t.isResolved);
  const resolvedReviewerThreads = candidateReviewerThreads.filter((t) => {
    if (!t.isResolved) return false;
    // A resolved thread only proves that this particular review was answered
    // when it contains a comment belonging to the review under evaluation.
    // Older resolved threads from the same reviewer must not clear a newer
    // change request.
    if (id === undefined) return false;
    return t.comments.some((c) => c.pullRequestReview?.id === id);
  });

  // An incomplete comment connection on any open thread could hide reviewer participation
  const hasOpenThreadWithTruncatedComments = threads.some(
    (t) => !t.isResolved && t.commentsTruncated !== false,
  );
  const hasAnyThreadWithTruncatedComments = threads.some((t) => t.commentsTruncated !== false);

  // Check graph ancestry and qualifying author commit
  let authorUpdateCommit: PullRequest['commits'][number] | null = null;
  let isAncestryIndeterminate = false;
  let qualifyingCommitsInRange: PullRequest['commits'][number][] = [];
  let qualifyingCommitRangeComplete = true;

  if (commitOid) {
    const ancestry = verifyCommitAncestor(pr, commitOid, pr.headRefOid ?? '', {
      limits: options?.limits,
      externalParents: options?.externalParents,
    });
    if (ancestry.status === 'ancestor') {
      const qual = hasQualifyingAuthorAuthoredCommit(
        pr,
        ancestry.rangeCommits,
        ancestry.rangeComplete,
      );
      if (qual.status === 'qualifying') {
        authorUpdateCommit = qual.commit;
        qualifyingCommitsInRange = ancestry.rangeCommits;
        qualifyingCommitRangeComplete = ancestry.rangeComplete;
      } else if (qual.status === 'indeterminate') {
        isAncestryIndeterminate = true;
      }
    } else if (ancestry.status === 'indeterminate') {
      isAncestryIndeterminate = true;
    } else {
      // A rebase or force-push can remove the reviewed commit from the
      // current graph. A later complete author commit is possible revision
      // evidence, but it cannot be correlated to the old review history.
      isAncestryIndeterminate =
        pr.commitsTruncated !== false ||
        pr.commits.some((commit) => parseDateSafe(commit.committedDate) > sinceMs);
    }
  } else if (reviewCommitOid === null) {
    // A timestamp cannot prove that a commit descends from the commit that was
    // reviewed, especially after a force-push or a merge from the base branch.
    // Keep the result fail-closed when there is actually a later commit to
    // correlate. If there is no later commit and the commit list is complete,
    // an open thread is a confirmed blocker rather than indeterminate data.
    isAncestryIndeterminate =
      pr.commitsTruncated !== false ||
      pr.commits.some((commit) => parseDateSafe(commit.committedDate) > sinceMs);
  } else {
    // Legacy callers may omit commit metadata entirely. Preserve their
    // timestamp-only behavior until they provide authoritative commit OIDs;
    // GraphQL-backed callers use null for an explicitly unavailable OID and
    // take the fail-closed branch above.
    const candidate = pr.commits.find(
      (c) =>
        sameLogin(c.authorLogin, authorLogin) &&
        c.parents <= 1 &&
        parseDateSafe(c.committedDate) > sinceMs,
    );
    if (candidate) {
      authorUpdateCommit = candidate;
      qualifyingCommitsInRange = [candidate];
    }
  }

  if (openReviewerThreads.length > 0) {
    let hasIndeterminateThread = false;
    let hasInvalidTimestamps = false;
    let hasAuthorIdentityMissing = false;

    // Scan all open reviewer threads, prioritizing confirmed blockers
    for (const thread of openReviewerThreads) {
      if (thread.commentsTruncated !== false) {
        hasIndeterminateThread = true;
        continue;
      }

      const matchingReviewerComments = thread.comments.filter((c) =>
        sameLogin(c.author, reviewerLogin),
      );
      if (matchingReviewerComments.length === 0) continue;

      const hasUnknownReviewer = matchingReviewerComments.some(
        (c) => getActorIdentityKind(c.authorTypename, c.author) === 'unknown',
      );
      if (hasUnknownReviewer) {
        hasIndeterminateThread = true;
        continue;
      }

      const reviewerComments = matchingReviewerComments.filter(
        (c) => getActorIdentityKind(c.authorTypename, c.author) === 'human',
      );
      if (reviewerComments.length === 0) continue;

      const reviewerTimes = reviewerComments
        .map((c) => parseDateSafe(c.createdAt))
        .filter((t) => t > 0);

      // Partially invalid reviewer timestamps fail closed into indeterminate
      if (reviewerTimes.length !== reviewerComments.length) {
        hasIndeterminateThread = true;
        hasInvalidTimestamps = true;
        continue;
      }

      if (!authorLogin) {
        hasIndeterminateThread = true;
        hasAuthorIdentityMissing = true;
        continue;
      }

      const matchingAuthorComments = thread.comments.filter((c) =>
        sameLogin(c.author, authorLogin),
      );
      const hasUnknownAuthor = matchingAuthorComments.some(
        (c) => getActorIdentityKind(c.authorTypename, c.author) === 'unknown',
      );
      if (hasUnknownAuthor) {
        hasIndeterminateThread = true;
        continue;
      }

      const authorComments = matchingAuthorComments.filter(
        (c) => getActorIdentityKind(c.authorTypename, c.author) === 'human',
      );
      const authorTimes = authorComments
        .map((c) => parseDateSafe(c.createdAt))
        .filter((t) => t > 0);

      // Partially invalid author timestamps fail closed into indeterminate
      if (authorTimes.length !== authorComments.length) {
        hasIndeterminateThread = true;
        hasInvalidTimestamps = true;
        continue;
      }

      const latestReviewerMs = Math.max(...reviewerTimes);
      const latestAuthorMs = authorTimes.length > 0 ? Math.max(...authorTimes) : 0;

      // Equal timestamps produce indeterminate thread responsibility (Test 10)
      if (latestAuthorMs > 0 && latestAuthorMs === latestReviewerMs) {
        hasIndeterminateThread = true;
        continue;
      }

      const repliedByComment = latestAuthorMs > latestReviewerMs && latestAuthorMs > sinceMs;

      let repliedByCommit = false;
      let effectiveUpdateCommit: PullRequest['commits'][number] | null = null;
      if (!repliedByComment && isAncestryIndeterminate) {
        // Missing or unverifiable review ancestry matters only when this
        // thread still needs commit evidence. A verified author comment is
        // sufficient to resolve the thread independently.
        hasIndeterminateThread = true;
        continue;
      }
      if (!repliedByComment && authorUpdateCommit) {
        // A commit that predates this thread's latest reviewer comment cannot
        // answer that comment, even if it was pushed after the review itself
        // was submitted.
        const commitsAfterLatestReviewerComment = qualifyingCommitsInRange.filter(
          (commit) => parseDateSafe(commit.committedDate) > latestReviewerMs,
        );
        if (thread.path) {
          const compResult = hasQualifyingAuthorAuthoredCommit(
            pr,
            commitsAfterLatestReviewerComment,
            qualifyingCommitRangeComplete,
            thread.path,
            options?.pathComparisons,
          );
          if (compResult.status === 'qualifying') {
            repliedByCommit = true;
            effectiveUpdateCommit = compResult.commit;
          } else if (compResult.status === 'indeterminate') {
            hasIndeterminateThread = true;
            continue;
          }
        } else {
          const compResult = hasQualifyingAuthorAuthoredCommit(
            pr,
            commitsAfterLatestReviewerComment,
            qualifyingCommitRangeComplete,
          );
          if (compResult.status === 'qualifying') {
            repliedByCommit = true;
            effectiveUpdateCommit = compResult.commit;
          } else if (compResult.status === 'indeterminate') {
            hasIndeterminateThread = true;
            continue;
          }
        }
      }

      if (!repliedByComment && !repliedByCommit) {
        // Confirmed blocker found
        return { status: 'blocked' };
      }

      // Check counter-replies by this reviewer on the author update (Finding 4, Test 38)
      if (!repliedByComment && effectiveUpdateCommit && repliedByCommit) {
        const updateMs = parseDateSafe(effectiveUpdateCommit.committedDate);
        const counterReplies = reviewerComments.filter(
          (rc) => parseDateSafe(rc.createdAt) > updateMs && parseDateSafe(rc.createdAt) > sinceMs,
        );
        for (const rc of counterReplies) {
          if (rc.originalCommitOid) {
            const replyAnc = verifyCommitAncestor(
              pr,
              effectiveUpdateCommit.sha,
              rc.originalCommitOid,
              {
                limits: options?.limits,
                externalParents: options?.externalParents,
              },
            );
            if (replyAnc.status === 'ancestor') {
              return { status: 'blocked' };
            } else if (replyAnc.status === 'indeterminate') {
              hasIndeterminateThread = true;
            }
          } else if (rc.commitOid) {
            hasIndeterminateThread = true;
          } else {
            hasIndeterminateThread = true;
          }
        }
      }
    }

    // No confirmed blocker exists in open reviewer threads.
    // Check outer thread completeness:
    if (pr.reviewThreads === undefined || pr.reviewThreadsTruncated !== false) {
      return { status: 'indeterminate', warnings: collectCompletenessWarnings(pr) };
    }

    if (
      hasIndeterminateThread ||
      hasOpenThreadWithTruncatedComments ||
      hasAnyThreadWithTruncatedComments
    ) {
      const extra: string[] = [];
      if (hasAuthorIdentityMissing) extra.push('author_identity_unavailable');
      const warnings = hasInvalidTimestamps
        ? collectTimestampWarnings(pr, extra)
        : collectCompletenessWarnings(pr);
      if (hasAuthorIdentityMissing && !warnings.includes('author_identity_unavailable')) {
        warnings.push('author_identity_unavailable');
      }
      if (warnings.length > 0 && !warnings.includes('review_data_incomplete')) {
        warnings.push('review_data_incomplete');
      }
      return { status: 'indeterminate', warnings };
    }

    // All open reviewer threads are complete and verified addressed
    return { status: 'addressed' };
  }

  // No open threads exist for this reviewer.
  // 1. Establish whether the outer reviewThreads connection is verified complete:
  if (pr.reviewThreads === undefined || pr.reviewThreadsTruncated !== false) {
    return { status: 'indeterminate', warnings: collectCompletenessWarnings(pr) };
  }

  // 2. An incomplete comment connection on any thread could hide reviewer participation:
  if (hasAnyThreadWithTruncatedComments) {
    return { status: 'indeterminate', warnings: collectCompletenessWarnings(pr) };
  }

  // 3. Validate historical reviewer threads where the relevant reviewer participated:
  let hasValidThreadReply = false;
  let hasIndeterminateHistoricalThread = false;
  let hasInvalidHistoricalTimestamps = false;
  let hasAuthorIdentityMissing = false;

  for (const thread of resolvedReviewerThreads) {
    if (thread.commentsTruncated !== false) {
      hasIndeterminateHistoricalThread = true;
      continue;
    }

    const matchingReviewerComments = thread.comments.filter((c) =>
      sameLogin(c.author, reviewerLogin),
    );
    if (matchingReviewerComments.length === 0) continue;

    const hasUnknownReviewer = matchingReviewerComments.some(
      (c) => getActorIdentityKind(c.authorTypename, c.author) === 'unknown',
    );
    if (hasUnknownReviewer) {
      hasIndeterminateHistoricalThread = true;
      continue;
    }

    const reviewerComments = matchingReviewerComments.filter(
      (c) => getActorIdentityKind(c.authorTypename, c.author) === 'human',
    );
    if (reviewerComments.length === 0) continue;

    const reviewerTimes = reviewerComments
      .map((c) => parseDateSafe(c.createdAt))
      .filter((t) => t > 0);

    if (reviewerTimes.length !== reviewerComments.length) {
      hasIndeterminateHistoricalThread = true;
      hasInvalidHistoricalTimestamps = true;
      continue;
    }

    if (!authorLogin) {
      hasIndeterminateHistoricalThread = true;
      hasAuthorIdentityMissing = true;
      continue;
    }

    const matchingAuthorComments = thread.comments.filter((c) => sameLogin(c.author, authorLogin));
    const hasUnknownAuthor = matchingAuthorComments.some(
      (c) => getActorIdentityKind(c.authorTypename, c.author) === 'unknown',
    );
    if (hasUnknownAuthor) {
      hasIndeterminateHistoricalThread = true;
      continue;
    }

    const authorComments = matchingAuthorComments.filter(
      (c) => getActorIdentityKind(c.authorTypename, c.author) === 'human',
    );
    const authorTimes = authorComments.map((c) => parseDateSafe(c.createdAt)).filter((t) => t > 0);

    if (authorTimes.length !== authorComments.length) {
      hasIndeterminateHistoricalThread = true;
      hasInvalidHistoricalTimestamps = true;
      continue;
    }

    const latestReviewerMs = Math.max(...reviewerTimes);
    const validReplies = authorComments.filter(
      (c) => parseDateSafe(c.createdAt) > sinceMs && parseDateSafe(c.createdAt) > latestReviewerMs,
    );

    if (validReplies.length > 0) {
      hasValidThreadReply = true;
    }
  }

  // If any thread has truncated comments, participation could be hidden
  if (hasAnyThreadWithTruncatedComments) {
    return { status: 'indeterminate', warnings: collectCompletenessWarnings(pr) };
  }

  if (hasIndeterminateHistoricalThread) {
    const extra: string[] = [];
    if (hasAuthorIdentityMissing) extra.push('author_identity_unavailable');
    const warnings = hasInvalidHistoricalTimestamps
      ? collectTimestampWarnings(pr, extra)
      : collectCompletenessWarnings(pr);
    if (hasAuthorIdentityMissing && !warnings.includes('author_identity_unavailable')) {
      warnings.push('author_identity_unavailable');
    }
    if (warnings.length > 0 && !warnings.includes('review_data_incomplete')) {
      warnings.push('review_data_incomplete');
    }
    return { status: 'indeterminate', warnings };
  }

  // 4. Under a verified-complete thread connection with no open threads for this reviewer:
  // Strictly require a known PR author identity before allowing addressed state
  if (!authorLogin) {
    return {
      status: 'indeterminate',
      warnings: collectAuthorIdentityWarnings(pr),
    };
  }

  const hasUserReRequest = pr.reviewRequests.some(
    (req) => req.kind === 'user' && sameLogin(req.login, reviewerLogin),
  );

  if (hasValidThreadReply || authorUpdateCommit || hasUserReRequest) {
    return { status: 'addressed' };
  }

  if (isAncestryIndeterminate) {
    const warnings = collectCompletenessWarnings(pr);
    if (!warnings.includes('review_data_incomplete')) warnings.push('review_data_incomplete');
    return { status: 'indeterminate', warnings };
  }

  // 5. Neither is found: require commitsTruncated === false and reviewRequestsTruncated === false
  // before declaring the review blocked.
  if (pr.commitsTruncated !== false || pr.reviewRequestsTruncated !== false) {
    return { status: 'indeterminate', warnings: collectCompletenessWarnings(pr) };
  }

  return { status: 'blocked' };
}

function hasAuthorResolvedWithoutReply(
  pr: PullRequest,
  reviewerLogins: ReadonlySet<string>,
): boolean {
  if (!pr.reviewThreads || !pr.author) return false;
  const authorLogin = pr.author.login;
  if (!authorLogin) return false;

  for (const t of pr.reviewThreads) {
    if (!t.isResolved) continue;
    if (!sameLogin(t.resolvedBy, authorLogin)) continue;
    if (t.commentsTruncated !== false) continue; // Must be complete

    const matchingReviewerComments = t.comments.filter(
      (c) =>
        Boolean(c.author) &&
        !sameLogin(c.author, authorLogin) &&
        reviewerLogins.has(c.author!.toLowerCase()),
    );
    if (matchingReviewerComments.length === 0) continue;

    // Reviewer participation itself must be verified. A bot or unknown reviewer
    // must not establish a reviewer contribution for this warning.
    const hasUnknownReviewer = matchingReviewerComments.some(
      (c) => getActorIdentityKind(c.authorTypename, c.author) === 'unknown',
    );
    if (hasUnknownReviewer) continue;

    const reviewerComments = matchingReviewerComments.filter(
      (c) => getActorIdentityKind(c.authorTypename, c.author) === 'human',
    );
    if (reviewerComments.length === 0) continue;

    const reviewerTimes = reviewerComments
      .map((comment) => parseDateSafe(comment.createdAt))
      .filter((timestamp) => timestamp > 0);
    // Strict timestamp validation for all reviewer comments
    if (reviewerTimes.length !== reviewerComments.length) continue;

    const latestReviewerMs = Math.max(...reviewerTimes);

    // Examine all author comments in thread
    const matchingAuthorComments = t.comments.filter((c) => sameLogin(c.author, authorLogin));

    // Distinguish matching author comments:
    // - Verified human with valid timestamp after reviewer -> replied! (suppress warning)
    // - Unknown identity with valid timestamp after reviewer -> indeterminate (suppress warning)
    // - Unknown identity with invalid timestamp -> indeterminate (suppress warning)
    // - Explicit bot -> does not count as reply
    // - Verified human with invalid timestamp -> indeterminate (suppress warning)
    let hasSuppressionComment = false;
    for (const c of matchingAuthorComments) {
      const kind = getActorIdentityKind(c.authorTypename, c.author);
      if (kind === 'non_human') continue; // Explicit bot does not count as author reply

      const timeMs = parseDateSafe(c.createdAt);
      if (timeMs === 0) {
        // Invalid timestamp on a human or unknown author comment prevents proving absence of reply
        hasSuppressionComment = true;
        break;
      }
      if (timeMs >= latestReviewerMs) {
        // Either verified human or unknown identity posted after latest reviewer comment
        hasSuppressionComment = true;
        break;
      }
    }

    if (hasSuppressionComment) continue;

    // Verified absence of any author reply after verified reviewer comment!
    return true;
  }

  return false;
}

/**
 * Classifies the next actor for a PullRequest in the triage workflow.
 */
export function classifyActor(
  pr: PullRequest,
  options?: ClassifyActorOptions,
): ActorClassification {
  const isDraft = pr.isDraft;
  const isBot = isBotAuthor(pr);
  const authorLogin = pr.author?.login;
  const isDepBot = isDependencyBotAuthor(authorLogin, pr.author?.typename);
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

  // Precedence 2: Draft PR (with fail-closed missing author check)
  if (isDraft) {
    if (!authorLogin) {
      return mk({
        nextActor: 'reviewer',
        isDraft: true,
        isBotAuthored: isBot,
        isDependencyBot: false,
        reason: 'uninspected_review_data',
        turnStartedAt: getHeadCommitDate(pr),
        warnings: collectCompletenessWarnings(pr),
      });
    }
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
  // For orphaned PRs (missing author), fail closed to reviewer while preserving
  // the specific blocker reason and attaching completeness warnings.
  const targetActor: NextActor = authorLogin ? 'author' : 'reviewer';
  const authorWarnings = authorLogin ? undefined : collectCompletenessWarnings(pr);

  const ci = ciFailing(pr);
  if (ci.triggered && !ci.labelOnlyFailure) {
    return mk({
      nextActor: targetActor,
      isDraft: false,
      isBotAuthored: isBot,
      isDependencyBot: false,
      reason: 'ci_failing',
      turnStartedAt: getHeadCommitDate(pr),
      warnings: authorWarnings,
    });
  }

  const conflict = mergeConflict(pr);
  if (conflict.triggered) {
    const conflictActivity = getLastReviewOrMaintainerActivityState(pr, options?.maintainerConfig);
    const warnings = conflictActivity.hasActivityDataUncertainty
      ? [...(authorWarnings ?? []), 'activity_data_incomplete']
      : authorWarnings;
    return mk({
      nextActor: targetActor,
      isDraft: false,
      isBotAuthored: isBot,
      isDependencyBot: false,
      reason: 'merge_conflict',
      turnStartedAt: conflictActivity.latest,
      warnings,
    });
  }

  const dco = dcoMissing(pr);
  if (dco.triggered) {
    return mk({
      nextActor: targetActor,
      isDraft: false,
      isBotAuthored: isBot,
      isDependencyBot: false,
      reason: 'dco_missing',
      turnStartedAt: getHeadCommitDate(pr),
      warnings: authorWarnings,
    });
  }

  // Precedence 4: Active changes requested
  const reviewResults = getLatestReviewsByReviewer(pr);
  const validReviews = reviewResults.filter(
    (r): r is Extract<ReviewerReviewResult, { status: 'valid' }> => r.status === 'valid',
  );
  const indeterminateReviewers = reviewResults.filter(
    (r): r is Extract<ReviewerReviewResult, { status: 'indeterminate' }> =>
      r.status === 'indeterminate',
  );
  const changesRequestedReviews = validReviews.filter((r) => r.state === 'CHANGES_REQUESTED');

  let hasConfirmedChangesRequestedBlocker = false;
  let earliestChangesRequestedTime: string | null = null;
  let hasIndeterminateReviewEvidence = false;
  const indeterminateReviewWarnings: string[] = [];

  const hasAnonymousIndeterminateReview = pr.reviews.some(
    (r) =>
      r.author === null &&
      (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED' || r.state === 'DISMISSED'),
  );
  if (hasAnonymousIndeterminateReview) {
    hasIndeterminateReviewEvidence = true;
    indeterminateReviewWarnings.push('review_actor_identity_unavailable');
  }

  const maintainerState = getLastReviewOrMaintainerActivityState(pr, options?.maintainerConfig);
  if (maintainerState.hasMaintainerConfigUncertainty) {
    hasIndeterminateReviewEvidence = true;
    indeterminateReviewWarnings.push('maintainers_data_unavailable');
  }
  if (maintainerState.hasActivityDataUncertainty) {
    hasIndeterminateReviewEvidence = true;
    indeterminateReviewWarnings.push('activity_data_incomplete');
  }

  if (changesRequestedReviews.length > 0 || indeterminateReviewers.length > 0) {
    const evaluations = changesRequestedReviews.map((r) => ({
      review: r,
      evaluation: evaluateChangesRequestedForReviewer(
        pr,
        r.reviewer,
        r.submittedAt,
        r.commitOid,
        r.id,
        options,
      ),
    }));

    const blocked = evaluations.filter((e) => e.evaluation.status === 'blocked');
    if (blocked.length > 0) {
      hasConfirmedChangesRequestedBlocker = true;
      const earliest = blocked.reduce((prev, curr) =>
        isEarlier(curr.review.submittedAt, prev.review.submittedAt) ? curr : prev,
      );
      earliestChangesRequestedTime = earliest.review.submittedAt;
    }

    const indeterminateEvaluations = evaluations.filter(
      (
        e,
      ): e is {
        review: Extract<ReviewerReviewResult, { status: 'valid' }>;
        evaluation: IndeterminateEvaluation;
      } => e.evaluation.status === 'indeterminate',
    );
    if (indeterminateEvaluations.length > 0 || indeterminateReviewers.length > 0) {
      hasIndeterminateReviewEvidence = true;
      for (const ir of indeterminateReviewers) {
        if (ir.reason === 'invalid_timestamp') {
          indeterminateReviewWarnings.push('review_timestamps_invalid');
        } else if (ir.reason === 'unknown_identity') {
          indeterminateReviewWarnings.push('review_data_incomplete');
        } else if (ir.reason === 'conflicting_review_state') {
          indeterminateReviewWarnings.push('conflicting_review_state');
        }
      }
      for (const e of indeterminateEvaluations) {
        indeterminateReviewWarnings.push(...e.evaluation.warnings);
      }
    }
  }

  if (hasConfirmedChangesRequestedBlocker) {
    return mk({
      nextActor: 'author',
      isDraft: false,
      isBotAuthored: isBot,
      isDependencyBot: false,
      reason: 'changes_requested',
      turnStartedAt: earliestChangesRequestedTime ?? getHeadCommitDate(pr),
    });
  }

  // Precedence 5: Review thread blockers across the PR
  const threads = pr.reviewThreads ?? [];
  let earliestThreadComment: string | null = null;
  let hasConfirmedThreadBlocker = false;
  let hasIndeterminateThread = false;
  let hasInvalidTimestamps = false;
  let hasAuthorIdentityMissing = false;

  // Incomplete outer reviewThreads connection is indeterminate
  if (pr.reviewThreads === undefined || pr.reviewThreadsTruncated !== false) {
    hasIndeterminateThread = true;
  }

  for (const t of threads) {
    if (!t.isResolved) {
      if (t.commentsTruncated !== false) {
        hasIndeterminateThread = true;
        continue;
      }

      if (t.comments.length === 0) continue;

      const matchingReviewerComments = t.comments.filter(
        (c) =>
          Boolean(c.author) &&
          (!authorLogin || !sameLogin(c.author, authorLogin)) &&
          reviewerLogins.has(c.author!.toLowerCase()),
      );
      if (matchingReviewerComments.length === 0) continue;

      const hasUnknownReviewer = matchingReviewerComments.some(
        (c) => getActorIdentityKind(c.authorTypename, c.author) === 'unknown',
      );
      if (hasUnknownReviewer) {
        hasIndeterminateThread = true;
        continue;
      }

      const reviewerComments = matchingReviewerComments.filter(
        (c) => getActorIdentityKind(c.authorTypename, c.author) === 'human',
      );
      if (reviewerComments.length === 0) continue;

      const reviewerTimes = reviewerComments
        .map((c) => parseDateSafe(c.createdAt))
        .filter((timestamp) => timestamp > 0);
      if (reviewerTimes.length !== reviewerComments.length) {
        hasIndeterminateThread = true;
        hasInvalidTimestamps = true;
        continue;
      }

      const latestReviewerMs = Math.max(...reviewerTimes);

      if (!authorLogin) {
        // Without PR author identity, author-reply verification cannot establish a confirmed blocker
        hasIndeterminateThread = true;
        hasAuthorIdentityMissing = true;
        continue;
      }

      const matchingAuthorComments = t.comments.filter((c) => sameLogin(c.author, authorLogin));
      const hasUnknownAuthor = matchingAuthorComments.some(
        (c) => getActorIdentityKind(c.authorTypename, c.author) === 'unknown',
      );
      if (hasUnknownAuthor) {
        hasIndeterminateThread = true;
        continue;
      }

      const authorComments = matchingAuthorComments.filter(
        (c) => getActorIdentityKind(c.authorTypename, c.author) === 'human',
      );
      const authorTimes = authorComments
        .map((c) => parseDateSafe(c.createdAt))
        .filter((timestamp) => timestamp > 0);
      if (authorTimes.length !== authorComments.length) {
        hasIndeterminateThread = true;
        hasInvalidTimestamps = true;
        continue;
      }

      const latestAuthorMs = authorTimes.length > 0 ? Math.max(...authorTimes) : 0;
      if (latestAuthorMs > 0 && latestAuthorMs === latestReviewerMs) {
        hasIndeterminateThread = true;
        continue;
      }

      const replied = authorComments.some((c) => parseDateSafe(c.createdAt) > latestReviewerMs);

      if (!replied) {
        let hasQualifyingCommitForThread = false;
        let isPathIndeterminate = false;

        let commitsAfterReviewer = pr.commits.filter(
          (c) => parseDateSafe(c.committedDate) > latestReviewerMs,
        );
        let commitRangeComplete = pr.commitsTruncated === false;

        // If GitHub gave us the commit the reviewer commented on, restrict
        // author-update evidence to the current head's ancestry from that
        // commit. A force-push can otherwise make an unrelated current commit
        // look like an answer to an old review thread merely because its date
        // is newer.
        const latestReviewerComment = reviewerComments.reduce((latest, curr) =>
          isLater(curr.createdAt, latest.createdAt) ? curr : latest,
        );
        const reviewerAnchorOid =
          latestReviewerComment.originalCommitOid ??
          latestReviewerComment.commitOid ??
          latestReviewerComment.pullRequestReview?.commitOid;
        if (reviewerAnchorOid) {
          const ancestry = verifyCommitAncestor(pr, reviewerAnchorOid, pr.headRefOid ?? '', {
            limits: options?.limits,
            externalParents: options?.externalParents,
          });
          if (ancestry.status === 'ancestor') {
            commitsAfterReviewer = ancestry.rangeCommits.filter(
              (c) => parseDateSafe(c.committedDate) > latestReviewerMs,
            );
            commitRangeComplete = ancestry.rangeComplete;
          } else if (ancestry.status === 'indeterminate') {
            isPathIndeterminate = true;
          } else {
            // The reviewed commit is no longer on the current head. Do not
            // claim that current commits answered a thread from that history.
            commitsAfterReviewer = [];
            commitRangeComplete = pr.commitsTruncated === false;
            isPathIndeterminate =
              pr.commitsTruncated !== false ||
              pr.commits.some((c) => parseDateSafe(c.committedDate) > latestReviewerMs);
          }
        } else if (commitsAfterReviewer.length > 0 || !commitRangeComplete) {
          // A timestamp alone cannot correlate a candidate commit after a
          // force-push. With a complete range and no candidate commit, the
          // open thread remains a confirmed blocker instead.
          isPathIndeterminate = true;
        }

        if (!isPathIndeterminate && commitsAfterReviewer.length > 0) {
          const qualResult = hasQualifyingAuthorAuthoredCommit(
            pr,
            commitsAfterReviewer,
            commitRangeComplete,
            t.path,
            options?.pathComparisons,
          );
          if (qualResult.status === 'qualifying') {
            hasQualifyingCommitForThread = true;
          } else if (qualResult.status === 'indeterminate') {
            isPathIndeterminate = true;
          }
        }

        if (isPathIndeterminate) {
          hasIndeterminateThread = true;
          continue;
        }

        if (!hasQualifyingCommitForThread) {
          hasConfirmedThreadBlocker = true;
          const lastReviewerComment = reviewerComments.reduce((latest, curr) =>
            isLater(curr.createdAt, latest.createdAt) ? curr : latest,
          );
          if (
            !earliestThreadComment ||
            isEarlier(lastReviewerComment.createdAt, earliestThreadComment)
          ) {
            earliestThreadComment = lastReviewerComment.createdAt;
          }
        }
      }
    }
  }

  if (hasConfirmedThreadBlocker) {
    return mk({
      nextActor: 'author',
      isDraft: false,
      isBotAuthored: isBot,
      isDependencyBot: false,
      reason: 'unresolved_review_thread',
      turnStartedAt: earliestThreadComment ?? pr.createdAt,
    });
  }

  // Precedence 5b: Indeterminate evidence aggregation (evaluated only after all confirmed blockers have had a chance to win)
  const hasAnyIndeterminateEvidence = hasIndeterminateReviewEvidence || hasIndeterminateThread;

  if (hasAnyIndeterminateEvidence) {
    const extra: string[] = [...indeterminateReviewWarnings];
    if (hasAuthorIdentityMissing) extra.push('author_identity_unavailable');
    if (hasInvalidTimestamps) extra.push('review_timestamps_invalid');
    const baseWarnings = extra.includes('review_timestamps_invalid')
      ? collectTimestampWarnings(pr, extra)
      : collectCompletenessWarnings(pr);
    const warnings = Array.from(new Set([...baseWarnings, ...extra]));
    if (!warnings.includes('review_data_incomplete')) {
      warnings.push('review_data_incomplete');
    }
    return mk({
      nextActor: 'reviewer',
      isDraft: false,
      isBotAuthored: isBot,
      isDependencyBot: false,
      reason: 'uninspected_review_data',
      turnStartedAt: getAuthorLatestActivity(pr),
      warnings,
    });
  }

  // Fail-closed author identity check before compatibility labels and review requests:
  if (!authorLogin) {
    return mk({
      nextActor: 'reviewer',
      isDraft: false,
      isBotAuthored: isBot,
      isDependencyBot: false,
      reason: 'uninspected_review_data',
      turnStartedAt: getHeadCommitDate(pr),
      warnings: collectCompletenessWarnings(pr),
    });
  }

  // Precedence 6: Compatibility label
  if (pr.labels.some((label) => label.trim().toLowerCase() === 'waiting-for-author')) {
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

  // Precedence 8: Incomplete review data check (Fail-Closed)
  const incompleteWarnings = collectReviewCompletenessWarnings(pr);
  if (incompleteWarnings.length > 0) {
    return mk({
      nextActor: 'reviewer',
      isDraft: false,
      isBotAuthored: isBot,
      isDependencyBot: false,
      reason: 'uninspected_review_data',
      turnStartedAt: getAuthorLatestActivity(pr),
      warnings: incompleteWarnings,
    });
  }

  // Precedence 9: Fully approved / Ready to merge
  const isMergeable = pr.mergeable === 'MERGEABLE';
  const humanApprovals = validReviews.filter(
    (r) =>
      r.state === 'APPROVED' &&
      isHumanApprover(r, pr.author?.login) &&
      parseDateSafe(r.submittedAt) > 0,
  );
  const currentHeadApprovals = humanApprovals.filter((review) => {
    if (review.commitOid != null) {
      return review.commitOid === pr.headRefOid;
    }
    const approvalMs = parseDateSafe(review.submittedAt);
    const headCommit = pr.commits[pr.commits.length - 1];
    const headCommitMs = parseDateSafe(headCommit?.committedDate);
    return approvalMs > 0 && headCommitMs > 0 && approvalMs >= headCommitMs;
  });
  const hasHumanApproval = currentHeadApprovals.length > 0;
  // An author reply or update transfers responsibility to reviewers, but it
  // does not dismiss the review in GitHub. Branch protection still treats the
  // authoritative CHANGES_REQUESTED state as a merge blocker.
  const hasActiveChangesRequested = validReviews.some(
    (review) => review.state === 'CHANGES_REQUESTED',
  );
  const isCiSuccess = pr.statusCheckRollup === 'SUCCESS';
  const hasPendingRuns = pr.headCheckRuns?.some((r) => r.conclusion === null) ?? false;
  const hasContradictoryVisibleFailure =
    isCiSuccess &&
    (pr.headCheckRuns?.some((r) =>
      ['failure', 'action_required', 'timed_out', 'cancelled', 'stale', 'startup_failure'].includes(
        r.conclusion ?? '',
      ),
    ) ??
      false);
  const isLabelOnlyReady =
    Boolean(ci.labelOnlyFailure) &&
    pr.headCheckRuns !== undefined &&
    pr.headCheckRunsTruncated === false &&
    !hasPendingRuns;
  const isCiPassing = isCiSuccess && !hasPendingRuns && !hasContradictoryVisibleFailure;
  const isDataFullyComplete =
    pr.author !== null &&
    Boolean(pr.author.login) &&
    pr.commits.length > 0 &&
    pr.commits[pr.commits.length - 1]?.sha === pr.headRefOid &&
    pr.commitsTruncated === false &&
    pr.reviewsTruncated === false &&
    pr.reviewRequestsTruncated === false &&
    pr.reviewThreadsTruncated === false &&
    pr.reviewThreads !== undefined &&
    pr.reviewThreads.every((t) => t.commentsTruncated === false) &&
    (pr.statusCheckRollup === 'SUCCESS' ||
      (pr.headCheckRunsTruncated === false && pr.headCheckRuns !== undefined));

  if (
    hasHumanApproval &&
    !hasActiveChangesRequested &&
    isCiPassing &&
    isMergeable &&
    isDataFullyComplete
  ) {
    const latestApproval = currentHeadApprovals.reduce((prev, curr) =>
      isLater(curr.submittedAt, prev.submittedAt) ? curr : prev,
    );
    return mk({
      nextActor: 'maintainer',
      isDraft: false,
      isBotAuthored: isBot,
      isDependencyBot: false,
      reason: 'ready_to_merge',
      turnStartedAt: latestApproval.submittedAt,
    });
  }

  // Precedence 9.5: Approved with label-only CI failure awaiting maintainer/reviewer label application
  if (
    hasHumanApproval &&
    !hasActiveChangesRequested &&
    isMergeable &&
    isLabelOnlyReady &&
    !hasPendingRuns &&
    !hasContradictoryVisibleFailure &&
    isDataFullyComplete
  ) {
    const latestApproval = currentHeadApprovals.reduce((prev, curr) =>
      isLater(curr.submittedAt, prev.submittedAt) ? curr : prev,
    );
    return mk({
      nextActor: 'reviewer',
      isDraft: false,
      isBotAuthored: isBot,
      isDependencyBot: false,
      reason: 'needs_label',
      turnStartedAt: latestApproval.submittedAt,
    });
  }

  // Precedence 10: Default queue
  return mk({
    nextActor: 'reviewer',
    isDraft: false,
    isBotAuthored: isBot,
    isDependencyBot: false,
    reason: 'awaiting_review',
    turnStartedAt: getAuthorLatestActivity(pr),
  });
}
