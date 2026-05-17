import type { CheckResult, PullRequest } from '../types.js';

export function mergeConflict(pr: PullRequest): CheckResult {
  const triggered = pr.mergeable === 'CONFLICTING';
  return {
    id: 'merge_conflict',
    triggered,
    summary: triggered
      ? 'Branch has merge conflicts with the base branch'
      : 'No merge conflicts detected',
    details: triggered
      ? 'Rebase or merge the latest base branch into your branch to resolve conflicts.'
      : undefined,
    publishesCheck: true,
    checkConclusion: triggered ? 'failure' : 'success',
    inDigest: triggered,
    // `merge_conflict` keeps the PR visible in triage — a maintainer may still
    // want to comment direction even while conflicts are unresolved. See RFC.
    hidesFromTriage: false,
  };
}
