import type { OpenPullRequests } from '@jaegertracing/maintainer-tools-checks';

import { classify, type ClassifiedPR } from './buckets.js';
import type { TriageConfig } from './config.js';
import { attachIssueState } from './issues.js';
import { logAuthorQuotas } from './quota.js';
import type { TriageSnapshot } from './snapshot.js';

export interface TriagePolicy {
  maintainers: Set<string>;
  priorityAuthors: Set<string>;
  codeowners: Record<string, string[]>;
  ignoreReviewRequestedOnYou: boolean;
}

export function buildTriagePolicy(config: TriageConfig): TriagePolicy {
  return {
    maintainers: new Set(config.maintainers),
    priorityAuthors: new Set([...config.maintainers, ...config.interns, ...config.priorityAuthors]),
    codeowners: config.codeowners,
    ignoreReviewRequestedOnYou: config.ignoreReviewRequestedOnYou,
  };
}

// The deciding layer of a triage run: it makes no GitHub call and reads no
// clock, so its result depends only on the snapshot and the config.
export function classifySnapshot(snapshot: TriageSnapshot, policy: TriagePolicy): ClassifiedPR[] {
  const openPullRequests: OpenPullRequests = {
    pullRequests: snapshot.pullRequests,
    mergedCounts: snapshot.mergedCounts,
    // The priority authors are exempt from the quota.
    quotaExemptLogins: policy.priorityAuthors,
    collaborators: snapshot.collaborators,
  };
  logAuthorQuotas(openPullRequests);
  if (snapshot.issues) attachIssueState(snapshot.pullRequests, snapshot.issues);
  return classifyAll(openPullRequests, snapshot.viewer, policy, new Date(snapshot.now));
}

export function classifyAll(
  openPullRequests: OpenPullRequests,
  viewer: string,
  policy: TriagePolicy,
  now: Date,
): ClassifiedPR[] {
  return openPullRequests.pullRequests.map((pr) =>
    classify(pr, {
      viewer,
      maintainers: policy.maintainers,
      priorityAuthors: policy.priorityAuthors,
      codeownerPaths: policy.codeowners[`${pr.repo.owner}/${pr.repo.name}`] ?? [],
      now,
      ignoreReviewRequestedOnYou: policy.ignoreReviewRequestedOnYou,
      openPullRequests,
    }),
  );
}
