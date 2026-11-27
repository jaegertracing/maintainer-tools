// The rule set of the checks, and `runAll()`, which evaluates it for one PR.
// `policy.ts` declares the facts and the rules.

import type { Verdict } from '../rules/evaluate.js';
import { isSameConclusion, OutputName, premiseText } from '../rules/model.js';
import type { Conclusion } from '../rules/model.js';
import { appliesFactName, CHECK_IDS } from '../types.js';
import type {
  CheckConclusion,
  CheckId,
  CheckResult,
  PredicateOptions,
  PullRequest,
} from '../types.js';
import { CHECK_FACTS, labelOnlyFailure, ruleSet } from '../policy.js';

export { CHECK_FACTS, labelOnlyFailure, ruleSet };

// The checks that have a check run, each with the conclusion of the run when
// the fact of the check holds. A check concludes `neutral` when the check is
// advisory and must not fail CI.
const CONCLUSION_WHEN_CHECK_HOLDS: Partial<Record<CheckId, CheckConclusion>> = {
  dco_missing: 'failure',
  merge_conflict: 'failure',
  description_empty: 'failure',
  no_linked_issue: 'neutral',
  no_tests_for_code_change: 'neutral',
};

// Whether `fact` is the fact of the check, or is derived from it by a reason.
function isDerivedFrom(fact: string, id: CheckId): boolean {
  return (
    fact === id ||
    ruleSet.rules.some(
      (rule) =>
        !rule.isVeto &&
        isSameConclusion(rule.conclusion, { kind: 'derived fact', name: fact }) &&
        rule.premises.some((premise) => isDerivedFrom(premise, id)),
    )
  );
}

// A check is a reason for an output when the output holds by a reason that
// reads the fact of the check, or a fact derived from it.
function isReasonFor(verdict: Verdict, output: OutputName, id: CheckId): boolean {
  const conclusion: Conclusion = { kind: 'output', name: output };
  const heldReasons = verdict.reasons(conclusion);
  return (
    verdict.outputsThatHold.includes(output) &&
    ruleSet.rules.some(
      (rule) =>
        !rule.isVeto &&
        isSameConclusion(rule.conclusion, conclusion) &&
        heldReasons.includes(premiseText(rule)) &&
        rule.premises.some((premise) => isDerivedFrom(premise, id)),
    )
  );
}

// A check with a check run applies to every PR when the policy declares no
// `<id>_applies` fact for it.
function checkAppliesToPr(id: CheckId, verdict: Verdict): boolean {
  const name = appliesFactName(id);
  const isDeclared =
    ruleSet.baseFacts.some((baseFact) => baseFact.name === name) ||
    ruleSet.rules.some((rule) => isSameConclusion(rule.conclusion, { kind: 'derived fact', name }));
  return !isDeclared || verdict.factsThatHold.includes(name);
}

// The conclusion of the check run of a check: `success` when the fact of the
// check does not hold. The conclusion is undefined, and no check run is
// published, for a check that has no check run or does not apply to the PR.
function checkRunConclusion(id: CheckId, verdict: Verdict): CheckConclusion | undefined {
  const whenCheckHolds = CONCLUSION_WHEN_CHECK_HOLDS[id];
  if (!whenCheckHolds || !checkAppliesToPr(id, verdict)) return undefined;
  return verdict.holds(CHECK_FACTS[id]) ? whenCheckHolds : 'success';
}

// The verdict as one check sees it: its own fact, its check run, and the
// outputs that it is a reason for.
function checkResult(id: CheckId, verdict: Verdict): CheckResult {
  const triggered = verdict.holds(CHECK_FACTS[id]);
  const checkConclusion = checkRunConclusion(id, verdict);
  return {
    id,
    triggered,
    summary: verdict.summary(id)!,
    details: verdict.details(id),
    publishesCheck: checkConclusion !== undefined,
    checkConclusion,
    inDigest: isReasonFor(verdict, OutputName.WeeklyDigest, id),
    hidesFromTriage: isReasonFor(verdict, OutputName.TriageHidden, id),
    ...(id === 'ci_failing' && triggered
      ? { labelOnlyFailure: verdict.holds(labelOnlyFailure) }
      : {}),
  };
}

// Evaluates the rules for one PR and returns the result of each requested
// check, in the order of `ids`. A caller that passes no clock gets the real
// one.
export function runAll(
  pr: PullRequest,
  ids: readonly CheckId[] = CHECK_IDS,
  opts: PredicateOptions = {},
): CheckResult[] {
  const verdict = ruleSet.evaluate(pr, { now: opts.now ?? new Date() });
  return ids.map((id) => checkResult(id, verdict));
}
