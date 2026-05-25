// Octokit GraphQL data layer.
//
// Three queries are exposed:
//   - fetchViewerLogin()     -> who am I (used by the CLI to identify "you")
//   - listOpenPRs()          -> {number, updatedAt} pairs per repo, paginated
//   - fetchPullRequest()     -> the full PullRequest shape used by predicates
//                               and the triage CLI
//
// One full-PR query pulls every field any current or planned consumer might
// need. Cache eviction is keyed by `updatedAt` — see cache.ts.

import { graphql } from '@octokit/graphql';
import type { AuthorAssociation, AuthorTypename, PullRequest, ReviewState } from './types.js';

// Fields returned by listOpenPRs. Together (updatedAt, headSha, headRollup)
// they form the cache freshness key — see scan.ts. `updatedAt` alone is not
// enough because GitHub does not advance it when CI checks complete or when
// the base branch advances under the PR.
export interface PrSummary {
  number: number;
  updatedAt: string;
  headSha: string | null;
  headRollup: PullRequest['statusCheckRollup'];
}

export interface GraphqlClient {
  fetchViewerLogin(): Promise<string>;
  listOpenPRs(owner: string, repo: string): Promise<PrSummary[]>;
  // Same shape as `listOpenPRs`, but server-side filtered to PRs carrying
  // the given label. Used by `pr-weekly-digest` to scope down to the
  // `waiting-for-author` set without paying for every open PR's details.
  listOpenPRsByLabel(owner: string, repo: string, label: string): Promise<PrSummary[]>;
  fetchPullRequest(owner: string, repo: string, number: number): Promise<PullRequest>;
  // Count merged PRs by `author` in `owner/repo`. Used by the quota
  // computation in the CLI. Implemented via GraphQL search, which returns
  // an exact `issueCount` without paginating — far cheaper than walking
  // closed PRs page-by-page.
  countMergedPRs(owner: string, repo: string, author: string): Promise<number>;
}

interface PullRequestNode {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  createdAt: string;
  updatedAt: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  authorAssociation: AuthorAssociation;
  author: { login: string; __typename: AuthorTypename } | null;
  body: string | null;
  labels: { nodes: Array<{ name: string }> };
  files: { nodes: Array<{ path: string }> };
  reviewRequests: {
    nodes: Array<{
      requestedReviewer:
        | { __typename: 'User'; login: string }
        | { __typename: 'Team'; slug: string }
        | null;
    }>;
  };
  reviews: {
    nodes: Array<{
      author: { login: string } | null;
      state: ReviewState;
      submittedAt: string | null;
    }>;
  };
  reviewThreads: {
    nodes: Array<{
      isResolved: boolean;
      resolvedBy: { login: string } | null;
      comments: {
        nodes: Array<{ author: { login: string } | null; createdAt: string }>;
      };
    }>;
  };
  comments: {
    nodes: Array<{
      author: { login: string } | null;
      createdAt: string;
    }>;
  };
  commits: {
    nodes: Array<{
      commit: {
        oid: string;
        messageHeadline: string;
        messageBody: string;
        committedDate: string;
        author: { email: string | null } | null;
        statusCheckRollup: {
          state: PullRequest['statusCheckRollup'];
          contexts: {
            nodes: Array<
              | { __typename: 'CheckRun'; name: string; conclusion: string | null }
              | { __typename: 'StatusContext'; context: string; state: string }
            >;
          };
        } | null;
        parents: { totalCount: number };
      };
    }>;
  };
}

