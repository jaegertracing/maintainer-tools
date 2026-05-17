// Thin adapter that turns an Octokit instance into the `CommentClient`
// shape the publisher expects. Lives next to the publisher so the
// publisher itself stays Octokit-free (easier to unit-test, easier to
// swap for a different transport later).

import type { CommentClient } from './publisher.js';

// Subset of Octokit we actually use. The full type from `@octokit/rest`
// is heavy and would force action subfolders to ncc-bundle the whole
// REST surface area; declaring just what we touch keeps the type
// dependency minimal.
interface IssuesApiSubset {
  listComments: (params: {
    owner: string;
    repo: string;
    issue_number: number;
    per_page?: number;
    page?: number;
  }) => Promise<{
    data: Array<{
      id: number;
      body?: string | null;
      created_at: string;
      user: { login: string } | null;
    }>;
  }>;
  createComment: (params: {
    owner: string;
    repo: string;
    issue_number: number;
    body: string;
  }) => Promise<{ data: { id: number; html_url: string } }>;
  updateComment: (params: {
    owner: string;
    repo: string;
    comment_id: number;
    body: string;
  }) => Promise<{ data: { id: number; html_url: string } }>;
}

export interface OctokitLike {
  rest: { issues: IssuesApiSubset };
}

export function octokitCommentClient(octokit: OctokitLike): CommentClient {
  return {
    async listComments(owner, repo, issueNumber) {
      // Manual pagination — listComments can exceed 100 on busy PRs and
      // we cannot afford to miss a prior footer on page 2. 100 per page is
      // the API max.
      const out: Array<{ id: number; body: string; createdAt: string; author: string | null }> = [];
      let page = 1;
      // eslint-disable-next-line no-constant-condition -- exit via break
      while (true) {
        const { data } = await octokit.rest.issues.listComments({
          owner,
          repo,
          issue_number: issueNumber,
          per_page: 100,
          page,
        });
        for (const c of data) {
          out.push({
            id: c.id,
            body: c.body ?? '',
            createdAt: c.created_at,
            author: c.user?.login ?? null,
          });
        }
        if (data.length < 100) break;
        page++;
      }
      return out;
    },
    async createComment(owner, repo, issueNumber, body) {
      const { data } = await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: issueNumber,
        body,
      });
      return { id: data.id, url: data.html_url };
    },
    async updateComment(owner, repo, commentId, body) {
      const { data } = await octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: commentId,
        body,
      });
      return { id: data.id, url: data.html_url };
    },
  };
}
