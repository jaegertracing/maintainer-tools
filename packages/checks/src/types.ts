// Shared types for the predicate library.
//
// Every check is a pure function `(pr: PullRequest) => CheckResult`. A
// CheckResult declares which surfaces (Checks panel, weekly digest, triage
// report) it publishes to, independently of whether the check `triggered`.
// See the RFC: docs/rfc/maintainer-pr-triage-tooling.md ("Predicate library").

export type CheckId = 'dco_missing' | 'ci_failing' | 'merge_conflict' | 'stale_on_author';

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

// Minimal PR shape consumed by the predicates. Sourced from a single GraphQL
// query (see graphql.ts) and intentionally narrower than the full GraphQL
// schema so predicates don't depend on transport details.
export interface PullRequest {
  repo: { owner: string; name: string };
  number: number;
  title: string;
  url: string;
  author: { login: string } | null;
  isDraft: boolean;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  updatedAt: string; // ISO 8601
  labels: string[];
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
  }>;
}
