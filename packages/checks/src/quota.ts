// The quota of open pull requests of one author in one repository.
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
// authorQuotas() sorts the open PRs of an author by createdAt, oldest
// first, and every PR beyond the quota of the author is over the quota.
// An author with a single open PR is in-quota in every tier and is skipped,
// and so is an exempt login.

import { hasLogin } from './logins.js';
import type { OpenPullRequests, PullRequest } from './types.js';

const QUOTA_BY_MERGED_COUNT = [1, 2, 3];
// An author with more merged pull requests than the table lists is not
// limited in practice.
const QUOTA_OF_ESTABLISHED_AUTHOR = 10;

export function quotaFor(mergedCount: number): number {
  return QUOTA_BY_MERGED_COUNT[mergedCount] ?? QUOTA_OF_ESTABLISHED_AUTHOR;
}

// An author who can exceed a quota in one repository: the author has two or
// more open pull requests there and is not exempt. Every quota allows one
// pull request, so the merged count of any other author is never fetched.
export interface QuotaCandidate {
  // `owner/repo|login`, the key of the merged count of the author.
  key: string;
  owner: string;
  repo: string;
  login: string;
  pullRequests: PullRequest[];
}

export function quotaCandidates(
  pullRequests: readonly PullRequest[],
  exemptLogins: ReadonlySet<string>,
): QuotaCandidate[] {
  const candidates = new Map<string, QuotaCandidate>();
  for (const pr of pullRequests) {
    const login = pr.author?.login;
    if (!login || hasLogin(exemptLogins, login)) continue;
    const { owner, name: repo } = pr.repo;
    const key = `${owner}/${repo}|${login}`;
    const candidate = candidates.get(key);
    if (candidate) candidate.pullRequests.push(pr);
    else candidates.set(key, { key, owner, repo, login, pullRequests: [pr] });
  }
  return [...candidates.values()].filter((candidate) => candidate.pullRequests.length > 1);
}

// The quota of one candidate, with the pull requests that are beyond it. The
// pull requests of an author are ranked by creation, and the quota admits
// the oldest ones.
export interface AuthorQuota {
  candidate: QuotaCandidate;
  mergedCount: number;
  quota: number;
  pullRequestsBeyondQuota: PullRequest[];
}

const authorQuotasOf = new WeakMap<OpenPullRequests, AuthorQuota[]>();

// Returns no quota when the merged counts were not gathered. A candidate
// without a count stops the run, because a count read as zero would give the
// author the lowest quota.
export function authorQuotas(openPullRequests: OpenPullRequests): AuthorQuota[] {
  const { mergedCounts } = openPullRequests;
  if (!mergedCounts) return [];
  let quotas = authorQuotasOf.get(openPullRequests);
  if (!quotas) {
    quotas = quotaCandidates(openPullRequests.pullRequests, openPullRequests.quotaExemptLogins).map(
      (candidate) => {
        const mergedCount = mergedCounts[candidate.key];
        if (mergedCount === undefined) {
          throw new Error(
            `the snapshot has no merged-PR count for @${candidate.login} in ${candidate.owner}/${candidate.repo}; ` +
              'it was gathered with a config that exempts this author from the quota',
          );
        }
        const quota = quotaFor(mergedCount);
        const oldestFirst = [...candidate.pullRequests].sort(
          (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
        );
        return { candidate, mergedCount, quota, pullRequestsBeyondQuota: oldestFirst.slice(quota) };
      },
    );
    authorQuotasOf.set(openPullRequests, quotas);
  }
  return quotas;
}

export function isBeyondQuota(pr: PullRequest, openPullRequests: OpenPullRequests): boolean {
  // A caller may evaluate a copy of a pull request, so the pull requests are
  // compared by repository and number and not by identity.
  return authorQuotas(openPullRequests).some(({ pullRequestsBeyondQuota }) =>
    pullRequestsBeyondQuota.some(
      (prBeyondQuota) =>
        prBeyondQuota.number === pr.number &&
        prBeyondQuota.repo.owner === pr.repo.owner &&
        prBeyondQuota.repo.name === pr.repo.name,
    ),
  );
}
