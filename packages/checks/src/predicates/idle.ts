// The predicates of the stale policy: a pull request on which no person has
// acted for `idleDays` of the config is idle, unless a maintainer exempts
// it. The rules that combine them are in policy.ts.

import { isPolicyComment } from '../policy-comments.js';
import type { BaseFactValue } from '../rules/model.js';
import { agesOf } from '../types.js';
import type { PredicateContext, PullRequest } from '../types.js';

const DO_NOT_EXPIRE_LABEL = 'do-not-expire';
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

// The time of the latest commit, or comment or review by a person. A
// comment or a review of a bot and a policy comment are the voice of the
// automation, so they do not count. A push is dated by its commits,
// whoever authored them, because GraphQL returns no time of a push.
export function lastActivityByPersonAt(pr: PullRequest): number {
  const times = [
    pr.createdAt,
    ...pr.comments
      .filter(
        (comment) =>
          !comment.authorIsBot && (comment.body === undefined || !isPolicyComment(comment.body)),
      )
      .map((comment) => comment.createdAt),
    ...pr.reviews.filter((review) => !review.authorIsBot).map((review) => review.submittedAt),
    ...pr.commits.map((commit) => commit.committedDate),
  ];
  return Math.max(...times.map((time) => Date.parse(time)));
}

export function quietPredicate(pr: PullRequest, context: PredicateContext): BaseFactValue {
  const { idleDays, idleNoticeDays } = agesOf(context);
  const quietDays = Math.floor(
    (context.now.getTime() - lastActivityByPersonAt(pr)) / MILLISECONDS_PER_DAY,
  );
  const holds = quietDays >= idleDays;
  return {
    holds,
    summary: holds
      ? `No person has acted on the PR for ${quietDays} days (threshold: ${idleDays})`
      : `A person acted on the PR ${quietDays} days ago`,
    details: `No person has commented on this pull request or pushed to it for ${idleDays} days. It is closed ${idleNoticeDays} days after it was labelled \`stale\`, unless someone comments or pushes before that.`,
  };
}

export function doNotExpirePredicate(pr: PullRequest): boolean {
  return pr.labels.includes(DO_NOT_EXPIRE_LABEL);
}
