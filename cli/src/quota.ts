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

import { log } from './log.js';

export function calculateQuota(mergedCount: number): number {
  if (mergedCount === 0) return 1;
  if (mergedCount === 1) return 2;
  if (mergedCount === 2) return 3;
  return 10; // effectively unlimited
}

export interface QuotaEnrichOptions {
  // Logins whose PRs are always in-quota and shouldn't even cost a query
  // (maintainers, interns, configured high-trust authors).
  exemptLogins: Set<string>;
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

  interface Row {
    repo: string;
    login: string;
    merged: number;
    quota: number;
    open: number;
    exceeded: number;
  }
  const rows: Row[] = [];

  for (const [key, authorPRs] of candidates) {
    const [slug, login] = key.split('|') as [string, string];
    const [owner, repo] = slug.split('/') as [string, string];

    const mergedCount = await client.countMergedPRs(owner, repo, login);
    const quota = calculateQuota(mergedCount);
    const sorted = [...authorPRs].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    const exceeded = sorted.slice(quota);
    for (const pr of exceeded) {
      pr.computed ??= {};
      pr.computed.quotaExceeded = true;
    }
    rows.push({ repo: slug, login, merged: mergedCount, quota, open: authorPRs.length, exceeded: exceeded.length });
  }

  // Print as a fixed-width table. Each line is a separate log() call so the
  // timestamp prefix is consistent across header and data rows. The author
  // column is loginW+1 wide to account for the leading '@' in data rows.
  const repoW  = Math.max(4, ...rows.map((r) => r.repo.length));
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
