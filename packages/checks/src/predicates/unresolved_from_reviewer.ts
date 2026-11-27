import type { BaseFactValue } from '../rules/model.js';
import type { PullRequest } from '../types.js';

// Triggers when at least one review thread is unresolved and the reviewer
// has the last word — the author hasn't replied there yet. Ball is in the
// author's court on that thread regardless of what else has happened
// elsewhere in the PR.

export function unresolvedFromReviewerPredicate(pr: PullRequest): BaseFactValue {
  const threads = pr.reviewThreads ?? [];
  const authorLogin = pr.author?.login;
  if (!authorLogin) return { holds: false, summary: 'No author to compare against' };

  const offenders = threads.filter((t) => {
    if (t.isResolved || t.comments.length === 0) return false;
    const latest = t.comments.reduce((a, b) =>
      Date.parse(b.createdAt) > Date.parse(a.createdAt) ? b : a,
    );
    return latest.author !== authorLogin;
  });

  const triggered = offenders.length > 0;
  return {
    holds: triggered,
    summary: triggered
      ? `${offenders.length} review thread(s) unresolved — the reviewer's comment hasn't been replied to`
      : 'No unresolved review threads awaiting an author reply',
  };
}
