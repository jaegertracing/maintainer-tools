// The predicate of the turn policy: it is the turn of the author when a
// maintainer spoke after the author last acted. A maintainer speaks with a
// comment or with a review that is not an approval. An approval supersedes
// what the same maintainer said before it. The author acts with a comment, a
// review or a commit.

import { canWriteToRepositoryOf } from '../collaborators.js';
import { sameLogin } from '../logins.js';
import { isPolicyComment } from '../policy-comments.js';
import type { BaseFactValue } from '../rules/model.js';
import type { PredicateContext, PullRequest } from '../types.js';

function latestTime(times: string[]): number | undefined {
  return times.length === 0 ? undefined : Math.max(...times.map((time) => Date.parse(time)));
}

// The commits that count as the author acting. A merge commit that GitHub
// attributes to another account is the "Update branch" of a maintainer, and
// it answers nothing for the author. Every other commit counts, because an
// author also commits under a second account or under an unknown email.
export function commitsOfAuthor(pr: PullRequest): PullRequest['commits'] {
  const author = pr.author?.login;
  return pr.commits.filter(
    (commit) =>
      commit.parents < 2 ||
      commit.authorLogin == null ||
      (author !== undefined && sameLogin(commit.authorLogin, author)),
  );
}

export function authorsTurnPredicate(pr: PullRequest, context: PredicateContext): BaseFactValue {
  const author = pr.author?.login;
  const isAuthor = (login: string | null): boolean =>
    login !== null && author !== undefined && sameLogin(login, author);
  const isMaintainer = (login: string | null): boolean =>
    login !== null && !isAuthor(login) && canWriteToRepositoryOf(pr, login, context);
  // A policy comment tells the author about a policy and answers nobody, so
  // it is the activity of neither side, whoever posted it.
  const commentsOfPeople = pr.comments.filter(
    (comment) => comment.body === undefined || !isPolicyComment(comment.body),
  );

  // An approval asks nothing of the author.
  const approvals = pr.reviews.filter((review) => review.state === 'APPROVED');
  const isSupersededByApproval = (login: string, time: string): boolean =>
    approvals.some(
      (approval) =>
        approval.author !== null &&
        sameLogin(approval.author, login) &&
        Date.parse(approval.submittedAt) > Date.parse(time),
    );
  const isStandingMaintainerActivity = (login: string | null, time: string): boolean =>
    login !== null && isMaintainer(login) && !isSupersededByApproval(login, time);

  const lastMaintainerActivityAt = latestTime([
    ...commentsOfPeople
      .filter((comment) => isStandingMaintainerActivity(comment.author, comment.createdAt))
      .map((comment) => comment.createdAt),
    ...pr.reviews
      .filter(
        (review) =>
          (review.state === 'CHANGES_REQUESTED' || review.state === 'COMMENTED') &&
          isStandingMaintainerActivity(review.author, review.submittedAt),
      )
      .map((review) => review.submittedAt),
  ]);
  const lastAuthorActivityAt = latestTime([
    ...commentsOfPeople
      .filter((comment) => isAuthor(comment.author))
      .map((comment) => comment.createdAt),
    // GitHub records a reply of the author in a review thread as a review.
    ...pr.reviews.filter((review) => isAuthor(review.author)).map((review) => review.submittedAt),
    // GraphQL returns no time of a push, so a push is dated by its commits.
    ...commitsOfAuthor(pr).map((commit) => commit.committedDate),
  ]);

  const holds =
    lastMaintainerActivityAt !== undefined &&
    (lastAuthorActivityAt === undefined || lastMaintainerActivityAt > lastAuthorActivityAt);
  return {
    holds,
    summary: holds
      ? 'A maintainer commented or reviewed, other than with an approval, after the last comment, review or commit of the author, and has not approved since'
      : 'No comment or review of a maintainer, other than an approval, is newer than the last activity of the author and the last approval of that maintainer',
  };
}
