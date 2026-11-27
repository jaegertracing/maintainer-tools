import { isBeyondQuota } from '../quota.js';
import type { BaseFactValue } from '../rules/model.js';
import type { PredicateContext, PullRequest } from '../types.js';

// `over_quota` does not read the `pr-quota-reached` label, because the label
// is the output of a separate evaluation of the quota policy by the
// pr-quota-manager workflow.
export function overQuotaPredicate(
  pr: PullRequest,
  { openPullRequests }: PredicateContext,
): BaseFactValue {
  const holds = openPullRequests !== undefined && isBeyondQuota(pr, openPullRequests);
  return {
    holds,
    summary: holds
      ? 'PR on hold — author has reached the new-contributor open-PR quota'
      : 'PR not quota-blocked',
  };
}
