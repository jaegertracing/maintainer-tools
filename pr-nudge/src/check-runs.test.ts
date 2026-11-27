import assert from 'node:assert/strict';
import test from 'node:test';

import { type CheckId, type PullRequest, ruleSet } from '@jaegertracing/maintainer-tools-checks';

import { type NewCheckRun, newCheckRun } from './check-runs.js';

const NOW = new Date('2026-06-01T00:00:00Z');

function pullRequest(overrides: Partial<PullRequest>): PullRequest {
  return {
    author: { login: 'contributor', typename: 'User' },
    body: 'Fixes #12 by handling the empty case.',
    commits: [
      {
        sha: 'abc1234def',
        messageHeadline: 'Handle the empty case',
        messageBody: 'Signed-off-by: Contributor <contributor@example.com>',
        parents: 1,
      },
    ],
    files: [],
    comments: [],
    reviews: [],
    labels: [],
    mergeable: 'MERGEABLE',
    statusCheckRollup: 'SUCCESS',
    updatedAt: NOW.toISOString(),
    ...overrides,
  } as PullRequest;
}

interface Case {
  name: string;
  id: CheckId;
  pr: PullRequest;
  expected: NewCheckRun | undefined;
}

const CASES: readonly Case[] = [
  {
    name: 'success for a check whose fact does not hold',
    id: 'no_linked_issue',
    pr: pullRequest({}),
    expected: {
      name: 'maintainer-tools: no_linked_issue',
      conclusion: 'success',
      output: {
        title: 'PR references a linked issue',
        summary: 'PR references a linked issue',
        text: '',
      },
    },
  },
  {
    name: 'neutral for no_linked_issue when its fact holds',
    id: 'no_linked_issue',
    pr: pullRequest({ body: 'Handles the empty case.' }),
    expected: {
      name: 'maintainer-tools: no_linked_issue',
      conclusion: 'neutral',
      output: {
        title: 'PR does not reference an issue with `Fixes #N` / `Closes #N` / `Resolves #N`',
        summary: 'PR does not reference an issue with `Fixes #N` / `Closes #N` / `Resolves #N`',
        text: 'Add a line like `Fixes #1234` to the PR description so the linked issue closes on merge. Or apply a `docs`/`ci`/`trivial` label if the PR genuinely has no associated issue.',
      },
    },
  },
  {
    name: 'failure for dco_missing when its fact holds',
    id: 'dco_missing',
    pr: pullRequest({
      commits: [
        {
          sha: 'abc1234def',
          messageHeadline: 'Handle the empty case',
          messageBody: '',
          authorEmail: null,
          committedDate: NOW.toISOString(),
          parents: 1,
        },
      ],
    }),
    expected: {
      name: 'maintainer-tools: dco_missing',
      conclusion: 'failure',
      output: {
        title: 'DCO missing on 1 commit(s): abc1234',
        summary: 'DCO missing on 1 commit(s): abc1234',
        text: 'Each non-merge commit must include a `Signed-off-by: Name <email>` trailer. Run `git commit --amend -s` or `git rebase --signoff` and force-push.',
      },
    },
  },
  {
    name: 'nothing for no_linked_issue on a pull request with the missing-issue label',
    id: 'no_linked_issue',
    pr: pullRequest({ body: 'Handles the empty case.', labels: ['missing-issue'] }),
    expected: undefined,
  },
  {
    name: 'nothing for no_linked_issue on a pull request with an exempt label',
    id: 'no_linked_issue',
    pr: pullRequest({ body: 'Handles the empty case.', labels: ['docs'] }),
    expected: undefined,
  },
  {
    name: 'nothing for a check without a check run',
    id: 'ci_failing',
    pr: pullRequest({ statusCheckRollup: 'FAILURE' }),
    expected: undefined,
  },
];

for (const { name, id, pr, expected } of CASES) {
  test(`pr-nudge publishes ${name}`, () => {
    assert.deepEqual(newCheckRun(id, ruleSet.evaluate(pr, { now: NOW })), expected);
  });
}
