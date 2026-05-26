import type { CheckResult, PullRequest } from '../types.js';

// Triggers when at least one review thread is unresolved and the PR
// author has pushed new commits since the most recent reviewer comment
// in that thread. That's the "ball is in the maintainer's court but they
// might not have seen the latest push" pattern — the author has acted on
// feedback but no one re-reviewed.

export function unresolvedFromReviewer(pr: PullRequest): CheckResult {
  const threads = pr.reviewThreads ?? [];
  const authorLogin = pr.author?.login;
  const head = pr.commits[pr.commits.length - 1];
  if (!authorLogin || !head) return mk(false, 'No author or no commits to compare against');

  const headTime = Date.parse(head.committedDate);

  const offenders = threads.filter((t) => {
    if (t.isResolved) return false;
    // Latest comment in this thread from anyone other than the author.
    const reviewerComments = t.comments.filter((c) => c.author && c.author !== authorLogin);
    if (reviewerComments.length === 0) return false;
    const latestReviewer = Math.max(...reviewerComments.map((c) => Date.parse(c.createdAt)));
    // Author pushed since the reviewer last commented?
    return headTime > latestReviewer;
  });

  const triggered = offenders.length > 0;
  return mk(
    triggered,
    triggered
      ? `${offenders.length} unresolved review thread(s); author has pushed since last reviewer comment`
      : 'No unresolved threads with new commits since',
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
