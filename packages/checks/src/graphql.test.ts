// Copyright (c) 2026 The Jaeger Authors.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGraphqlClient } from './graphql.js';

interface MockResponsePayload {
  data?: unknown;
  errors?: unknown[];
}

function mockFetchRouter(
  t: { mock: { method: (target: unknown, property: string, fn: unknown) => void } },
  handler: (query: string, vars: Record<string, unknown>) => MockResponsePayload,
) {
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: { body?: unknown }) => {
    const rawBody = typeof init?.body === 'string' ? init.body : '';
    const parsed = JSON.parse(rawBody) as { query: string; variables?: Record<string, unknown> };
    const query = parsed.query ?? '';
    const vars = parsed.variables ?? {};
    const res = handler(query, vars);
    return new Response(JSON.stringify(res), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

function createBasePrPayload(overrides: Record<string, unknown> = {}) {
  return {
    number: 100,
    title: 'Test PR',
    url: 'https://github.com/jaegertracing/jaeger/pull/100',
    headRefOid: 'sha-head',
    baseRefOid: 'sha-base',
    isDraft: false,
    mergeable: 'MERGEABLE',
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-02T00:00:00Z',
    additions: 10,
    deletions: 2,
    changedFiles: 1,
    authorAssociation: 'CONTRIBUTOR',
    author: { login: 'alice', __typename: 'User' },
    body: 'Test body',
    labels: {
      totalCount: 0,
      pageInfo: { hasNextPage: false },
      nodes: [],
    },
    files: {
      totalCount: 0,
      pageInfo: { hasNextPage: false },
      nodes: [],
    },
    reviewRequests: {
      totalCount: 0,
      nodes: [],
    },
    reviews: {
      totalCount: 0,
      nodes: [],
    },
    reviewThreads: {
      totalCount: 0,
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [],
    },
    comments: {
      totalCount: 0,
      nodes: [],
    },
    commits: {
      totalCount: 1,
      pageInfo: { hasPreviousPage: false, startCursor: 'cur-1' },
      nodes: [
        {
          commit: {
            oid: 'sha-head',
            messageHeadline: 'feat: initial commit',
            messageBody: 'Signed-off-by: Alice <alice@example.com>',
            committedDate: '2026-10-01T00:00:00Z',
            author: { email: 'alice@example.com', user: { login: 'alice', __typename: 'User' } },
            parents: {
              totalCount: 1,
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ oid: 'sha-parent' }],
            },
            changedFilesIfAvailable: 1,
          },
        },
      ],
    },
    headCommit: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              state: 'SUCCESS',
              contexts: {
                totalCount: 1,
                nodes: [{ __typename: 'CheckRun', name: 'build', conclusion: 'success' }],
              },
            },
          },
        },
      ],
    },
    ...overrides,
  };
}

test('Step 2: Initial commit page (<= 100 commits) without pagination', async (t) => {
  mockFetchRouter(t, (query) => {
    if (query.includes('query PR(')) {
      return {
        data: {
          repository: {
            pullRequest: createBasePrPayload(),
          },
        },
      };
    }
    throw new Error(`Unexpected query: ${query}`);
  });

  const client = createGraphqlClient('token');
  const pr = await client.fetchPullRequest('jaegertracing', 'jaeger', 100);

  assert.equal(pr.commits.length, 1);
  assert.equal(pr.commits[0]!.sha, 'sha-head');
  assert.equal(pr.commits[0]!.authorLogin, 'alice');
  assert.equal(pr.commitsTruncated, false);
});

test('Pull request label pagination fetches the complete set', async (t) => {
  const firstPageLabels = Array.from({ length: 50 }, (_, index) => ({ name: `label-${index}` }));
  mockFetchRouter(t, (query, vars) => {
    if (query.includes('query PR(')) {
      return {
        data: {
          repository: {
            pullRequest: createBasePrPayload({
              labels: {
                totalCount: 52,
                pageInfo: { hasNextPage: true, endCursor: 'labels-cursor-1' },
                nodes: firstPageLabels,
              },
            }),
          },
        },
      };
    }
    if (query.includes('query PRLabels(')) {
      assert.equal(vars.cursor, 'labels-cursor-1');
      return {
        data: {
          repository: {
            pullRequest: {
              updatedAt: '2026-10-02T00:00:00Z',
              labels: {
                totalCount: 52,
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{ name: 'label-50' }, { name: 'waiting-for-author' }],
              },
            },
          },
        },
      };
    }
    throw new Error(`Unexpected query: ${query}`);
  });

  const client = createGraphqlClient('token');
  const pr = await client.fetchPullRequest('jaegertracing', 'jaeger', 100);

  assert.equal(pr.labels.length, 52);
  assert.ok(pr.labels.includes('waiting-for-author'));
  assert.equal(pr.labelsTruncated, false);
});

test('Pull request label pagination fails if the PR changes during pagination', async (t) => {
  mockFetchRouter(t, (query) => {
    if (query.includes('query PR(')) {
      return {
        data: {
          repository: {
            pullRequest: createBasePrPayload({
              labels: {
                totalCount: 51,
                pageInfo: { hasNextPage: true, endCursor: 'labels-cursor-1' },
                nodes: Array.from({ length: 50 }, (_, index) => ({ name: `label-${index}` })),
              },
            }),
          },
        },
      };
    }
    if (query.includes('query PRLabels(')) {
      return {
        data: {
          repository: {
            pullRequest: {
              updatedAt: '2026-10-03T00:00:00Z',
              labels: {
                totalCount: 51,
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{ name: 'waiting-for-author' }],
              },
            },
          },
        },
      };
    }
    throw new Error(`Unexpected query: ${query}`);
  });

  const client = createGraphqlClient('token');
  await assert.rejects(
    client.fetchPullRequest('jaegertracing', 'jaeger', 100),
    /changed while labels were being paginated/,
  );
});

