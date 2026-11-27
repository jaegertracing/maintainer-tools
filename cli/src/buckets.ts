// Bucket classifier.
//
// Pure function `(pr, ctx) -> ClassifiedPR`. Every open PR lands in exactly
// one bucket; ties are broken by priority order (lower number = stronger
// signal). The Hidden bucket absorbs PRs that aren't actionable until the
// contributor moves.
//
import {
  authorsTurn,
  commitsOfAuthor,
  hasLogin,
  isDependencyBotLogin,
  labelOnlyFailure,
  mergeConflict,
  needsIssue,
  noTestsForCodeChange,
  pullRequestsOfSameIssue,
  type OpenPullRequests,
  type PolicyAges,
  resolvedWithoutReply,
  staleOnAuthor,
  supportingFacts,
  type PullRequest,
  ruleSet,
  sameLogin,
  OutputName,
  unresolvedFromReviewer,
  type Verdict,
} from '@jaegertracing/maintainer-tools-checks';

import { type CopilotReview, copilotReview } from './copilot.js';

export type Bucket =
  | 'priority-authors'
  | 'review-requested-on-you'
  | 'changes-requested-revised'
  | 'youre-the-bottleneck'
  | 'first-timer-awaiting'
  | 'codeowners-hits'
  | 'fyi'
  | 'dependency-bots'
  | 'hidden';

export const BUCKET_ORDER: Bucket[] = [
  'priority-authors',
  'review-requested-on-you',
  'changes-requested-revised',
  'youre-the-bottleneck',
  'first-timer-awaiting',
  'codeowners-hits',
  'fyi',
  'dependency-bots',
  'hidden',
];

export const BUCKET_LABELS: Record<Bucket, string> = {
  'priority-authors': 'Priority authors',
  'review-requested-on-you': 'Review requested on you',
  'changes-requested-revised': 'You requested changes; author has revised',
  'youre-the-bottleneck': "You're the bottleneck",
  'first-timer-awaiting': 'First-time contributors awaiting first response',
  'codeowners-hits': 'CODEOWNERS hits',
  fyi: 'Needs triage',
  'dependency-bots': 'Dependency bots',
  hidden: 'Blocked on author',
};

// One-sentence explanation shown under each bucket header in the report, so
// a reader doesn't have to go dig through docs to know what a section means.
export const BUCKET_DESCRIPTIONS: Record<Bucket, string> = {
  'priority-authors': 'Author is a configured maintainer, intern, or priority author.',
  'review-requested-on-you': 'Someone added you to the Reviewers field on this PR.',
  'changes-requested-revised':
    'You submitted a Request changes review and the author has pushed or commented since, so the ball is back with you. Your review is also still blocking the merge until you clear it.',
  'youre-the-bottleneck':
    "You've reviewed this PR before, and the author has pushed a commit or commented since — it's waiting on you again.",
  'first-timer-awaiting':
    "Author's first PR to the repo (GitHub-reported), and no maintainer has engaged with it yet.",
  'codeowners-hits': 'PR touches file paths you are configured as a CODEOWNER for.',
  fyi: "Open PR that didn't match a stronger signal above — needs a first look.",
  'dependency-bots': 'Opened by a recognized dependency-update bot (Dependabot, Renovate).',
  hidden: 'Not actionable right now — draft, blocked, or flagged as waiting on the author.',
};

// High-priority buckets render expanded by default; low-priority collapsed.
export const BUCKETS_EXPANDED_BY_DEFAULT = new Set<Bucket>([
  'priority-authors',
  'review-requested-on-you',
  'changes-requested-revised',
  'youre-the-bottleneck',
  'first-timer-awaiting',
]);

export interface ClassifyContext {
  viewer: string;
  maintainers: Set<string>;
  priorityAuthors: Set<string>;
  codeownerPaths: string[]; // for the current PR's repo
  now: Date;
  // See TriageConfig.ignoreReviewRequestedOnYou.
  ignoreReviewRequestedOnYou: boolean;
  // The pull requests that are classified together with this one. Without
  // them no pull request is over a quota.
  openPullRequests?: OpenPullRequests;
  // The ages of the config. Without them every age has its default.
  ages?: PolicyAges;
}

