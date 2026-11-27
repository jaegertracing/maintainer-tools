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
import { isSameConclusion, OutputName, ruleText } from './model.js';
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

  for (const rule of ruleSet.rules) {
    for (const name of rule.premises) {
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

// Each of the two checks evaluates 2^n combinations for a conclusion that
// depends on n base facts, which took about 1 s for 18 base facts and 5 s
// for 20 on a laptop. Every consumer pays that time when it starts, so a
// conclusion that depends on about 20 base facts needs another way to be
// checked.
function enumeratedViolations(ruleSet: RuleSet): RuleSetViolation[] {
  return [
    ...outputThatNoPersonCanClearViolations(ruleSet),
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
