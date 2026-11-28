// Gathering is the layer of a triage run that talks to GitHub and reads the
// clock. Its whole result is one TriageSnapshot, and the other layer,
// classifySnapshot() in triage-policy.ts, decides from the snapshot and the
// config alone.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type {
  GraphqlClient,
  RepositoryPermission,
  PullRequest,
} from '@jaegertracing/maintainer-tools-checks';
import type { PrCache } from '@jaegertracing/maintainer-tools-checks/cache';

import { log } from './log.js';
import { fetchMergedCounts } from './quota.js';
import { scanRepos } from './scan.js';

// A TriageSnapshot is everything that a triage run takes from GitHub and from
// the clock, as plain data. A run that loads the snapshot from a file makes no
// GitHub call, so the same file and the same config always give the same
// report.
export interface TriageSnapshot {
  // The clock of the run, as an ISO 8601 time.
  now: string;
  // Login of the maintainer that the report is for.
  viewer: string;
  // The open pull requests as GitHub returned them.
  pullRequests: PullRequest[];
  // Merged-PR count of each author that can exceed a quota, keyed by
  // `owner/repo|login`. Absent when the run skipped the quota (--no-quota).
  mergedCounts?: Record<string, number>;
  // The permission of each collaborator of each repository that has an open
  // pull request, keyed by `owner/repo` and then by login. A repository
  // whose list could not be fetched has no entry; GitHub refuses the list
  // to a token without push access. Absent in a snapshot file from before
  // the field existed.
  collaborators?: Record<string, Record<string, RepositoryPermission>>;
  // The run gathered one pull request (--pr) or the first ones of each
  // repository (--limit), and not every open one.
  isPartial?: true;
}

export interface GatherOptions {
  repos: string[];
  // The viewer from the command line or the config. GitHub is asked when
  // neither names one.
  viewer?: string;
  // The run gathers this one pull request instead of every open one of
  // `repos`.
  singlePr?: { owner: string; repo: string; number: number };
  // The run scans at most this many pull requests of each repository.
  limit?: number;
  // The run fetches no merged-PR count for these logins, see quota.ts.
  quotaExemptLogins: Set<string>;
  skipQuota: boolean;
}

export async function gatherSnapshot(
  client: GraphqlClient,
  cache: PrCache | null,
  opts: GatherOptions,
): Promise<TriageSnapshot> {
  let viewer = opts.viewer;
  if (viewer) {
    log(`viewer: @${viewer} (from config)`);
  } else {
    log('viewer: fetching from GraphQL...');
    viewer = await client.fetchViewerLogin();
    log(`viewer: @${viewer}`);
  }

  let pullRequests: PullRequest[];
  if (opts.singlePr) {
    const ref = opts.singlePr;
    log(`single PR mode: ${ref.owner}/${ref.repo}#${ref.number} (bypassing list query)`);
    const fresh = await client.fetchPullRequest(ref.owner, ref.repo, ref.number);
    cache?.put(fresh);
    pullRequests = [fresh];
  } else {
    log(
      `scanning ${opts.repos.length} repo(s): ${opts.repos.join(', ')}` +
        (opts.limit !== undefined ? ` (limit ${opts.limit} per repo)` : ''),
    );
    const result = await scanRepos(opts.repos, client, cache, { limit: opts.limit });
    log(
      `scan complete: ${result.prs.length} open PR(s) — ${result.cacheHits} cached, ${result.cacheMisses} fetched`,
    );
    pullRequests = result.prs;
  }

  let mergedCounts: TriageSnapshot['mergedCounts'];
  if (opts.skipQuota) {
    log('quota: computation skipped (--no-quota); no PR is flagged as over its quota');
  } else {
    mergedCounts = await fetchMergedCounts(pullRequests, client, opts.quotaExemptLogins, { cache });
  }

  const collaborators = await fetchCollaboratorsOfRepos(pullRequests, client);

  return {
    now: new Date().toISOString(),
    viewer,
    pullRequests,
    mergedCounts,
    collaborators,
    ...(opts.singlePr || opts.limit !== undefined ? { isPartial: true as const } : {}),
  };
}

async function fetchCollaboratorsOfRepos(
  pullRequests: PullRequest[],
  client: GraphqlClient,
): Promise<NonNullable<TriageSnapshot['collaborators']>> {
  const repos = new Map(pullRequests.map((pr) => [`${pr.repo.owner}/${pr.repo.name}`, pr.repo]));
  const collaborators: NonNullable<TriageSnapshot['collaborators']> = {};
  for (const [key, repo] of repos) {
    try {
      const permissions = await client.fetchCollaborators(repo.owner, repo.name);
      collaborators[key] = permissions;
      log(`collaborators: ${Object.keys(permissions).length} in ${key}`);
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      log(`collaborators: not gathered for ${key} (${reason})`);
    }
  }
  return collaborators;
}

// readSnapshot() returns the pull requests in the order in which
// gatherSnapshot() returns them for the same config: grouped by repository,
// in the order of `repos`. A pull request of a repository that the config
// does not list stops the run.
export function readSnapshot(path: string, repos: string[]): TriageSnapshot {
  const snapshot = JSON.parse(readFileSync(path, 'utf8')) as TriageSnapshot;
  if (
    !Array.isArray(snapshot.pullRequests) ||
    typeof snapshot.viewer !== 'string' ||
    Number.isNaN(Date.parse(snapshot.now))
  ) {
    throw new Error(`${path} is not a snapshot written by --save-snapshot.`);
  }
  const repoOf = (pr: PullRequest): string => `${pr.repo.owner}/${pr.repo.name}`;
  const unlistedRepo = snapshot.pullRequests.map(repoOf).find((repo) => !repos.includes(repo));
  if (unlistedRepo) {
    throw new Error(
      `${path} holds pull requests of ${unlistedRepo}, which the config does not list.`,
    );
  }
  const positionInConfig = (pr: PullRequest): number => repos.indexOf(repoOf(pr));
  return {
    ...snapshot,
    pullRequests: [...snapshot.pullRequests].sort(
      (a, b) => positionInConfig(a) - positionInConfig(b),
    ),
  };
}

export function writeSnapshot(path: string, snapshot: TriageSnapshot): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(snapshot, null, 2) + '\n');
}
