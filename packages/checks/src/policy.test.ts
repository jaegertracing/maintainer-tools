import assert from 'node:assert/strict';
import test from 'node:test';

import { baseFactsByCheckId, CHECK_FACTS, ruleSet } from './policy.js';
import { CHECK_IDS } from './types.js';

test('the base fact of each check is the base fact that has the ID of the check as its name', () => {
  for (const id of CHECK_IDS) assert.equal(CHECK_FACTS[id].name, id);
});

test('a check ID without a base fact is rejected', () => {
  const baseFactsWithoutDcoMissing = ruleSet.baseFacts.filter(({ name }) => name !== 'dco_missing');
  assert.throws(
    () => baseFactsByCheckId(baseFactsWithoutDcoMissing),
    /the check dco_missing has no base fact/,
  );
});
