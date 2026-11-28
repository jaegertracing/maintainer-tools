// The startup check rejects a rule set that has a violation. It checks the
// structure of the rules first, and then it enumerates the values of the
// base facts. A dependency cycle is reported earlier, by `derivedFactOrder()`
// when the rule set is loaded, because nothing can be evaluated without an
// order of the derived facts.
//
// `allPossibleBaseFacts()` and `baseFactsAffecting()` are exported for the
// generator of the decision tables, which enumerates the same combinations.

import { derivedFactNamesWithRule } from './evaluate.js';
import type { BaseFacts, RuleSet, Verdict } from './evaluate.js';
import { isSameConclusion, OutputName, RECONCILER_OUTPUT_NAMES, ruleText } from './model.js';
import type { Conclusion, Rule } from './model.js';
import { InvalidRuleSetError } from './violations.js';
import type { RuleSetViolation } from './violations.js';

// Every combination of values of the named base facts.
export function allPossibleBaseFacts(names: readonly string[]): BaseFacts[] {
  let combinations: BaseFacts[] = [{}];
  for (const name of names) {
    combinations = combinations.flatMap((baseFacts) => [
      { ...baseFacts, [name]: false },
      { ...baseFacts, [name]: true },
    ]);
  }
  return combinations;
}

function distinctConclusions(rules: readonly Rule[]): Conclusion[] {
  const conclusions: Conclusion[] = [];
  for (const { conclusion } of rules) {
    if (!conclusions.some((listedConclusion) => isSameConclusion(listedConclusion, conclusion))) {
      conclusions.push(conclusion);
    }
  }
  return conclusions;
}

// The base facts that a conclusion depends on through its rules and the
// rules of the derived facts that they read.
export function baseFactsAffecting(rules: readonly Rule[], conclusion: Conclusion): string[] {
  const derivedFactNames = derivedFactNamesWithRule(rules);
  const baseFactNames = new Set<string>();
  const visitedDerivedFactNames = new Set<string>();
  const visitConclusion = (conclusionToVisit: Conclusion): void => {
    for (const rule of rules.filter((candidate) =>
      isSameConclusion(candidate.conclusion, conclusionToVisit),
    )) {
      for (const premise of rule.premises) {
        if (!derivedFactNames.has(premise)) {
          baseFactNames.add(premise);
        } else if (!visitedDerivedFactNames.has(premise)) {
          visitedDerivedFactNames.add(premise);
          visitConclusion({ kind: 'derived fact', name: premise });
        }
      }
    }
  };
  visitConclusion(conclusion);
  return [...baseFactNames];
}

// A premise has no value when it is a derived fact without a rule or a fact
// of another policy.
function structuralViolations(ruleSet: RuleSet): RuleSetViolation[] {
  const violations: RuleSetViolation[] = [];
  const derivedFactNames = derivedFactNamesWithRule(ruleSet.rules);
  const baseFactNames = new Set(ruleSet.baseFacts.map((baseFact) => baseFact.name));

  const labelAges = new Map(
    ruleSet.baseFacts
      .filter((baseFact) => baseFact.ageOf.length > 0)
      .map((baseFact) => [baseFact.name, baseFact.ageOf]),
  );

  for (const rule of ruleSet.rules) {
    // A label age is what the reconciler wrote, read back. The notice form
    // keeps a rule from holding on that alone: the age is a premise of a
    // reason, beside a fact that says why the label is there.
    const hasFactBesideLabelAge = rule.premises.some((name) => !labelAges.has(name));
    for (const name of rule.premises) {
      const ageOf = labelAges.get(name);
      if (ageOf && (rule.isVeto || !hasFactBesideLabelAge)) {
        violations.push({
          kind: 'rule that reads an output',
          rules: [ruleText(rule)],
          detail: `a rule reads the age of ${ageOf.join(' or ')} through ${name} outside the notice form, which is a reason with a fact beside the age`,
        });
      }
      if (!baseFactNames.has(name) && !derivedFactNames.has(name)) {
        violations.push({
          kind: 'rule that never holds',
          rules: [ruleText(rule)],
          detail: `a rule reads ${name}, which is not a base fact and has no rule`,
        });
      }
    }
  }
  return violations;
}

function baseFactsText(baseFacts: BaseFacts, names: readonly string[]): string {
  return names.map((name) => `${name}=${baseFacts[name] ? 'yes' : 'no'}`).join(' ');
}

function conclusionHolds(verdict: Verdict, conclusion: Conclusion): boolean {
  return conclusion.kind === 'output'
    ? verdict.outputsThatHold.includes(conclusion.name)
    : verdict.factsThatHold.includes(conclusion.name);
}