export interface ClassifiedPR {
  pr: PullRequest;
  bucket: Bucket;
  // Reasons the classifier picked this bucket (for tooltips/debugging).
  reasons: string[];
  // The facts of the PR, which the hide rules, the row flags and the
  // renderers read.
  verdict: Verdict;
  // Inline row flags derived from PR state, not from a single predicate.
  flags: RowFlag[];
  facets: Facets;
  // The other open PRs that share an issue with this one under the
  // duplicates policy, ordered by number. The report lists them beside the
  // issues of the PR.
  pullRequestsOfSameIssue: Array<{ number: number; url: string }>;
  // Latest GitHub Copilot review verdict, parsed once here for every renderer.
  copilot: CopilotReview | null;
}

// The signals the classifier weighs, recorded independently of which one won.
// The bucket keeps exactly one answer per PR; the facets let the table view
// filter on a signal the bucket decision overrode, such as a priority author
// whose PR is hidden for a missing DCO sign-off.
export interface Facets {
  priorityAuthor: boolean;
  reviewRequested: boolean;
  viewerReviewed: boolean;
  firstTimer: boolean;
  dependencyBot: boolean;
  codeownersHit: boolean;
  maintainerEngaged: boolean;
  // Every reason that would send the PR to Hidden, in the same `draft` /
  // `hide:<predicate_id>` / label vocabulary as `reasons`.
  hideReasons: string[];
}

// Row-flag labels rendered in the `flags` column of each PR row. The
// `RESOLVED-W/O-REPLY:N` variant carries a count appended after a colon;
// the renderer splits on `:` to derive a stable CSS class. `string` rather
// than a tighter union so dynamic forms compose cleanly.
export type RowFlag = string;

