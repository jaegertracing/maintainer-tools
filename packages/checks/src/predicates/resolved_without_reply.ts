import type { CheckResult, PullRequest } from '../types.js';

// Triggers when the PR author resolved one or more review threads without
// posting a reply to the most recent reviewer comment first. This is the
// "silently dismissed feedback" pattern — sometimes legitimate (typo fix
// applied via commit, conversation actually handled), sometimes evasion.
// Surfaced in triage as `[RESOLVED-W/O-REPLY: N]` so a maintainer can
// re-open if needed.

export function resolvedWithoutReply(pr: PullRequest): CheckResult {
  const threads = pr.reviewThreads ?? [];
  const authorLogin = pr.author?.login;
  if (!authorLogin) return mk(false, 'No author', 0);

  let offenderCount = 0;
  for (const t of threads) {
    if (!t.isResolved) continue;
    if (t.resolvedBy !== authorLogin) continue;
    // Find the most recent reviewer comment in this thread.
    const reviewerComments = t.comments.filter((c) => c.author && c.author !== authorLogin);
    if (reviewerComments.length === 0) continue;
    const latestReviewer = Math.max(...reviewerComments.map((c) => Date.parse(c.createdAt)));
    // Did the author post a comment in this thread after the reviewer's latest?
    const replied = t.comments.some(
      (c) => c.author === authorLogin && Date.parse(c.createdAt) > latestReviewer,
    );
    if (!replied) offenderCount++;
  }

  const triggered = offenderCount > 0;
  return mk(
    triggered,
    triggered
      ? `Author resolved ${offenderCount} review thread(s) without replying to the reviewer`
      : 'No author-resolved-without-reply threads',
    offenderCount,
  );
}

function mk(triggered: boolean, summary: string, _count: number): CheckResult {
  // _count is conceptually part of the result but predicates don't yet have
  // a structured-data slot on CheckResult. Consumers that need the count
  // (the triage row flag `[RESOLVED-W/O-REPLY: N]`) recompute it directly
  // from `pr.reviewThreads` — same data, same cost, no extra API.
  return {
    id: 'resolved_without_reply',
    triggered,
    summary,
    publishesCheck: false,
    inDigest: false,
    // Don't hide — the maintainer should see this so they can decide
    // whether to re-open the thread.
    hidesFromTriage: false,
  };
}
