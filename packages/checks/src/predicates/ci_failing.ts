import type { CheckResult, PullRequest } from '../types.js';

export function ciFailing(pr: PullRequest): CheckResult {
  const rollup = pr.statusCheckRollup;
  const triggered = rollup === 'FAILURE' || rollup === 'ERROR';
  return {
    id: 'ci_failing',
    triggered,
    summary: triggered
      ? `CI status rollup is ${rollup}`
      : rollup
        ? `CI status rollup is ${rollup}`
        : 'No CI status checks reported',
    // `ci_failing` reads the status rollup; it doesn't publish its own Check —
    // the underlying CI workflows already do. See RFC predicate table.
    publishesCheck: false,
    inDigest: triggered,
    hidesFromTriage: triggered,
  };
}