export function classify(pr: PullRequest, ctx: ClassifyContext): ClassifiedPR {
  const verdict = ruleSet.evaluate(pr, {
    now: ctx.now,
    openPullRequests: ctx.openPullRequests,
    ages: ctx.ages,
  });
  const sharingIssue = pullRequestsOfSameIssue(pr, ctx.openPullRequests?.pullRequests ?? [])
    .map(({ number, url }) => ({ number, url }))
    .sort((left, right) => left.number - right.number);
  const flags = computeFlags(pr, verdict, ctx, sharingIssue.length);
  const reasons: string[] = [];

  // --- Hide rules first. The `triage_hidden` output of the rules wins
  // unless an explicit "you" signal overrides (review-requested overrides
  // because GitHub's request is the strongest signal a maintainer can send).
  // ignoreReviewRequestedOnYou switches this signal off entirely — GitHub
  // lets anyone request a review, not just maintainers, so it can't be
  // trusted on its own.
  const explicitlyRequested =
    !ctx.ignoreReviewRequestedOnYou && isReviewRequestedOnViewer(pr, ctx.viewer);
  const viewerReviews = pr.reviews.filter(
    (review) => review.author !== null && sameLogin(review.author, ctx.viewer),
  );
  // A PR can trip more than one hide predicate at once (e.g. stale AND
  // quota-exceeded); report all of them so the report doesn't silently
  // mask one behind whichever predicate happens to run first.
  const hideReasonsOfFacts = supportingFacts(verdict, OutputName.TriageHidden).map(
    (fact) => `hide:${fact}`,
  );
  const changesRequestedPending =
    latestReviewState(viewerReviews) === 'CHANGES_REQUESTED' &&
    !authorActedSinceViewerReview(pr, viewerReviews, ctx.viewer);
  const authorLogin = pr.author?.login;

  const hideReasons: string[] = [];
  if (pr.isDraft) hideReasons.push('draft');
  hideReasons.push(...hideReasonsOfFacts);
  if (changesRequestedPending) hideReasons.push('changes-requested');
  if (isBotAuthor(pr) && !isDependencyBot(pr)) hideReasons.push('bot-authored');
  const facets: Facets = {
    priorityAuthor:
      authorLogin !== undefined &&
      !sameLogin(authorLogin, ctx.viewer) &&
      isPriorityAuthor(ctx, authorLogin),
    reviewRequested: isReviewRequestedOnViewer(pr, ctx.viewer),
    viewerReviewed: viewerReviews.length > 0,
    firstTimer: isFirstTimeContributor(pr),
    dependencyBot: isDependencyBot(pr),
    codeownersHit: anyFileMatches(pr.files, ctx.codeownerPaths),
    maintainerEngaged: hasMaintainerActivity(pr, ctx.maintainers),
    hideReasons,
  };
  const copilot = copilotReview(pr);
  const mk = (bucket: Bucket, reasons: string[]): ClassifiedPR => ({
    pr,
    bucket,
    reasons,
    verdict,
    flags,
    facets,
    pullRequestsOfSameIssue: sharingIssue,
    copilot,
  });

  // Dependency bots go to their own bucket regardless of draft state, CI
  // status, merge conflicts, or any other hide signal — Renovate and
  // Dependabot manage their own PRs, so none of that is something a
  // maintainer needs to triage.
  if (isDependencyBot(pr) && !explicitlyRequested) {
    reasons.push('dependency bot');
    return mk('dependency-bots', reasons);
  }

  if (pr.isDraft && !explicitlyRequested) {
    return mk('hidden', ['draft']);
  }
  if (hideReasonsOfFacts.length > 0 && !explicitlyRequested) {
    return mk('hidden', hideReasonsOfFacts);
  }
  // The mirror of `changes-requested-revised` below: the viewer asked for
  // changes and the author has not answered yet. `maintainer_spoke_last` hides such
  // a PR when the run knows the viewer as a maintainer; this branch hides
  // it for a viewer whom the run does not, such as a run that could not
  // list the collaborators.
  // Without this the PR fell through to `fyi`, whose description is "needs a
  // first look" — the one thing it demonstrably does not need.
  if (!explicitlyRequested && changesRequestedPending) {
    return mk('hidden', ['changes-requested']);
  }
  // Non-dependency bots (anything matching __typename=Bot or `*[bot]`
  // login that we don't know about) → Hidden.
  if (isBotAuthor(pr) && !isDependencyBot(pr) && !explicitlyRequested) {
    return mk('hidden', ['bot-authored']);
  }

  // --- Priority 1: actionable PRs from configured priority authors.
  if (facets.priorityAuthor) {
    reasons.push('priority author');
    return mk('priority-authors', reasons);
  }

  // --- Priority 2: someone clicked the viewer in Reviewers.
  if (explicitlyRequested) {
    reasons.push('viewer in reviewRequests');
    return mk('review-requested-on-you', reasons);
  }

  // --- Priority 3: viewer previously reviewed, author has acted since.
  //
  // Split by what kind of review it was. "Request changes" is a commitment: it
  // names things the author had to fix and it blocks the merge until dismissed,
  // so a revision against it needs re-reading against that specific list. A
  // plain comment that the author replied to is a weaker signal, and lumping
  // the two together buried the explicit ones — 7 of the 9 PRs in this branch
  // were requested-changes revisions on the 2026-08-15 queue.
  if (viewerReviews.length > 0 && authorActedSinceViewerReview(pr, viewerReviews, ctx.viewer)) {
    if (latestReviewState(viewerReviews) === 'CHANGES_REQUESTED') {
      reasons.push('you requested changes; author has revised since');
      return mk('changes-requested-revised', reasons);
    }
    reasons.push('viewer reviewed; author has acted since');
    return mk('youre-the-bottleneck', reasons);
  }

  // --- Priority 4: first-time contributors awaiting a first response.
  const noMaintainerActivity = !hasMaintainerActivity(pr, ctx.maintainers);
  if (noMaintainerActivity && authorLogin) {
    if (isFirstTimeContributor(pr)) {
      reasons.push('first-time contributor; no maintainer response yet');
      return mk('first-timer-awaiting', reasons);
    }
  }

  // --- Priority 5: PR touches files the viewer co-owns.
  if (anyFileMatches(pr.files, ctx.codeownerPaths)) {
    reasons.push('PR touches viewer CODEOWNERS paths');
    return mk('codeowners-hits', reasons);
  }

  // --- Priority 6: catch-all for open PRs that don't trip a stronger signal.
  return mk('fyi', ['no stronger signal']);
}

function isReviewRequestedOnViewer(pr: PullRequest, viewer: string): boolean {
  return pr.reviewRequests.some((r) => r.kind === 'user' && sameLogin(r.login, viewer));
}