const PR_QUERY = `
  query PR($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        number
        title
        url
        isDraft
        mergeable
        createdAt
        updatedAt
        additions
        deletions
        changedFiles
        authorAssociation
        author { login __typename }
        body
        labels(first: 50) { nodes { name } }
        files(first: 100) { nodes { path } }
        reviewRequests(first: 50) {
          nodes {
            requestedReviewer {
              __typename
              ... on User { login }
              ... on Team { slug }
            }
          }
        }
        reviews(last: 50) {
          nodes {
            author { login }
            state
            submittedAt
          }
        }
        reviewThreads(first: 100) {
          nodes {
            isResolved
            resolvedBy { login }
            comments(first: 50) {
              nodes {
                author { login }
                createdAt
              }
            }
          }
        }
        comments(last: 50) {
          nodes {
            author { login }
            createdAt
          }
        }
        commits(last: 100) {
          nodes {
            commit {
              oid
              messageHeadline
              messageBody
              committedDate
              author { email }
              statusCheckRollup {
                state
                contexts(first: 50) {
                  nodes {
                    __typename
                    ... on CheckRun { name conclusion }
                    ... on StatusContext { context state }
                  }
                }
              }
              parents { totalCount }
            }
          }
        }
      }
    }
  }
`;

const LIST_QUERY = `
  query ListPRs($owner: String!, $repo: String!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequests(states: OPEN, first: 100, after: $cursor, orderBy: {field: UPDATED_AT, direction: DESC}) {
        pageInfo { hasNextPage endCursor }
        nodes {
          number
          updatedAt
          commits(last: 1) {
            nodes {
              commit {
                oid
                statusCheckRollup { state }
              }
            }
          }
        }
      }
    }
  }
`;

// Same shape as LIST_QUERY but server-filtered to a single label. The
// `labels` arg on `pullRequests` is an AND across all values, which is
// what we want — pass one label and you get exactly the PRs with that
// label. Used by `pr-weekly-digest` for the `waiting-for-author` set.
const LIST_BY_LABEL_QUERY = `
  query ListPRsByLabel($owner: String!, $repo: String!, $label: String!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequests(states: OPEN, labels: [$label], first: 100, after: $cursor, orderBy: {field: UPDATED_AT, direction: DESC}) {
        pageInfo { hasNextPage endCursor }
        nodes {
          number
          updatedAt
          commits(last: 1) {
            nodes {
              commit {
                oid
                statusCheckRollup { state }
              }
            }
          }
        }
      }
    }
  }
`;

const VIEWER_QUERY = `query Viewer { viewer { login } }`;

// `first: 1` (not 0 — GraphQL search rejects 0) and we read only issueCount;
// the actual node is discarded. issueCount is the authoritative total.
const MERGED_COUNT_QUERY = `
  query MergedCount($q: String!) {
    search(query: $q, type: ISSUE, first: 1) {
      issueCount
    }
  }
`;

// Shared pagination loop for any query that returns a `repository.
// pullRequests` connection with PrSummary-shaped nodes. The two list
// queries (with/without label filter) differ only in their `$label` var,
// so the loop is identical — extracting it keeps the two methods
// trivially short and avoids drift.
async function paginateListQuery(
  gql: typeof graphql,
  query: string,
  vars: Record<string, string>,
): Promise<PrSummary[]> {
  type ListNode = {
    number: number;
    updatedAt: string;
    commits: {
      nodes: Array<{
        commit: {
          oid: string;
          statusCheckRollup: { state: PullRequest['statusCheckRollup'] } | null;
        };
      }>;
    };
  };
  type ListResp = {
    repository: {
      pullRequests: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: ListNode[];
      };
    };
  };
  const out: PrSummary[] = [];
  let cursor: string | null = null;
  do {
    const data: ListResp = await gql<ListResp>(query, { ...vars, cursor });
    for (const n of data.repository.pullRequests.nodes) {
      const head = n.commits.nodes[0]?.commit;
      out.push({
        number: n.number,
        updatedAt: n.updatedAt,
        headSha: head?.oid ?? null,
        headRollup: head?.statusCheckRollup?.state ?? null,
      });
    }
    cursor = data.repository.pullRequests.pageInfo.hasNextPage
      ? data.repository.pullRequests.pageInfo.endCursor
      : null;
  } while (cursor);
  return out;
}

