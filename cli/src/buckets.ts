// Bucket classifier.
//
// Pure function `(pr, ctx) -> ClassifiedPR`. Every open PR lands in exactly
// one bucket; ties are broken by priority order (lower number = stronger
// signal). The Hidden bucket absorbs PRs that aren't actionable until the
// contributor moves.
//
import { type CheckResult, type PullRequest, runAll } from '@jaegertracing/maintainer-tools-checks';

import { type CopilotReview, copilotReview } from './copilot.js';
import { hasLogin, isBotActor, isBotAuthor, isDependencyBotAuthor, sameLogin } from './logins.js';

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
}

export interface ClassifiedPR {
  pr: PullRequest;
  bucket: Bucket;
  // Reasons the classifier picked this bucket (for tooltips/debugging).
  reasons: string[];
  // Predicate results applied for hide rules and per-row flags.
  checks: CheckResult[];
  // Inline row flags derived from PR state, not from a single predicate.
  flags: RowFlag[];
  facets: Facets;
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
  const checks = runAll(pr, undefined, { now: ctx.now });
  const flags = computeFlags(pr, checks, ctx);
  const reasons: string[] = [];

  // --- Hide rules first. Any predicate that declared hidesFromTriage wins
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
  const hiddenByChecks = checks.filter((c) => c.triggered && c.hidesFromTriage);
  const changesRequestedPending =
    latestReviewState(viewerReviews) === 'CHANGES_REQUESTED' &&
    !authorActedSinceViewerReview(pr, viewerReviews, ctx.viewer);
  const authorLogin = pr.author?.login;

