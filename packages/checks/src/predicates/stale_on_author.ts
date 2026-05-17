import type { CheckResult, PullRequest } from '../types.js';

// `stale_on_author` is triage-only: actions/stale continues to own the
// labelling/nudge half. The predicate reads (not writes) the `stale` label
// and also fires if the PR's last update was more than `staleDays` ago.
const DEFAULT_STALE_DAYS = 30;

export function staleOnAuthor(
  pr: PullRequest,
  opts: { staleDays?: number; now?: Date } = {},
): CheckResult {
  const staleDays = opts.staleDays ?? DEFAULT_STALE_DAYS;
  const now = opts.now ?? new Date();
  const updated = new Date(pr.updatedAt);
  const ageDays = (now.getTime() - updated.getTime()) / (1000 * 60 * 60 * 24);

  const hasStaleLabel = pr.labels.includes('stale');
  const triggered = hasStaleLabel || ageDays > staleDays;

  return {
    id: 'stale_on_author',
    triggered,
    summary: hasStaleLabel
      ? 'PR carries the `stale` label'
      : triggered
        ? `Author silent for ${Math.floor(ageDays)} days (threshold: ${staleDays})`
        : `Last update ${Math.floor(ageDays)} days ago`,
    // Triage-only — does not publish a Check, does not appear in the digest,
    // does not manage labels. See RFC predicate table.
    publishesCheck: false,
    inDigest: false,
    hidesFromTriage: triggered,
  };
}