// The rules that held in a verdict, for the given conclusion and every
// derived fact that it depends on.
function heldRuleTexts(ruleSet: RuleSet, verdict: Verdict, conclusion: Conclusion): string[] {
  const ruleTexts: string[] = [];
  const visitedFactNames = new Set<string>();
  const visitConclusion = (conclusionToVisit: Conclusion): void => {
    for (const rule of ruleSet.rules.filter((candidate) =>
      isSameConclusion(candidate.conclusion, conclusionToVisit),
    )) {
      if (verdict.rulesThatHold.includes(rule)) ruleTexts.push(ruleText(rule));
      for (const premise of rule.premises) {
        if (visitedFactNames.has(premise)) continue;
        visitedFactNames.add(premise);
        visitConclusion({ kind: 'derived fact', name: premise });
      }
    }
  };
  visitConclusion(conclusion);
  return ruleTexts;
}

// A person clears an output by changing base facts whose change source is
// the author or a maintainer. The check takes each combination of base-fact
// values for which the output holds, and it looks for a combination for
// which the output does not hold and which has the same values of the base
// facts that only time changes.
function outputThatNoPersonCanClearViolations(ruleSet: RuleSet): RuleSetViolation[] {
  const violations: RuleSetViolation[] = [];
  const changeSourceOf = new Map(
    ruleSet.baseFacts.map((baseFact) => [baseFact.name, baseFact.changedBy]),
  );
  const isChangedByPerson = (name: string): boolean => changeSourceOf.get(name) !== 'time';
  for (const name of Object.values(OutputName)) {
    const output = { kind: 'output', name } as const;
    if (!ruleSet.rules.some((rule) => isSameConclusion(rule.conclusion, output))) continue;
    const affectingBaseFactNames = baseFactsAffecting(ruleSet.rules, output);
    const namesChangedByTime = affectingBaseFactNames.filter((name) => !isChangedByPerson(name));
    const combinations = allPossibleBaseFacts(affectingBaseFactNames);
    const verdicts = ruleSet.evaluateBaseFacts(combinations);
    const timeValuesThatAllowClearing = new Set<string>();
    combinations.forEach((baseFacts, index) => {
      if (!verdicts[index]!.outputsThatHold.includes(output.name)) {
        timeValuesThatAllowClearing.add(baseFactsText(baseFacts, namesChangedByTime));
      }
    });
    const index = combinations.findIndex(
      (baseFacts, at) =>
        verdicts[at]!.outputsThatHold.includes(output.name) &&
        !timeValuesThatAllowClearing.has(baseFactsText(baseFacts, namesChangedByTime)),
    );
    if (index >= 0) {
      violations.push({
        kind: 'output that no person can clear',
        rules: heldRuleTexts(ruleSet, verdicts[index]!, output),
        detail: `${output.name} holds for ${baseFactsText(combinations[index]!, affectingBaseFactNames)}, and it holds for every value of the base facts that the author or a maintainer can change (${affectingBaseFactNames.filter(isChangedByPerson).join(', ') || 'none'})`,
      });
    }
  }
  return violations;
}

function exclusiveOutputsThatBothHoldViolations(ruleSet: RuleSet): RuleSetViolation[] {
  const violations: RuleSetViolation[] = [];
  for (const [left, right] of ruleSet.exclusions) {
    const leftOutput = { kind: 'output', name: left } as const;
    const rightOutput = { kind: 'output', name: right } as const;
    const names = [
      ...new Set([
        ...baseFactsAffecting(ruleSet.rules, leftOutput),
        ...baseFactsAffecting(ruleSet.rules, rightOutput),
      ]),
    ];
    const combinations = allPossibleBaseFacts(names);
    const verdicts = ruleSet.evaluateBaseFacts(combinations);
    const index = verdicts.findIndex(
      (verdict) =>
        verdict.outputsThatHold.includes(left) && verdict.outputsThatHold.includes(right),
    );
    if (index >= 0) {
      violations.push({
        kind: 'exclusive outputs that both hold',
        rules: [
          ...new Set([
            ...heldRuleTexts(ruleSet, verdicts[index]!, leftOutput),
            ...heldRuleTexts(ruleSet, verdicts[index]!, rightOutput),
          ]),
        ],
        detail: `${left} and ${right} both hold for ${baseFactsText(combinations[index]!, names)}`,
      });
    }
  }
  return violations;
}

