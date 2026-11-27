// The JSON report exists so that two versions of the code can be compared on
// one snapshot: it holds the decisions without the fetched data, sorted and
// without the time of the run. See "Comparing two versions of the classifier"
// in ARCHITECTURE.md.

import {
  CHECK_FACTS,
  CHECK_IDS,
  checkRunConclusion,
  labelOnlyFailure,
  supportingFacts,
  OutputName,
  type Verdict,
} from '@jaegertracing/maintainer-tools-checks';

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
        .map(({ pr, verdict, ...decisions }) => ({
          number: pr.number,
          ...decisions,
          checks: checksOf(verdict),
        })),
    })),
  };
  return JSON.stringify(withSortedKeys(report), null, 2) + '\n';
}

// The field keeps the names that it had before the checks became facts, so
// that the reports of two versions of the code can be compared byte for byte.
function checksOf(verdict: Verdict): object[] {
  const factsSupportingDigest = supportingFacts(verdict, OutputName.WeeklyDigest);
  const factsSupportingHidden = supportingFacts(verdict, OutputName.TriageHidden);
  return CHECK_IDS.map((id) => {
    const triggered = verdict.holds(CHECK_FACTS[id]);
    const checkConclusion = checkRunConclusion(id, verdict);
    return {
      id,
      triggered,
      summary: verdict.summary(id),
      details: verdict.details(id),
      publishesCheck: checkConclusion !== undefined,
      checkConclusion,
      inDigest: factsSupportingDigest.includes(id),
      hidesFromTriage: factsSupportingHidden.includes(id),
      ...(id === 'ci_failing' && triggered
        ? { labelOnlyFailure: verdict.holds(labelOnlyFailure) }
        : {}),
    };
  });
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
