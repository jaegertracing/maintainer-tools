// Shared types for the predicate library.
//
// Every check is a base fact of a PR, declared in predicates/ with the surfaces
// (weekly digest, triage report) that it appears on.
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

// Predicates are pure functions of the PR, so a predicate that compares
// against the current time takes it from here instead of the wall clock.
export interface PredicateContext {
  now: Date;
  // A predicate about several pull requests, such as the quota of an author,
  // reads the others from here. A consumer that does not gather the open
  // pull requests as a set omits the field, and the fact of such a predicate
  // then does not hold.
  openPullRequests?: OpenPullRequests;
  // The ages that the config sets. An age that it leaves out has the value
  // of `DEFAULT_POLICY_AGES`.
  ages?: Partial<PolicyAges>;
}

// The ages, in days, at which the policies act. Each is a setting of the
// config, see `ages` in the README.
export interface PolicyAges {
  // A pull request on which no person has acted for this long is idle.
  idleDays: number;
  // The time between the `stale` label and the closing of an idle pull
  // request.
  idleNoticeDays: number;
  // The time between the flag label and the closing of a pull request
  // without an approved issue.
  flagNoticeDays: number;
  // The triage report marks a pull request whose last update is older than
  // this as stale on its author.
  staleOnAuthorDays: number;
}

export const DEFAULT_POLICY_AGES: PolicyAges = {
  idleDays: 60,
  idleNoticeDays: 14,
  flagNoticeDays: 7,
  staleOnAuthorDays: 30,
};

export function agesOf(context: Pick<PredicateContext, 'ages'>): PolicyAges {
  return { ...DEFAULT_POLICY_AGES, ...context.ages };
}

// The ages of a config, with the default for each one that `settings`
// leaves out. An age is a whole number of days and at least one: a label
// age of no days would hold as soon as the label is applied, and the plan
// of a pull request would then change with its own label.
export function parsePolicyAges(settings: unknown): PolicyAges {
  const ages = { ...DEFAULT_POLICY_AGES };
  if (settings === undefined || settings === null) return ages;
  if (typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error('"ages" must be an object.');
  }
  for (const [name, days] of Object.entries(settings)) {
    if (!Object.hasOwn(DEFAULT_POLICY_AGES, name)) {
      throw new Error(
        `"ages.${name}" is not one of ${Object.keys(DEFAULT_POLICY_AGES).join(', ')}.`,
      );
    }
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 1) {
      throw new Error(`"ages.${name}" must be a whole number of days, at least 1.`);
    }
    ages[name as keyof PolicyAges] = days;
  }
  return ages;
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
    // Whether the author of the review is a bot account, such as GitHub
    // Copilot. Absent in a snapshot file from before the field existed.
    authorIsBot?: boolean;
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
    // policy comment, and of every comment of the bot of GitHub Actions. The
    // text of any other comment is not kept, because nothing reads it.
    body?: string;
    // The node ID by which the reconciler edits or minimizes the comment,
    // whether GitHub shows it minimized, and whether its author is a bot
    // account. All three are absent in a snapshot file from before they
    // existed.
    id?: string;
    isMinimized?: boolean;
    authorIsBot?: boolean;
  }>;

  // When a label was added to the PR or removed from it (last 100 events),
  // from which the reconciler dates a notice period. Optional because a
  // snapshot file from before the field existed does not have it.
  labelEvents?: LabelEvent[];

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

export interface LabelEvent {
  label: string;
  event: 'labeled' | 'unlabeled';
  at: string;
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

// Subset of GraphQL Actor __typename we care about.
export type AuthorTypename =
  'User' | 'Bot' | 'EnterpriseUserAccount' | 'Mannequin' | 'Organization';
