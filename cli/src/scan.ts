// Cross-repo PR scanner.
//
// For each configured repo:
//   1. listOpenPRs() — cheap pagination, returns {number, updatedAt} pairs.
//   2. For each PR, look up the cache by updatedAt; on miss, fetch via the
//      full-PR query and write back.
//
// Logs each phase so the user can see what's happening — long fetch loops
// against large repos would otherwise look hung.

import {
  createGraphqlClient,
  type GraphqlClient,
  type PullRequest,
} from '@jaegertracing/maintainer-tools-checks';
import { type PrCache } from '@jaegertracing/maintainer-tools-checks/cache';

import { log } from './log.js';

export interface ScanResult {
  prs: PullRequest[];
  cacheMisses: number;
  cacheHits: number;
}

export async function scanRepos(
  repos: string[],
  client: GraphqlClient,
  cache: PrCache | null,
): Promise<ScanResult> {
  const all: PullRequest[] = [];
  let misses = 0;
  let hits = 0;

  for (const slug of repos) {
    const [owner, name] = slug.split('/', 2) as [string, string];
    log(`  ${slug}: listing open PRs...`);
    const summaries = await client.listOpenPRs(owner, name);
    log(`  ${slug}: ${summaries.length} open PR(s)`);

    let repoHits = 0;
    let repoMisses = 0;
    for (let i = 0; i < summaries.length; i++) {
      const s = summaries[i]!;
      const cached = cache?.get(owner, name, s.number);
      if (cached && cached.updatedAt === s.updatedAt) {
        all.push(cached);
        hits++;
        repoHits++;
        continue;
      }
      log(`  ${slug}#${s.number}: fetching (${i + 1}/${summaries.length})`);
      const fresh = await client.fetchPullRequest(owner, name, s.number);
      cache?.put(fresh);
      all.push(fresh);
      misses++;
      repoMisses++;
    }
    log(`  ${slug}: done (${repoHits} cached, ${repoMisses} fetched)`);
  }

  return { prs: all, cacheMisses: misses, cacheHits: hits };
}

export function makeClient(token: string): GraphqlClient {
  return createGraphqlClient(token);
}
