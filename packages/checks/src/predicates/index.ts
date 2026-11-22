import { CHECK_FACTS, ruleSet } from '../policy.js';
import type { Verdict } from '../rules/evaluate.js';
import { isSameConclusion } from '../rules/model.js';
import { appliesFactName } from '../types.js';
import type { CheckConclusion, CheckId } from '../types.js';

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
export function checkRunConclusion(id: CheckId, verdict: Verdict): CheckConclusion | undefined {
  const whenCheckHolds = CONCLUSION_WHEN_CHECK_HOLDS[id];
  if (!whenCheckHolds || !checkAppliesToPr(id, verdict)) return undefined;
  return verdict.holds(CHECK_FACTS[id]) ? whenCheckHolds : 'success';
}
