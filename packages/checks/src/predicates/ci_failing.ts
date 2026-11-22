import type { BaseFactValue } from '../rules/model.js';
import type { PullRequest } from '../types.js';

// Check names that are purely pre-merge label gates — they fail only because
// a changelog/kind/release label has not been applied yet, which is a
// maintainer responsibility, not a contributor CI failure. PRs blocked solely
// by these checks are surfaced in a dedicated "needs label" section rather
// than being hidden as "CI failing".
const LABEL_GATE_PATTERNS = [/check.?label/i, /verify.?pr.?label/i, /label.?check/i];

function isLabelGate(name: string): boolean {
  return LABEL_GATE_PATTERNS.some((re) => re.test(name));
}

function isRollupFailing(pr: PullRequest): boolean {
  return pr.statusCheckRollup === 'FAILURE' || pr.statusCheckRollup === 'ERROR';
}

// Whether the only failing checks of a PR with a failing rollup are label
// gates. When headCheckRuns is absent (legacy cache entry), we can't tell —
// treat it as a real CI failure to avoid surfacing broken PRs.
function isLabelOnlyFailure(pr: PullRequest): boolean {
  const runs = pr.headCheckRuns;
  // Conclusions that mean "this check is actively broken". null means
  // in-progress/skipped/neutral — not a failure. 'success' is not failing.
  const FAILING_CONCLUSIONS = new Set([
    'failure',
    'action_required',
    'timed_out',
    'cancelled',
    'startup_failure',
  ]);
  const failingRuns = runs?.filter(
    (r) => r.conclusion !== null && FAILING_CONCLUSIONS.has(r.conclusion),
  );
  // Require at least one failing run (guards against empty-array edge case)
  // and every failing run must be a label gate.
  //
  // A truncated list cannot support "every failing run is a label gate": the
  // checks we were not shown may include a real failure, and concluding
  // label-only would surface a broken PR as merely needing a label. Treat it
  // the same as absent data — assume a real CI failure. jaeger PRs reach 145
  // check contexts against a page size of 100, so this is reachable, not
  // hypothetical.
  return (
    failingRuns !== undefined &&
    failingRuns.length > 0 &&
    pr.headCheckRunsTruncated !== true &&
    failingRuns.every((r) => isLabelGate(r.name))
  );
}

export function ciFailingPredicate(pr: PullRequest): BaseFactValue {
  const rollup = pr.statusCheckRollup;
  if (!isRollupFailing(pr)) {
    return {
      holds: false,
      summary: rollup ? `CI status rollup is ${rollup}` : 'No CI status checks reported',
    };
  }
  return {
    holds: true,
    summary: isLabelOnlyFailure(pr)
      ? 'CI only failing on label gate check(s)'
      : `CI status rollup is ${rollup}`,
  };
}

export function labelOnlyFailurePredicate(pr: PullRequest): boolean {
  return isRollupFailing(pr) && isLabelOnlyFailure(pr);
}
