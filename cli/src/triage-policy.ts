import type { PullRequest } from '@jaegertracing/maintainer-tools-checks';

import { classify, type ClassifiedPR } from './buckets.js';
import type { TriageConfig } from './config.js';

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
