// This file evaluates a policy. It orders the derived facts so that each
// follows the derived facts that its rules read. It decides every derived
// fact in one pass over that order, and then it decides every output.

import type { PullRequest, ResolvedPredicateOptions } from '../types.js';
import { isSameConclusion, premiseText, ruleText } from './model.js';
import type {
  BaseFact,
  BaseFactValue,
  Conclusion,
  Fact,
  OutputName,
  Policy,
  Rule,
} from './model.js';
import { InvalidRuleSetError } from './violations.js';

// The values of the base facts of one pull request, by the name of the fact.
// The pull request is a real one, or a hypothetical one that the startup
// check makes up to enumerate what the rules decide.
export type BaseFacts = Record<string, boolean>;

// A verdict is the result of a rule set for one pull request. It names the
// facts that hold and the outputs that hold, and it lists the rules that
// hold. `reasons()` and `vetoes()` return the premise texts of the reasons
// and of the vetoes that held for a conclusion.
export class Verdict {
  readonly factsThatHold: string[] = [];
  readonly outputsThatHold: OutputName[] = [];
  readonly rulesThatHold: Rule[] = [];

  constructor(
    private readonly printedValues: ReadonlyMap<string, Exclude<BaseFactValue, boolean>>,
  ) {}

  // `holds()` takes a fact object and not a name, so that a misspelled name
  // does not compile. It compares by name, so the fact must belong to the
  // policy of this verdict. A caller finds an output by its `OutputName` in
  // `outputsThatHold`.
  holds(fact: Fact): boolean {
    return this.factsThatHold.includes(fact.name);
  }

  reasons(conclusion: Conclusion): string[] {
    return this.rulesThatHold
      .filter((rule) => !rule.isVeto && isSameConclusion(rule.conclusion, conclusion))
      .map(premiseText);
  }

  vetoes(conclusion: Conclusion): string[] {
    return this.rulesThatHold
      .filter((rule) => rule.isVeto && isSameConclusion(rule.conclusion, conclusion))
      .map(premiseText);
  }

  // The summary of a base fact whose predicate returned one, whether the
  // fact holds or not. A hypothetical pull request has none.
  summary(factName: string): string | undefined {
    return this.printedValues.get(factName)?.summary;
  }

  details(factName: string): string | undefined {
    return this.printedValues.get(factName)?.details;
  }
}

// A rule set is a policy that `loadRuleSet()` has loaded for evaluation.
export interface RuleSet {
  readonly rules: readonly Rule[];
  readonly baseFacts: readonly BaseFact[];
  // Evaluates the rules once for each element. A base fact that an element
  // leaves out is false.
  evaluateBaseFacts(hypotheticalPullRequests: readonly BaseFacts[]): Verdict[];
  evaluate(pr: PullRequest, opts: ResolvedPredicateOptions): Verdict;
}

interface Decision {
  holds: boolean;
  rulesThatHold: Rule[];
}

export function decideConclusion(
  rules: readonly Rule[],
  conclusion: Conclusion,
  factHolds: (name: string) => boolean,
): Decision {
  const rulesThatHold = rules.filter(
    (rule) => isSameConclusion(rule.conclusion, conclusion) && rule.premises.every(factHolds),
  );
  const hasReason = rulesThatHold.some((rule) => !rule.isVeto);
  const hasVeto = rulesThatHold.some((rule) => rule.isVeto);
  return { holds: hasReason && !hasVeto, rulesThatHold };
}

export function derivedFactNamesWithRule(rules: readonly Rule[]): Set<string> {
  return new Set(
    rules
      .filter((rule) => rule.conclusion.kind === 'derived fact')
      .map((rule) => rule.conclusion.name),
  );
}

