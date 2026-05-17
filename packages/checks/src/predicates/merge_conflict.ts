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
    // A merge conflict puts the ball in the author's court — nothing for a
    // maintainer to do until the rebase lands. Hide from triage; pr-nudge
    // will surface it to the author via the `waiting-for-author` composite.
    // (The RFC predicate table had `Hidden: no` here, but that's
    // inconsistent with `waiting_for_author` being OR'd over this predicate.)
    hidesFromTriage: triggered,
  };
}
