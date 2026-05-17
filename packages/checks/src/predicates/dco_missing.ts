import type { CheckResult, PullRequest } from '../types.js';

// Tested per-line so `[^<]+<[^>]+>` is unambiguous (the boundary characters
// can't appear in the adjacent character classes), avoiding the polynomial
// backtracking the previous multi-line `.+ <[^>]+>` pattern allowed on
// inputs like `Signed-off-by: a <a <a <…` with no closing `>`.
const SIGNED_OFF_LINE_RE = /^Signed-off-by: [^<]+<[^>]+>\s*$/;

function hasSignoff(message: string): boolean {
  return message.split('\n').some((line) => SIGNED_OFF_LINE_RE.test(line));
}

export function dcoMissing(pr: PullRequest): CheckResult {
  const unsigned = pr.commits.filter((c) => {
    const message = `${c.messageHeadline}\n${c.messageBody}`;
    return !hasSignoff(message);
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
