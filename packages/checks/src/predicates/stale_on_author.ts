import type { BaseFactValue } from '../rules/model.js';
import { agesOf } from '../types.js';
import type { PredicateContext, PullRequest } from '../types.js';

// `stale_on_author` is triage-only: actions/stale continues to own the
// labelling/nudge half. The predicate reads (not writes) the `stale` label
// and also fires if the last update of the PR is older than
// `staleOnAuthorDays` of the config.

export function staleOnAuthorPredicate(pr: PullRequest, context: PredicateContext): BaseFactValue {
  const staleDays = agesOf(context).staleOnAuthorDays;
  const now = context.now;
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
