import { isBeyondQuota } from '../quota.js';
import type { BaseFactValue } from '../rules/model.js';
import type { PredicateContext, PullRequest } from '../types.js';

const QUOTA_POLICY_URL =
  'https://github.com/jaegertracing/jaeger/blob/main/CONTRIBUTING_GUIDELINES.md#pull-request-limits-for-new-contributors';

// `over_quota` does not read the `pr-quota-reached` label, because the label
// is an output that the rules derive from this fact.
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
    details: holds
      ? `The author has more open pull requests than the limit for new contributors allows, so this one is on hold until an older one is merged or closed. See the [pull request limits](${QUOTA_POLICY_URL}).`
      : undefined,
  };
}
