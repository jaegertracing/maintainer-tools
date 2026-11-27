import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createGraphqlClient } from '@jaegertracing/maintainer-tools-checks';
import { retryRequest } from '../../packages/checks/src/retry.js';

test('GraphQL retries a GOAWAY transport failure and returns the response', async (t) => {
  const requests: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: { body: unknown }) => {
    requests.push(init.body);
    if (requests.length === 1) {
      throw new Error('HTTP/2: "GOAWAY" frame received with code 0');
    }
    return new Response(JSON.stringify({ data: { viewer: { login: 'maintainer' } } }), {
      headers: { 'content-type': 'application/json' },
    });
  });
  assert.equal(await createGraphqlClient('test-token').fetchViewerLogin(), 'maintainer');
  assert.equal(requests.length, 2);
  assert.equal(requests[0], requests[1]);
});

for (const status of [500, 502, 503, 504]) {
  test(`retries status ${status} with bounded backoff and preserves the final error`, async () => {
    const error = Object.assign(new Error('unavailable'), { status });
    let attempts = 0;
    const delays: number[] = [];
    await assert.rejects(
      retryRequest(
        async () => {
          attempts++;
          throw error;
        },
        async (delay) => {
          delays.push(delay);
        },
      ),
      (actual) => actual === error,
    );
    assert.equal(attempts, 3);
    assert.deepEqual(delays, [1000, 2000]);
  });
}

for (const error of [
  ...[400, 401, 403, 404, 422, 429].map((status) =>
    Object.assign(new Error('rejected'), { status }),
  ),
  new Error('GraphQL validation failed'),
  Object.assign(new Error('aborted'), { name: 'AbortError', status: 500 }),
]) {
  test(`does not retry ${error.name}: ${'status' in error ? error.status : error.message}`, async () => {
    let attempts = 0;
    await assert.rejects(
      retryRequest(
        async () => {
          attempts++;
          throw error;
        },
        async () => {
          assert.fail('must not sleep');
        },
      ),
      (actual) => actual === error,
    );
    assert.equal(attempts, 1);
  });
}

// mockGraphqlResponses() replaces `fetch` so that each GraphQL request
// receives the next entry of `responses`. It returns the variables of the
// requests, in the order in which they were sent.
function mockGraphqlResponses(t: TestContext, responses: unknown[]): Record<string, unknown>[] {
  const variablesOfRequests: Record<string, unknown>[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: { body: string }) => {
    const response = responses[variablesOfRequests.length];
    variablesOfRequests.push(JSON.parse(init.body).variables);
    return new Response(JSON.stringify({ data: response }), {
      headers: { 'content-type': 'application/json' },
    });
  });
  return variablesOfRequests;
}

