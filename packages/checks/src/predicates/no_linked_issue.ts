import { hasIssueRef } from '../issue-refs.js';
import type { BaseFactValue } from '../rules/model.js';
import type { PullRequest } from '../types.js';

// Labels that exempt a PR from needing an issue link. Doc-only PRs,
// CI/tooling changes, and explicitly-trivial work don't always have a
// tracking issue. `no-issue-needed` is a maintainer's exemption of one PR.
const EXEMPT_LABELS = new Set([
  'docs',
  'documentation',
  'ci',
  'trivial',
  'chore',
  'no-issue-needed',
]);

// The `missing-issue` label marks a PR that has no open `help wanted` issue
// linked. The body check cannot see the labels of an issue, so the label is
// checked first.
const MISSING_ISSUE_LABEL = 'missing-issue';

export function missingIssueLabelPredicate(pr: PullRequest): boolean {
  return pr.labels.includes(MISSING_ISSUE_LABEL);
}

export function linkedIssueExemptPredicate(pr: PullRequest): boolean {
  return pr.labels.some((l) => EXEMPT_LABELS.has(l.toLowerCase()));
}

export function noLinkedIssuePredicate(pr: PullRequest): BaseFactValue {
  if (missingIssueLabelPredicate(pr)) {
    return {
      holds: true,
      summary: 'PR is not linked to an open `help wanted` issue (`missing-issue` label)',
    };
  }
  if (linkedIssueExemptPredicate(pr)) {
    return {
      holds: false,
      summary: 'Linked-issue check skipped (exempt label)',
    };
  }
  const triggered = !hasIssueRef(pr.body ?? '');
  return {
    holds: triggered,
    summary: triggered
      ? 'PR does not reference an issue with `Fixes #N` / `Closes #N` / `Resolves #N`'
      : 'PR references a linked issue',
    details: triggered
      ? 'Add a line like `Fixes #1234` to the PR description so the linked issue closes on merge. Or apply a `docs`/`ci`/`trivial` label if the PR genuinely has no associated issue.'
      : undefined,
  };
}
