import type { BaseFactValue } from '../rules/model.js';
import type { PullRequest } from '../types.js';

export function mergeConflictPredicate(pr: PullRequest): BaseFactValue {
  const triggered = pr.mergeable === 'CONFLICTING';
  return {
    holds: triggered,
    summary: triggered
      ? 'Branch has merge conflicts with the base branch'
      : 'No merge conflicts detected',
    details: triggered
      ? 'Rebase or merge the latest base branch into your branch to resolve conflicts.'
      : undefined,
  };
}