test('Step 2: Commit pagination across multiple cursors with prepending and head preserved', async (t) => {
  const page2Nodes = [
    {
      commit: {
        oid: 'sha-100',
        messageHeadline: 'commit 100',
        messageBody: 'Signed-off-by: Bob <bob@example.com>',
        committedDate: '2026-10-02T00:00:00Z',
        author: { email: 'bob@example.com', user: { login: 'bob' } },
        parents: { totalCount: 1 },
      },
    },
    {
      commit: {
        oid: 'sha-head-150',
        messageHeadline: 'commit 150 head',
        messageBody: 'Signed-off-by: Alice <alice@example.com>',
        committedDate: '2026-10-03T00:00:00Z',
        author: { email: 'alice@example.com', user: { login: 'alice' } },
        parents: { totalCount: 1 },
      },
    },
  ];

  const page1Nodes = [
    {
      commit: {
        oid: 'sha-001',
        messageHeadline: 'commit 1 oldest',
        messageBody: 'Signed-off-by: Carol <carol@example.com>',
        committedDate: '2026-09-30T00:00:00Z',
        author: { email: 'carol@example.com', user: { login: 'carol' } },
        parents: { totalCount: 1 },
      },
    },
  ];

  mockFetchRouter(t, (query, vars) => {
    if (query.includes('query PR(')) {
      return {
        data: {
          repository: {
            pullRequest: createBasePrPayload({
              headRefOid: 'sha-head-150',
              commits: {
                totalCount: 3,
                pageInfo: { hasPreviousPage: true, startCursor: 'cursor-p2' },
                nodes: page2Nodes,
              },
            }),
          },
        },
      };
    }
    if (query.includes('query CommitsBefore(')) {
      assert.equal(vars.cursor, 'cursor-p2');
      return {
        data: {
          repository: {
            pullRequest: {
              commits: {
                pageInfo: { hasPreviousPage: false, startCursor: 'cursor-p1' },
                nodes: page1Nodes,
              },
            },
          },
        },
      };
    }
    if (query.includes('query PRHeadSnapshot(')) {
      return {
        data: {
          repository: {
            pullRequest: {
              headRefOid: 'sha-head-150',
              baseRefOid: 'sha-base',
              commits: { totalCount: 3 },
            },
          },
        },
      };
    }
    throw new Error(`Unexpected query: ${query}`);
  });

  const client = createGraphqlClient('token');
  const pr = await client.fetchPullRequest('jaegertracing', 'jaeger', 100);

  // Invariant check: Older page (page 1) must be PREPENDED before page 2
  assert.equal(pr.commits.length, 3);
  assert.equal(pr.commits[0]!.sha, 'sha-001'); // Oldest
  assert.equal(pr.commits[1]!.sha, 'sha-100');
  assert.equal(pr.commits[2]!.sha, 'sha-head-150'); // Newest (head commit)
  assert.equal(pr.commitsTruncated, false);
});

test('Step 2: Commit pagination safety ceiling caps at 2,000 commits with commitsTruncated: true', async (t) => {
  // Simulate PR with 2,500 commits
  const initialNodes = Array.from({ length: 100 }, (_, i) => ({
    commit: {
      oid: `sha-${2401 + i}`,
      messageHeadline: `commit ${2401 + i}`,
      messageBody: 'Signed-off-by: Dev <dev@example.com>',
      committedDate: '2026-10-02T00:00:00Z',
      author: { email: 'dev@example.com', user: { login: 'dev' } },
      parents: { totalCount: 1 },
    },
  }));

  let beforeCallCount = 0;
  mockFetchRouter(t, (query) => {
    if (query.includes('query PR(')) {
      return {
        data: {
          repository: {
            pullRequest: createBasePrPayload({
              headRefOid: 'sha-2500',
              commits: {
                totalCount: 2500,
                pageInfo: { hasPreviousPage: true, startCursor: 'cursor-2401' },
                nodes: initialNodes,
              },
            }),
          },
        },
      };
    }
    if (query.includes('query CommitsBefore(')) {
      beforeCallCount++;
      const olderNodes = Array.from({ length: 100 }, (_, i) => ({
        commit: {
          oid: `sha-older-${beforeCallCount}-${i}`,
          messageHeadline: 'older commit',
          messageBody: 'Signed-off-by: Dev <dev@example.com>',
          committedDate: '2026-10-01T00:00:00Z',
          author: { email: 'dev@example.com', user: { login: 'dev' } },
          parents: { totalCount: 1 },
        },
      }));
      return {
        data: {
          repository: {
            pullRequest: {
              commits: {
                pageInfo: { hasPreviousPage: true, startCursor: `cursor-older-${beforeCallCount}` },
                nodes: olderNodes,
              },
            },
          },
        },
      };
    }
    if (query.includes('query PRHeadSnapshot(')) {
      return {
        data: {
          repository: {
            pullRequest: {
              headRefOid: 'sha-2500',
              baseRefOid: 'sha-base',
              commits: { totalCount: 2500 },
            },
          },
        },
      };
    }
    throw new Error(`Unexpected query: ${query}`);
  });

  const client = createGraphqlClient('token');
  const pr = await client.fetchPullRequest('jaegertracing', 'jaeger', 100);

  // Safety ceiling stops at 2,000 commits
  assert.equal(pr.commits.length, 2000);
  assert.equal(pr.commitsTruncated, true);
  // Head commit must remain the last element
  assert.equal(pr.commits[pr.commits.length - 1]!.sha, 'sha-2500');
});

