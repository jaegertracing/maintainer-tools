// Renderer-agnostic data shaping: group classified PRs into repo blocks and
// bucket sections, sort by staleness (oldest first), and pre-compute the
// "visible / total" header counts each renderer displays.

import type { PullRequest } from '@jaegertracing/maintainer-tools-checks';
import { type Bucket, BUCKET_ORDER, type ClassifiedPR } from '../buckets.js';

export interface BucketSection {
  bucket: Bucket;
  prs: ClassifiedPR[];
}

export interface RepoBlock {
  repo: string; // "owner/name"
  totalCount: number;
  visibleCount: number; // excludes Hidden
  sections: BucketSection[];
  // For the Hidden header line: counts split by reason.
  hiddenBreakdown: Map<string, number>;
}

export function groupByRepo(classified: ClassifiedPR[]): RepoBlock[] {
  const byRepo = new Map<string, ClassifiedPR[]>();
  for (const c of classified) {
    const key = `${c.pr.repo.owner}/${c.pr.repo.name}`;
    let arr = byRepo.get(key);
    if (!arr) {
      arr = [];
      byRepo.set(key, arr);
    }
    arr.push(c);
  }

  const blocks: RepoBlock[] = [];
  for (const [repo, prs] of byRepo) {
    const sections: BucketSection[] = [];
    for (const bucket of BUCKET_ORDER) {
      const inBucket = prs
        .filter((c) => c.bucket === bucket)
        .sort((a, b) => Date.parse(a.pr.updatedAt) - Date.parse(b.pr.updatedAt));
      if (inBucket.length > 0) sections.push({ bucket, prs: inBucket });
    }

    const visibleCount = prs.filter((c) => c.bucket !== 'hidden').length;
    const hiddenBreakdown = new Map<string, number>();
    for (const c of prs.filter((p) => p.bucket === 'hidden')) {
      const reason = c.reasons[0] ?? 'other';
      hiddenBreakdown.set(reason, (hiddenBreakdown.get(reason) ?? 0) + 1);
    }

    blocks.push({
      repo,
      totalCount: prs.length,
      visibleCount,
      sections,
      hiddenBreakdown,
    });
  }
  // Stable repo order — match the order PRs were scanned in (insertion order
  // of the underlying Map already does this).
  return blocks;
}

export function ageInDays(pr: PullRequest, now: Date): number {
  return Math.max(0, (now.getTime() - Date.parse(pr.updatedAt)) / (1000 * 60 * 60 * 24));
}

export function formatAge(pr: PullRequest, now: Date): string {
  const days = ageInDays(pr, now);
  if (days < 1) {
    const hours = Math.floor(days * 24);
    return `${hours}h`;
  }
  return `${Math.floor(days)}d`;
}

export function summarizeAuthor(pr: PullRequest): string {
  return pr.author?.login ?? '(unknown)';
}
