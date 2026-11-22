import assert from 'node:assert/strict';
import test from 'node:test';

import { digestItems } from './digest.js';
import type { PullRequest } from './types.js';

const NOW = new Date('2026-06-01T00:00:00Z');

function pullRequest(overrides: Partial<PullRequest>): PullRequest {
  return {
    author: { login: 'contributor', typename: 'User' },
    body: 'A description that is long enough to count as one.',
    commits: [{ sha: 'abc1234def', messageHeadline: 'Add a feature', messageBody: '', parents: 1 }],
    files: ['pkg/feature.go'],
    labels: [],
    mergeable: 'MERGEABLE',
    statusCheckRollup: 'SUCCESS',
    updatedAt: NOW.toISOString(),
    ...overrides,
  } as PullRequest;
}

const CASES: readonly { name: string; pr: PullRequest; expected: string[] }[] = [
  {
    name: 'each fact that the digest holds by, in the order of the rules',
    pr: pullRequest({ statusCheckRollup: 'FAILURE' }),
    expected: [
      'DCO missing on 1 commit(s): abc1234',
      'CI status rollup is FAILURE',
      'PR does not reference an issue with `Fixes #N` / `Closes #N` / `Resolves #N`',
      '1 source file(s) changed but no tests were added or modified',
    ],
  },
  {
    name: 'no CI failure of a label gate alone, nor a missing issue under the `missing-issue` label',
    pr: pullRequest({
      statusCheckRollup: 'FAILURE',
      headCheckRuns: [{ name: 'check-label', conclusion: 'failure' }],
      labels: ['missing-issue'],
    }),
    expected: [
      'DCO missing on 1 commit(s): abc1234',
      '1 source file(s) changed but no tests were added or modified',
    ],
  },
];

for (const { name, pr, expected } of CASES) {
  test(`the digest lists ${name}`, () => {
    assert.deepEqual(digestItems(pr, NOW), expected);
  });
}