test('Step 2: Concurrent head update triggers retry and fail-closed handling', async (t) => {
  let snapshotCheckCount = 0;
  mockFetchRouter(t, (query) => {
    if (query.includes('query PR(')) {
      return {
        data: {
          repository: {
            pullRequest: createBasePrPayload({
              headRefOid: 'sha-head-initial',
              commits: {
                totalCount: 2,
                pageInfo: { hasPreviousPage: true, startCursor: 'cur-1' },
                nodes: [
                  {
                    commit: {
                      oid: 'sha-head-initial',
                      messageHeadline: 'head initial',
                      messageBody: 'Signed-off-by: A <a@example.com>',
                      committedDate: '2026-10-01T00:00:00Z',
                      author: { email: 'a@example.com', user: { login: 'a' } },
                      parents: { totalCount: 1 },
                    },
                  },
                ],
              },
            }),
          },
        },
      };
    }
    if (query.includes('query CommitsBefore(')) {
      return {
        data: {
          repository: {
            pullRequest: {
              commits: {
                pageInfo: { hasPreviousPage: false, startCursor: 'cur-0' },
                nodes: [
                  {
                    commit: {
                      oid: 'sha-commit-0',
                      messageHeadline: 'commit 0',
                      messageBody: 'Signed-off-by: A <a@example.com>',
                      committedDate: '2026-09-30T00:00:00Z',
                      author: { email: 'a@example.com', user: { login: 'a' } },
                      parents: { totalCount: 1 },
                    },
                  },
                ],
              },
            },
          },
        },
      };
    }
    if (query.includes('query PRHeadSnapshot(')) {
      snapshotCheckCount++;
      // Return a different headRefOid indicating concurrent push
      return {
        data: {
          repository: {
            pullRequest: {
              headRefOid: 'sha-concurrent-new-head',
              baseRefOid: 'sha-base',
              commits: { totalCount: 3 },
            },
          },
        },
      };
    }
    if (query.includes('query CommitsInitial(')) {
      // Return fresh commits snapshot for single retry
      return {
        data: {
          repository: {
            pullRequest: {
              headRefOid: 'sha-concurrent-new-head',
              baseRefOid: 'sha-base',
              commits: {
                totalCount: 3,
                pageInfo: { hasPreviousPage: true, startCursor: 'cur-retry' },
                nodes: [
                  {
                    commit: {
                      oid: 'sha-concurrent-new-head',
                      messageHeadline: 'new head',
                      messageBody: 'Signed-off-by: A <a@example.com>',
                      committedDate: '2026-10-02T00:00:00Z',
                      author: { email: 'a@example.com', user: { login: 'a' } },
                      parents: { totalCount: 1 },
                    },
                  },
                ],
              },
            },
          },
        },
      };
    }
    throw new Error(`Unexpected query: ${query}`);
  });

  const client = createGraphqlClient('token');
  const pr = await client.fetchPullRequest('jaegertracing', 'jaeger', 100);

  // Snapshot check was invoked, retried, and marked truncated
  assert.equal(snapshotCheckCount >= 1, true);
  assert.equal(pr.commitsTruncated, true);
});

test('Review requests avoid protected EnterpriseTeam fields and fail closed', async (t) => {
  mockFetchRouter(t, (query) => {
    if (query.includes('query PR(')) {
      assert.equal(query.includes('... on EnterpriseTeam'), false);
      return {
        data: {
          repository: {
            pullRequest: createBasePrPayload({
              reviewRequests: {
                totalCount: 5,
                nodes: [
                  { requestedReviewer: { __typename: 'User', login: 'alice' } },
                  { requestedReviewer: { __typename: 'Team', slug: 'maintainers' } },
                  {
                    requestedReviewer: {
                      __typename: 'EnterpriseTeam',
                      slug: 'enterprise-security',
                    },
                  },
                  { requestedReviewer: { __typename: 'Bot', login: 'copilot' } },
                  { requestedReviewer: { __typename: 'Mannequin', login: 'legacy-user' } },
                ],
              },
            }),
          },
        },
      };
    }
    throw new Error(`Unexpected query: ${query}`);
  });

  const client = createGraphqlClient('token');
  const pr = await client.fetchPullRequest('jaegertracing', 'jaeger', 100);

  // EnterpriseTeam identity is unavailable without an additional token scope.
  assert.equal(pr.reviewRequests.length, 2);
  assert.deepEqual(pr.reviewRequests[0], { kind: 'user', login: 'alice' });
  assert.deepEqual(pr.reviewRequests[1], { kind: 'team', login: 'maintainers' });
  assert.equal(pr.reviewRequestsTruncated, true);
});

