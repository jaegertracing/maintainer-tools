import type { CheckResult, PullRequest } from '../types.js';

// Check names that are purely pre-merge label gates — they fail only because
// a changelog/kind/release label has not been applied yet, which is a
// maintainer responsibility, not a contributor CI failure. PRs blocked solely
// by these checks are surfaced in a dedicated "needs label" section rather
// than being hidden as "CI failing".
const LABEL_GATE_PATTERNS = [
  /check.?label/i,
  /verify.?pr.?label/i,
  /label.?check/i,
];

function isLabelGate(name: string): boolean {
  return LABEL_GATE_PATTERNS.some((re) => re.test(name));
}

export function ciFailing(pr: PullRequest): CheckResult {
  const rollup = pr.statusCheckRollup;
  const triggered = rollup === 'FAILURE' || rollup === 'ERROR';

  if (!triggered) {
    return {
      id: 'ci_failing',
      triggered: false,
      summary: rollup ? `CI status rollup is ${rollup}` : 'No CI status checks reported',
      publishesCheck: false,
      inDigest: false,
      hidesFromTriage: false,
    };
  }

  // Determine whether the only failing checks are label gates. When
  // headCheckRuns is absent (legacy cache entry), we can't tell — treat it
  // as a real CI failure to avoid surfacing broken PRs.
  const runs = pr.headCheckRuns;
  // Conclusions that mean "this check is actively broken". null means
  // in-progress/skipped/neutral — not a failure. 'success' is not failing.
  const FAILING_CONCLUSIONS = new Set([
    'failure', 'action_required', 'timed_out', 'cancelled', 'startup_failure',
  ]);
  const failingRuns = runs?.filter((r) => r.conclusion !== null && FAILING_CONCLUSIONS.has(r.conclusion));
  // Require at least one failing run (guards against empty-array edge case)
  // and every failing run must be a label gate.
  const labelOnlyFailure =
    failingRuns !== undefined &&
    failingRuns.length > 0 &&
    failingRuns.every((r) => isLabelGate(r.name));

  return {
    id: 'ci_failing',
    triggered: true,
    summary: labelOnlyFailure
      ? 'CI only failing on label gate check(s)'
      : `CI status rollup is ${rollup}`,
    publishesCheck: false,
    inDigest: !labelOnlyFailure,
    // Label-only failures do NOT hide from triage — the PR is still
    // actionable by a maintainer who can apply the label. Real CI failures
    // do hide because the contributor needs to fix them first.
    hidesFromTriage: !labelOnlyFailure,
    labelOnlyFailure,
  };
}
