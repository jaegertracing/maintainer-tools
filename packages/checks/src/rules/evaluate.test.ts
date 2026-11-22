import assert from 'node:assert/strict';
import test from 'node:test';

import type { PullRequest } from '../types.js';
import { loadRuleSet, supportingFacts } from './evaluate.js';
import type { Verdict } from './evaluate.js';
import { OutputName, Policy } from './model.js';
import type { Conclusion } from './model.js';

const NOW = { now: new Date('2026-06-01T00:00:00Z') };

const CI_FAILING_NOT_LABEL_ONLY: Conclusion = {
  kind: 'derived fact',
  name: 'ci_failing_not_label_only',
};
const TRIAGE_HIDDEN: Conclusion = { kind: 'output', name: OutputName.TriageHidden };
const WEEKLY_DIGEST: Conclusion = { kind: 'output', name: OutputName.WeeklyDigest };

function pullRequest(labels: string[]): PullRequest {
  return { labels } as PullRequest;
}

// `ci_failing` holds on the label `ci-failing`, and the label `label-gate`
// marks the failure as one that the author cannot fix.
function ruleSet() {
  const policy = new Policy();
  const ciFailing = policy.baseFact(
    'ci_failing',
    (pr) => {
      const holds = pr.labels.includes('ci-failing');
      return {
        holds,
        summary: holds ? 'CI is failing' : 'CI is passing',
        details: holds ? 'Fix the build.' : undefined,
      };
    },
    { changedBy: 'author' },
  );
  const labelOnlyFailure = policy.baseFact(
    'label_only_failure',
    (pr) => pr.labels.includes('label-gate'),
    { changedBy: 'maintainer' },
  );
  const stale = policy.baseFact(
    'stale',
    (pr, { now }) => pr.labels.includes('stale') && now.getTime() > 0,
    { changedBy: 'author' },
  );
  const ciFailingNotLabelOnly = policy
    .derivedFact('ci_failing_not_label_only')
    .when(ciFailing)
    .unless(labelOnlyFailure);
  policy.triageHidden.when(ciFailingNotLabelOnly).when(stale);
  policy.weeklyDigest.when(ciFailing).unless(labelOnlyFailure);
  return loadRuleSet(policy);
}

test('a fact or an output holds when a reason holds and no veto does', () => {
  const verdict = ruleSet().evaluate(pullRequest(['ci-failing', 'stale']), NOW);
  assert.deepEqual(verdict.factsThatHold, ['ci_failing', 'stale', 'ci_failing_not_label_only']);
  assert.deepEqual(verdict.outputsThatHold, ['triage_hidden', 'weekly_digest']);
  assert.deepEqual(verdict.reasons(CI_FAILING_NOT_LABEL_ONLY), ['ci_failing']);
  assert.deepEqual(verdict.reasons(TRIAGE_HIDDEN), ['ci_failing_not_label_only', 'stale']);
  assert.deepEqual(verdict.reasons(WEEKLY_DIGEST), ['ci_failing']);
  assert.deepEqual(
    verdict.rulesThatHold.filter((rule) => rule.isVeto),
    [],
  );
});

test('a veto wins over a reason, and the verdict names both', () => {
  const verdict = ruleSet().evaluate(pullRequest(['ci-failing', 'label-gate']), NOW);
  assert.deepEqual(verdict.factsThatHold, ['ci_failing', 'label_only_failure']);
  assert.deepEqual(verdict.outputsThatHold, []);
  assert.deepEqual(verdict.reasons(CI_FAILING_NOT_LABEL_ONLY), ['ci_failing']);
  assert.deepEqual(verdict.reasons(TRIAGE_HIDDEN), []);
  assert.deepEqual(verdict.reasons(WEEKLY_DIGEST), ['ci_failing']);
  assert.deepEqual(verdict.vetoes(CI_FAILING_NOT_LABEL_ONLY), ['label_only_failure']);
  assert.deepEqual(verdict.vetoes(TRIAGE_HIDDEN), []);
  assert.deepEqual(verdict.vetoes(WEEKLY_DIGEST), ['label_only_failure']);
});

test('a fact with the name of an output is not that output', () => {
  const policy = new Policy();
  const triageHiddenFact = policy.baseFact('triage_hidden', () => true, { changedBy: 'author' });
  const stale = policy.baseFact('stale', () => false, { changedBy: 'author' });
  policy.derivedFact('weekly_digest').when(triageHiddenFact);
  policy.triageHidden.when(stale);
  policy.weeklyDigest.when(stale);
  const verdict = loadRuleSet(policy).evaluate(pullRequest([]), NOW);
  assert.deepEqual(verdict.factsThatHold, ['triage_hidden', 'weekly_digest']);
  assert.deepEqual(verdict.outputsThatHold, []);
  assert.equal(verdict.holds(triageHiddenFact), true);
  assert.deepEqual(verdict.reasons({ kind: 'derived fact', name: 'weekly_digest' }), [
    'triage_hidden',
  ]);
  assert.deepEqual(verdict.reasons(WEEKLY_DIGEST), []);
});