function isBotAuthor(pr: PullRequest): boolean {
  if (!pr.author) return false;
  if (pr.author.typename === 'Bot') return true;
  // GraphQL doesn't emit a `[bot]`-suffixed login in practice; this guards
  // non-GraphQL-sourced PR data (fixtures, hand-written cache rows) where
  // typename might be 'User' but the login still carries the suffix.
  return pr.author.login.endsWith('[bot]');
}

// The PRs of a dependency bot always land in their own bucket, regardless
// of draft state, CI status, or merge conflicts, so they never drown out
// human-authored PRs in CODEOWNERS hits / FYI and never inflate
// Blocked-on-author with noise nobody needs to triage.
function isDependencyBot(pr: PullRequest): boolean {
  if (!pr.author) return false;
  return isDependencyBotLogin(pr.author.login);
}

function isFirstTimeContributor(pr: PullRequest): boolean {
  return (
    pr.authorAssociation === 'FIRST_TIMER' || pr.authorAssociation === 'FIRST_TIME_CONTRIBUTOR'
  );
}

// Any review or comment from any maintainer (the viewer included) counts.
// This matches the RFC's "no maintainer response" wording for the
// first-response buckets: once someone from the team has engaged, the PR is
// no longer in the "first response" state and should drop out of those
// buckets. Subsequent staleness — e.g. a first-timer's reply that nobody
// followed up on — is the job of the `stale_on_author` / nudge surfaces,
// not this bucket.
function hasMaintainerActivity(pr: PullRequest, maintainers: Set<string>): boolean {
  for (const r of pr.reviews) {
    if (r.author && hasLogin(maintainers, r.author)) return true;
  }
  for (const c of pr.comments) {
    if (c.author && hasLogin(maintainers, c.author)) return true;
  }
  return false;
}

// State of the viewer's most recent submitted review. GitHub keeps the whole
// history, and a later APPROVED or COMMENTED supersedes an earlier
// CHANGES_REQUESTED, so only the newest one says where the PR stands.
function latestReviewState(
  reviews: PullRequest['reviews'],
): PullRequest['reviews'][number]['state'] | null {
  let latest: PullRequest['reviews'][number] | undefined;
  for (const r of reviews) {
    if (!latest || Date.parse(r.submittedAt) > Date.parse(latest.submittedAt)) latest = r;
  }
  return latest?.state ?? null;
}

function authorActedSinceViewerReview(
  pr: PullRequest,
  viewerReviews: PullRequest['reviews'],
  viewer: string,
): boolean {
  const latest = viewerReviews
    .map((r) => Date.parse(r.submittedAt))
    .reduce((a, b) => Math.max(a, b), 0);
  if (!latest) return false;
  // Did the author push commits after the viewer's review?
  const authorLogin = pr.author?.login;
  if (!authorLogin) return false;
  if (commitsOfAuthor(pr).some((commit) => Date.parse(commit.committedDate) > latest)) return true;
  // Or answered in a review thread since? GitHub records such a reply as a
  // review of the author.
  for (const review of pr.reviews) {
    if (
      review.author &&
      sameLogin(review.author, authorLogin) &&
      !sameLogin(review.author, viewer) &&
      Date.parse(review.submittedAt) > latest
    ) {
      return true;
    }
  }
  // Or commented since?
  for (const c of pr.comments) {
    if (
      c.author &&
      sameLogin(c.author, authorLogin) &&
      Date.parse(c.createdAt) > latest &&
      !sameLogin(c.author, viewer)
    ) {
      return true;
    }
  }
  return false;
}

// Minimal glob matcher: `**` matches across path separators, `*` matches
// within a segment, everything else is literal. Sufficient for CODEOWNERS-
// style paths. We don't implement negation or character classes — neither
// is needed for the triage use case.
export function matchesGlob(path: string, pattern: string): boolean {
  const re = new RegExp(
    '^' +
      pattern
        .split(/(\*\*|\*)/)
        .map((token) => {
          if (token === '**') return '.*';
          if (token === '*') return '[^/]*';
          return escapeRegex(token);
        })
        .join('') +
      '$',
  );
  return re.test(path);
}

