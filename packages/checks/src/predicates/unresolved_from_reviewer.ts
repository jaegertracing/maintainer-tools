import type { CheckResult, PullRequest } from '../types.js';

// Triggers when at least one review thread is unresolved and the reviewer
// has the last word — the author hasn't replied there yet. Ball is in the
// author's court on that thread regardless of what else has happened
// elsewhere in the PR.

export function unresolvedFromReviewer(pr: PullRequest): CheckResult {
  const threads = pr.reviewThreads ?? [];
  const authorLogin = pr.author?.login;
  if (!authorLogin) return mk(false, 'No author to compare against');

  const offenders = threads.filter((t) => {
    if (t.isResolved || t.comments.length === 0) return false;
    const latest = t.comments.reduce((a, b) =>
      Date.parse(b.createdAt) > Date.parse(a.createdAt) ? b : a,
    );
    return latest.author !== authorLogin;
  });

  const triggered = offenders.length > 0;
  return mk(
    triggered,
    triggered
      ? `${offenders.length} review thread(s) unresolved — the reviewer's comment hasn't been replied to`
      : 'No unresolved review threads awaiting an author reply',
  );
}

function mk(triggered: boolean, summary: string): CheckResult {
  return {
    id: 'unresolved_from_reviewer',
    triggered,
    summary,
    publishesCheck: false,
    inDigest: triggered,
    // Unresolved reviewer threads with author pushes since = ball is in the
    // author's court. Not actionable by a maintainer until the author responds.
    hidesFromTriage: triggered,
  };
}