test('an output with the name of a fact is not that fact', () => {
  const policy = new Policy();
  const triageHiddenFact = policy.baseFact('triage_hidden', () => false, { changedBy: 'author' });
  const stale = policy.baseFact('stale', () => true, { changedBy: 'author' });
  policy.triageHidden.when(stale);
  policy.weeklyDigest.when(triageHiddenFact);
  const verdict = loadRuleSet(policy).evaluate(pullRequest([]), NOW);
  assert.deepEqual(verdict.factsThatHold, ['stale']);
  assert.deepEqual(verdict.outputsThatHold, ['triage_hidden']);
  assert.equal(verdict.holds(triageHiddenFact), false);
  assert.equal(verdict.holds(stale), true);
  assert.deepEqual(verdict.reasons(WEEKLY_DIGEST), []);
});

// `Verdict.holds()` rejects the calls below. Each `@ts-expect-error` fails
// the type check of this file if the compiler stops reporting the mistake.
// The compiler checks the function, and no test calls it.
export function holdsRejectedByCompiler(verdict: Verdict, policy: Policy): void {
  // @ts-expect-error `holds()` takes a fact and not the name of one.
  verdict.holds('ci_failing');
  // @ts-expect-error An output is not a fact.
  verdict.holds(policy.triageHidden);
}

test('a verdict has the summary and the details that a predicate returned', () => {
  const verdict = ruleSet().evaluate(pullRequest(['ci-failing']), NOW);
  assert.equal(verdict.summary('ci_failing'), 'CI is failing');
  assert.equal(verdict.details('ci_failing'), 'Fix the build.');
});

test('a verdict has the summary of a base fact that does not hold', () => {
  const verdict = ruleSet().evaluate(pullRequest([]), NOW);
  assert.deepEqual(verdict.factsThatHold, []);
  assert.equal(verdict.summary('ci_failing'), 'CI is passing');
  assert.equal(verdict.details('ci_failing'), undefined);
});

test('a verdict has no summary of a fact whose predicate returned a boolean', () => {
  const verdict = ruleSet().evaluate(pullRequest(['stale']), NOW);
  assert.equal(verdict.summary('stale'), undefined);
  assert.equal(verdict.summary('ci_failing_not_label_only'), undefined);
});

test('base facts are evaluated like a pull request that has those values', () => {
  const [verdict] = ruleSet().evaluateBaseFacts([{ ci_failing: true, stale: false }]);
  assert.deepEqual(verdict!.factsThatHold, ['ci_failing', 'ci_failing_not_label_only']);
  assert.deepEqual(verdict!.outputsThatHold, ['triage_hidden', 'weekly_digest']);
  assert.equal(verdict!.summary('ci_failing'), undefined);
});

test('a rule is evaluated after the rules of the derived fact that it reads', () => {
  const policy = new Policy();
  const stale = policy.baseFact('stale', () => true, { changedBy: 'author' });
  const blocked = policy.derivedFact('blocked');
  policy.triageHidden.when(blocked);
  blocked.when(stale);
  const verdict = loadRuleSet(policy).evaluate(pullRequest([]), NOW);
  assert.deepEqual(verdict.factsThatHold, ['stale', 'blocked']);
  assert.deepEqual(verdict.outputsThatHold, ['triage_hidden']);
});

// Only `ci_failing` has a summary.
const SUPPORTING_FACTS_CASES: readonly { name: string; labels: string[]; expected: string[] }[] = [
  {
    name: 'a base fact with a summary that a derived fact holds by',
    labels: ['ci-failing', 'stale'],
    expected: ['ci_failing'],
  },
  {
    name: 'no fact when the output does not hold',
    labels: ['ci-failing', 'label-gate'],
    expected: [],
  },
  {
    name: 'no fact behind a reason that a veto stopped',
    labels: ['ci-failing', 'label-gate', 'stale'],
    expected: [],
  },
];

for (const { name, labels, expected } of SUPPORTING_FACTS_CASES) {
  test(`supportingFacts returns ${name}`, () => {
    const verdict = ruleSet().evaluate(pullRequest(labels), NOW);
    assert.deepEqual(supportingFacts(verdict, OutputName.TriageHidden), expected);
  });
}
