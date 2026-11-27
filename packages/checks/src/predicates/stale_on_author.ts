import type { BaseFactValue } from '../rules/model.js';
import type { PullRequest } from '../types.js';

// `stale_on_author` is triage-only: actions/stale continues to own the
// labelling/nudge half. The predicate reads (not writes) the `stale` label
// and also fires if the PR's last update was more than `staleDays` ago.
const DEFAULT_STALE_DAYS = 30;

export function staleOnAuthorPredicate(
  pr: PullRequest,
  opts: { staleDays?: number; now: Date },
): BaseFactValue {
  const staleDays = opts.staleDays ?? DEFAULT_STALE_DAYS;
  const now = opts.now;
  const updated = new Date(pr.updatedAt);
  const ageDays = (now.getTime() - updated.getTime()) / (1000 * 60 * 60 * 24);

  const hasStaleLabel = pr.labels.includes('stale');
  const triggered = hasStaleLabel || ageDays > staleDays;

  return {
    holds: triggered,
    summary: hasStaleLabel
      ? 'PR carries the `stale` label'
      : triggered
        ? `Author silent for ${Math.floor(ageDays)} days (threshold: ${staleDays})`
        : `Last update ${Math.floor(ageDays)} days ago`,
  };
}
