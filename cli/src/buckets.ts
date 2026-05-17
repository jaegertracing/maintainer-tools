// Bucket classifier.
//
// Pure function `(pr, ctx) -> ClassifiedPR`. Every open PR lands in exactly
// one bucket; ties are broken by priority order (lower number = stronger
// signal). The Hidden bucket absorbs PRs that aren't actionable until the
// contributor moves.
//
// Buckets follow the RFC, "Attention categories":
//   1. review-requested-on-you
//   2. youre-the-bottleneck
//   3. high-trust-awaiting-first-response
//   4. first-timer-awaiting
//   5. codeowners-hits
//   6. fyi
//   7. hidden

import { type CheckResult, type PullRequest, runAll } from '@jaegertracing/maintainer-tools-checks';

export type Bucket =
  | 'review-requested-on-you'
  | 'youre-the-bottleneck'
  | 'high-trust-awaiting-first-response'
  | 'first-timer-awaiting'
  | 'codeowners-hits'
  | 'fyi'
  | 'dependency-bots'
  | 'hidden';

export const BUCKET_ORDER: Bucket[] = [
  'review-requested-on-you',
  'youre-the-bottleneck',
  'high-trust-awaiting-first-response',
  'first-timer-awaiting',
  'codeowners-hits',
  'fyi',
  'dependency-bots',
  'hidden',
];

export const BUCKET_LABELS: Record<Bucket, string> = {
  'review-requested-on-you': 'Review requested on you',
  'youre-the-bottleneck': "You're the bottleneck",
  'high-trust-awaiting-first-response': 'High-trust authors awaiting first response',
  'first-timer-awaiting': 'First-time contributors awaiting first response',
  'codeowners-hits': 'CODEOWNERS hits',
  fyi: 'FYI',
  'dependency-bots': 'Dependency bots',
  hidden: 'Hidden',
};

// Logins treated as "dependency bots" — PRs they open are reviewable
// merges, just authored by a service account. They follow the same hide
// rules as humans (draft / merge-conflict / CI red still send them to
// Hidden) but otherwise get their own section so they don't drown out
// human-authored PRs in CODEOWNERS hits / FYI.
const DEPENDENCY_BOT_LOGINS = new Set<string>([
  'dependabot[bot]',
  'renovate[bot]',
  'renovate-bot[bot]',
]);

// High-priority buckets render expanded by default; low-priority collapsed.
export const BUCKETS_EXPANDED_BY_DEFAULT = new Set<Bucket>([
  'review-requested-on-you',
  'youre-the-bottleneck',
  'high-trust-awaiting-first-response',
  'first-timer-awaiting',
]);

export interface ClassifyContext {
  viewer: string;
  maintainers: Set<string>;
  interns: Set<string>;
  codeownerPaths: string[]; // for the current PR's repo
  now: Date;
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
}

export type RowFlag =
  | 'BLOCKER'
  | 'POSSIBLE-QUESTION'
  | 'QUESTION'
  | 'STALE'
  | 'MERGE-CONFLICT'
  | 'DRAFT'
  | 'BOT';

