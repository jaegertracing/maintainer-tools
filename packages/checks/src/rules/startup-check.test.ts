import assert from 'node:assert/strict';
import test from 'node:test';

import { loadRuleSet } from './evaluate.js';
import { Policy } from './model.js';
import { assertRuleSetIsValid } from './startup-check.js';
import { InvalidRuleSetError } from './violations.js';
import type { RuleSetViolationKind } from './violations.js';

// A policy without a violation, with the facts that a seeded case reads.
// Each seeded case below adds one bad rule to the policy.
function validPolicy() {
  const policy = new Policy();
  const dcoMissing = policy.baseFact('dco_missing', () => true, { changedBy: 'author' });
  const ciFailing = policy.baseFact('ci_failing', () => true, { changedBy: 'author' });
  const labelOnlyFailure = policy.baseFact('label_only_failure', () => true, {
    changedBy: 'maintainer',
  });
  const quiet = policy.baseFact('quiet', () => true, { changedBy: 'author' });
  const monthOld = policy.baseFact('month_old', () => true, { changedBy: 'time' });
  const ciFailingNotLabelOnly = policy
    .derivedFact('ci_failing_not_label_only')
    .when(ciFailing)
    .unless(labelOnlyFailure);
  const blocked = policy.derivedFact('blocked').when(dcoMissing).when(ciFailingNotLabelOnly);
  policy.triageHidden.when(blocked).when(quiet, monthOld);
  policy.weeklyDigest.when(blocked);
  return { policy, labelOnlyFailure, monthOld, ciFailingNotLabelOnly, blocked };
}

interface SeededViolation {
  name: string;
  kind: RuleSetViolationKind;
  addBadRule: (valid: ReturnType<typeof validPolicy>) => void;
  // The seeded rule as the error names it.
  ruleInError: string;
}

const SEEDED_VIOLATIONS: readonly SeededViolation[] = [
  {
    name: 'a cycle through a veto',
    kind: 'dependency cycle',
    addBadRule: ({ ciFailingNotLabelOnly, blocked }) => ciFailingNotLabelOnly.unless(blocked),
    ruleInError: 'blocked ⇒ not ci_failing_not_label_only',
  },
  {
    name: 'an output that only time decides',
    kind: 'output that no person can clear',
    addBadRule: ({ policy, monthOld }) => policy.triageHidden.when(monthOld),
    ruleInError: 'month_old ⇒ triage_hidden',
  },
  {
    name: 'a rule that reads a derived fact without a rule',
    kind: 'rule that never holds',
    addBadRule: ({ policy }) => policy.triageHidden.when(policy.derivedFact('needs_issue')),
    ruleInError: 'needs_issue ⇒ triage_hidden',
  },
  {
    name: 'a rule that reads a fact of another policy',
    kind: 'rule that never holds',
    addBadRule: ({ policy }) =>
      policy.triageHidden.when(
        new Policy().baseFact('needs_issue', () => true, { changedBy: 'author' }),
      ),
    ruleInError: 'needs_issue ⇒ triage_hidden',
  },
  {
    name: 'a rule that holds for no values of the base facts',
    kind: 'rule that never holds',
    addBadRule: ({ policy, ciFailingNotLabelOnly, labelOnlyFailure }) =>
      policy.weeklyDigest.when(ciFailingNotLabelOnly, labelOnlyFailure),
    ruleInError: 'ci_failing_not_label_only ∧ label_only_failure ⇒ weekly_digest',
  },
];

test('the startup check accepts a rule set without a violation', () => {
  assertRuleSetIsValid(loadRuleSet(validPolicy().policy));
});

test('the startup check accepts a fact that no rule reads', () => {
  const policy = new Policy();
  const quiet = policy.baseFact('quiet', () => true, { changedBy: 'author' });
  policy.triageHidden.when(quiet);
  policy.baseFact('month_old', () => true, { changedBy: 'time' });
  policy.derivedFact('blocked').when(quiet);
  assertRuleSetIsValid(loadRuleSet(policy));
});

test('the startup check rejects a derived fact that never holds', () => {
  const policy = new Policy();
  const quiet = policy.baseFact('quiet', () => true, { changedBy: 'author' });
  policy.derivedFact('blocked').when(quiet).unless(quiet);
  assert.throws(
    () => assertRuleSetIsValid(loadRuleSet(policy)),
    (error: unknown) => {
      assert.ok(error instanceof InvalidRuleSetError);
      assert.deepEqual(error.violations, [
        {
          kind: 'rule that never holds',
          rules: ['quiet ⇒ blocked', 'quiet ⇒ not blocked'],
          detail: 'blocked holds for no values of the base facts',
        },
      ]);
      return true;
    },
  );
});

test('the startup check rejects an output whose one reason reads only base facts that time changes', () => {
  const policy = new Policy();
  const quiet = policy.baseFact('quiet', () => true, { changedBy: 'time' });
  const monthOld = policy.baseFact('month_old', () => true, { changedBy: 'time' });
  policy.triageHidden.when(monthOld, quiet);
  assert.throws(
    () => assertRuleSetIsValid(loadRuleSet(policy)),
    (error: unknown) => {
      assert.ok(error instanceof InvalidRuleSetError);
      assert.deepEqual(
        error.violations.map(({ kind, rules }) => ({ kind, rules })),
        [{ kind: 'output that no person can clear', rules: ['month_old ∧ quiet ⇒ triage_hidden'] }],
      );
      return true;
    },
  );
});

for (const seeded of SEEDED_VIOLATIONS) {
  test(`the startup check rejects ${seeded.name}`, () => {
    const valid = validPolicy();
    seeded.addBadRule(valid);
    assert.throws(
      () => assertRuleSetIsValid(loadRuleSet(valid.policy)),
      (error: unknown) => {
        assert.ok(error instanceof InvalidRuleSetError);
        const ofSeededKind = error.violations.filter((violation) => violation.kind === seeded.kind);
        assert.ok(
          ofSeededKind.some((violation) => violation.rules.includes(seeded.ruleInError)),
          `no "${seeded.kind}" names ${seeded.ruleInError} in:\n${error.message}`,
        );
        return true;
      },
    );
  });
}
