// The violations that stop a rule set from being used. The evaluator reports
// a dependency cycle when it loads a policy, and the startup check reports
// the others.

export type RuleSetViolationKind =
  | 'dependency cycle'
  | 'rule that reads an output'
  | 'exclusive outputs that both hold'
  | 'output that no person can clear'
  | 'plan that does not converge'
  | 'rule that never holds';

// A violation is a defect that makes a rule set unusable.
export interface RuleSetViolation {
  kind: RuleSetViolationKind;
  // The rules involved, as `ruleText()` prints them.
  rules: string[];
  detail: string;
}

export class InvalidRuleSetError extends Error {
  constructor(readonly violations: RuleSetViolation[]) {
    super(
      violations
        .map(
          (violation) =>
            `${violation.kind}: ${violation.detail}\n  rules: ${violation.rules.join(' | ')}`,
        )
        .join('\n'),
    );
    this.name = 'InvalidRuleSetError';
  }
}
