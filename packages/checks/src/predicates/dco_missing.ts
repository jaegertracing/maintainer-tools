import type { CheckResult, PullRequest } from '../types.js';

const SIGNED_OFF_RE = /^Signed-off-by: .+ <[^>]+>\s*$/m;

export function dcoMissing(pr: PullRequest): CheckResult {
  const unsigned = pr.commits.filter((c) => {
    const message = `${c.messageHeadline}\n${c.messageBody}`;
    return !SIGNED_OFF_RE.test(message);
  });

  const triggered = unsigned.length > 0;
  return {
    id: 'dco_missing',
    triggered,
    summary: triggered
      ? `DCO missing on ${unsigned.length} commit(s): ${unsigned.map((c) => c.sha.slice(0, 7)).join(', ')}`
      : 'DCO present on all commits',
    details: triggered
      ? 'Each commit must include a `Signed-off-by: Name <email>` trailer. Run `git commit --amend -s` or `git rebase --signoff` and force-push.'
      : undefined,
    publishesCheck: true,
    checkConclusion: triggered ? 'failure' : 'success',
    inDigest: triggered,
    hidesFromTriage: triggered,
  };
}
