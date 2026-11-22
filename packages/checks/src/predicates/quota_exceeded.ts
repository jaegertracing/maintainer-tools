import type { BaseFactValue } from '../rules/model.js';
import type { PullRequest } from '../types.js';

// Two independent signals:
//   - `pr-quota-reached` label, set by the upstream pr-quota-manager workflow
//     (jaegertracing/jaeger/.github/scripts/pr-quota-manager.js).
//   - `pr.computed.quotaExceeded`, set by an in-process pass with cross-PR
//     context (see cli/src/quota.ts) that re-runs the quota math from
//     scratch using the same tiered policy.
//
// Either is sufficient. The label is fast (single GraphQL field) but
// depends on the external workflow being healthy; the computed signal is
// authoritative but pays for an extra search query per multi-PR author.
// The CLI runs both and OR's them.
const QUOTA_LABEL = 'pr-quota-reached';

export function quotaExceededPredicate(pr: PullRequest): BaseFactValue {
  const byLabel = pr.labels.includes(QUOTA_LABEL);
  const byCompute = pr.computed?.quotaExceeded === true;
  const triggered = byLabel || byCompute;
  const reason = byLabel && byCompute ? 'label+computed' : byLabel ? 'label' : 'computed';

  return {
    holds: triggered,
    summary: triggered
      ? `PR on hold — author has reached the new-contributor open-PR quota (${reason})`
      : 'PR not quota-blocked',
  };
}
