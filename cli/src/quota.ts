// Cross-PR quota enrichment.
//
// Mirrors the policy implemented by the upstream pr-quota-manager workflow
// in jaegertracing/jaeger/.github/scripts/pr-quota-manager.js. Quota tiers
// are based on the author's merged-PR count in the repo:
//
//   merged = 0  -> quota = 1   (first-time contributor)
//   merged = 1  -> quota = 2
//   merged = 2  -> quota = 3
//   merged >= 3 -> quota = 10  (effectively unlimited)
//
// For each (owner/repo, author) bucket with > 1 open PR, fetchMergedCounts()
// fetches the merged count while the snapshot is gathered. From those
// counts markQuotaExceeded() calculates the quota, sorts the author's open
// PRs by createdAt (oldest first), and marks anything beyond the quota as
// `computed.quotaExceeded = true`. Authors with a single open PR are
// trivially in-quota regardless of tier and skipped.
//
// Single-open-PR authors and exempt logins get
// no enrichment, which keeps the query budget proportional to the small
// subset that could actually be quota-blocked.

import {
  hasLogin,
  type GraphqlClient,
  type PullRequest,
} from '@jaegertracing/maintainer-tools-checks';
import type { PrCache } from '@jaegertracing/maintainer-tools-checks/cache';

import { log } from './log.js';

export function calculateQuota(mergedCount: number): number {
  if (mergedCount === 0) return 1;
  if (mergedCount === 1) return 2;
  if (mergedCount === 2) return 3;
  return 10; // effectively unlimited
}

// Merged-PR counts only grow as authors land more PRs, and quota tiers are
// coarse (see calculateQuota above) — a day-old count is virtually never
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

interface QuotaCandidate {
  // `owner/repo|login`, the key of the author's merged count in the snapshot.
  key: string;
  owner: string;
  repo: string;
  login: string;
  authorPRs: PullRequest[];
}

// `exemptLogins` are the logins whose PRs are always in-quota and shouldn't
// even cost a query (maintainers, interns, and configured priority authors).
function quotaCandidates(prs: PullRequest[], exemptLogins: Set<string>): QuotaCandidate[] {
  // Group by (repo, author).
  const groups = new Map<string, PullRequest[]>();
  for (const pr of prs) {
    const login = pr.author?.login;
    if (!login) continue;
    if (hasLogin(exemptLogins, login)) continue;
    const key = `${pr.repo.owner}/${pr.repo.name}|${login}`;
    let arr = groups.get(key);
    if (!arr) {
      arr = [];
      groups.set(key, arr);
    }
    arr.push(pr);
  }

  // Skip authors with one open PR — they can't exceed any quota tier.
  return [...groups.entries()]
    .filter(([, arr]) => arr.length > 1)
    .map(([key, authorPRs]) => {
      const [slug, login] = key.split('|') as [string, string];
      const [owner, repo] = slug.split('/') as [string, string];
      return { key, owner, repo, login, authorPRs };
    });
}

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

export function markQuotaExceeded(
  prs: PullRequest[],
  mergedCounts: Record<string, number>,
  exemptLogins: Set<string>,
): void {
  const candidates = quotaCandidates(prs, exemptLogins);
  if (candidates.length === 0) return;

  interface Row {
    repo: string;
    login: string;
    merged: number;
    quota: number;
    open: number;
    exceeded: number;
  }
  const rows: Row[] = [];

  for (const candidate of candidates) {
    const mergedCount = mergedCounts[candidate.key];
    if (mergedCount === undefined) {
      throw new Error(
        `the snapshot has no merged-PR count for @${candidate.login} in ${candidate.owner}/${candidate.repo}; ` +
          'it was gathered with a config that exempts this author from the quota',
      );
    }
    const quota = calculateQuota(mergedCount);
    const sorted = [...candidate.authorPRs].sort(
      (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
    );
    const exceeded = sorted.slice(quota);
    for (const pr of exceeded) {
      pr.computed ??= {};
      pr.computed.quotaExceeded = true;
    }
    rows.push({
      repo: `${candidate.owner}/${candidate.repo}`,
      login: candidate.login,
      merged: mergedCount,
      quota,
      open: candidate.authorPRs.length,
      exceeded: exceeded.length,
    });
  }

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
