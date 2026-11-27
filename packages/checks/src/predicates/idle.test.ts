import assert from 'node:assert/strict';
import test from 'node:test';

import type { PredicateContext, PullRequest } from '../types.js';
import { quietPredicate } from './idle.js';

const NOW = new Date('2026-11-01T00:00:00Z');
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * MILLISECONDS_PER_DAY).toISOString();
}

// A pull request that was opened 90 days ago, with the one event of the case
// on it.
function isQuiet(event: Partial<Pick<PullRequest, 'comments' | 'reviews' | 'commits'>>): boolean {
  const pr = {
    createdAt: daysAgo(90),
    comments: [],
    reviews: [],
    commits: [],
    ...event,
  } as unknown as PullRequest;
  const quiet = quietPredicate(pr, { now: NOW } as PredicateContext);
  return typeof quiet === 'boolean' ? quiet : quiet.holds;
}

const quietCases: Array<[string, Parameters<typeof isQuiet>[0], boolean]> = [
  ['nothing happened after it was opened', {}, true],
  [
    'a person commented 60 days ago',
    { comments: [{ author: 'author', authorIsBot: false, createdAt: daysAgo(60), body: 'ping' }] },
    true,
  ],
  [
    'a person commented 59 days ago',
    { comments: [{ author: 'author', authorIsBot: false, createdAt: daysAgo(59), body: 'ping' }] },
    false,
  ],
  [
    'a bot commented yesterday',
    { comments: [{ author: 'codecov', authorIsBot: true, createdAt: daysAgo(1), body: 'report' }] },
    true,
  ],
  [
    'a maintainer posted a policy comment yesterday',
    {
      comments: [
        {
          author: 'maintainer',
          authorIsBot: false,
          createdAt: daysAgo(1),
          body: '<!-- jaeger-pr-linked-issue -->\nThis PR links no approved issue.',
        },
      ],
    },
    true,
  ],
  [
    'a person reviewed it yesterday',
    {
      reviews: [
        { author: 'maintainer', authorIsBot: false, state: 'COMMENTED', submittedAt: daysAgo(1) },
      ],
    },
    false,
  ],
  [
    'a bot reviewed it yesterday',
    {
      reviews: [
        { author: 'copilot', authorIsBot: true, state: 'COMMENTED', submittedAt: daysAgo(1) },
      ],
    },
    true,
  ],
  [
    'a commit was made yesterday',
    { commits: [{ committedDate: daysAgo(1) }] } as Parameters<typeof isQuiet>[0],
    false,
  ],
];

for (const [history, event, expected] of quietCases) {
  test(`a pull request on which ${history} is ${expected ? '' : 'not '}quiet`, () => {
    assert.equal(isQuiet(event), expected);
  });
}

test('the config sets the number of days after which a pull request is quiet', () => {
  const pr = { createdAt: daysAgo(40), comments: [], reviews: [], commits: [] };
  const quiet = (idleDays: number): unknown =>
    quietPredicate(pr as unknown as PullRequest, { now: NOW, ages: { idleDays } });
  assert.partialDeepStrictEqual(quiet(30), {
    holds: true,
    summary: 'No person has acted on the PR for 40 days (threshold: 30)',
  });
  assert.partialDeepStrictEqual(quiet(41), { holds: false });
});
