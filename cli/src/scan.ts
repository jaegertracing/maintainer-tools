// Cross-repo PR scanner.
//
// For each configured repo:
//   1. listOpenPRs() — cheap pagination; returns each PR's updatedAt, head
//      SHA, and head-commit status check rollup.
//   2. For each PR, check the cache against all three fields; on miss,
//      fetch the full PR and overwrite.
//
// All three fields matter because GitHub does not advance `updatedAt`
// when CI completes (rollup state changes on the commit, not the PR) or
// when the base branch advances under the PR (mergeable flips silently).
// Comparing the head SHA also catches force-pushes that somehow didn't
// bump updatedAt.
//
// Logs each phase so the user can see what's happening — long fetch loops
// against large repos would otherwise look hung.

import {
  createGraphqlClient,
  type GraphqlClient,
  type PrSummary,
  type PullRequest,
} from '@jaegertracing/maintainer-tools-checks';
import { type PrCache } from '@jaegertracing/maintainer-tools-checks/cache';

import { log } from './log.js';

export interface ScanResult {
  prs: PullRequest[];
  cacheMisses: number;
  cacheHits: number;
}

export interface ScanOptions {
  // Cap per-repo PR count. Caller-supplied for testing; production runs leave
  // this undefined to scan everything. The list query returns PRs
  // updated-desc, so this samples the most recently active.
  limit?: number;
}

export async function scanRepos(
  repos: string[],
  client: GraphqlClient,
  cache: PrCache | null,
  opts: ScanOptions = {},
): Promise<ScanResult> {
  const all: PullRequest[] = [];
  let misses = 0;
  let hits = 0;

  for (const slug of repos) {
    const [owner, name] = slug.split('/', 2) as [string, string];
    log(`  ${slug}: listing open PRs...`);
    const fullList = await client.listOpenPRs(owner, name);
    const summaries =
      opts.limit !== undefined && fullList.length > opts.limit
        ? fullList.slice(0, opts.limit)
        : fullList;
    log(
      `  ${slug}: ${summaries.length} open PR(s)` +
        (summaries.length < fullList.length ? ` (truncated from ${fullList.length})` : ''),
    );

    // Split into cache-check + fetch passes so the fetch counter reads
    // 1/N out of the number that actually need fetching, not 1/total.
    const toFetch: PrSummary[] = [];
    for (const s of summaries) {
      const cached = cache?.get(owner, name, s.number);
      if (cached && isFresh(cached, s)) {
        all.push(cached);
        hits++;
        continue;
      }
      toFetch.push(s);
    }
    const repoHits = summaries.length - toFetch.length;
    log(`  ${slug}: ${repoHits} cached, ${toFetch.length} to fetch`);

    for (let i = 0; i < toFetch.length; i++) {
      const s = toFetch[i]!;
      log(`  ${slug}#${s.number}: fetching (${i + 1}/${toFetch.length})`);
      const fresh = await client.fetchPullRequest(owner, name, s.number);
      cache?.put(fresh);
      all.push(fresh);
      misses++;
    }
    log(`  ${slug}: done`);
  }

  return { prs: all, cacheMisses: misses, cacheHits: hits };
}

// Three-part freshness check. If updatedAt drifted, the PR moved (push,
// comment, review, label). If headSha drifted, the branch was force-pushed
// without bumping updatedAt — rare but possible. If headRollup drifted, CI
// completed and the cached `statusCheckRollup` is stale.
function isFresh(cached: PullRequest, s: PrSummary): boolean {
  const cachedHead = cached.commits[cached.commits.length - 1];
  return (
    cached.updatedAt === s.updatedAt &&
    (cachedHead?.sha ?? null) === s.headSha &&
    cached.statusCheckRollup === s.headRollup
  );
}

export function makeClient(token: string): GraphqlClient {
  return createGraphqlClient(token);
}
