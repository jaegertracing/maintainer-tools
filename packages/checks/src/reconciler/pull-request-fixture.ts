// The pull request that the tests of the reconciler start from.

import type { OwnedLabel } from '../rules/model.js';
import type { LinkedIssue, PullRequest } from '../types.js';

export const NOW = new Date('2026-06-30T12:00:00Z');

export function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

export const approvedIssue: LinkedIssue = {
  owner: 'example',
  repo: 'repo',
  number: 100,
  state: 'OPEN',
  labels: ['help wanted'],
};
export const unapprovedIssue: LinkedIssue = { ...approvedIssue, number: 101, labels: ['bug'] };

// A pull request of an outside contributor that meets every policy: it
// links an approved issue, and its author pushed a day ago.
export function pullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    repo: { owner: 'example', name: 'repo' },
    number: 1,
    title: 'Fix the thing',
    url: 'https://github.com/example/repo/pull/1',
    author: { login: 'contributor', typename: 'User' },
    authorAssociation: 'CONTRIBUTOR',
    isDraft: false,
    mergeable: 'MERGEABLE',
    createdAt: daysAgo(20),
    updatedAt: daysAgo(1),
    labels: [],
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    files: ['src/example.ts'],
    statusCheckRollup: 'SUCCESS',
    commits: [
      {
        sha: 'abc1234',
        messageHeadline: 'Fix the thing',
        messageBody: 'Signed-off-by: Contributor <contributor@example.com>',
        authorEmail: 'contributor@example.com',
        authorLogin: 'contributor',
        committedDate: daysAgo(1),
        parents: 1,
      },
    ],
    reviewRequests: [],
    reviews: [],
    comments: [],
    linkedIssues: [approvedIssue],
    labelEvents: [],
    body: 'Closes #100',
    ...overrides,
  };
}

// The labels of a pull request that has carried each of them for `days`.
export function carrying(days: number, ...labels: OwnedLabel[]): Partial<PullRequest> {
  return {
    labels: [...labels],
    labelEvents: labels.map((label) => ({ label, event: 'labeled', at: daysAgo(days) })),
  };
}
