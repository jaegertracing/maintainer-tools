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
// For each (owner/repo, author) bucket with > 1 open PR, we fetch the
// merged count, calculate the quota, sort the author's open PRs by
// createdAt (oldest first), and mark anything beyond the quota as
// `computed.quotaExceeded = true`. Authors with a single open PR are
// trivially in-quota regardless of tier and skipped.
//
// Single-open-PR authors and exempt logins (maintainers + interns) get
// no enrichment, which keeps the query budget proportional to the small
// subset that could actually be quota-blocked.

import type { GraphqlClient, PullRequest } from '@jaegertracing/maintainer-tools-checks';
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

export interface QuotaEnrichOptions {
  // Logins whose PRs are always in-quota and shouldn't even cost a query
  // (maintainers, interns, configured high-trust authors).
  exemptLogins: Set<string>;
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

export async function enrichQuotaState(
  prs: PullRequest[],
  client: GraphqlClient,
  opts: QuotaEnrichOptions,
): Promise<void> {
  // Group by (repo, author).
  const groups = new Map<string, PullRequest[]>();
  for (const pr of prs) {
    const login = pr.author?.login;
    if (!login) continue;
    if (opts.exemptLogins.has(login)) continue;
    const key = `${pr.repo.owner}/${pr.repo.name}|${login}`;
    let arr = groups.get(key);
    if (!arr) {
      arr = [];
      groups.set(key, arr);
    }
    arr.push(pr);
  }

  // Skip authors with one open PR — they can't exceed any quota tier.
  const candidates = [...groups.entries()].filter(([, arr]) => arr.length > 1);
  if (candidates.length === 0) {
    log('quota: no multi-PR authors to evaluate; skipping');
    return;
  }

  log(`quota: evaluating ${candidates.length} multi-PR author(s)`);

  const ttlMs = opts.mergedCountTtlMs ?? DEFAULT_MERGED_COUNT_TTL_MS;
  const cache = opts.cache ?? null;

  interface Candidate {
    key: string;
    owner: string;
    repo: string;
    login: string;
    authorPRs: PullRequest[];
  }
  const parsed: Candidate[] = candidates.map(([key, authorPRs]) => {
    const [slug, login] = key.split('|') as [string, string];
    const [owner, repo] = slug.split('/') as [string, string];
    return { key, owner, repo, login, authorPRs };
  });

  // Cache lookups are synchronous and cheap; split into hits (no network
  // needed) and misses (need a countMergedPRs call) up front.
  const merged = new Map<string, number>();
  const misses: Candidate[] = [];
  for (const c of parsed) {
    const cached = cache?.getMergedCount(c.owner, c.repo, c.login, ttlMs) ?? null;
    if (cached !== null) {
      merged.set(c.key, cached);
    } else {
      misses.push(c);
    }
  }

  if (misses.length > 0) {
    await mapWithConcurrency(misses, FETCH_CONCURRENCY, async (c) => {
      const count = await client.countMergedPRs(c.owner, c.repo, c.login);
      merged.set(c.key, count);
      cache?.putMergedCount(c.owner, c.repo, c.login, count);
    });
  }
  log(
    `quota: merged-count cache — ${parsed.length - misses.length} hit(s), ${misses.length} fetched`,
  );

  interface Row {
    repo: string;
    login: string;
    merged: number;
    quota: number;
    open: number;
    exceeded: number;
  }
  const rows: Row[] = [];

  for (const c of parsed) {
    const mergedCount = merged.get(c.key)!;
    const quota = calculateQuota(mergedCount);
    const sorted = [...c.authorPRs].sort(
      (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
    );
    const exceeded = sorted.slice(quota);
    for (const pr of exceeded) {
      pr.computed ??= {};
      pr.computed.quotaExceeded = true;
    }
    rows.push({
      repo: `${c.owner}/${c.repo}`,
      login: c.login,
      merged: mergedCount,
      quota,
      open: c.authorPRs.length,
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
