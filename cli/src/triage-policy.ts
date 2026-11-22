import type { PullRequest } from '@jaegertracing/maintainer-tools-checks';

import { classify, type ClassifiedPR } from './buckets.js';
import type { TriageConfig } from './config.js';
import { attachIssueState } from './issues.js';
import { markQuotaExceeded } from './quota.js';
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
  const prs = snapshot.pullRequests;
  if (snapshot.mergedCounts) markQuotaExceeded(prs, snapshot.mergedCounts, policy.priorityAuthors);
  if (snapshot.issues) attachIssueState(prs, snapshot.issues);
  return classifyAll(prs, snapshot.viewer, policy, new Date(snapshot.now));
}

export function classifyAll(
  prs: PullRequest[],
  viewer: string,
  policy: TriagePolicy,
  now: Date,
): ClassifiedPR[] {
  return prs.map((pr) =>
    classify(pr, {
      viewer,
      maintainers: policy.maintainers,
      priorityAuthors: policy.priorityAuthors,
      codeownerPaths: policy.codeowners[`${pr.repo.owner}/${pr.repo.name}`] ?? [],
      now,
      ignoreReviewRequestedOnYou: policy.ignoreReviewRequestedOnYou,
    }),
  );
}
