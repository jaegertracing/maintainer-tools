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

import { graphql, type withCustomRequest } from '@octokit/graphql';
import { retryRequest } from './retry.js';
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

export interface TreeEntryNode {
  oid: string;
  mode: number;
  type: string;
}

export type FileEntryResult =
  | { status: 'found'; entry: TreeEntryNode }
  | { status: 'absent' }
  | { status: 'unavailable'; message: string };

export interface CommitPathComparison {
  candidateOid: string;
  parentOid: string | null;
  path: string;
  candidateResult: FileEntryResult;
  parentResult: FileEntryResult;
}

export interface ExternalCommitParents {
  oid: string;
  parentOids: string[];
  parentsTruncated: boolean;
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
  // Compares tree entries (file) between candidate commit and its parent for
  // specific file paths in one batched query, distinguishing additions, modifications,
  // deletions, unchanged files, and execution errors.
  fetchCommitPathComparison(
    owner: string,
    repo: string,
    candidateOid: string,
    parentOid: string | null,
    paths: string[],
  ): Promise<Map<string, CommitPathComparison>>;
  // Look up parent OIDs and truncation state for a batch of commit OIDs in one request
  // using aliased fields. Returns a map keyed by commit OID.
  fetchBatchCommitParents(
    owner: string,
    repo: string,
    oids: string[],
  ): Promise<Map<string, ExternalCommitParents>>;
}

interface RawRequestedReviewer {
  __typename: string;
  login?: string;
  slug?: string;
}

interface RawCommitNode {
  commit: {
    oid: string;
    messageHeadline: string;
    messageBody: string;
    committedDate: string;
    author: {
      email: string | null;
      user: { login: string; __typename?: AuthorTypename } | null;
    } | null;
    parents: {
      totalCount: number;
      pageInfo?: { hasNextPage: boolean; endCursor: string | null };
      nodes?: Array<{ oid: string }>;
    };
    changedFilesIfAvailable?: number | null;
  };
}

