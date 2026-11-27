// Shared types for the predicate library.
//
// Every check is a base fact of a PR, declared in predicates/ with the surfaces
// (Checks panel, weekly digest, triage report) that it appears on.
// See the RFC: docs/rfc/0001-maintainer-pr-triage-tooling.md ("Predicate library").

// The checks, in the order in which the JSON report lists them.
export const CHECK_IDS = [
  'dco_missing',
  'ci_failing',
  'merge_conflict',
  'stale_on_author',
  'over_quota',
  'description_empty',
  'no_linked_issue',
  'no_tests_for_code_change',
  'unresolved_from_reviewer',
  'resolved_without_reply',
] as const;

export type CheckId = (typeof CHECK_IDS)[number];

// A check "applies" to a pull request when `pr-nudge` publishes a check run
// of the check for it. A check for which the policy declares the fact
// `<id>_applies` applies to the pull requests that the fact holds for, and a
// check with a check run and no such fact applies to every pull request.
export function appliesFactName(id: CheckId): string {
  return `${id}_applies`;
}

// Predicates are pure functions of the PR, so a predicate that compares
// against the current time takes it from here instead of the wall clock.
export interface PredicateContext {
  now: Date;
  // A predicate about several pull requests, such as the quota of an author,
  // reads the others from here. A consumer that does not gather the open
  // pull requests as a set omits the field, and the fact of such a predicate
  // then does not hold.
  openPullRequests?: OpenPullRequests;
}

// The open pull requests that one run evaluates together, with the merged-PR
// counts that the run gathered and the logins that the config exempts from
// the quota.
export interface OpenPullRequests {
  pullRequests: readonly PullRequest[];
  // Merged-PR count of each author that can exceed a quota, keyed by
  // `owner/repo|login`. Absent when the run did not gather the counts.
  mergedCounts?: Record<string, number>;
  // The logins whose pull requests are within every quota.
  quotaExemptLogins: ReadonlySet<string>;
  // The permission of each collaborator of each repository, keyed by
  // `owner/repo` and then by login. A repository whose collaborators the run
  // did not gather has no entry. Absent in a snapshot file from before the
  // field existed, and for a consumer that gathers no collaborators.
  collaborators?: Record<string, Record<string, RepositoryPermission>>;
}

export type CheckConclusion = 'success' | 'failure' | 'neutral' | 'skipped' | 'action_required';

// GitHub's PR-author association enum.
export type AuthorAssociation =
  | 'COLLABORATOR'
  | 'CONTRIBUTOR'
  | 'FIRST_TIMER'
  | 'FIRST_TIME_CONTRIBUTOR'
  | 'MANNEQUIN'
  | 'MEMBER'
  | 'NONE'
  | 'OWNER';

export type ReviewState = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';

// Minimal PR shape consumed by the predicates and the triage CLI. Sourced
// from a single GraphQL query (see graphql.ts) and intentionally narrower
// than the full GraphQL schema so predicates don't depend on transport
// details. Triage-only fields (additions/files/reviews/...) live alongside
// the P0 fields because the same query fills them both; predicates ignore
// what they don't need.
export interface PullRequest {
  repo: { owner: string; name: string };
  number: number;
  title: string;
  url: string;
  author: { login: string; typename: AuthorTypename } | null;
  authorAssociation: AuthorAssociation;
  isDraft: boolean;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  createdAt: string;
  updatedAt: string;
  labels: string[];
  additions: number;
  deletions: number;
  changedFiles: number;
  files: string[]; // first 100 paths
  // Per-file line counts for the same first-100 files. Optional because
  // entries cached before the field existed don't have it; consumers fall
  // back to the whole-PR `additions`/`deletions` totals. Path-only consumers
  // keep using `files` so they don't have to project this down.
  fileStats?: FileChange[];
  // Status check rollup state from the head commit; STATUS_ROLLUP can be
  // EXPECTED | ERROR | FAILURE | PENDING | SUCCESS, or null if no checks.
  statusCheckRollup: 'EXPECTED' | 'ERROR' | 'FAILURE' | 'PENDING' | 'SUCCESS' | null;
  // Per-commit DCO inspection. A commit fails DCO if no message line matches
  // `Signed-off-by: <name> <email>` for the commit author. Merge commits
  // (`parents > 1`) are exempt — they're not authored by the contributor
  // and the standard DCO action excludes them.
  commits: Array<{
    sha: string;
    messageHeadline: string;
    messageBody: string;
    authorEmail: string | null;
    // The GitHub account of the author of the commit, or null when GitHub
    // attributes the commit to no account. Optional because a snapshot
    // that was saved without the field has none.
    authorLogin?: string | null;
    committedDate: string;
    parents: number;
  }>;
  // Pending requests (no review submitted yet). Users + teams.
  reviewRequests: Array<{ kind: 'user' | 'team'; login: string }>;
  // Submitted reviews (most recent per reviewer is typically what matters).
  reviews: Array<{
    author: string | null;
    state: ReviewState;
    submittedAt: string;
    // Review URL and body. Only the triage CLI reads them (GitHub Copilot's
    // review overview); the actions carry them because the query is shared.
    // Optional so consumers degrade gracefully when they are absent.
    url?: string;
    body?: string;
  }>;
  // Issue-style PR comments (last 50). Used by triage to decide whether a
  // maintainer has responded yet.
  comments: Array<{
    author: string | null;
    createdAt: string;
    // The text of a comment that `isPolicyComment()` recognizes as a
    // policy comment. The text of any other comment is not kept, because
    // nothing reads it.
    body?: string;
  }>;