test('a pull request carries its linked issues, the text of a comment only when it is a policy comment, and the login of the author of each commit', async (t) => {
  const noNodes = { nodes: [] };
  const commitNode = (oid: string, author: object | null) => ({
    commit: {
      oid,
      messageHeadline: 'Fix the thing',
      messageBody: '',
      committedDate: '2026-09-10T08:00:00Z',
      author,
      statusCheckRollup: null,
      parents: { totalCount: 1 },
    },
  });
  mockGraphqlResponses(t, [
    {
      repository: {
        pullRequest: {
          number: 7,
          title: 'Fix the thing',
          url: 'https://github.com/example/repo/pull/7',
          isDraft: false,
          mergeable: 'MERGEABLE',
          createdAt: '2026-09-10T08:00:00Z',
          updatedAt: '2026-09-18T08:00:00Z',
          additions: 1,
          deletions: 0,
          changedFiles: 1,
          authorAssociation: 'CONTRIBUTOR',
          author: { login: 'contributor', __typename: 'User' },
          body: 'Resolves #3',
          labels: noNodes,
          files: noNodes,
          reviewRequests: noNodes,
          reviews: {
            nodes: [
              {
                author: { login: 'copilot-pull-request-reviewer', __typename: 'Bot' },
                state: 'COMMENTED',
                submittedAt: '2026-09-11T09:00:00Z',
                url: 'https://github.com/example/repo/pull/7#pullrequestreview-1',
                body: '',
              },
              {
                author: { login: 'maintainer', __typename: 'User' },
                state: 'CHANGES_REQUESTED',
                submittedAt: '2026-09-11T10:00:00Z',
                url: 'https://github.com/example/repo/pull/7#pullrequestreview-2',
                body: '',
              },
              {
                author: null,
                state: 'COMMENTED',
                submittedAt: '2026-09-11T11:00:00Z',
                url: 'https://github.com/example/repo/pull/7#pullrequestreview-3',
                body: '',
              },
            ],
          },
          reviewThreads: {
            totalCount: 0,
            pageInfo: { hasNextPage: false, endCursor: null },
            ...noNodes,
          },
          comments: {
            nodes: [
              {
                id: 'IC_1',
                author: { login: 'maintainer', __typename: 'User' },
                createdAt: '2026-09-11T08:00:00Z',
                body: '<!-- jaeger-pr-linked-issue -->\nThis PR links no approved issue.',
                isMinimized: true,
              },
              {
                id: 'IC_2',
                author: { login: 'contributor', __typename: 'User' },
                createdAt: '2026-09-12T08:00:00Z',
                body: 'I linked the issue.',
                isMinimized: false,
              },
              {
                id: 'IC_3',
                author: { login: 'github-actions', __typename: 'Bot' },
                createdAt: '2026-09-13T08:00:00Z',
                body: 'This PR is currently **on hold**.',
                isMinimized: false,
              },
            ],
          },
          timelineItems: {
            nodes: [
              {
                __typename: 'LabeledEvent',
                createdAt: '2026-09-11T08:00:00Z',
                label: { name: 'missing-issue' },
              },
              {
                __typename: 'UnlabeledEvent',
                createdAt: '2026-09-12T09:00:00Z',
                label: { name: 'missing-issue' },
              },
            ],
          },
          closingIssuesReferences: {
            nodes: [
              {
                number: 3,
                state: 'OPEN',
                title: 'The thing is broken',
                author: { login: 'reporter' },
                repository: { name: 'repo', owner: { login: 'example' } },
                labels: { nodes: [{ name: 'help wanted' }, { name: 'bug' }] },
              },
              {
                number: 4,
                state: 'CLOSED',
                title: 'An issue of a deleted account',
                author: null,
                repository: { name: 'repo', owner: { login: 'example' } },
                labels: { nodes: [] },
              },
            ],
          },
          commits: {
            nodes: [
              commitNode('a1', { email: 'c@example.com', user: { login: 'contributor' } }),
              commitNode('b2', { email: 'unknown@example.com', user: null }),
              commitNode('c3', null),
            ],
          },
          headCommit: noNodes,
        },
      },
    },
  ]);

  const pr = await createGraphqlClient('test-token').fetchPullRequest('example', 'repo', 7);

  assert.deepEqual(pr.linkedIssues, [
    {
      owner: 'example',
      repo: 'repo',
      number: 3,
      state: 'OPEN',
      title: 'The thing is broken',
      author: 'reporter',
      labels: ['help wanted', 'bug'],
    },
    {
      owner: 'example',
      repo: 'repo',
      number: 4,
      state: 'CLOSED',
      title: 'An issue of a deleted account',
      author: null,
      labels: [],
    },
  ]);
  assert.deepEqual(pr.comments, [
    {
      author: 'maintainer',
      createdAt: '2026-09-11T08:00:00Z',
      body: '<!-- jaeger-pr-linked-issue -->\nThis PR links no approved issue.',
      id: 'IC_1',
      isMinimized: true,
      authorIsBot: false,
    },
    {
      author: 'contributor',
      createdAt: '2026-09-12T08:00:00Z',
      id: 'IC_2',
      isMinimized: false,
      authorIsBot: false,
    },
    {
      author: 'github-actions',
      createdAt: '2026-09-13T08:00:00Z',
      body: 'This PR is currently **on hold**.',
      id: 'IC_3',
      isMinimized: false,
      authorIsBot: true,
    },
  ]);
  assert.deepEqual(
    pr.reviews.map((review) => [review.author, review.authorIsBot]),
    [
      ['copilot-pull-request-reviewer', true],
      ['maintainer', false],
      [null, false],
    ],
  );
  assert.deepEqual(pr.labelEvents, [
    { label: 'missing-issue', event: 'labeled', at: '2026-09-11T08:00:00Z' },
    { label: 'missing-issue', event: 'unlabeled', at: '2026-09-12T09:00:00Z' },
  ]);
  assert.deepEqual(
    pr.commits.map((commit) => commit.authorLogin),
    ['contributor', null, null],
  );
});

test('the collaborators of a repository are read from every page', async (t) => {
  const page = (login: string, permission: string, endCursor: string | null) => ({
    repository: {
      collaborators: {
        pageInfo: { hasNextPage: endCursor !== null, endCursor },
        edges: [{ permission, node: { login } }],
      },
    },
  });
  const variablesOfRequests = mockGraphqlResponses(t, [
    page('alice', 'ADMIN', 'cursor-1'),
    page('bob', 'READ', null),
  ]);

  assert.deepEqual(await createGraphqlClient('test-token').fetchCollaborators('example', 'repo'), {
    alice: 'ADMIN',
    bob: 'READ',
  });
  assert.deepEqual(
    variablesOfRequests.map(({ cursor }) => cursor),
    [null, 'cursor-1'],
  );
});

test('a repository without a list of collaborators is an error', async (t) => {
  mockGraphqlResponses(t, [{ repository: { collaborators: null } }]);

  await assert.rejects(
    createGraphqlClient('test-token').fetchCollaborators('example', 'repo'),
    /no list of collaborators for example\/repo/,
  );
});
