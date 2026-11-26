import assert from 'node:assert/strict';
import test from 'node:test';

import type { PullRequest } from '@jaegertracing/maintainer-tools-checks';

import type { ClassifiedPR } from '../buckets.js';
import { renderJson } from './json.js';

function classifiedPR(repo: string, number: number): ClassifiedPR {
  const pr = { repo: { owner: 'example', name: repo }, number } as PullRequest;
  return { pr, bucket: 'fyi' } as ClassifiedPR;
}

test('renderJson orders repositories by name and pull requests by number', () => {
  const input = [
    classifiedPR('b', 10),
    classifiedPR('a', 3),
    classifiedPR('b', 2),
    classifiedPR('a', 1),
  ];

  const report = renderJson(input);

  assert.deepEqual(JSON.parse(report), {
    repos: [
      {
        repo: 'example/a',
        pullRequests: [
          { bucket: 'fyi', number: 1 },
          { bucket: 'fyi', number: 3 },
        ],
      },
      {
        repo: 'example/b',
        pullRequests: [
          { bucket: 'fyi', number: 2 },
          { bucket: 'fyi', number: 10 },
        ],
      },
    ],
  });
  assert.equal(renderJson([...input].reverse()), report);
});
