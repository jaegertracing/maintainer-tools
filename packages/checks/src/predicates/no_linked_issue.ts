import type { CheckResult, PullRequest } from '../types.js';

// Matches GitHub's auto-close keywords. Case-insensitive, accepts either
// the bare `#NNN` form or a full GitHub issue URL. Pluralized variants
// (`fixes`, `fixed`) and the singular all count.
//
// Examples that count:
//   "Fixes #123"
//   "closes  jaegertracing/jaeger#456"
//   "Resolves: https://github.com/jaegertracing/jaeger/issues/789"
const LINKED_RE =
  /\b(fix|fixes|fixed|close|closes|closed|resolve|resolves|resolved)\b[:\s]+(?:[\w-]+\/[\w-]+)?#\d+|\b(fix|fixes|fixed|close|closes|closed|resolve|resolves|resolved)\b[:\s]+https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+/i;

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
  const triggered = !LINKED_RE.test(pr.body ?? '');
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