// The derived facts that the rules of the derived fact `name` read, each
// with the rules that read it.
function derivedFactsReadBy(rules: readonly Rule[], name: string): Map<string, Rule[]> {
  const derivedFactNames = derivedFactNamesWithRule(rules);
  const readDerivedFactNames = new Map<string, Rule[]>();
  for (const rule of rules.filter((candidate) =>
    isSameConclusion(candidate.conclusion, { kind: 'derived fact', name }),
  )) {
    for (const premise of rule.premises.filter((premise) => derivedFactNames.has(premise))) {
      readDerivedFactNames.set(premise, [...(readDerivedFactNames.get(premise) ?? []), rule]);
    }
  }
  return readDerivedFactNames;
}

// Orders the derived facts so that each follows the derived facts that its
// rules read, and throws an `InvalidRuleSetError` when no such order exists.
// The outputs need no order, because no rule reads one.
export function derivedFactOrder(rules: readonly Rule[]): string[] {
  const order: string[] = [];
  const orderedDerivedFactNames = new Set<string>();
  const path: string[] = [];
  const visitDerivedFact = (name: string): void => {
    if (orderedDerivedFactNames.has(name)) return;
    if (path.includes(name)) {
      const cycle = [...path.slice(path.indexOf(name)), name];
      const rulesOnCycle = cycle
        .slice(0, -1)
        .flatMap((from, index) => derivedFactsReadBy(rules, from).get(cycle[index + 1]!) ?? []);
      throw new InvalidRuleSetError([
        {
          kind: 'dependency cycle',
          rules: [...new Set(rulesOnCycle.map(ruleText))],
          detail: cycle.join(' reads '),
        },
      ]);
    }
    path.push(name);
    for (const readDerivedFact of derivedFactsReadBy(rules, name).keys()) {
      visitDerivedFact(readDerivedFact);
    }
    path.pop();
    orderedDerivedFactNames.add(name);
    order.push(name);
  };
  for (const name of derivedFactNamesWithRule(rules)) visitDerivedFact(name);
  return order;
}

export function loadRuleSet(policy: Policy): RuleSet {
  const { rules, baseFacts } = policy;
  const derivedFactNames = derivedFactOrder(rules);
  const outputs = new Set(
    rules.flatMap(({ conclusion }) => (conclusion.kind === 'output' ? [conclusion.name] : [])),
  );

  const deriveVerdict = (values: Map<string, boolean>, verdict: Verdict): Verdict => {
    const factHolds = (name: string): boolean => values.get(name) ?? false;
    for (const { name } of baseFacts) {
      if (factHolds(name)) verdict.factsThatHold.push(name);
    }
    for (const name of derivedFactNames) {
      const decision = decideConclusion(rules, { kind: 'derived fact', name }, factHolds);
      values.set(name, decision.holds);
      if (decision.holds) verdict.factsThatHold.push(name);
      verdict.rulesThatHold.push(...decision.rulesThatHold);
    }
    for (const name of outputs) {
      const decision = decideConclusion(rules, { kind: 'output', name }, factHolds);
      if (decision.holds) verdict.outputsThatHold.push(name);
      verdict.rulesThatHold.push(...decision.rulesThatHold);
    }
    return verdict;
  };

  return {
    rules,
    baseFacts,

    evaluateBaseFacts(hypotheticalPullRequests: readonly BaseFacts[]): Verdict[] {
      return hypotheticalPullRequests.map((values) =>
        deriveVerdict(new Map(Object.entries(values)), new Verdict(new Map())),
      );
    },

    evaluate(pr: PullRequest, opts: ResolvedPredicateOptions): Verdict {
      const values = new Map<string, boolean>();
      const printedValues = new Map<string, Exclude<BaseFactValue, boolean>>();
      for (const { name, predicate } of baseFacts) {
        const value = predicate(pr, opts);
        if (typeof value === 'boolean') {
          values.set(name, value);
        } else {
          values.set(name, value.holds);
          printedValues.set(name, value);
        }
      }
      return deriveVerdict(values, new Verdict(printedValues));
    },
  };
}
