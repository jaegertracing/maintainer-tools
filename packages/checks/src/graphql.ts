// Octokit GraphQL data layer. One query per PR pulls every field the P0
// predicates need (reviews, status rollup, mergeable, recent commits, labels).
// Cache eviction is keyed by `updatedAt` — see cache.ts.

import { graphql } from '@octokit/graphql';
import type { PullRequest } from './types.js';

export interface GraphqlClient {
  fetchPullRequest(owner: string, repo: string, number: number): Promise<PullRequest>;
}

// Narrow GraphQL response shape for the single PR query below.
interface PullRequestNode {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  updatedAt: string;
  author: { login: string } | null;
  labels: { nodes: Array<{ name: string }> };
  commits: {
    nodes: Array<{
      commit: {
        oid: string;
        messageHeadline: string;
        messageBody: string;
        authoredByCommitter: boolean;
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
        updatedAt
        author { login }
        labels(first: 50) { nodes { name } }
        commits(last: 100) {
          nodes {
            commit {
              oid
              messageHeadline
              messageBody
              author { email }
              statusCheckRollup { state }
            }
          }
        }
      }
    }
  }
`;

export function createGraphqlClient(token: string): GraphqlClient {
  const gql = graphql.defaults({
    headers: { authorization: `token ${token}` },
  });

  return {
    async fetchPullRequest(owner, repo, number) {
      const data = await gql<{ repository: { pullRequest: PullRequestNode } }>(PR_QUERY, {
        owner,
        repo,
        number,
      });
      const pr = data.repository.pullRequest;
      // The statusCheckRollup lives on the *head* commit (last in the array).
      const head = pr.commits.nodes[pr.commits.nodes.length - 1];
      return {
        repo: { owner, name: repo },
        number: pr.number,
        title: pr.title,
        url: pr.url,
        author: pr.author,
        isDraft: pr.isDraft,
        mergeable: pr.mergeable,
        updatedAt: pr.updatedAt,
        labels: pr.labels.nodes.map((l) => l.name),
        statusCheckRollup: head?.commit.statusCheckRollup?.state ?? null,
        commits: pr.commits.nodes.map((n) => ({
          sha: n.commit.oid,
          messageHeadline: n.commit.messageHeadline,
          messageBody: n.commit.messageBody,
          authorEmail: n.commit.author?.email ?? null,
        })),
      };
    },
  };
}