// A run can stop after it changed the labels and before it closed the pull
// request. The next run must derive the same plan from that state. The check
// therefore derives the plan of each combination again with the label ages
// that the first plan leaves: a label age does not hold once the plan keeps
// none of its labels.
function planThatDoesNotConvergeViolations(ruleSet: RuleSet): RuleSetViolation[] {
  const outputs = RECONCILER_OUTPUT_NAMES.filter((name) =>
    ruleSet.rules.some((rule) => isSameConclusion(rule.conclusion, { kind: 'output', name })),
  );
  const names = [
    ...new Set(
      outputs.flatMap((name) => baseFactsAffecting(ruleSet.rules, { kind: 'output', name })),
    ),
  ];
  const labelAges = ruleSet.baseFacts.filter(
    (baseFact) => baseFact.ageOf.length > 0 && names.includes(baseFact.name),
  );
  if (labelAges.length === 0) return [];
  const planOf = (verdict: Verdict): string =>
    outputs.filter((name) => verdict.outputsThatHold.includes(name)).join(', ');
  const combinations = allPossibleBaseFacts(names);
  const firstVerdicts = ruleSet.evaluateBaseFacts(combinations);
  const combinationsAfterLabels = combinations.map((baseFacts, index) => {
    const after = { ...baseFacts };
    for (const labelAge of labelAges) {
      const keepsLabel = labelAge.ageOf.some((label) =>
        firstVerdicts[index]!.outputsThatHold.includes(label),
      );
      if (!keepsLabel) after[labelAge.name] = false;
    }
    return after;
  });
  const secondVerdicts = ruleSet.evaluateBaseFacts(combinationsAfterLabels);
  const index = combinations.findIndex(
    (_, at) => planOf(firstVerdicts[at]!) !== planOf(secondVerdicts[at]!),
  );
  if (index < 0) return [];
  const changedLabelAges = labelAges
    .filter(({ name }) => combinations[index]![name] !== combinationsAfterLabels[index]![name])
    .map(({ name }) => name);
  return [
    {
      kind: 'plan that does not converge',
      rules: ruleSet.rules
        .filter(
          (rule) =>
            rule.premises.some((name) => changedLabelAges.includes(name)) &&
            firstVerdicts[index]!.rulesThatHold.includes(rule),
        )
        .map(ruleText),
      detail: `${baseFactsText(combinations[index]!, names)} gives the plan [${planOf(firstVerdicts[index]!)}], and after the labels of that plan are applied it gives [${planOf(secondVerdicts[index]!)}], because ${changedLabelAges.join(', ')} no longer holds`,
    },
  ];
}

function ruleThatNeverHoldsViolations(ruleSet: RuleSet): RuleSetViolation[] {
  const violations: RuleSetViolation[] = [];
  for (const conclusion of distinctConclusions(ruleSet.rules)) {
    const verdicts = ruleSet.evaluateBaseFacts(
      allPossibleBaseFacts(baseFactsAffecting(ruleSet.rules, conclusion)),
    );
    const rulesOfConclusion = ruleSet.rules.filter((rule) =>
      isSameConclusion(rule.conclusion, conclusion),
    );
    for (const rule of rulesOfConclusion) {
      if (!verdicts.some((verdict) => verdict.rulesThatHold.includes(rule))) {
        violations.push({
          kind: 'rule that never holds',
          rules: [ruleText(rule)],
          detail: `a rule for ${conclusion.name} holds for no values of the base facts`,
        });
      }
    }
    if (!verdicts.some((verdict) => conclusionHolds(verdict, conclusion))) {
      violations.push({
        kind: 'rule that never holds',
        rules: rulesOfConclusion.map(ruleText),
        detail: `${conclusion.name} holds for no values of the base facts`,
      });
    }
  }
  return violations;
}

// Each check that enumerates evaluates 2^n combinations for a conclusion that
// depends on n base facts, which took about 1 s for 18 base facts and 5 s
// for 20 on a laptop. Every consumer pays that time when it starts, so a
// conclusion that depends on about 20 base facts needs another way to be
// checked.
function enumeratedViolations(ruleSet: RuleSet): RuleSetViolation[] {
  return [
    ...exclusiveOutputsThatBothHoldViolations(ruleSet),
    ...outputThatNoPersonCanClearViolations(ruleSet),
    ...planThatDoesNotConvergeViolations(ruleSet),
    ...ruleThatNeverHoldsViolations(ruleSet),
  ];
}

// The enumeration assumes the structure that the first part checks, so it
// runs only on a rule set that passed it.
export function assertRuleSetIsValid(ruleSet: RuleSet): void {
  const violations = structuralViolations(ruleSet);
  if (violations.length === 0) violations.push(...enumeratedViolations(ruleSet));
  if (violations.length > 0) throw new InvalidRuleSetError(violations);
}
