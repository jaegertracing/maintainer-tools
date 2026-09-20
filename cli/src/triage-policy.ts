import type { PullRequest } from '@jaegertracing/maintainer-tools-checks';

import { classify, type ClassifiedPR } from './buckets.js';
import { priorityAuthorLogins, type TriageConfig } from './config.js';

export function quotaExemptLogins(config: TriageConfig): Set<string> {
  return priorityAuthorLogins(config);
}

export function classifyAll(
  prs: PullRequest[],
  viewer: string,
  config: TriageConfig,
  now: Date,
): ClassifiedPR[] {
  const maintainers = new Set(config.maintainers);
  const priorityAuthors = priorityAuthorLogins(config);
  return prs.map((pr) =>
    classify(pr, {
      viewer,
      maintainers,
      priorityAuthors,
      codeownerPaths: config.codeowners[`${pr.repo.owner}/${pr.repo.name}`] ?? [],
      now,
      ignoreReviewRequestedOnYou: config.ignoreReviewRequestedOnYou,
    }),
  );
}
