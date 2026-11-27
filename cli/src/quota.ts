// Gathering and logging for the quota of open pull requests.
//
// For each (owner/repo, author) with more than one open PR,
// fetchMergedCounts() fetches the merged count while the snapshot is
// gathered. The `over_quota` check of the checks package decides the
// quota from those counts, and logAuthorQuotas() prints what it decided.
//
// An author with one open PR gets no count, and neither does an exempt
// login. That keeps the query budget proportional to the small subset that
// could actually be quota-blocked.

import {
  authorQuotas,
  quotaCandidates,
  type GraphqlClient,
  type OpenPullRequests,
  type PullRequest,
  type QuotaCandidate,
} from '@jaegertracing/maintainer-tools-checks';
import type { PrCache } from '@jaegertracing/maintainer-tools-checks/cache';

import { log } from './log.js';

// Merged-PR counts only grow as authors land more PRs, and quota tiers are
// coarse — a day-old count is virtually never
// wrong about which tier an author is in. Caching it turns "N multi-PR
// authors" back-to-back triage runs into near-zero-network-cost after the
// first one.
const DEFAULT_MERGED_COUNT_TTL_MS = 24 * 60 * 60 * 1000;

// How many countMergedPRs GraphQL calls to have in flight at once for
// cache misses. Each is a cheap `search` query, so a small pool is safe
// without tripping secondary rate limits.
const FETCH_CONCURRENCY = 6;

export interface MergedCountFetchOptions {
  // Optional cache for merged-PR counts, keyed by (repo, author). Omit (or
  // pass null) to always query fresh, e.g. for --no-cache.
  cache?: PrCache | null;
  mergedCountTtlMs?: number;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// `exemptLogins` are the logins whose PRs are always in-quota and shouldn't
// even cost a query (maintainers, interns, and configured priority authors).
export async function fetchMergedCounts(
  prs: PullRequest[],
  client: GraphqlClient,
  exemptLogins: Set<string>,
  opts: MergedCountFetchOptions = {},
): Promise<Record<string, number>> {
  const candidates = quotaCandidates(prs, exemptLogins);
  if (candidates.length === 0) {
    log('quota: no multi-PR authors to evaluate; skipping');
    return {};
  }

  log(`quota: evaluating ${candidates.length} multi-PR author(s)`);

  const ttlMs = opts.mergedCountTtlMs ?? DEFAULT_MERGED_COUNT_TTL_MS;
  const cache = opts.cache ?? null;

  // Cache lookups are synchronous and cheap; split into hits (no network
  // needed) and misses (need a countMergedPRs call) up front.
  const merged: Record<string, number> = {};
  const misses: QuotaCandidate[] = [];
  for (const candidate of candidates) {
    const cached =
      cache?.getMergedCount(candidate.owner, candidate.repo, candidate.login, ttlMs) ?? null;
    if (cached !== null) {
      merged[candidate.key] = cached;
    } else {
      misses.push(candidate);
    }
  }

  if (misses.length > 0) {
    await mapWithConcurrency(misses, FETCH_CONCURRENCY, async (candidate) => {
      const count = await client.countMergedPRs(candidate.owner, candidate.repo, candidate.login);
      merged[candidate.key] = count;
      cache?.putMergedCount(candidate.owner, candidate.repo, candidate.login, count);
    });
  }
  log(
    `quota: merged-count cache — ${candidates.length - misses.length} hit(s), ${misses.length} fetched`,
  );
  return merged;
}

export function logAuthorQuotas(openPullRequests: OpenPullRequests): void {
  const rows = authorQuotas(openPullRequests).map(
    ({ candidate, mergedCount, quota, pullRequestsBeyondQuota }) => ({
      repo: `${candidate.owner}/${candidate.repo}`,
      login: candidate.login,
      merged: mergedCount,
      quota,
      open: candidate.pullRequests.length,
      exceeded: pullRequestsBeyondQuota.length,
    }),
  );
  if (rows.length === 0) return;

  // Print as a fixed-width table. Each line is a separate log() call so the
  // timestamp prefix is consistent across header and data rows. The author
  // column is loginW+1 wide to account for the leading '@' in data rows.
  const repoW = Math.max(4, ...rows.map((r) => r.repo.length));
  const loginW = Math.max(7, ...rows.map((r) => r.login.length + 1)); // +1 for '@'
  const header = `${'repo'.padEnd(repoW)}  ${'author'.padEnd(loginW)}  merged  quota  open  exceeded`;
  log(`quota:   ${header}`);
  log(`quota:   ${'-'.repeat(header.length)}`);
  for (const r of rows) {
    const author = `@${r.login}`;
    log(
      `quota:   ${r.repo.padEnd(repoW)}  ${author.padEnd(loginW)}  ${String(r.merged).padStart(6)}  ${String(r.quota).padStart(5)}  ${String(r.open).padStart(4)}  ${String(r.exceeded).padStart(8)}`,
    );
  }
}
