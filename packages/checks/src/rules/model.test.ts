import assert from 'node:assert/strict';
import test from 'node:test';

import { Policy } from './model.js';

const CHANGED_BY_AUTHOR = { changedBy: 'author' } as const;

test('a policy records its base facts and a chained definition as rules', () => {
  const policy = new Policy();
  const ciFailingPredicate = () => true;
  const labelOnlyFailure = policy.baseFact('label_only_failure', () => true, {
    changedBy: 'maintainer',
  });
  const ciFailing = policy.baseFact('ci_failing', ciFailingPredicate, CHANGED_BY_AUTHOR);
  const ciFailingNotLabelOnly = policy
    .derivedFact('ci_failing_not_label_only')
    .when(ciFailing)
    .unless(labelOnlyFailure);
  policy.triageHidden.when(ciFailingNotLabelOnly);
  policy.weeklyDigest.when(ciFailing, ciFailingNotLabelOnly).unless(labelOnlyFailure);

  const derivedFactConclusion = { kind: 'derived fact', name: 'ci_failing_not_label_only' };
  const triageHiddenConclusion = { kind: 'output', name: 'triage_hidden' };
  const weeklyDigestConclusion = { kind: 'output', name: 'weekly_digest' };
  assert.deepEqual(policy.rules, [
    { conclusion: derivedFactConclusion, premises: ['ci_failing'], isVeto: false },
    { conclusion: derivedFactConclusion, premises: ['label_only_failure'], isVeto: true },
    {
      conclusion: triageHiddenConclusion,
      premises: ['ci_failing_not_label_only'],
      isVeto: false,
    },
    {
      conclusion: weeklyDigestConclusion,
      premises: ['ci_failing', 'ci_failing_not_label_only'],
      isVeto: false,
    },
    { conclusion: weeklyDigestConclusion, premises: ['label_only_failure'], isVeto: true },
  ]);
  assert.deepEqual(
    policy.baseFacts.map(({ name, changedBy }) => ({ name, changedBy })),
    [
      { name: 'label_only_failure', changedBy: 'maintainer' },
      { name: 'ci_failing', changedBy: 'author' },
    ],
  );
  assert.equal(policy.baseFacts[1]!.predicate, ciFailingPredicate);
});

test('a policy refuses a fact name that is declared twice', () => {
  const policy = new Policy();
  policy.baseFact('ci_failing', () => true, CHANGED_BY_AUTHOR);
  assert.throws(
    () => policy.baseFact('ci_failing', () => false, CHANGED_BY_AUTHOR),
    /the fact ci_failing is declared twice/,
  );
  assert.throws(() => policy.derivedFact('ci_failing'), /the fact ci_failing is declared twice/);
});

// The types of the policy reject the mistakes below, so no runtime check
// looks for them. Each `@ts-expect-error` fails the type check of this file if the compiler
// stops reporting the mistake. The compiler checks the function, and no test
// calls it.
export function rejectedByCompiler(): void {
  const policy = new Policy();
  const ciFailing = policy.baseFact('ci_failing', () => true, CHANGED_BY_AUTHOR);
  const blocked = policy.derivedFact('blocked');

  // @ts-expect-error A rule cannot read an output.
  blocked.unless(policy.triageHidden);
  // @ts-expect-error A rule for an output cannot read an output.
  policy.weeklyDigest.when(policy.triageHidden);
  // @ts-expect-error A base fact has no rule.
  ciFailing.when(blocked);
  // @ts-expect-error A base fact has no rule.
  ciFailing.unless(blocked);
  // @ts-expect-error The function that records a rule is private to the policy.
  policy.recordRule;
  // @ts-expect-error Bracket access does not reach the function either.
  policy['recordRule'];
  // @ts-expect-error A derived fact does not expose the function.
  blocked['recordRule'];
  // @ts-expect-error An output does not expose the function.
  policy.triageHidden['recordRule'];
  // @ts-expect-error A base fact says who can change it.
  policy.baseFact('stale', () => true);
  // @ts-expect-error A reason needs at least one fact.
  blocked.when();
}
