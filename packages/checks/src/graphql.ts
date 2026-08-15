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
import { refKey } from './issue-refs.js';
import type {
  AuthorAssociation,
  AuthorTypename,
  IssueMeta,
  IssueRef,
  PullRequest,
  ReviewState,
} from './types.js';

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
  // Look up author/state/title for a batch of referenced issues in one
  // request. Returns a map keyed by `refKey()`; a reference that doesn't
  // resolve (deleted, wrong repo, or a number that was never valid) is
  // simply absent from the map rather than throwing, because contributors
  // do write `Fixes #<nonexistent>`.
  fetchIssues(refs: IssueRef[]): Promise<Map<string, IssueMeta>>;
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
  files: {
    nodes: Array<{ path: string; additions: number; deletions: number; changeType: string }>;
  };
  reviewRequests: {
    nodes: Array<{
      requestedReviewer:
        { __typename: 'User'; login: string } | { __typename: 'Team'; slug: string } | null;
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
    totalCount: number;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
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
        statusCheckRollup: { state: PullRequest['statusCheckRollup'] } | null;
        parents: { totalCount: number };
      };
    }>;
  };
  // Separate head-only selection so we can fetch check contexts without
  // paying for them on all 100 commits (which are only needed for DCO).
  headCommit: {
    nodes: Array<{
      commit: {
        statusCheckRollup: {
          contexts: {
            totalCount: number;
            nodes: Array<
              | { __typename: 'CheckRun'; name: string; conclusion: string | null }
              | { __typename: 'StatusContext'; context: string; state: string }
            >;
          };
        } | null;
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
        files(first: 100) { nodes { path additions deletions changeType } }
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
          totalCount
          pageInfo { hasNextPage endCursor }
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
              statusCheckRollup { state }
              parents { totalCount }
            }
          }
        }
        headCommit: commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                contexts(first: 100) {
                  totalCount
                  nodes {
                    __typename
                    ... on CheckRun { name conclusion }
                    ... on StatusContext { context state }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

// Review threads beyond the first page. Only fired for the rare PR that has
// more than 100 of them, so the ordinary PR costs no extra request.
const REVIEW_THREADS_QUERY = `
  query ReviewThreads($owner: String!, $repo: String!, $number: Int!, $cursor: String!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
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

// How many issue lookups to put in one aliased query. GitHub's GraphQL node
// limit is generous for this shape (each alias fetches one node with three
// scalar fields), and 50 keeps the query text well short of any practical
// request-size limit.
const ISSUE_BATCH_SIZE = 50;

// `issueOrPullRequest` rather than `issue`: closing keywords accept any
// number, and contributors do point them at pull requests. Resolving both
// lets the caller report that rather than showing a blank.
function buildIssueQuery(refs: IssueRef[]): string {
  const parts = refs.map(
    (ref, i) => `    a${i}: repository(owner: ${JSON.stringify(ref.owner)}, name: ${JSON.stringify(
      ref.repo,
    )}) {
      issueOrPullRequest(number: ${ref.number}) {
        __typename
        ... on Issue { title state author { login } }
        ... on PullRequest { title prState: state author { login } }
      }
    }`,
  );
  return `query IssueBatch {\n${parts.join('\n')}\n}`;
}

type IssueOrPrNode = {
  __typename: string;
  title: string;
  state?: string;
  prState?: string;
  author: { login: string } | null;
} | null;

type RawReviewThread = {
  isResolved: boolean;
  resolvedBy: { login: string } | null;
  comments: { nodes: Array<{ author: { login: string } | null; createdAt: string }> };
};

function mapReviewThread(t: RawReviewThread): NonNullable<PullRequest['reviewThreads']>[number] {
  return {
    isResolved: t.isResolved,
    resolvedBy: t.resolvedBy?.login ?? null,
    comments: t.comments.nodes.map((c) => ({
      author: c.author?.login ?? null,
      createdAt: c.createdAt,
    })),
  };
}

// Walk the remaining review-thread pages. `reviewThreads` caps at 100 per page
// and jaeger has a PR with 181 threads, so without this the counts derived from
// them are a prefix: that PR reports 47 unresolved threads out of 118, and
// `resolved_without_reply` undercounts 57 as 53.
async function fetchRemainingReviewThreads(
  gql: typeof graphql,
  owner: string,
  repo: string,
  number: number,
  startCursor: string,
): Promise<Array<NonNullable<PullRequest['reviewThreads']>[number]>> {
  const out: Array<NonNullable<PullRequest['reviewThreads']>[number]> = [];
  let cursor: string | null = startCursor;
  while (cursor) {
    const data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: RawReviewThread[];
          };
        };
      };
    } = await gql(REVIEW_THREADS_QUERY, { owner, repo, number, cursor });
    const rt = data.repository.pullRequest.reviewThreads;
    out.push(...rt.nodes.map(mapReviewThread));
    cursor = rt.pageInfo.hasNextPage ? rt.pageInfo.endCursor : null;
  }
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

    async fetchIssues(refs) {
      const out = new Map<string, IssueMeta>();
      for (let i = 0; i < refs.length; i += ISSUE_BATCH_SIZE) {
        const batch = refs.slice(i, i + ISSUE_BATCH_SIZE);
        let data: Record<string, { issueOrPullRequest: IssueOrPrNode } | null>;
        try {
          data = await gql<Record<string, { issueOrPullRequest: IssueOrPrNode } | null>>(
            buildIssueQuery(batch),
          );
        } catch (err: unknown) {
          // A batch can carry NOT_FOUND errors for individual aliases while
          // still returning usable `data` for the rest. Octokit throws on any
          // `errors` entry, so recover the partial payload instead of losing
          // the whole batch to one bad reference.
          const partial = (err as { data?: Record<string, { issueOrPullRequest: IssueOrPrNode }> })
            .data;
          if (!partial) continue;
          data = partial;
        }
        batch.forEach((ref, j) => {
          const node = data[`a${j}`]?.issueOrPullRequest;
          if (!node) return;
          const isPr = node.__typename === 'PullRequest';
          const state = (isPr ? node.prState : node.state) ?? 'OPEN';
          out.set(refKey(ref), {
            author: node.author?.login ?? null,
            state: state as IssueMeta['state'],
            title: node.title,
            isPullRequest: isPr,
          });
        });
      }
      return out;
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
      const headCheckRollup = pr.headCommit.nodes[0]?.commit.statusCheckRollup;
      const threads = pr.reviewThreads.nodes.map(mapReviewThread);
      const nextThreadCursor = pr.reviewThreads.pageInfo.endCursor;
      if (pr.reviewThreads.pageInfo.hasNextPage && nextThreadCursor) {
        threads.push(
          ...(await fetchRemainingReviewThreads(gql, owner, repo, number, nextThreadCursor)),
        );
      }
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
        fileStats: pr.files.nodes.map((f) => ({
          path: f.path,
          additions: f.additions,
          deletions: f.deletions,
          changeType: f.changeType.toLowerCase(),
        })),
        statusCheckRollup: head?.commit.statusCheckRollup?.state ?? null,
        headCheckRunsTruncated:
          headCheckRollup !== undefined && headCheckRollup !== null
            ? headCheckRollup.contexts.totalCount > headCheckRollup.contexts.nodes.length
            : undefined,
        headCheckRuns: headCheckRollup?.contexts.nodes.map((ctx) => {
          if (ctx.__typename === 'CheckRun') {
            return { name: ctx.name, conclusion: ctx.conclusion?.toLowerCase() ?? null };
          }
          // StatusContext: map GitHub's PENDING/EXPECTED to null (not yet run),
          // SUCCESS to 'success', and ERROR/FAILURE to 'failure'.
          const state = ctx.state.toUpperCase();
          const conclusion =
            state === 'SUCCESS'
              ? 'success'
              : state === 'PENDING' || state === 'EXPECTED'
                ? null
                : 'failure';
          return { name: ctx.context, conclusion };
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
        reviewThreads: threads,
      };
    },
  };
}