interface PullRequestNode {
  number: number;
  title: string;
  url: string;
  headRefOid: string;
  baseRefOid: string;
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
  labels: {
    totalCount: number;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: Array<{ name: string }>;
  };
  files: {
    totalCount: number;
    pageInfo: { hasNextPage: boolean };
    nodes: Array<{ path: string; additions: number; deletions: number; changeType: string }>;
  };
  reviewRequests: {
    totalCount: number;
    nodes: Array<{
      requestedReviewer: RawRequestedReviewer | null;
    }>;
  };
  reviews: {
    totalCount: number;
    pageInfo?: { hasPreviousPage: boolean; startCursor: string | null };
    nodes: Array<{
      id?: string;
      author: { login: string; __typename: AuthorTypename } | null;
      state: ReviewState;
      submittedAt: string | null;
      commit?: { oid: string } | null;
      url: string;
      body: string;
    }>;
  };
  reviewThreads: {
    totalCount: number;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: RawReviewThread[];
  };
  comments: {
    totalCount: number;
    nodes: Array<{
      author: { login: string; __typename: AuthorTypename } | null;
      authorAssociation: AuthorAssociation;
      createdAt: string;
    }>;
  };
  commits: {
    totalCount: number;
    pageInfo: { hasPreviousPage: boolean; startCursor: string | null };
    nodes: Array<RawCommitNode>;
  };
  // Separate head-only selection so we can fetch check contexts without
  // paying for them on all 100 commits (which are only needed for DCO).
  headCommit: {
    nodes: Array<{
      commit: {
        statusCheckRollup: {
          state: PullRequest['statusCheckRollup'];
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
        headRefOid
        baseRefOid
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
        labels(first: 50) {
          totalCount
          pageInfo { hasNextPage endCursor }
          nodes { name }
        }
        files(first: 100) {
          totalCount
          pageInfo { hasNextPage }
          nodes { path additions deletions changeType }
        }
        reviewRequests(first: 50) {
          totalCount
          nodes {
            requestedReviewer {
              __typename
              ... on User { login }
              ... on Team { slug }
            }
          }
        }
        reviews(last: 50) {
          totalCount
          pageInfo { hasPreviousPage startCursor }
          nodes {
            id
            author { login __typename }
            state
            submittedAt
            commit { oid }
            url
            body
          }
        }
        reviewThreads(first: 100) {
          totalCount
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            path
            isResolved
            resolvedBy { login }
            comments(first: 50) {
              totalCount
              pageInfo { hasNextPage endCursor }
              nodes {
                id
                author { login __typename }
                authorAssociation
                createdAt
                commit { oid }
                originalCommit { oid }
                pullRequestReview {
                  id
                  state
                  submittedAt
                  commit { oid }
                }
              }
            }
          }
        }
        comments(last: 50) {
          totalCount
          nodes {
            author { login __typename }
            authorAssociation
            createdAt
          }
        }
        commits(last: 100) {
          totalCount
          pageInfo { hasPreviousPage startCursor }
          nodes {
            commit {
              oid
              messageHeadline
              messageBody
              committedDate
              author { email user { login __typename } }
              parents(first: 10) {
                totalCount
                pageInfo { hasNextPage endCursor }
                nodes { oid }
              }
              changedFilesIfAvailable
            }
          }
        }
        headCommit: commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                state
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

const REVIEWS_BEFORE_QUERY = `
  query ReviewsBefore($owner: String!, $repo: String!, $number: Int!, $cursor: String!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviews(last: 50, before: $cursor) {
          pageInfo { hasPreviousPage startCursor }
          nodes {
            id
            author { login __typename }
            state
            submittedAt
            commit { oid }
            url
            body
          }
        }
      }
    }
  }
`;

type RawReviewNode = PullRequestNode['reviews']['nodes'][number];

const MAX_REVIEW_NODES = 2_000;
const MAX_REVIEW_THREAD_NODES = 2_000;

function mapReviewNode(r: RawReviewNode, number: number): PullRequest['reviews'][number] {
  if (!r.id) {
    throw new Error(`Review in PR #${number} response missing authoritative id`);
  }
  return {
    id: r.id,
    author: r.author?.login ?? null,
    authorTypename: r.author?.__typename ?? null,
    state: r.state,
    submittedAt: r.submittedAt ?? '',
    commitOid: r.commit?.oid ?? null,
    url: r.url,
    body: r.body,
  };
}

async function fetchRemainingReviews(
  gql: typeof graphql,
  owner: string,
  repo: string,
  number: number,
  startCursor: string,
): Promise<{ reviews: PullRequest['reviews']; complete: boolean }> {
  const out: PullRequest['reviews'] = [];
  let cursor: string | null = startCursor;
  let complete = true;
  const seenCursors = new Set<string>();
  while (cursor && out.length < MAX_REVIEW_NODES) {
    if (seenCursors.has(cursor)) {
      complete = false;
      break;
    }
    seenCursors.add(cursor);
    const data: {
      repository: {
        pullRequest: {
          reviews: {
            pageInfo: { hasPreviousPage: boolean; startCursor: string | null };
            nodes: RawReviewNode[];
          };
        };
      };
    } = await gql(REVIEWS_BEFORE_QUERY, { owner, repo, number, cursor });
    const reviews = data.repository.pullRequest.reviews;
    out.push(...reviews.nodes.map((r) => mapReviewNode(r, number)));
    if (out.length > MAX_REVIEW_NODES) {
      out.length = MAX_REVIEW_NODES;
      complete = false;
      cursor = null;
      break;
    }
    if (reviews.pageInfo.hasPreviousPage && !reviews.pageInfo.startCursor) {
      complete = false;
      cursor = null;
    } else {
      cursor = reviews.pageInfo.hasPreviousPage ? reviews.pageInfo.startCursor : null;
    }
  }
  if (cursor) complete = false;
  return { reviews: out, complete };
}

// Review threads beyond the first page. Only fired for the rare PR that has
// more than 100 of them, so the ordinary PR costs no extra request.
const REVIEW_THREADS_QUERY = `
  query ReviewThreads($owner: String!, $repo: String!, $number: Int!, $cursor: String!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            path
            isResolved
            resolvedBy { login }
            comments(first: 50) {
              totalCount
              pageInfo { hasNextPage endCursor }
              nodes {
                id
                author { login __typename }
                authorAssociation
                createdAt
                commit { oid }
                originalCommit { oid }
                pullRequestReview {
                  id
                  state
                  submittedAt
                  commit { oid }
                }
              }
            }
          }
        }
      }
    }
  }
`;

const REVIEW_THREAD_COMMENTS_QUERY = `
  query ReviewThreadComments($threadId: ID!, $cursor: String!) {
    node(id: $threadId) {
      ... on PullRequestReviewThread {
        comments(first: 50, after: $cursor) {
          totalCount
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            author { login __typename }
            authorAssociation
            createdAt
            commit { oid }
            originalCommit { oid }
            pullRequestReview {
              id
              state
              submittedAt
              commit { oid }
            }
          }
        }
      }
    }
  }
`;

const COMMITS_BEFORE_QUERY = `
  query CommitsBefore($owner: String!, $repo: String!, $number: Int!, $cursor: String!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        commits(last: 100, before: $cursor) {
          pageInfo { hasPreviousPage startCursor }
          nodes {
            commit {
              oid
              messageHeadline
              messageBody
              committedDate
              author { email user { login __typename } }
              parents(first: 10) {
                totalCount
                pageInfo { hasNextPage endCursor }
                nodes { oid }
              }
              changedFilesIfAvailable
            }
          }
        }
      }
    }
  }
`;

const PR_HEAD_SNAPSHOT_QUERY = `
  query PRHeadSnapshot($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        headRefOid
        baseRefOid
        commits(last: 1) { totalCount }
      }
    }
  }
`;

const COMMITS_INITIAL_QUERY = `
  query CommitsInitial($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        headRefOid
        baseRefOid
        commits(last: 100) {
          totalCount
          pageInfo { hasPreviousPage startCursor }
          nodes {
            commit {
              oid
              messageHeadline
              messageBody
              committedDate
              author { email user { login __typename } }
              parents(first: 10) {
                totalCount
                pageInfo { hasNextPage endCursor }
                nodes { oid }
              }
              changedFilesIfAvailable
            }
          }
        }
      }
    }
  }
`;

const LABELS_PAGE_QUERY = `
  query PRLabels($owner: String!, $repo: String!, $number: Int!, $cursor: String!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        updatedAt
        labels(first: 100, after: $cursor) {
          totalCount
          pageInfo { hasNextPage endCursor }
          nodes { name }
        }
      }
    }
  }
`;

const MAX_LABEL_NODES = 1_000;

async function fetchAllLabels(
  gql: typeof graphql,
  owner: string,
  repo: string,
  number: number,
  updatedAt: string,
  initial: PullRequestNode['labels'],
): Promise<string[]> {
  const labelNames = initial.nodes.map((label) => label.name);
  const expectedTotal = initial.totalCount;
  const seenLabelNames = new Set(labelNames);
  const context = `Pull request ${owner}/${repo}#${number}`;

  if (expectedTotal > MAX_LABEL_NODES) {
    throw new Error(`${context} has more than ${MAX_LABEL_NODES} labels`);
  }
  if (labelNames.length > expectedTotal) {
    throw new Error(`${context} label response contains more labels than its totalCount`);
  }
  if (seenLabelNames.size !== labelNames.length) {
    throw new Error(`${context} label response contains duplicate labels`);
  }
  if (!initial.pageInfo.hasNextPage) {
    if (labelNames.length !== expectedTotal) {
      throw new Error(`${context} label response is incomplete`);
    }
    return labelNames;
  }

  let cursor = initial.pageInfo.endCursor;
  const seenCursors = new Set<string>();
  while (true) {
    if (!cursor || seenCursors.has(cursor)) {
      throw new Error(`${context} label pagination did not advance`);
    }
    seenCursors.add(cursor);

    const data: {
      repository: {
        pullRequest: {
          updatedAt: string;
          labels: PullRequestNode['labels'];
        };
      };
    } = await gql(LABELS_PAGE_QUERY, { owner, repo, number, cursor });
    const pr = data.repository.pullRequest;
    if (pr.updatedAt !== updatedAt || pr.labels.totalCount !== expectedTotal) {
      throw new Error(`${context} changed while labels were being paginated`);
    }

    const page = pr.labels;
    if (page.nodes.length === 0 && page.pageInfo.hasNextPage) {
      throw new Error(`${context} label pagination returned an empty page`);
    }
    for (const label of page.nodes) {
      if (seenLabelNames.has(label.name)) {
        throw new Error(`${context} label pagination returned a duplicate label`);
      }
      seenLabelNames.add(label.name);
      labelNames.push(label.name);
    }
    if (labelNames.length > expectedTotal) {
      throw new Error(`${context} label response contains more labels than its totalCount`);
    }

    if (!page.pageInfo.hasNextPage) {
      if (labelNames.length !== expectedTotal) {
        throw new Error(`${context} label response is incomplete`);
      }
      return labelNames;
    }
    cursor = page.pageInfo.endCursor;
  }
}

const LIST_QUERY = `
  query ListPRs($owner: String!, $repo: String!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequests(states: OPEN, first: 50, after: $cursor, orderBy: {field: UPDATED_AT, direction: DESC}) {
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
      pullRequests(states: OPEN, labels: [$label], first: 50, after: $cursor, orderBy: {field: UPDATED_AT, direction: DESC}) {
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
  const seenNumbers = new Set<number>();
  let cursor: string | null = null;
  do {
    const data: ListResp = await gql<ListResp>(query, { ...vars, cursor });
    for (const n of data.repository.pullRequests.nodes) {
      if (seenNumbers.has(n.number)) {
        throw new Error(`GitHub returned a duplicate open PR #${n.number}`);
      }
      seenNumbers.add(n.number);
      const head = n.commits.nodes[0]?.commit;
      out.push({
        number: n.number,
        updatedAt: n.updatedAt,
        headSha: head?.oid ?? null,
        headRollup: head?.statusCheckRollup?.state ?? null,
      });
    }
    const pageInfo = data.repository.pullRequests.pageInfo;
    if (pageInfo.hasNextPage && !pageInfo.endCursor) {
      throw new Error('GitHub returned hasNextPage without an endCursor for open PRs');
    }
    if (pageInfo.hasNextPage && pageInfo.endCursor === cursor) {
      throw new Error('GitHub returned a repeated endCursor for open PRs');
    }
    cursor = pageInfo.hasNextPage ? pageInfo.endCursor : null;
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

type RawReviewThreadComment = {
  id?: string;
  author: { login: string; __typename?: AuthorTypename } | null;
  authorAssociation: AuthorAssociation;
  createdAt: string;
  commit?: { oid: string } | null;
  originalCommit?: { oid: string } | null;
  pullRequestReview?: {
    id: string;
    state: ReviewState;
    submittedAt: string | null;
    commit?: { oid: string } | null;
  } | null;
};

type RawReviewThread = {
  id: string;
  path?: string;
  isResolved: boolean;
  resolvedBy: { login: string } | null;
  comments: {
    totalCount?: number;
    pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
    nodes?: RawReviewThreadComment[];
  };
};

function mapReviewThread(
  t: RawReviewThread,
  nodes: RawReviewThreadComment[],
  commentsComplete: boolean,
): NonNullable<PullRequest['reviewThreads']>[number] {
  return {
    path: t.path,
    isResolved: t.isResolved,
    resolvedBy: t.resolvedBy?.login ?? null,
    commentsTruncated: !commentsComplete,
    comments: nodes.map((c) => ({
      author: c.author?.login ?? null,
      authorTypename: c.author?.__typename ?? null,
      authorAssociation: c.authorAssociation,
      createdAt: c.createdAt,
      commitOid: c.commit?.oid ?? null,
      originalCommitOid: c.originalCommit?.oid ?? null,
      pullRequestReview: c.pullRequestReview
        ? {
            id: c.pullRequestReview.id,
            state: c.pullRequestReview.state,
            submittedAt: c.pullRequestReview.submittedAt ?? null,
            commitOid: c.pullRequestReview.commit?.oid ?? null,
          }
        : null,
    })),
  };
}

const MAX_REVIEW_THREAD_COMMENT_NODES = 2_000;

async function fetchCompleteReviewThread(
  gql: typeof graphql,
  thread: RawReviewThread,
): Promise<NonNullable<PullRequest['reviewThreads']>[number]> {
  const nodes = [...(thread.comments.nodes ?? [])];
  const totalCount = thread.comments.totalCount;
  const pageInfo = thread.comments.pageInfo;
  const seenIds = new Set(nodes.flatMap((comment) => (comment.id ? [comment.id] : [])));
  const hasDuplicateInitialIds = seenIds.size < nodes.filter((comment) => comment.id).length;
  const cursor = pageInfo?.hasNextPage ? pageInfo.endCursor : null;

  if (!pageInfo?.hasNextPage) {
    return mapReviewThread(
      thread,
      nodes,
      totalCount !== undefined && totalCount === nodes.length && !hasDuplicateInitialIds,
    );
  }

  if (
    !thread.id ||
    !cursor ||
    totalCount === undefined ||
    hasDuplicateInitialIds ||
    nodes.length >= MAX_REVIEW_THREAD_COMMENT_NODES
  ) {
    return mapReviewThread(thread, nodes, false);
  }

  const seenCursors = new Set<string>();
  let nextCursor: string | null = cursor;
  while (nextCursor && nodes.length < MAX_REVIEW_THREAD_COMMENT_NODES) {
    if (seenCursors.has(nextCursor)) break;
    seenCursors.add(nextCursor);
    try {
      const data: {
        node: {
          comments: {
            totalCount: number;
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: RawReviewThreadComment[];
          };
        } | null;
      } = await gql(REVIEW_THREAD_COMMENTS_QUERY, { threadId: thread.id, cursor: nextCursor });
      const page = data.node?.comments;
      if (
        !page ||
        page.totalCount !== totalCount ||
        (page.nodes.length === 0 && page.pageInfo.hasNextPage)
      ) {
        break;
      }
      let hasDuplicate = false;
      for (const comment of page.nodes) {
        if (!comment.id || seenIds.has(comment.id)) {
          hasDuplicate = true;
          break;
        }
        seenIds.add(comment.id);
      }
      if (hasDuplicate) break;
      nodes.push(...page.nodes);
      if (nodes.length > MAX_REVIEW_THREAD_COMMENT_NODES) break;
      if (page.pageInfo.hasNextPage && !page.pageInfo.endCursor) break;
      nextCursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } catch {
      break;
    }
  }

  const complete =
    nextCursor === null &&
    totalCount === nodes.length &&
    nodes.length <= MAX_REVIEW_THREAD_COMMENT_NODES;
  return mapReviewThread(thread, nodes, complete);
}

async function mapReviewThreads(
  gql: typeof graphql,
  threads: RawReviewThread[],
): Promise<Array<NonNullable<PullRequest['reviewThreads']>[number]>> {
  const mapped: Array<NonNullable<PullRequest['reviewThreads']>[number]> = [];
  for (let index = 0; index < threads.length; index += 10) {
    const batch = threads.slice(index, index + 10);
    mapped.push(
      ...(await Promise.all(batch.map((thread) => fetchCompleteReviewThread(gql, thread)))),
    );
  }
  return mapped;
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
): Promise<{
  threads: Array<NonNullable<PullRequest['reviewThreads']>[number]>;
  complete: boolean;
}> {
  const out: Array<NonNullable<PullRequest['reviewThreads']>[number]> = [];
  let cursor: string | null = startCursor;
  let complete = true;
  const seenCursors = new Set<string>();
  while (cursor && out.length < MAX_REVIEW_THREAD_NODES) {
    if (seenCursors.has(cursor)) {
      complete = false;
      break;
    }
    seenCursors.add(cursor);
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
    out.push(...(await mapReviewThreads(gql, rt.nodes)));
    if (out.length > MAX_REVIEW_THREAD_NODES) {
      out.length = MAX_REVIEW_THREAD_NODES;
      complete = false;
      cursor = null;
      break;
    }
    if (rt.pageInfo.hasNextPage && !rt.pageInfo.endCursor) {
      complete = false;
      cursor = null;
    } else {
      cursor = rt.pageInfo.hasNextPage ? rt.pageInfo.endCursor : null;
    }
  }
  if (cursor) complete = false;
  return { threads: out, complete };
}

interface CommitPaginationResult {
  commits: PullRequest['commits'];
  commitsTruncated: boolean;
}

const MAX_COMMIT_NODES = 2_000;

function mapCommitNode(n: RawCommitNode): PullRequest['commits'][number] {
  const parentsCount = n.commit.parents.totalCount;
  const parentOids = n.commit.parents.nodes?.map((p) => p.oid) ?? [];
  const parentsTruncated =
    parentsCount > parentOids.length || Boolean(n.commit.parents.pageInfo?.hasNextPage);

  return {
    sha: n.commit.oid,
    messageHeadline: n.commit.messageHeadline,
    messageBody: n.commit.messageBody,
    committedDate: n.commit.committedDate,
    authorEmail: n.commit.author?.email ?? null,
    authorLogin: n.commit.author?.user?.login ?? null,
    authorTypename: n.commit.author?.user?.__typename ?? null,
    parents: parentsCount,
    parentOids,
    parentsTruncated,
    changedFilesIfAvailable: n.commit.changedFilesIfAvailable ?? null,
  };
}

async function fetchCommitsPass(
  gql: typeof graphql,
  owner: string,
  repo: string,
  number: number,
  initialHeadRefOid: string,
  initialBaseRefOid: string,
  initialTotalCount: number,
  initialNodes: RawCommitNode[],
  initialHasPreviousPage: boolean,
  initialStartCursor: string | null,
): Promise<{
  allNodes: RawCommitNode[];
  isTruncated: boolean;
  isConsistent: boolean;
}> {
  let allNodes = [...initialNodes];
  let hasPrevious = initialHasPreviousPage;
  let cursor = initialStartCursor;
  const seenCursors = new Set<string>();
  let hitSafetyCeiling = allNodes.length >= MAX_COMMIT_NODES;

  while (hasPrevious && cursor && allNodes.length < MAX_COMMIT_NODES) {
    if (seenCursors.has(cursor)) break;
    seenCursors.add(cursor);
    const data: {
      repository: {
        pullRequest: {
          commits: {
            pageInfo: { hasPreviousPage: boolean; startCursor: string | null };
            nodes: RawCommitNode[];
          };
        };
      };
    } = await gql(COMMITS_BEFORE_QUERY, { owner, repo, number, cursor });

    const page = data.repository.pullRequest.commits;
    if (page.nodes.length === 0) break;

    // Prepend older commits to maintain chronological order where newest commit stays last
    allNodes = [...page.nodes, ...allNodes];
    if (allNodes.length > MAX_COMMIT_NODES) {
      // Keep the newest commits, including the head, because classifier and
      // DCO checks depend on the snapshot head remaining the final element.
      allNodes = allNodes.slice(-MAX_COMMIT_NODES);
      hitSafetyCeiling = true;
      break;
    }
    hasPrevious = page.pageInfo.hasPreviousPage;
    cursor = page.pageInfo.startCursor;
  }

  let isTruncated = hitSafetyCeiling;
  if (hasPrevious || initialTotalCount > allNodes.length) {
    isTruncated = true;
  }

  // Validate head and base snapshot consistency after pagination
  const snapshot: {
    repository: {
      pullRequest: {
        headRefOid: string;
        baseRefOid: string;
        commits: { totalCount: number };
      };
    };
  } = await gql(PR_HEAD_SNAPSHOT_QUERY, { owner, repo, number });

  const currentHeadOid = snapshot.repository.pullRequest.headRefOid;
  const currentBaseRefOid = snapshot.repository.pullRequest.baseRefOid;
  const currentTotalCount = snapshot.repository.pullRequest.commits.totalCount;

  const lastNode = allNodes[allNodes.length - 1];
  const isConsistent =
    currentHeadOid === initialHeadRefOid &&
    currentBaseRefOid === initialBaseRefOid &&
    currentTotalCount === initialTotalCount &&
    lastNode?.commit.oid === initialHeadRefOid;

  // Deduplicate and verify SHA uniqueness
  const shaSet = new Set<string>();
  let hasDuplicate = false;
  for (const n of allNodes) {
    if (shaSet.has(n.commit.oid)) {
      hasDuplicate = true;
      break;
    }
    shaSet.add(n.commit.oid);
  }
  if (hasDuplicate) {
    isTruncated = true;
  }

  if (!isTruncated && allNodes.length === initialTotalCount) {
    isTruncated = false;
  } else {
    isTruncated = true;
  }

  return { allNodes, isTruncated, isConsistent };
}

async function fetchRemainingCommits(
  gql: typeof graphql,
  owner: string,
  repo: string,
  number: number,
  initialHeadRefOid: string,
  initialBaseRefOid: string,
  initialTotalCount: number,
  initialNodes: RawCommitNode[],
  initialHasPreviousPage: boolean,
  initialStartCursor: string | null,
): Promise<CommitPaginationResult> {
  let pass = await fetchCommitsPass(
    gql,
    owner,
    repo,
    number,
    initialHeadRefOid,
    initialBaseRefOid,
    initialTotalCount,
    initialNodes,
    initialHasPreviousPage,
    initialStartCursor,
  );

  // If head or base changed during pagination, retry complete commit retrieval once
  if (!pass.isConsistent) {
    try {
      const fresh: {
        repository: {
          pullRequest: {
            headRefOid: string;
            baseRefOid: string;
            commits: {
              totalCount: number;
              pageInfo: { hasPreviousPage: boolean; startCursor: string | null };
              nodes: RawCommitNode[];
            };
          };
        };
      } = await gql(COMMITS_INITIAL_QUERY, { owner, repo, number });

      const freshPr = fresh.repository.pullRequest;
      pass = await fetchCommitsPass(
        gql,
        owner,
        repo,
        number,
        freshPr.headRefOid,
        freshPr.baseRefOid,
        freshPr.commits.totalCount,
        freshPr.commits.nodes,
        freshPr.commits.pageInfo.hasPreviousPage,
        freshPr.commits.pageInfo.startCursor,
      );

      if (!pass.isConsistent) {
        pass.isTruncated = true;
      }
    } catch {
      pass.isTruncated = true;
    }
  }

  return {
    commits: pass.allNodes.map(mapCommitNode),
    commitsTruncated: pass.isTruncated,
  };
}

export function createGraphqlClient(token: string): GraphqlClient {
  const gql = graphql.defaults({
    headers: { authorization: `token ${token}` },
    request: {
      hook: (
        request: Parameters<typeof withCustomRequest>[0],
        options: Parameters<typeof graphql.defaults>[0] & { url: string },
      ) => retryRequest(() => request(options)),
    },
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
      const labels = await fetchAllLabels(gql, owner, repo, number, pr.updatedAt, pr.labels);
      const headCheckRollup = pr.headCommit.nodes[0]?.commit.statusCheckRollup;
      const threads = await mapReviewThreads(gql, pr.reviewThreads.nodes);
      const nextThreadCursor = pr.reviewThreads.pageInfo.endCursor;
      let reviewThreadsTruncated = pr.reviewThreads.pageInfo.hasNextPage;

      if (pr.reviewThreads.pageInfo.hasNextPage && nextThreadCursor) {
        try {
          const remainingThreads = await fetchRemainingReviewThreads(
            gql,
            owner,
            repo,
            number,
            nextThreadCursor,
          );
          threads.push(...remainingThreads.threads);
          reviewThreadsTruncated =
            !remainingThreads.complete || pr.reviewThreads.totalCount > threads.length;
        } catch {
          reviewThreadsTruncated = true;
        }
      } else {
        reviewThreadsTruncated =
          reviewThreadsTruncated || pr.reviewThreads.totalCount > threads.length;
      }

      // A cursor can advance while the server still repeats an item from the
      // previous page. Count-based checks alone would then mistake an
      // overlapping page for complete coverage and could hide a thread.
      const threadKeys = new Set(
        threads.map((thread) =>
          JSON.stringify({
            path: thread.path ?? null,
            isResolved: thread.isResolved,
            resolvedBy: thread.resolvedBy,
            comments: thread.comments.map((comment) => [
              comment.author,
              comment.createdAt,
              comment.commitOid,
              comment.originalCommitOid,
            ]),
          }),
        ),
      );
      if (threadKeys.size !== threads.length) {
        reviewThreadsTruncated = true;
      }

      // Review requests mapping
      const rawReviewRequests = pr.reviewRequests;
      let hasUnknownReviewerKind = false;
      const reviewRequests = rawReviewRequests.nodes.flatMap<PullRequest['reviewRequests'][number]>(
        (r) => {
          const rr = r.requestedReviewer;
          if (!rr) return [];
          if (rr.__typename === 'User' && typeof rr.login === 'string') {
            return [{ kind: 'user', login: rr.login }];
          }
          if (rr.__typename === 'Team' && typeof rr.slug === 'string') {
            return [{ kind: 'team', login: rr.slug }];
          }
          if (rr.__typename === 'Bot' || rr.__typename === 'Mannequin') {
            return [];
          }
          hasUnknownReviewerKind = true;
          return [];
        },
      );
      const reviewRequestsTruncated =
        rawReviewRequests.totalCount > rawReviewRequests.nodes.length || hasUnknownReviewerKind;

      if (!pr.baseRefOid) {
        throw new Error(`Pull request #${pr.number} response missing authoritative baseRefOid`);
      }

      // Reviews mapping & pagination
      const rawReviews = pr.reviews;
      const reviews = rawReviews.nodes.map((r) => mapReviewNode(r, pr.number));
      let reviewsTruncated =
        rawReviews.totalCount > reviews.length || rawReviews.pageInfo?.hasPreviousPage === true;
      if (rawReviews.pageInfo?.hasPreviousPage && rawReviews.pageInfo.startCursor) {
        try {
          const remainingReviews = await fetchRemainingReviews(
            gql,
            owner,
            repo,
            number,
            rawReviews.pageInfo.startCursor,
          );
          reviews.unshift(...remainingReviews.reviews);
          const reviewIds = new Set(reviews.map((review) => review.id));
          reviewsTruncated =
            !remainingReviews.complete ||
            rawReviews.totalCount > reviews.length ||
            reviewIds.size !== reviews.length;
        } catch {
          reviewsTruncated = true;
        }
      }
      const reviewIds = new Set(reviews.map((review) => review.id));
      if (reviewIds.size !== reviews.length) {
        reviewsTruncated = true;
      }

      // Comments mapping
      const comments = pr.comments.nodes.map((c) => ({
        author: c.author?.login ?? null,
        authorTypename: c.author?.__typename ?? null,
        authorAssociation: c.authorAssociation,
        createdAt: c.createdAt,
      }));
      const commentsTruncated =
        pr.comments.totalCount !== undefined
          ? pr.comments.totalCount > pr.comments.nodes.length
          : undefined;

      // Commits mapping & pagination
      let commitsData: CommitPaginationResult;
      if (pr.commits.pageInfo.hasPreviousPage && pr.commits.pageInfo.startCursor) {
        try {
          commitsData = await fetchRemainingCommits(
            gql,
            owner,
            repo,
            number,
            pr.headRefOid,
            pr.baseRefOid,
            pr.commits.totalCount,
            pr.commits.nodes,
            pr.commits.pageInfo.hasPreviousPage,
            pr.commits.pageInfo.startCursor,
          );
        } catch {
          commitsData = {
            commits: pr.commits.nodes.map(mapCommitNode),
            commitsTruncated: true,
          };
        }
      } else {
        const shaSet = new Set<string>();
        let hasDuplicate = false;
        for (const n of pr.commits.nodes) {
          if (shaSet.has(n.commit.oid)) {
            hasDuplicate = true;
            break;
          }
          shaSet.add(n.commit.oid);
        }
        const lastNode = pr.commits.nodes[pr.commits.nodes.length - 1];
        const isConsistent = lastNode?.commit.oid === pr.headRefOid;
        const isTruncated =
          pr.commits.totalCount > pr.commits.nodes.length ||
          pr.commits.pageInfo.hasPreviousPage ||
          hasDuplicate ||
          !isConsistent;

        commitsData = {
          commits: pr.commits.nodes.map(mapCommitNode),
          commitsTruncated: isTruncated,
        };
      }

      return {
        repo: { owner, name: repo },
        number: pr.number,
        title: pr.title,
        url: pr.url,
        headRefOid: pr.headRefOid,
        baseRefOid: pr.baseRefOid,
        author: pr.author
          ? { login: pr.author.login, typename: pr.author.__typename ?? null }
          : null,
        authorAssociation: pr.authorAssociation,
        isDraft: pr.isDraft,
        mergeable: pr.mergeable,
        createdAt: pr.createdAt,
        updatedAt: pr.updatedAt,
        labels,
        labelsTruncated: false,
        additions: pr.additions,
        deletions: pr.deletions,
        changedFiles: pr.changedFiles,
        files: pr.files.nodes.map((f) => f.path),
        filesTruncated:
          pr.files.pageInfo.hasNextPage || pr.files.totalCount > pr.files.nodes.length,
        fileStats: pr.files.nodes.map((f) => ({
          path: f.path,
          additions: f.additions,
          deletions: f.deletions,
          changeType: f.changeType.toLowerCase(),
        })),
        statusCheckRollup: headCheckRollup?.state ?? null,
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
        commits: commitsData.commits,
        commitsTruncated: commitsData.commitsTruncated,
        reviewRequests,
        reviewRequestsTruncated,
        reviews,
        reviewsTruncated,
        comments,
        commentsTruncated,
        body: pr.body ?? '',
        reviewThreads: threads,
        reviewThreadsTruncated,
      };
    },

    async fetchCommitPathComparison(owner, repo, candidateOid, parentOid, paths) {
      if (paths.length === 0) {
        return new Map();
      }
      const candidateFields = paths
        .map((p, i) => `        f${i}: file(path: ${JSON.stringify(p)}) { oid mode type }`)
        .join('\n');
      const parentSelection = parentOid
        ? `    parent: object(oid: ${JSON.stringify(parentOid)}) {
      ... on Commit {
        oid
${candidateFields}
      }
    }`
        : '';
      const query = `query CommitPathEntries($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
    candidate: object(oid: ${JSON.stringify(candidateOid)}) {
      ... on Commit {
        oid
${candidateFields}
      }
    }
${parentSelection}
  }
}`;

      type RawFileEntry = { oid: string; mode: number; type: string } | null;
      type CommitObject = {
        oid: string;
        [key: string]: RawFileEntry | string;
      } | null;

      type Resp = {
        repository: {
          candidate: CommitObject;
          parent?: CommitObject;
        } | null;
      };

      let respData: Resp | undefined;
      const errorMap = new Map<string, string>();

      try {
        const resp = await gql<Resp>(query, { owner, repo });
        respData = resp;
      } catch (err: unknown) {
        const partial = (err as { data?: Resp })?.data;
        const errors = (
          err as { errors?: Array<{ path?: Array<string | number>; message: string }> }
        )?.errors;
        if (errors) {
          for (const e of errors) {
            const fieldPath = e.path?.join('.') ?? 'unknown';
            errorMap.set(fieldPath, e.message);
          }
        }
        if (partial) {
          respData = partial;
        } else {
          // Complete failure
          const resultMap = new Map<string, CommitPathComparison>();
          const errMsg = err instanceof Error ? err.message : String(err);
          for (const p of paths) {
            resultMap.set(p, {
              candidateOid,
              parentOid,
              path: p,
              candidateResult: { status: 'unavailable', message: errMsg },
              parentResult: { status: 'unavailable', message: errMsg },
            });
          }
          return resultMap;
        }
      }

      const candObj = respData?.repository?.candidate;
      const parentObj = respData?.repository?.parent;
      const resultMap = new Map<string, CommitPathComparison>();

      for (let i = 0; i < paths.length; i++) {
        const p = paths[i]!;
        const fieldKey = `f${i}`;

        // Candidate evaluation
        let candidateResult: FileEntryResult;
        const candError =
          errorMap.get(`repository.candidate.${fieldKey}`) ?? errorMap.get('repository.candidate');
        if (candError) {
          candidateResult = { status: 'unavailable', message: candError };
        } else if (!candObj) {
          candidateResult = { status: 'unavailable', message: 'Candidate commit object not found' };
        } else {
          const raw = candObj[fieldKey] as RawFileEntry;
          if (raw === null || raw === undefined) {
            candidateResult = { status: 'absent' };
          } else {
            candidateResult = {
              status: 'found',
              entry: { oid: raw.oid, mode: raw.mode, type: raw.type },
            };
          }
        }

        // Parent evaluation
        let parentResult: FileEntryResult;
        if (!parentOid) {
          // Root commit with no parent: parent has no files (absent)
          parentResult = { status: 'absent' };
        } else {
          const parentError =
            errorMap.get(`repository.parent.${fieldKey}`) ?? errorMap.get('repository.parent');
          if (parentError) {
            parentResult = { status: 'unavailable', message: parentError };
          } else if (!parentObj) {
            parentResult = { status: 'unavailable', message: 'Parent commit object not found' };
          } else {
            const raw = parentObj[fieldKey] as RawFileEntry;
            if (raw === null || raw === undefined) {
              parentResult = { status: 'absent' };
            } else {
              parentResult = {
                status: 'found',
                entry: { oid: raw.oid, mode: raw.mode, type: raw.type },
              };
            }
          }
        }

        resultMap.set(p, {
          candidateOid,
          parentOid,
          path: p,
          candidateResult,
          parentResult,
        });
      }

      return resultMap;
    },

    async fetchBatchCommitParents(owner, repo, oids) {
      if (oids.length === 0) {
        return new Map();
      }
      const uniqueOids = Array.from(new Set(oids));
      const resultMap = new Map<string, ExternalCommitParents>();

      for (let offset = 0; offset < uniqueOids.length; offset += 20) {
        const batchOids = uniqueOids.slice(offset, offset + 20);
        const fields = batchOids
          .map(
            (oid, i) => `    c${i}: object(oid: ${JSON.stringify(oid)}) {
      ... on Commit {
        oid
        parents(first: 10) {
          totalCount
          pageInfo { hasNextPage endCursor }
          nodes { oid }
        }
      }
    }`,
          )
          .join('\n');

        const query = `query BatchCommitParents($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
${fields}
  }
}`;

        type RawCommit = {
          oid: string;
          parents?: {
            totalCount: number;
            pageInfo?: { hasNextPage: boolean; endCursor: string | null };
            nodes?: Array<{ oid: string }>;
          };
        } | null;

        type Resp = {
          repository: {
            [key: string]: RawCommit;
          } | null;
        };

        let respData: Resp | undefined;
        try {
          respData = await gql<Resp>(query, { owner, repo });
        } catch (err: unknown) {
          const partial = (err as { data?: Resp })?.data;
          if (partial) {
            respData = partial;
          } else {
            continue;
          }
        }

        const repoObj = respData?.repository;
        if (!repoObj) continue;

        for (let i = 0; i < batchOids.length; i++) {
          const c = repoObj[`c${i}`];
          if (c && c.oid) {
            const parentNodes = c.parents?.nodes ?? [];
            const total = c.parents?.totalCount ?? parentNodes.length;
            const hasNext = c.parents?.pageInfo?.hasNextPage ?? false;
            resultMap.set(c.oid, {
              oid: c.oid,
              parentOids: parentNodes.map((n) => n.oid),
              parentsTruncated: total > parentNodes.length || hasNext,
            });
          }
        }
      }

      return resultMap;
    },
  };
}