export function classify(pr: PullRequest, ctx: ClassifyContext): ClassifiedPR {
  const checks = runAll(pr);
  const flags = computeFlags(pr, checks);
  const reasons: string[] = [];

  // --- Hide rules first. Any predicate that declared hidesFromTriage wins
  // unless an explicit "you" signal overrides (review-requested overrides
  // because GitHub's request is the strongest signal a maintainer can send).
  const explicitlyRequested = isReviewRequestedOnViewer(pr, ctx.viewer);
  const hiddenByCheck = checks.find((c) => c.triggered && c.hidesFromTriage);

  if (pr.isDraft && !explicitlyRequested) {
    return mk('hidden', ['draft'], pr, checks, flags);
  }
  if (hiddenByCheck && !explicitlyRequested) {
    return mk('hidden', [`hide:${hiddenByCheck.id}`], pr, checks, flags);
  }
  // Non-dependency bots (anything matching __typename=Bot or `*[bot]`
  // login that we don't know about) → Hidden. Dependency bots get their
  // own bucket below.
  if (isBotAuthor(pr) && !isDependencyBot(pr) && !explicitlyRequested) {
    return mk('hidden', ['bot-authored'], pr, checks, flags);
  }

  // --- Priority 1: someone clicked the viewer in Reviewers.
  if (explicitlyRequested) {
    reasons.push('viewer in reviewRequests');
    return mk('review-requested-on-you', reasons, pr, checks, flags);
  }

  // --- Dependency bots that survived the hide rules go to their own
  // bucket regardless of CODEOWNERS / FYI signals. A dependabot PR
  // touching a viewer-owned path is still a dependabot PR.
  if (isDependencyBot(pr)) {
    reasons.push('dependency bot');
    return mk('dependency-bots', reasons, pr, checks, flags);
  }

  // --- Priority 2: viewer previously reviewed, author has acted since.
  const viewerReviews = pr.reviews.filter((r) => r.author === ctx.viewer);
  if (viewerReviews.length > 0 && authorActedSinceViewerReview(pr, viewerReviews, ctx.viewer)) {
    reasons.push('viewer reviewed; author has acted since');
    return mk('youre-the-bottleneck', reasons, pr, checks, flags);
  }

  // --- Priority 3 & 4: first-response triage for high-trust authors and
  // first-time contributors. Both require "no maintainer has engaged yet"
  // — a comment from a maintainer or any review by a maintainer disqualifies.
  const noMaintainerActivity = !hasMaintainerActivity(pr, ctx.maintainers);
  const authorLogin = pr.author?.login;
  if (noMaintainerActivity && authorLogin) {
    if (ctx.maintainers.has(authorLogin) || ctx.interns.has(authorLogin)) {
      reasons.push('high-trust author; no maintainer response yet');
      return mk('high-trust-awaiting-first-response', reasons, pr, checks, flags);
    }
    if (isFirstTimeContributor(pr)) {
      reasons.push('first-time contributor; no maintainer response yet');
      return mk('first-timer-awaiting', reasons, pr, checks, flags);
    }
  }

  // --- Priority 5: PR touches files the viewer co-owns.
  if (anyFileMatches(pr.files, ctx.codeownerPaths)) {
    reasons.push('PR touches viewer CODEOWNERS paths');
    return mk('codeowners-hits', reasons, pr, checks, flags);
  }

  // --- Priority 6: catch-all for open PRs that don't trip a stronger signal.
  return mk('fyi', ['no stronger signal'], pr, checks, flags);
}

function mk(
  bucket: Bucket,
  reasons: string[],
  pr: PullRequest,
  checks: CheckResult[],
  flags: RowFlag[],
): ClassifiedPR {
  return { pr, bucket, reasons, checks, flags };
}

function isReviewRequestedOnViewer(pr: PullRequest, viewer: string): boolean {
  return pr.reviewRequests.some((r) => r.kind === 'user' && r.login === viewer);
}

function isBotAuthor(pr: PullRequest): boolean {
  if (!pr.author) return false;
  if (pr.author.typename === 'Bot') return true;
  // Some bots (e.g. renovate, dependabot) sometimes show as User typename.
  // The conventional `[bot]` suffix is a reliable fallback signal.
  return pr.author.login.endsWith('[bot]');
}

function isDependencyBot(pr: PullRequest): boolean {
  if (!pr.author) return false;
  return DEPENDENCY_BOT_LOGINS.has(pr.author.login.toLowerCase());
}

function isFirstTimeContributor(pr: PullRequest): boolean {
  return (
    pr.authorAssociation === 'FIRST_TIMER' || pr.authorAssociation === 'FIRST_TIME_CONTRIBUTOR'
  );
}

function hasMaintainerActivity(pr: PullRequest, maintainers: Set<string>): boolean {
  for (const r of pr.reviews) {
    if (r.author && maintainers.has(r.author)) return true;
  }
  for (const c of pr.comments) {
    if (c.author && maintainers.has(c.author)) return true;
  }
  return false;
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
  const headCommittedAt = Date.parse(
    pr.commits[pr.commits.length - 1]?.committedDate ?? pr.updatedAt,
  );
  if (headCommittedAt > latest) return true;
  // Or commented since?
  for (const c of pr.comments) {
    if (c.author === authorLogin && Date.parse(c.createdAt) > latest && c.author !== viewer) {
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

function computeFlags(pr: PullRequest, checks: CheckResult[]): RowFlag[] {
  const flags: RowFlag[] = [];
  if (pr.isDraft) flags.push('DRAFT');
  if (isBotAuthor(pr)) flags.push('BOT');
  if (pr.labels.some((l) => l === 'release-blocker' || l === 'blocker')) flags.push('BLOCKER');
  if (checks.some((c) => c.id === 'merge_conflict' && c.triggered)) flags.push('MERGE-CONFLICT');
  if (checks.some((c) => c.id === 'stale_on_author' && c.triggered)) flags.push('STALE');
  if (pr.labels.includes('awaiting-maintainer-input')) flags.push('QUESTION');
  return flags;
}
