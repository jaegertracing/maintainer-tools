import { hasIssueRef } from '../issue-refs.js';
import type { CheckResult, PullRequest } from '../types.js';

// Labels that exempt a PR from needing an issue link. Doc-only PRs,
// CI/tooling changes, and explicitly-trivial work don't always have a
// tracking issue.
const EXEMPT_LABELS = new Set(['docs', 'documentation', 'ci', 'trivial', 'chore']);

export function noLinkedIssue(pr: PullRequest): CheckResult {
  if (pr.labels.some((l) => EXEMPT_LABELS.has(l.toLowerCase()))) {
    return {
      id: 'no_linked_issue',
      triggered: false,
      summary: 'Linked-issue check skipped (PR labelled docs/ci/trivial)',
      publishesCheck: false,
      inDigest: false,
      hidesFromTriage: false,
    };
  }
  const triggered = !hasIssueRef(pr.body ?? '');
  return {
    id: 'no_linked_issue',
    triggered,
    summary: triggered
      ? 'PR does not reference an issue with `Fixes #N` / `Closes #N` / `Resolves #N`'
      : 'PR references a linked issue',
    details: triggered
      ? 'Add a line like `Fixes #1234` to the PR description so the linked issue closes on merge. Or apply a `docs`/`ci`/`trivial` label if the PR genuinely has no associated issue.'
      : undefined,
    // Neutral, not failing — the rule isn't strict enough to fail CI.
    publishesCheck: true,
    checkConclusion: triggered ? 'neutral' : 'success',
    inDigest: triggered,
    hidesFromTriage: false,
  };
}
