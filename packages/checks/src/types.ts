// Shared types for the predicate library.
//
// Every check is a pure function `(pr: PullRequest) => CheckResult`. A
// CheckResult declares which surfaces (Checks panel, weekly digest, triage
// report) it publishes to, independently of whether the check `triggered`.
// See the RFC: docs/rfc/maintainer-pr-triage-tooling.md ("Predicate library").

export type CheckId =
  | 'dco_missing'
  | 'ci_failing'
  | 'merge_conflict'
  | 'stale_on_author'
  | 'quota_exceeded'
  | 'description_empty'
  | 'no_linked_issue'
  | 'no_tests_for_code_change'
  | 'unresolved_from_reviewer'
  | 'resolved_without_reply';

export type CheckConclusion = 'success' | 'failure' | 'neutral' | 'skipped' | 'action_required';

export interface CheckResult {
  id: CheckId;
  // Whether the predicate's condition is currently met for this PR.
  triggered: boolean;
  // Short human-readable text. Reused verbatim in the Checks panel and the
  // weekly digest so there is no parallel phrasing to maintain.
  summary: string;
  // Optional longer remediation paragraph rendered behind the Checks panel
  // "Details" link.
  details?: string;
  // Surface declarations — set by the predicate, read by each consumer.
  publishesCheck: boolean;
  checkConclusion?: CheckConclusion;
  inDigest: boolean;
  hidesFromTriage: boolean;
}

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
  // Status check rollup state from the head commit; STATUS_ROLLUP can be
  // EXPECTED | ERROR | FAILURE | PENDING | SUCCESS, or null if no checks.
  statusCheckRollup: 'EXPECTED' | 'ERROR' | 'FAILURE' | 'PENDING' | 'SUCCESS' | null;
  // Per-commit DCO inspection. A commit fails DCO if no message line matches
  // `Signed-off-by: <name> <email>` for the commit author.
  commits: Array<{
    sha: string;
    messageHeadline: string;
    messageBody: string;
    authorEmail: string | null;
    committedDate: string;
  }>;
  // Pending requests (no review submitted yet). Users + teams.
  reviewRequests: Array<{ kind: 'user' | 'team'; login: string }>;
  // Submitted reviews (most recent per reviewer is typically what matters).
  reviews: Array<{
    author: string | null;
    state: ReviewState;
    submittedAt: string;
  }>;
  // Issue-style PR comments (last 50). Used by triage to decide whether a
  // maintainer has responded yet; not used by predicates.
  comments: Array<{ author: string | null; createdAt: string }>;

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

  // Optional computed annotations. Filled in by enrichment passes that have
  // cross-PR context the per-PR GraphQL query can't supply (e.g. the quota
  // computation in cli/src/quota.ts, which needs the author's other open
  // PRs in the same repo plus their merged-PR history). Predicates may
  // consult these if set, but should remain functional when they're not.
  computed?: {
    // True iff a cross-PR quota computation has determined this PR is
    // beyond the author's allowed concurrent-open-PR cap for this repo.
    // Independent of (but congruent with) the `pr-quota-reached` label.
    quotaExceeded?: boolean;
  };
}

// Subset of GraphQL Actor __typename we care about.
export type AuthorTypename =
  | 'User'
  | 'Bot'
  | 'EnterpriseUserAccount'
  | 'Mannequin'
  | 'Organization';