  const hideReasons: string[] = [];
  if (pr.isDraft) hideReasons.push('draft');
  hideReasons.push(...hiddenByChecks.map((c) => `hide:${c.id}`));
  if (pr.labels.some((label) => label.trim().toLowerCase() === 'waiting-for-author')) {
    hideReasons.push('waiting-for-author');
  }
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
    checks,
    flags,
    facets,
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
  if (hiddenByChecks.length > 0 && !explicitlyRequested) {
    return mk(
      'hidden',
      hiddenByChecks.map((c) => `hide:${c.id}`),
    );
  }
  if (
    pr.labels.some((label) => label.trim().toLowerCase() === 'waiting-for-author') &&
    !explicitlyRequested
  ) {
    return mk('hidden', ['waiting-for-author']);
  }
  // The mirror of `changes-requested-revised` below: the viewer asked for
  // changes and the author has not answered yet. That is waiting on the author,
  // the same as the `waiting-for-author` label above, but derived from review
  // state instead of from a label the nudge workflow has to apply first.
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

function isDependencyBot(pr: PullRequest): boolean {
  return isDependencyBotAuthor(pr.author?.login);
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
  for (const thread of pr.reviewThreads ?? []) {
    for (const c of thread.comments) {
      if (c.author && hasLogin(maintainers, c.author)) return true;
    }
  }
  return false;
}

// State of the viewer's most recent authoritative submitted review. COMMENTED
// and PENDING are discussion/workflow states, not review decisions, so they
// cannot clear an active CHANGES_REQUESTED review.
function latestReviewState(
  reviews: PullRequest['reviews'],
): PullRequest['reviews'][number]['state'] | null {
  let latest: PullRequest['reviews'][number] | undefined;
  for (const r of reviews) {
    if (r.state === 'COMMENTED' || r.state === 'PENDING') continue;
    if (!r.submittedAt || Number.isNaN(Date.parse(r.submittedAt))) continue;
    if (!latest || Date.parse(r.submittedAt) > Date.parse(latest.submittedAt)) latest = r;
  }
  return latest?.state ?? null;
}

function authorActedSinceViewerReview(
  pr: PullRequest,
  viewerReviews: PullRequest['reviews'],
  viewer: string,
): boolean {
  // Review decisions determine the bucket state, but every submitted review
  // is reviewer activity and therefore moves the revision baseline.
  const latest = viewerReviews
    .map((r) => Date.parse(r.submittedAt))
    .filter((timestamp) => Number.isFinite(timestamp))
    .reduce((a, b) => Math.max(a, b), 0);
  let latestActivity = latest;
  for (const comment of pr.comments) {
    if (comment.author && sameLogin(comment.author, viewer)) {
      const timestamp = Date.parse(comment.createdAt);
      if (Number.isFinite(timestamp)) latestActivity = Math.max(latestActivity, timestamp);
    }
  }
  for (const thread of pr.reviewThreads ?? []) {
    for (const comment of thread.comments) {
      if (comment.author && sameLogin(comment.author, viewer)) {
        const timestamp = Date.parse(comment.createdAt);
        if (Number.isFinite(timestamp)) latestActivity = Math.max(latestActivity, timestamp);
      }
    }
  }
  if (!Number.isFinite(latestActivity) || latestActivity <= 0) return false;
  // Did the author push commits after the viewer's review?
  const authorLogin = pr.author?.login;
  if (!authorLogin) return false;
  const hasAuthorRevision = pr.commits.some(
    (commit) =>
      commit.authorLogin &&
      sameLogin(commit.authorLogin, authorLogin) &&
      Date.parse(commit.committedDate) > latestActivity,
  );
  if (hasAuthorRevision) {
    return true;
  }
  // Or commented since?
  for (const c of pr.comments) {
    if (
      c.author &&
      sameLogin(c.author, authorLogin) &&
      Date.parse(c.createdAt) > latestActivity &&
      !sameLogin(c.author, viewer)
    ) {
      return true;
    }
  }
  for (const thread of pr.reviewThreads ?? []) {
    for (const c of thread.comments) {
      if (
        c.author &&
        sameLogin(c.author, authorLogin) &&
        Date.parse(c.createdAt) > latestActivity
      ) {
        return true;
      }
    }
  }
  return false;
}

// Minimal glob matcher: `**` matches across path separators, `*` matches
// within a segment, everything else is literal. Sufficient for CODEOWNERS-
// style paths. We don't implement negation or character classes — neither
// is needed for the triage use case.
export function matchesGlob(path: string, pattern: string): boolean {
  const rooted = pattern.startsWith('/');
  const withoutRoot = rooted ? pattern.slice(1) : pattern;
  const directoryPattern = withoutRoot.endsWith('/');
  const core = directoryPattern ? withoutRoot.slice(0, -1) : withoutRoot;
  const hasSlash = core.includes('/');
  const doubleStarDirectory = core.startsWith('**/');
  const source = directoryPattern ? `${core}/**` : doubleStarDirectory ? core.slice(3) : core;
  const prefix = doubleStarDirectory ? '^(?:.*/)?' : rooted || hasSlash ? '^' : '^(?:.*/)?';
  const tokens = source.split(/(\*\*|\*)/);
  const patternRegex = tokens
    .map((token, index) => {
      if (token === '**' && tokens[index + 1]?.startsWith('/')) return '(?:.*/)?';
      if (index > 0 && tokens[index - 1] === '**' && token.startsWith('/')) {
        return escapeRegex(token.slice(1));
      }
      if (token === '**') return '.*';
      if (token === '*') return '[^/]*';
      return escapeRegex(token);
    })
    .join('');
  const re = new RegExp(prefix + patternRegex + '$');
  return re.test(path);
}

function escapeRegex(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

function anyFileMatches(files: string[], patterns: string[]): boolean {
  if (patterns.length === 0) return false;
  return files.some((f) => patterns.some((p) => matchesGlob(f, p)));
}

function computeFlags(pr: PullRequest, checks: CheckResult[], ctx: ClassifyContext): RowFlag[] {
  const flags: RowFlag[] = [];
  flags.push(...issueFlags(pr, ctx));
  if (pr.isDraft) flags.push('DRAFT');
  if (isBotAuthor(pr) || isDependencyBot(pr)) flags.push('BOT');
  if (
    pr.labels.some((label) => {
      const normalized = label.trim().toLowerCase();
      return normalized === 'release-blocker' || normalized === 'blocker';
    })
  ) {
    flags.push('BLOCKER');
  }
  if (checks.some((c) => c.id === 'merge_conflict' && c.triggered)) flags.push('MERGE-CONFLICT');
  if (checks.some((c) => c.id === 'stale_on_author' && c.triggered)) flags.push('STALE');
  if (pr.labels.some((label) => label.trim().toLowerCase() === 'awaiting-maintainer-input')) {
    flags.push('QUESTION');
  }
  if (pr.labels.some((label) => label.trim().toLowerCase() === 'waiting-for-author')) {
    flags.push('WAITING-FOR-AUTHOR');
  }

  // P3 predicates: each fires as a visible row flag when triggered, so a
  // maintainer can spot it at a glance in the triage table. A predicate that
  // also hides the PR does so through its own `hidesFromTriage`.
  if (checks.some((c) => c.id === 'ci_failing' && c.triggered && c.labelOnlyFailure))
    flags.push('NEEDS-LABEL');
  if (checks.some((c) => c.id === 'no_linked_issue' && c.triggered)) flags.push('NO-ISSUE');
  if (checks.some((c) => c.id === 'no_tests_for_code_change' && c.triggered)) {
    flags.push('NO-TESTS');
  }
  if (checks.some((c) => c.id === 'unresolved_from_reviewer' && c.triggered)) {
    flags.push('UNRESOLVED');
  }
  if (checks.some((c) => c.id === 'resolved_without_reply' && c.triggered)) {
    // Per the RFC, surface the offender count so a maintainer can decide
    // whether to re-open. Recomputed here from pr.reviewThreads rather
    // than threaded through CheckResult — same data, no extra plumbing.
    const count = countResolvedWithoutReply(pr);
    flags.push(`RESOLVED-W/O-REPLY: ${count}`);
  }
  return flags;
}

// Flags derived from the referenced-issue enrichment (cli/src/issues.ts).
// Absent enrichment yields no flags rather than misleading ones.
function issueFlags(pr: PullRequest, ctx: ClassifyContext): RowFlag[] {
  const refs = pr.computed?.issueRefs;
  if (!refs || refs.length === 0) return [];
  const flags: RowFlag[] = [];
  const meta = pr.computed?.issueMeta ?? {};
  const author = pr.author?.login;

  const colliding = pr.computed?.collidingPrs ?? [];
  if (colliding.length > 0) flags.push(`ISSUE-COLLISION: ${colliding.length + 1}`);

  // Self-filed only counts for outside contributors. A priority author filing
  // an issue and then fixing it is ordinary planned work, so flagging it would
  // fire on the expected PRs and mean nothing.
  if (author && !isPriorityAuthor(ctx, author)) {
    for (const ref of refs) {
      const m = meta[`${ref.owner}/${ref.repo}#${ref.number}`];
      if (m && !m.isPullRequest && sameLogin(m.author, author)) {
        flags.push('SELF-FILED');
        break;
      }
    }
  }

  // An open PR against an already-closed issue is either superseded by
  // whoever closed it or stale enough that the problem went away.
  for (const ref of refs) {
    const m = meta[`${ref.owner}/${ref.repo}#${ref.number}`];
    if (m && m.state !== 'OPEN') {
      flags.push('ISSUE-CLOSED');
      break;
    }
  }
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
    if (!t.isResolved || !sameLogin(t.resolvedBy, authorLogin)) continue;
    const reviewerComments = t.comments.filter(
      (c) =>
        c.author && !sameLogin(c.author, authorLogin) && !isBotActor(c.authorTypename, c.author),
    );
    if (reviewerComments.length === 0) continue;
    const latest = Math.max(...reviewerComments.map((c) => Date.parse(c.createdAt)));
    const replied = t.comments.some(
      (c) => sameLogin(c.author, authorLogin) && Date.parse(c.createdAt) >= latest,
    );
    if (!replied) n++;
  }
  return n;
}
