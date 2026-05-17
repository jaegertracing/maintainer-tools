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

export interface GraphqlClient {
  fetchViewerLogin(): Promise<string>;
  listOpenPRs(owner: string, repo: string): Promise<Array<{ number: number; updatedAt: string }>>;
  fetchPullRequest(owner: string, repo: string, number: number): Promise<PullRequest>;
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
        nodes { number updatedAt }
      }
    }
  }
`;

const VIEWER_QUERY = `query Viewer { viewer { login } }`;

export function createGraphqlClient(token: string): GraphqlClient {
  const gql = graphql.defaults({
    headers: { authorization: `token ${token}` },
  });

  return {
    async fetchViewerLogin() {
      const data = await gql<{ viewer: { login: string } }>(VIEWER_QUERY);
      return data.viewer.login;
    },

    async listOpenPRs(owner, repo) {
      type ListResp = {
        repository: {
          pullRequests: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: Array<{ number: number; updatedAt: string }>;
          };
        };
      };
      const out: Array<{ number: number; updatedAt: string }> = [];
      let cursor: string | null = null;
      // Paginate until exhausted. 100 PRs per page; most repos have one page.
      do {
        const data: ListResp = await gql<ListResp>(LIST_QUERY, { owner, repo, cursor });
        out.push(...data.repository.pullRequests.nodes);
        cursor = data.repository.pullRequests.pageInfo.hasNextPage
          ? data.repository.pullRequests.pageInfo.endCursor
          : null;
      } while (cursor);
      return out;
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
        commits: pr.commits.nodes.map((n) => ({
          sha: n.commit.oid,
          messageHeadline: n.commit.messageHeadline,
          messageBody: n.commit.messageBody,
          committedDate: n.commit.committedDate,
          authorEmail: n.commit.author?.email ?? null,
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
      };
    },
  };
}