function escapeRegex(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

function anyFileMatches(files: string[], patterns: string[]): boolean {
  if (patterns.length === 0) return false;
  return files.some((f) => patterns.some((p) => matchesGlob(f, p)));
}

function computeFlags(
  pr: PullRequest,
  verdict: Verdict,
  ctx: ClassifyContext,
  otherPullRequestsOfSameIssue: number,
): RowFlag[] {
  const flags: RowFlag[] = [];
  flags.push(...issueFlags(pr, ctx, otherPullRequestsOfSameIssue));
  if (pr.isDraft) flags.push('DRAFT');
  if (isBotAuthor(pr) || isDependencyBot(pr)) flags.push('BOT-AUTHORED');
  if (pr.labels.some((l) => l === 'release-blocker' || l === 'blocker')) flags.push('BLOCKER');
  if (verdict.holds(mergeConflict)) flags.push('MERGE-CONFLICT');
  if (verdict.holds(staleOnAuthor)) flags.push('STALE-ON-AUTHOR');
  if (pr.labels.includes('awaiting-maintainer-input')) flags.push('QUESTION');
  if (verdict.holds(authorsTurn)) flags.push('AUTHORS-TURN');

  // P3 predicates: each fires as a visible row flag when triggered, so a
  // maintainer can spot it at a glance in the triage table. A predicate that
  // also hides the PR does so through a rule for `triage_hidden`.
  if (verdict.holds(labelOnlyFailure)) flags.push('NEEDS-LABEL');
  if (verdict.holds(needsIssue)) flags.push('NO-APPROVED-ISSUE');
  if (verdict.holds(noTestsForCodeChange)) flags.push('NO-TESTS');
  if (verdict.holds(unresolvedFromReviewer)) flags.push('UNRESOLVED-FROM-REVIEWER');
  if (verdict.holds(resolvedWithoutReply)) {
    // Per the RFC, surface the offender count so a maintainer can decide
    // whether to re-open. Recomputed here from pr.reviewThreads rather
    // than threaded through the verdict — same data, no extra plumbing.
    const count = countResolvedWithoutReply(pr);
    flags.push(`RESOLVED-W/O-REPLY: ${count}`);
  }
  return flags;
}

// Flags about the issues that GitHub closes when the PR is merged.
function issueFlags(
  pr: PullRequest,
  ctx: ClassifyContext,
  otherPullRequestsOfSameIssue: number,
): RowFlag[] {
  const issues = pr.linkedIssues ?? [];
  const flags: RowFlag[] = [];
  const author = pr.author?.login;

  if (otherPullRequestsOfSameIssue > 0) {
    flags.push(`ISSUE-COLLISION: ${otherPullRequestsOfSameIssue + 1}`);
  }

  // Self-filed only counts for outside contributors. A priority author filing
  // an issue and then fixing it is ordinary planned work, so flagging it would
  // fire on the expected PRs and mean nothing.
  if (
    author &&
    !isPriorityAuthor(ctx, author) &&
    issues.some((issue) => issue.author != null && sameLogin(issue.author, author))
  ) {
    flags.push('SELF-FILED');
  }

  // An open PR against an already-closed issue is either superseded by
  // whoever closed it or stale enough that the problem went away.
  if (issues.some((issue) => issue.state !== 'OPEN')) flags.push('ISSUE-CLOSED');
  return flags;
}

function isPriorityAuthor(ctx: ClassifyContext, login: string): boolean {
  return hasLogin(ctx.priorityAuthors, login);
}

function countResolvedWithoutReply(pr: PullRequest): number {
  const authorLogin = pr.author?.login;
  if (!authorLogin) return 0;
  let n = 0;
  for (const t of pr.reviewThreads ?? []) {
    if (!t.isResolved || t.resolvedBy !== authorLogin) continue;
    const reviewerComments = t.comments.filter((c) => c.author && c.author !== authorLogin);
    if (reviewerComments.length === 0) continue;
    const latest = Math.max(...reviewerComments.map((c) => Date.parse(c.createdAt)));
    const replied = t.comments.some(
      (c) => c.author === authorLogin && Date.parse(c.createdAt) > latest,
    );
    if (!replied) n++;
  }
  return n;
}