test('Step 2: Review requests with >50 raw requests marks reviewRequestsTruncated: true', async (t) => {
  mockFetchRouter(t, (query) => {
    if (query.includes('query PR(')) {
      return {
        data: {
          repository: {
            pullRequest: createBasePrPayload({
              reviewRequests: {
                totalCount: 55, // More than 50
                nodes: [{ requestedReviewer: { __typename: 'User', login: 'alice' } }],
              },
            }),
          },
        },
      };
    }
    throw new Error(`Unexpected query: ${query}`);
  });

  const client = createGraphqlClient('token');
  const pr = await client.fetchPullRequest('jaegertracing', 'jaeger', 100);

  assert.equal(pr.reviewRequestsTruncated, true);
});

test('Step 2: Reviews and top-level comments mapping: authorTypename, authorAssociation, completeness', async (t) => {
  mockFetchRouter(t, (query) => {
    if (query.includes('query PR(')) {
      return {
        data: {
          repository: {
            pullRequest: createBasePrPayload({
              reviews: {
                totalCount: 2,
                nodes: [
                  {
                    id: 'PRR_1',
                    author: { login: 'bob', __typename: 'User' },
                    state: 'APPROVED',
                    submittedAt: '2026-10-02T12:00:00Z',
                    url: 'https://github.com/pr/1#review-1',
                    body: 'LGTM',
                  },
                  {
                    id: 'PRR_2',
                    author: { login: 'copilot', __typename: 'Bot' },
                    state: 'COMMENTED',
                    submittedAt: '2026-10-02T13:00:00Z',
                    url: 'https://github.com/pr/1#review-2',
                    body: '<!-- ccr-overview-v2 -->',
                  },
                ],
              },
              comments: {
                nodes: [
                  {
                    author: { login: 'charlie', __typename: 'User' },
                    authorAssociation: 'MEMBER',
                    createdAt: '2026-10-02T14:00:00Z',
                  },
                ],
              },
            }),
          },
        },
      };
    }
    throw new Error(`Unexpected query: ${query}`);
  });

  const client = createGraphqlClient('token');
  const pr = await client.fetchPullRequest('jaegertracing', 'jaeger', 100);

  assert.equal(pr.reviews.length, 2);
  assert.equal(pr.reviews[0]!.authorTypename, 'User');
  assert.equal(pr.reviews[1]!.authorTypename, 'Bot');
  assert.equal(pr.reviewsTruncated, false);

  assert.equal(pr.comments.length, 1);
  assert.equal(pr.comments[0]!.author, 'charlie');
  assert.equal(pr.comments[0]!.authorTypename, 'User');
  assert.equal(pr.comments[0]!.authorAssociation, 'MEMBER');
});