export function createGraphqlClient(token: string): GraphqlClient {
  const gql = graphql.defaults({
    headers: { authorization: `token ${token}` },
  });

  return {
    async fetchViewerLogin() {
      const data = await gql<{ viewer: { login: string } }>(VIEWER_QUERY);
      return data.viewer.login;
    },

    async countMergedPRs(owner, repo, author) {
      const data = await gql<{ search: { issueCount: number } }>(MERGED_COUNT_QUERY, {
        q: `repo:${owner}/${repo} author:${author} is:pr is:merged`,
      });
      return data.search.issueCount;
    },

    async listOpenPRs(owner, repo) {
      return paginateListQuery(gql, LIST_QUERY, { owner, repo });
    },

    async listOpenPRsByLabel(owner, repo, label) {
      return paginateListQuery(gql, LIST_BY_LABEL_QUERY, { owner, repo, label });
    },

    async fetchPullRequest(owner, repo, number) {
      const data = await gql<{ repository: { pullRequest: PullRequestNode } }>(PR_QUERY, {
        owner,
        repo,
        number,
      });
      const pr = data.repository.pullRequest;
      const head = pr.commits.nodes[pr.commits.nodes.length - 1];
      return {
        repo: { owner, name: repo },
        number: pr.number,
        title: pr.title,
        url: pr.url,
        author: pr.author ? { login: pr.author.login, typename: pr.author.__typename } : null,
        authorAssociation: pr.authorAssociation,
        isDraft: pr.isDraft,
        mergeable: pr.mergeable,
        createdAt: pr.createdAt,
        updatedAt: pr.updatedAt,
        labels: pr.labels.nodes.map((l) => l.name),
        additions: pr.additions,
        deletions: pr.deletions,
        changedFiles: pr.changedFiles,
        files: pr.files.nodes.map((f) => f.path),
        statusCheckRollup: head?.commit.statusCheckRollup?.state ?? null,
        headCheckRuns: head?.commit.statusCheckRollup?.contexts.nodes.map((ctx) => {
          if (ctx.__typename === 'CheckRun') {
            return { name: ctx.name, conclusion: ctx.conclusion?.toLowerCase() ?? null };
          }
          // StatusContext: map GitHub state string to conclusion-like values.
          const state = ctx.state.toLowerCase();
          return {
            name: ctx.context,
            conclusion: state === 'success' ? 'success' : state === 'pending' ? null : 'failure',
          };
        }),
        commits: pr.commits.nodes.map((n) => ({
          sha: n.commit.oid,
          messageHeadline: n.commit.messageHeadline,
          messageBody: n.commit.messageBody,
          committedDate: n.commit.committedDate,
          authorEmail: n.commit.author?.email ?? null,
          parents: n.commit.parents.totalCount,
        })),
        reviewRequests: pr.reviewRequests.nodes.flatMap<PullRequest['reviewRequests'][number]>(
          (r) => {
            const rr = r.requestedReviewer;
            if (!rr) return [];
            return rr.__typename === 'User'
              ? [{ kind: 'user', login: rr.login }]
              : [{ kind: 'team', login: rr.slug }];
          },
        ),
        reviews: pr.reviews.nodes
          .filter((r) => r.submittedAt !== null)
          .map((r) => ({
            author: r.author?.login ?? null,
            state: r.state,
            // submittedAt is non-null by the filter above.
            submittedAt: r.submittedAt as string,
          })),
        comments: pr.comments.nodes.map((c) => ({
          author: c.author?.login ?? null,
          createdAt: c.createdAt,
        })),
        body: pr.body ?? '',
        reviewThreads: pr.reviewThreads.nodes.map((t) => ({
          isResolved: t.isResolved,
          resolvedBy: t.resolvedBy?.login ?? null,
          comments: t.comments.nodes.map((c) => ({
            author: c.author?.login ?? null,
            createdAt: c.createdAt,
          })),
        })),
      };
    },
  };
}
