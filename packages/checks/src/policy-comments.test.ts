import assert from 'node:assert/strict';
import test from 'node:test';

import { isPolicyComment } from './policy-comments.js';

const policyCommentCases: Array<[string, string, boolean]> = [
  [
    'a comment with the marker of pr-linked-issue',
    '<!-- jaeger-pr-linked-issue -->\nThis PR is not linked to an issue.',
    true,
  ],
  [
    'a comment with the marker of pr-duplicates',
    'Another PR closes this issue.\n<!-- jaeger-pr-per-issue-limit -->',
    true,
  ],
  [
    'a comment that quotes the stale notice',
    '> This pull request has been automatically marked as stale.\nI am still working on it.',
    false,
  ],
  ['a comment with another marker', '<!-- ci-summary-report -->\nCI summary', false],
  ['a comment without a marker', 'Thanks, I pushed a fix for the stale cache.', false],
];

for (const [comment, body, expected] of policyCommentCases) {
  test(`${comment} is ${expected ? '' : 'not '}a policy comment`, () => {
    assert.equal(isPolicyComment(body), expected);
  });
}
