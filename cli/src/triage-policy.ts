import type { PullRequest } from '@jaegertracing/maintainer-tools-checks';

import { classify, type ClassifiedPR } from './buckets.js';
import type { TriageConfig } from './config.js';

export function priorityAuthorLogins(
  config: Pick<TriageConfig, 'maintainers' | 'interns' | 'priorityAuthors'>,
): Set<string> {
  return new Set([...config.maintainers, ...config.interns, ...config.priorityAuthors]);
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
