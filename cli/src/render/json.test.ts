import assert from 'node:assert/strict';
import test from 'node:test';

import { type PullRequest, ruleSet } from '@jaegertracing/maintainer-tools-checks';

import type { ClassifiedPR } from '../buckets.js';
import { renderJson } from './json.js';

const NOW = new Date('2026-06-01T00:00:00Z');

function classifiedPR(repo: string, number: number): ClassifiedPR {
  const pr = {
    repo: { owner: 'example', name: repo },
    number,
    labels: [],
    commits: [],
    files: [],
    updatedAt: NOW.toISOString(),
  } as unknown as PullRequest;
  return { pr, bucket: 'fyi', verdict: ruleSet.evaluate(pr, { now: NOW }) } as ClassifiedPR;
}

interface Report {
  repos: { repo: string; pullRequests: { bucket: ClassifiedPR['bucket']; number: number }[] }[];
}

test('renderJson orders repositories by name and pull requests by number', () => {
  const input = [
    classifiedPR('b', 10),
    classifiedPR('a', 3),
    classifiedPR('b', 2),
    classifiedPR('a', 1),
  ];

  const report = renderJson(input);

  const decisions = (JSON.parse(report) as Report).repos.map(({ repo, pullRequests }) => ({
    repo,
    pullRequests: pullRequests.map(({ bucket, number }) => ({ bucket, number })),
  }));
  assert.deepEqual(decisions, [
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
  ]);
  assert.equal(renderJson([...input].reverse()), report);
});