  // The issues that GitHub closes when the PR is merged, which GitHub calls
  // the closing issue references (first 20). Optional because a snapshot
  // file from before the field existed does not have it.
  linkedIssues?: LinkedIssue[];

  // PR description body. Used by `description_empty` and `no_linked_issue`.
  // May be empty string (PR opened with no body) or undefined (legacy
  // cache entry from before this field was added — predicates treat as
  // empty without warning).
  body?: string;

  // Review threads (inline review comments grouped by file/line). Used by
  // `unresolved_from_reviewer` and `resolved_without_reply`. Optional for
  // the same legacy-cache reason as `body`.
  reviewThreads?: Array<{
    isResolved: boolean;
    // Login of the user who resolved the thread, if resolved. Used by
    // `resolved_without_reply` to detect author-resolved-without-reply.
    resolvedBy: string | null;
    comments: Array<{ author: string | null; createdAt: string }>;
  }>;

  // Individual check runs on the head commit. Populated from the GitHub
  // CheckRun / StatusContext contexts on the head commit's statusCheckRollup.
  // Optional for backward compatibility with older cache entries — predicates
  // and classifiers should degrade gracefully when absent.
  // True when the head commit has more check contexts than the query asked
  // for, so `headCheckRuns` is a prefix rather than the whole set. Any
  // consumer reasoning about *which* checks are failing has to treat a
  // truncated list as unknown rather than complete — jaeger PRs reach 145
  // contexts against a page size of 100.
  headCheckRunsTruncated?: boolean;
  headCheckRuns?: Array<{
    name: string;
    // GitHub CheckConclusionState (lowercase) for CheckRun nodes, or a
    // normalized equivalent ('failure' | 'success' | null) for StatusContext
    // nodes. null means in-progress / neutral / skipped.
    conclusion: string | null;
  }>;

  // Optional computed annotations. Filled in by the issue pass of the triage
  // CLI (cli/src/issues.ts), which has cross-PR context that the per-PR
  // GraphQL query can't supply.
  computed?: {
    // Issues this PR claims to close, parsed from the body. Closing keywords
    // only — a bare `#N` mention is not a claim, and in practice most bare
    // mentions point at other PRs ("follow-up to #123") rather than issues.
    issueRefs?: IssueRef[];
    // Metadata for each entry in `issueRefs`, keyed by `refKey()`. Absent
    // keys mean the lookup failed or was skipped; consumers degrade to
    // showing the bare reference.
    issueMeta?: Record<string, IssueMeta>;
    // Other open PRs in the same scan that claim to close one of the same
    // issues, as `owner/repo#number`. Empty or absent means no collision.
    collidingPrs?: string[];
  };
}

// An issue that GitHub closes when a pull request is merged, with the state
// and the labels that the lifecycle policies read.
export interface LinkedIssue extends IssueRef {
  state: 'OPEN' | 'CLOSED';
  labels: string[];
  // The title of the issue and the login of the account that opened it. The
  // login is null when GitHub has deleted the account. Both are absent in a
  // snapshot file from before they existed.
  title?: string;
  author?: string | null;
}

// What a collaborator may do in a repository, in GitHub's terms.
export type RepositoryPermission = 'ADMIN' | 'MAINTAIN' | 'WRITE' | 'TRIAGE' | 'READ';

// One changed file's line counts. `changeType` is GitHub's PatchStatus enum,
// lowercased.
export interface FileChange {
  path: string;
  additions: number;
  deletions: number;
  changeType: string;
}

// A reference to an issue in some repo. Owner/repo are resolved against the
// referring PR's repo when the body used the bare `#N` form.
export interface IssueRef {
  owner: string;
  repo: string;
  number: number;
}

export interface IssueMeta {
  author: string | null;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  title: string;
  // True when the referenced number turned out to be a PR. GitHub's closing
  // keywords accept any number, and contributors do write `Fixes #<pr>`.
  isPullRequest: boolean;
}

// Subset of GraphQL Actor __typename we care about.
export type AuthorTypename =
  'User' | 'Bot' | 'EnterpriseUserAccount' | 'Mannequin' | 'Organization';