test('Step 2: Review threads pagination and nested commentsTruncated mapping', async (t) => {
  mockFetchRouter(t, (query, vars) => {
    if (query.includes('query PR(')) {
      return {
        data: {
          repository: {
            pullRequest: createBasePrPayload({
              reviewThreads: {
                totalCount: 2,
                pageInfo: { hasNextPage: true, endCursor: 'rt-cursor-1' },
                nodes: [
                  {
                    isResolved: false,
                    resolvedBy: null,
                    comments: {
                      totalCount: 55, // Truncated thread (>50 comments)
                      nodes: [
                        {
                          author: { login: 'bob', __typename: 'User' },
                          createdAt: '2026-10-02T10:00:00Z',
                        },
                      ],
                    },
                  },
                ],
              },
            }),
          },
        },
      };
    }
    if (query.includes('query ReviewThreads(')) {
      assert.equal(vars.cursor, 'rt-cursor-1');
      return {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    isResolved: true,
                    resolvedBy: { login: 'alice' },
                    comments: {
                      totalCount: 2, // Complete thread (<= 50 comments)
                      nodes: [
                        {
                          author: { login: 'bob', __typename: 'User' },
                          createdAt: '2026-10-02T11:00:00Z',
                        },
                        {
                          author: { login: 'alice', __typename: 'User' },
                          createdAt: '2026-10-02T11:30:00Z',
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      };
    }
    throw new Error(`Unexpected query: ${query}`);
  });

  const client = createGraphqlClient('token');
  const pr = await client.fetchPullRequest('jaegertracing', 'jaeger', 100);

  assert.equal(pr.reviewThreads?.length, 2);
  assert.equal(pr.reviewThreadsTruncated, false);

  // Thread 1: >50 comments -> commentsTruncated: true
  assert.equal(pr.reviewThreads![0]!.commentsTruncated, true);
  assert.equal(pr.reviewThreads![0]!.comments[0]!.authorTypename, 'User');

  // Thread 2 (from page 2): 2 comments -> commentsTruncated: false
  assert.equal(pr.reviewThreads![1]!.commentsTruncated, false);
  assert.equal(pr.reviewThreads![1]!.resolvedBy, 'alice');
});

test('Review threads and nested comments are paginated completely', async (t) => {
  mockFetchRouter(t, (query, vars) => {
    if (query.includes('query PR(')) {
      return {
        data: {
          repository: {
            pullRequest: createBasePrPayload({
              reviewThreads: {
                totalCount: 2,
                pageInfo: { hasNextPage: true, endCursor: 'rt-cursor-1' },
                nodes: [
                  {
                    id: 'thread-1',
                    isResolved: false,
                    resolvedBy: null,
                    comments: {
                      totalCount: 55,
                      pageInfo: { hasNextPage: true, endCursor: 'comment-cursor-1' },
                      nodes: Array.from({ length: 50 }, (_, index) => ({
                        id: `comment-${index}`,
                        author: { login: 'bob', __typename: 'User' },
                        authorAssociation: 'CONTRIBUTOR',
                        createdAt: `2026-10-02T10:${String(index).padStart(2, '0')}:00Z`,
                      })),
                    },
                  },
                ],
              },
            }),
          },
        },
      };
    }
    if (query.includes('query ReviewThreadComments(')) {
      assert.equal(vars.threadId, 'thread-1');
      assert.equal(vars.cursor, 'comment-cursor-1');
      return {
        data: {
          node: {
            comments: {
              totalCount: 55,
              pageInfo: { hasNextPage: false, endCursor: 'comment-cursor-2' },
              nodes: Array.from({ length: 5 }, (_, index) => ({
                id: `comment-${index + 50}`,
                author: { login: 'bob', __typename: 'User' },
                authorAssociation: 'CONTRIBUTOR',
                createdAt: `2026-10-02T11:0${index}:00Z`,
              })),
            },
          },
        },
      };
    }
    if (query.includes('query ReviewThreads(')) {
      assert.equal(vars.cursor, 'rt-cursor-1');
      return {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: 'thread-2',
                    isResolved: true,
                    resolvedBy: { login: 'alice' },
                    comments: {
                      totalCount: 2,
                      pageInfo: { hasNextPage: false, endCursor: 'comment-cursor-3' },
                      nodes: [
                        {
                          id: 'comment-thread-2-1',
                          author: { login: 'bob', __typename: 'User' },
                          authorAssociation: 'CONTRIBUTOR',
                          createdAt: '2026-10-02T11:00:00Z',
                        },
                        {
                          id: 'comment-thread-2-2',
                          author: { login: 'alice', __typename: 'User' },
                          authorAssociation: 'CONTRIBUTOR',
                          createdAt: '2026-10-02T11:30:00Z',
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      };
    }
    throw new Error(`Unexpected query: ${query}`);
  });

  const client = createGraphqlClient('token');
  const pr = await client.fetchPullRequest('jaegertracing', 'jaeger', 100);

  assert.equal(pr.reviewThreads?.length, 2);
  assert.equal(pr.reviewThreadsTruncated, false);
  assert.equal(pr.reviewThreads![0]!.commentsTruncated, false);
  assert.equal(pr.reviewThreads![0]!.comments.length, 55);
  assert.equal(pr.reviewThreads![0]!.comments[0]!.authorTypename, 'User');
  assert.equal(pr.reviewThreads![1]!.commentsTruncated, false);
  assert.equal(pr.reviewThreads![1]!.resolvedBy, 'alice');
});

test('Review-thread comment pagination errors remain marked incomplete', async (t) => {
  mockFetchRouter(t, (query) => {
    if (query.includes('query PR(')) {
      return {
        data: {
          repository: {
            pullRequest: createBasePrPayload({
              reviewThreads: {
                totalCount: 1,
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: 'thread-1',
                    isResolved: false,
                    resolvedBy: null,
                    comments: {
                      totalCount: 51,
                      pageInfo: { hasNextPage: true, endCursor: 'comment-cursor-1' },
                      nodes: Array.from({ length: 50 }, (_, index) => ({
                        id: `comment-${index}`,
                        author: { login: 'bob', __typename: 'User' },
                        authorAssociation: 'CONTRIBUTOR',
                        createdAt: '2026-10-02T10:00:00Z',
                      })),
                    },
                  },
                ],
              },
            }),
          },
        },
      };
    }
    if (query.includes('query ReviewThreadComments(')) {
      throw new Error('GitHub API unavailable');
    }
    throw new Error(`Unexpected query: ${query}`);
  });

  const client = createGraphqlClient('token');
  const pr = await client.fetchPullRequest('jaegertracing', 'jaeger', 100);
  assert.equal(pr.reviewThreads?.[0]?.commentsTruncated, true);
});

test('Open PR list queries use 50-node pages', async (t) => {
  mockFetchRouter(t, (query) => {
    assert.match(query, /pullRequests\([^)]*first: 50/);
    return {
      data: {
        repository: {
          pullRequests: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [],
          },
        },
      },
    };
  });

  const client = createGraphqlClient('token');
  assert.deepEqual(await client.listOpenPRs('jaegertracing', 'jaeger'), []);
  assert.deepEqual(await client.listOpenPRsByLabel('jaegertracing', 'jaeger', 'waiting'), []);
});

test('Step 2 (Phase 1): BaseRefOid change triggers retry and truncation flag on inconsistency', async (t) => {
  let snapshotCheckCount = 0;
  mockFetchRouter(t, (query) => {
    if (query.includes('query PR(')) {
      return {
        data: {
          repository: {
            pullRequest: createBasePrPayload({
              headRefOid: 'sha-head',
              baseRefOid: 'sha-base-initial',
              commits: {
                totalCount: 2,
                pageInfo: { hasPreviousPage: true, startCursor: 'cur-p1' },
                nodes: [
                  {
                    commit: {
                      oid: 'sha-head',
                      messageHeadline: 'head commit',
                      messageBody: 'Signed-off-by: Dev <dev@example.com>',
                      committedDate: '2026-10-02T00:00:00Z',
                      author: {
                        email: 'dev@example.com',
                        user: { login: 'dev', __typename: 'User' },
                      },
                      parents: {
                        totalCount: 1,
                        pageInfo: { hasNextPage: false, endCursor: null },
                        nodes: [{ oid: 'sha-base-initial' }],
                      },
                      changedFilesIfAvailable: 1,
                    },
                  },
                ],
              },
            }),
          },
        },
      };
    }
    if (query.includes('query CommitsBefore(')) {
      return {
        data: {
          repository: {
            pullRequest: {
              commits: {
                pageInfo: { hasPreviousPage: false, startCursor: 'cur-p0' },
                nodes: [
                  {
                    commit: {
                      oid: 'sha-older',
                      messageHeadline: 'older commit',
                      messageBody: 'Signed-off-by: Dev <dev@example.com>',
                      committedDate: '2026-10-01T00:00:00Z',
                      author: {
                        email: 'dev@example.com',
                        user: { login: 'dev', __typename: 'User' },
                      },
                      parents: {
                        totalCount: 1,
                        pageInfo: { hasNextPage: false, endCursor: null },
                        nodes: [{ oid: 'sha-base-initial' }],
                      },
                      changedFilesIfAvailable: 1,
                    },
                  },
                ],
              },
            },
          },
        },
      };
    }
    if (query.includes('query PRHeadSnapshot(')) {
      snapshotCheckCount++;
      // Base ref changed during pagination
      return {
        data: {
          repository: {
            pullRequest: {
              headRefOid: 'sha-head',
              baseRefOid: 'sha-base-advanced',
              commits: { totalCount: 2 },
            },
          },
        },
      };
    }
    if (query.includes('query CommitsInitial(')) {
      // Return retry response with new base
      return {
        data: {
          repository: {
            pullRequest: {
              headRefOid: 'sha-head',
              baseRefOid: 'sha-base-advanced',
              commits: {
                totalCount: 2,
                pageInfo: { hasPreviousPage: false, startCursor: null },
                nodes: [
                  {
                    commit: {
                      oid: 'sha-head',
                      messageHeadline: 'head commit',
                      messageBody: 'Signed-off-by: Dev <dev@example.com>',
                      committedDate: '2026-10-02T00:00:00Z',
                      author: {
                        email: 'dev@example.com',
                        user: { login: 'dev', __typename: 'User' },
                      },
                      parents: {
                        totalCount: 1,
                        pageInfo: { hasNextPage: false, endCursor: null },
                        nodes: [{ oid: 'sha-base-advanced' }],
                      },
                      changedFilesIfAvailable: 1,
                    },
                  },
                ],
              },
            },
          },
        },
      };
    }
    throw new Error(`Unexpected query: ${query}`);
  });

  const client = createGraphqlClient('token');
  const pr = await client.fetchPullRequest('jaegertracing', 'jaeger', 100);

  assert.equal(snapshotCheckCount >= 1, true);
  // Retry was triggered; the retry had count 2 but only 1 node returned -> commitsTruncated: true
  assert.equal(pr.commitsTruncated, true);
});

test('Step 2 (Phase 1): Commit mapping preserves authorTypename, parentOids, parentsTruncated, and changedFilesIfAvailable', async (t) => {
  mockFetchRouter(t, (query) => {
    if (query.includes('query PR(')) {
      return {
        data: {
          repository: {
            pullRequest: createBasePrPayload({
              commits: {
                totalCount: 2,
                pageInfo: { hasPreviousPage: false, startCursor: 'c1' },
                nodes: [
                  {
                    commit: {
                      oid: 'sha-merge',
                      messageHeadline: 'Merge branch main',
                      messageBody: '',
                      committedDate: '2026-10-02T00:00:00Z',
                      author: {
                        email: 'renovate[bot]@users.noreply.github.com',
                        user: { login: 'renovate[bot]', __typename: 'Bot' },
                      },
                      parents: {
                        totalCount: 2,
                        pageInfo: { hasNextPage: false, endCursor: null },
                        nodes: [{ oid: 'sha-p1' }, { oid: 'sha-p2' }],
                      },
                      changedFilesIfAvailable: 4,
                    },
                  },
                  {
                    commit: {
                      oid: 'sha-octopus',
                      messageHeadline: 'Octopus merge',
                      messageBody: '',
                      committedDate: '2026-10-03T00:00:00Z',
                      author: {
                        email: null,
                        user: null,
                      },
                      parents: {
                        totalCount: 12,
                        pageInfo: { hasNextPage: true, endCursor: 'p-cur' },
                        nodes: [{ oid: 'sha-p1' }, { oid: 'sha-p2' }],
                      },
                      changedFilesIfAvailable: null,
                    },
                  },
                ],
              },
            }),
          },
        },
      };
    }
    throw new Error(`Unexpected query: ${query}`);
  });

  const client = createGraphqlClient('token');
  const pr = await client.fetchPullRequest('jaegertracing', 'jaeger', 100);

  assert.equal(pr.commits.length, 2);
  const c0 = pr.commits[0]!;
  assert.equal(c0.authorLogin, 'renovate[bot]');
  assert.equal(c0.authorTypename, 'Bot');
  assert.equal(c0.parents, 2);
  assert.deepEqual(c0.parentOids, ['sha-p1', 'sha-p2']);
  assert.equal(c0.parentsTruncated, false);
  assert.equal(c0.changedFilesIfAvailable, 4);

  const c1 = pr.commits[1]!;
  assert.equal(c1.authorLogin, null);
  assert.equal(c1.authorTypename, null);
  assert.equal(c1.parents, 12);
  assert.deepEqual(c1.parentOids, ['sha-p1', 'sha-p2']);
  assert.equal(c1.parentsTruncated, true);
  assert.equal(c1.changedFilesIfAvailable, null);
});

test('Step 2 (Phase 1): Reviews mapping preserves id and commitOid', async (t) => {
  mockFetchRouter(t, (query) => {
    if (query.includes('query PR(')) {
      return {
        data: {
          repository: {
            pullRequest: createBasePrPayload({
              reviews: {
                totalCount: 2,
                nodes: [
                  {
                    id: 'PRR_kwDOA123',
                    author: { login: 'reviewer-alice', __typename: 'User' },
                    state: 'CHANGES_REQUESTED',
                    submittedAt: '2026-10-02T10:00:00Z',
                    commit: { oid: 'sha-reviewed-commit' },
                    url: 'https://github.com/jaegertracing/jaeger/pull/100#pullrequestreview-1',
                    body: 'Please fix these issues',
                  },
                  {
                    id: 'PRR_kwDOA456',
                    author: { login: 'reviewer-bob', __typename: 'User' },
                    state: 'APPROVED',
                    submittedAt: '2026-10-02T12:00:00Z',
                    commit: null,
                    url: 'https://github.com/jaegertracing/jaeger/pull/100#pullrequestreview-2',
                    body: 'LGTM',
                  },
                ],
              },
            }),
          },
        },
      };
    }
    throw new Error(`Unexpected query: ${query}`);
  });

  const client = createGraphqlClient('token');
  const pr = await client.fetchPullRequest('jaegertracing', 'jaeger', 100);

  assert.equal(pr.reviews.length, 2);
  assert.equal(pr.reviews[0]!.id, 'PRR_kwDOA123');
  assert.equal(pr.reviews[0]!.commitOid, 'sha-reviewed-commit');
  assert.equal(pr.reviews[0]!.state, 'CHANGES_REQUESTED');

  assert.equal(pr.reviews[1]!.id, 'PRR_kwDOA456');
  assert.equal(pr.reviews[1]!.commitOid, null);
  assert.equal(pr.reviews[1]!.state, 'APPROVED');
});

test('Step 2 (Phase 1): ReviewThreads mapping preserves path, comment revision metadata, and authorAssociation', async (t) => {
  mockFetchRouter(t, (query) => {
    if (query.includes('query PR(')) {
      return {
        data: {
          repository: {
            pullRequest: createBasePrPayload({
              reviewThreads: {
                totalCount: 1,
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    path: 'packages/checks/src/actor.ts',
                    isResolved: false,
                    resolvedBy: null,
                    comments: {
                      totalCount: 2,
                      nodes: [
                        {
                          author: { login: 'reviewer-alice', __typename: 'User' },
                          authorAssociation: 'MEMBER',
                          createdAt: '2026-10-02T10:00:00Z',
                          commit: { oid: 'sha-c1' },
                          originalCommit: { oid: 'sha-orig-1' },
                          pullRequestReview: {
                            id: 'PRR_1',
                            state: 'CHANGES_REQUESTED',
                            submittedAt: '2026-10-02T10:05:00Z',
                            commit: { oid: 'sha-c1' },
                          },
                        },
                        {
                          author: { login: 'contributor-bob', __typename: 'User' },
                          authorAssociation: 'FIRST_TIMER',
                          createdAt: '2026-10-02T10:30:00Z',
                          commit: null,
                          originalCommit: null,
                          pullRequestReview: null,
                        },
                      ],
                    },
                  },
                ],
              },
            }),
          },
        },
      };
    }
    throw new Error(`Unexpected query: ${query}`);
  });

  const client = createGraphqlClient('token');
  const pr = await client.fetchPullRequest('jaegertracing', 'jaeger', 100);

  assert.equal(pr.reviewThreads?.length, 1);
  const thread = pr.reviewThreads![0]!;
  assert.equal(thread.path, 'packages/checks/src/actor.ts');
  assert.equal(thread.comments.length, 2);

  const comment0 = thread.comments[0]!;
  assert.equal(comment0.author, 'reviewer-alice');
  assert.equal(comment0.authorAssociation, 'MEMBER');
  assert.equal(comment0.commitOid, 'sha-c1');
  assert.equal(comment0.originalCommitOid, 'sha-orig-1');
  assert.equal(comment0.pullRequestReview?.id, 'PRR_1');
  assert.equal(comment0.pullRequestReview?.state, 'CHANGES_REQUESTED');
  assert.equal(comment0.pullRequestReview?.commitOid, 'sha-c1');

  const comment1 = thread.comments[1]!;
  assert.equal(comment1.author, 'contributor-bob');
  assert.equal(comment1.authorAssociation, 'FIRST_TIMER');
  assert.equal(comment1.commitOid, null);
  assert.equal(comment1.originalCommitOid, null);
  assert.equal(comment1.pullRequestReview, null);
});

test('Step 2 (Phase 1): Top-level commentsTruncated mapping', async (t) => {
  mockFetchRouter(t, (query) => {
    if (query.includes('query PR(')) {
      return {
        data: {
          repository: {
            pullRequest: createBasePrPayload({
              comments: {
                totalCount: 75,
                nodes: [
                  {
                    author: { login: 'charlie', __typename: 'User' },
                    authorAssociation: 'COLLABORATOR',
                    createdAt: '2026-10-02T14:00:00Z',
                  },
                ],
              },
            }),
          },
        },
      };
    }
    throw new Error(`Unexpected query: ${query}`);
  });

  const client = createGraphqlClient('token');
  const pr = await client.fetchPullRequest('jaegertracing', 'jaeger', 100);

  assert.equal(pr.comments.length, 1);
  assert.equal(pr.commentsTruncated, true);
});

test('Step 2 (Phase 1): fetchCommitPathComparison distinguishes found, absent, and unavailable tree entries', async (t) => {
  mockFetchRouter(t, (query, vars) => {
    assert.equal(vars.owner, 'jaegertracing');
    assert.equal(vars.repo, 'jaeger');
    if (query.includes('query CommitPathEntries(')) {
      return {
        data: {
          repository: {
            candidate: {
              oid: 'sha-candidate',
              f0: { oid: 'blob-111', mode: 33188, type: 'blob' }, // found
              f1: null, // absent (legitimate null)
              f2: { oid: 'blob-222', mode: 33188, type: 'blob' },
            },
            parent: {
              oid: 'sha-parent',
              f0: { oid: 'blob-000', mode: 33188, type: 'blob' }, // modified
              f1: { oid: 'blob-old', mode: 33188, type: 'blob' }, // deleted in candidate
              f2: null, // absent in parent (added in candidate)
            },
          },
        },
      };
    }
    throw new Error(`Unexpected query: ${query}`);
  });

  const client = createGraphqlClient('token');
  const paths = ['src/modified.ts', 'src/deleted.ts', 'src/added.ts'];
  const comparison = await client.fetchCommitPathComparison(
    'jaegertracing',
    'jaeger',
    'sha-candidate',
    'sha-parent',
    paths,
  );

  assert.equal(comparison.size, 3);

  const mod = comparison.get('src/modified.ts')!;
  assert.equal(mod.candidateResult.status, 'found');
  assert.equal(mod.parentResult.status, 'found');
  if (mod.candidateResult.status === 'found' && mod.parentResult.status === 'found') {
    assert.notEqual(mod.candidateResult.entry.oid, mod.parentResult.entry.oid);
  }

  const del = comparison.get('src/deleted.ts')!;
  assert.equal(del.candidateResult.status, 'absent');
  assert.equal(del.parentResult.status, 'found');

  const add = comparison.get('src/added.ts')!;
  assert.equal(add.candidateResult.status, 'found');
  assert.equal(add.parentResult.status, 'absent');
});

test('Step 2 (Phase 1): fetchCommitPathComparison handles root commit without parent and GraphQL error', async (t) => {
  mockFetchRouter(t, (query) => {
    if (query.includes('query CommitPathEntries(')) {
      return {
        errors: [
          {
            message: 'Path resolution timeout',
            path: ['repository', 'candidate', 'f1'],
          },
        ],
        data: {
          repository: {
            candidate: {
              oid: 'sha-root',
              f0: { oid: 'blob-root', mode: 33188, type: 'blob' },
              f1: null,
            },
          },
        },
      };
    }
    throw new Error(`Unexpected query: ${query}`);
  });

  const client = createGraphqlClient('token');
  const paths = ['src/root.ts', 'src/timeout.ts'];
  const comparison = await client.fetchCommitPathComparison(
    'jaegertracing',
    'jaeger',
    'sha-root',
    null,
    paths,
  );

  assert.equal(comparison.size, 2);

  const root = comparison.get('src/root.ts')!;
  assert.equal(root.candidateResult.status, 'found');
  assert.equal(root.parentResult.status, 'absent'); // parent is absent for root commit

  const timeout = comparison.get('src/timeout.ts')!;
  assert.equal(timeout.candidateResult.status, 'unavailable'); // Error field must be unavailable, not absent!
  assert.equal(timeout.parentResult.status, 'absent');
});

test('Step 2 (Phase 1): fetchBatchCommitParents retrieves parent OIDs and truncation state', async (t) => {
  mockFetchRouter(t, (query) => {
    if (query.includes('query BatchCommitParents(')) {
      return {
        data: {
          repository: {
            c0: {
              oid: 'oid-1',
              parents: {
                totalCount: 1,
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{ oid: 'parent-1' }],
              },
            },
            c1: {
              oid: 'oid-2',
              parents: {
                totalCount: 12,
                pageInfo: { hasNextPage: true, endCursor: 'cur-10' },
                nodes: [{ oid: 'parent-2' }],
              },
            },
            c2: null, // missing commit object
          },
        },
      };
    }
    throw new Error(`Unexpected query: ${query}`);
  });

  const client = createGraphqlClient('token');
  const res = await client.fetchBatchCommitParents('jaegertracing', 'jaeger', [
    'oid-1',
    'oid-2',
    'oid-3',
  ]);

  assert.equal(res.size, 2);
  const c1 = res.get('oid-1')!;
  assert.equal(c1.oid, 'oid-1');
  assert.deepEqual(c1.parentOids, ['parent-1']);
  assert.equal(c1.parentsTruncated, false);

  const c2 = res.get('oid-2')!;
  assert.equal(c2.oid, 'oid-2');
  assert.deepEqual(c2.parentOids, ['parent-2']);
  assert.equal(c2.parentsTruncated, true);

  // Empty oids check returns empty map immediately
  const emptyRes = await client.fetchBatchCommitParents('jaegertracing', 'jaeger', []);
  assert.equal(emptyRes.size, 0);
});
