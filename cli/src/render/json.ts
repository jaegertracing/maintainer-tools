// The JSON report exists so that two versions of the code can be compared on
// one snapshot: it holds the decisions without the fetched data, sorted and
// without the time of the run. See "Comparing two versions of the classifier"
// in ARCHITECTURE.md.

import type { ClassifiedPR } from '../buckets.js';

export function renderJson(classified: ClassifiedPR[]): string {
  const byRepo = new Map<string, ClassifiedPR[]>();
  for (const c of classified) {
    const repo = `${c.pr.repo.owner}/${c.pr.repo.name}`;
    const ofRepo = byRepo.get(repo);
    if (ofRepo) ofRepo.push(c);
    else byRepo.set(repo, [c]);
  }
  const report = {
    repos: [...byRepo.keys()].sort().map((repo) => ({
      repo,
      pullRequests: byRepo
        .get(repo)!
        .sort((a, b) => a.pr.number - b.pr.number)
        .map(({ pr, ...decisions }) => ({ number: pr.number, ...decisions })),
    })),
  };
  return JSON.stringify(withSortedKeys(report), null, 2) + '\n';
}

function withSortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withSortedKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, child]) => [key, withSortedKeys(child)]),
  );
}
