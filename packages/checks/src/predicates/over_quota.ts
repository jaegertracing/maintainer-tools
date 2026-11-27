import { isBeyondQuota } from '../quota.js';
import type { BaseFactValue } from '../rules/model.js';
import type { PredicateContext, PullRequest } from '../types.js';

// Two independent signals, and either is sufficient:
//   - the `pr-quota-reached` label, set by the upstream pr-quota-manager
//     workflow. It depends on that workflow being healthy.
//   - the rank of the PR among the open PRs of its author, computed here
//     from the same tiered policy (see quota.ts). It needs the other open
//     PRs, so a consumer that does not gather them as a set has the label
//     only.
const QUOTA_LABEL = 'pr-quota-reached';

export function overQuotaPredicate(
  pr: PullRequest,
  { openPullRequests }: PredicateContext,
): BaseFactValue {
  const byLabel = pr.labels.includes(QUOTA_LABEL);
  const byCompute = openPullRequests !== undefined && isBeyondQuota(pr, openPullRequests);
  const triggered = byLabel || byCompute;
  const reason = byLabel && byCompute ? 'label+computed' : byLabel ? 'label' : 'computed';

  return {
    holds: triggered,
    summary: triggered
      ? `PR on hold — author has reached the new-contributor open-PR quota (${reason})`
      : 'PR not quota-blocked',
  };
}
