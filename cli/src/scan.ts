// Cross-repo PR scanner.
//
// For each configured repo:
//   1. listOpenPRs() — cheap pagination, returns {number, updatedAt} pairs.
//   2. For each PR, look up the cache by updatedAt; on miss, fetch via the
//      full-PR query and write back.
//
// Surfaces only the cache-miss count up to the caller so the CLI can log
// how much work the cache saved on this run.

import {
  createGraphqlClient,
  type GraphqlClient,
  type PullRequest,
} from '@jaegertracing/maintainer-tools-checks';
import { type PrCache } from '@jaegertracing/maintainer-tools-checks/cache';

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
    const summaries = await client.listOpenPRs(owner, name);
    for (const s of summaries) {
      const cached = cache?.get(owner, name, s.number);
      if (cached && cached.updatedAt === s.updatedAt) {
        all.push(cached);
        hits++;
        continue;
      }
      const fresh = await client.fetchPullRequest(owner, name, s.number);
      cache?.put(fresh);
      all.push(fresh);
      misses++;
    }
  }

  return { prs: all, cacheMisses: misses, cacheHits: hits };
}

export function makeClient(token: string): GraphqlClient {
  return createGraphqlClient(token);
}
