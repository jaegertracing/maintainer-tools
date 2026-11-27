import assert from 'node:assert/strict';
import test from 'node:test';

import type { LabelEvent, PredicateContext, PullRequest } from '../types.js';
import { labelPeriodStart, Policy } from './model.js';

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

const NOW = new Date('2026-06-30T12:00:00Z');

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function labelEvent(label: string, event: LabelEvent['event'], days: number): LabelEvent {
  return {
    label,
    event,
    at: daysAgo(days),
  };
}

const FLAG_LABELS = ['missing-issue', 'unapproved-issue'];

const labelPeriodCases: Array<[string, string[], LabelEvent[], string | undefined]> = [
  ['carries none of the labels', [], [labelEvent('missing-issue', 'labeled', 9)], undefined],
  ['carries a label that no event dates', ['missing-issue'], [], undefined],
  [
    'has carried one label since it was applied',
    ['missing-issue'],
    [labelEvent('missing-issue', 'labeled', 9)],
    daysAgo(9),
  ],
  [
    'lost the label and got it again',
    ['missing-issue'],
    [
      labelEvent('missing-issue', 'labeled', 9),
      labelEvent('missing-issue', 'unlabeled', 5),
      labelEvent('missing-issue', 'labeled', 2),
    ],
    daysAgo(2),
  ],
  [
    'got the second label before it lost the first',
    ['unapproved-issue'],
    [
      labelEvent('missing-issue', 'labeled', 9),
      labelEvent('unapproved-issue', 'labeled', 3),
      labelEvent('missing-issue', 'unlabeled', 3),
    ],
    daysAgo(9),
  ],
  [
    'got the first label before the oldest gathered event',
    ['unapproved-issue'],
    [labelEvent('unapproved-issue', 'labeled', 3), labelEvent('missing-issue', 'unlabeled', 3)],
    undefined,
  ],
  [
    'carries a label of another group that is older',
    ['missing-issue', 'stale'],
    [labelEvent('stale', 'labeled', 20), labelEvent('missing-issue', 'labeled', 4)],
    daysAgo(4),
  ],
];

for (const [history, labels, labelEvents, expected] of labelPeriodCases) {
  test(`the label period of a pull request that ${history}`, () => {
    const pr = { labels, labelEvents } as PullRequest;
    assert.equal(labelPeriodStart(pr, FLAG_LABELS), expected);
  });
}

test('a label age holds from the day on which the label is old enough', () => {
  const policy = new Policy();
  const flagLabelOld = policy.labelAge('flag_label_old', {
    of: [policy.label('missing-issue'), policy.label('unapproved-issue')],
    days: () => 7,
  });
  const holds = (days: number): boolean =>
    flagLabelOld.predicate(
      {
        labels: ['missing-issue'],
        labelEvents: [labelEvent('missing-issue', 'labeled', days)],
      } as PullRequest,
      { now: NOW } as PredicateContext,
    ) === true;

  assert.deepEqual([holds(6), holds(7)], [false, true]);
  assert.throws(
    () => policy.labelAge('close_old', { of: [policy.close], days: () => 7 }),
    /the label age close_old measures an output that is not a label/,
  );
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
