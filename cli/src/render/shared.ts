// Renderer-agnostic data shaping: group classified PRs into repo blocks and
// bucket sections, sort by staleness (oldest first), and pre-compute the
// "visible / total" header counts each renderer displays.

import type { PullRequest } from '@jaegertracing/maintainer-tools-checks';
import { type Bucket, BUCKET_ORDER, type ClassifiedPR } from '../buckets.js';

export interface BucketSection {
  bucket: Bucket;
  prs: ClassifiedPR[];
}

// When priorityLabels are configured, each RepoBlock is subdivided into
// PriorityGroup entries (one per label plus one catch-all for unlabelled PRs).
// When priorityLabels is empty, `priorityGroups` is empty and `sections`
// contains the flat bucket view used before priority labels were introduced.
export interface PriorityGroup {
  label: string; // the matched priority label, or NO_PRIORITY_LABEL for catch-all
  sections: BucketSection[];
  totalCount: number;
  visibleCount: number;
  hiddenBreakdown: Map<string, number>;
}

// Sentinel used as the label for PRs that carry none of the configured
// priority labels.
export const NO_PRIORITY_LABEL = '(no priority)';

export interface RepoBlock {
  repo: string; // "owner/name"
  totalCount: number;
  visibleCount: number; // excludes Hidden
  // Non-empty only when priorityLabels were provided to groupByRepo.
  priorityGroups: PriorityGroup[];
  // Non-empty only when priorityLabels is empty (flat view).
  sections: BucketSection[];
  // For the Hidden header line in flat view: counts split by reason.
  hiddenBreakdown: Map<string, number>;
}

export function groupByRepo(
  classified: ClassifiedPR[],
  priorityLabels: string[] = [],
): RepoBlock[] {
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
    const visibleCount = prs.filter((c) => c.bucket !== 'hidden').length;

    if (priorityLabels.length > 0) {
      const priorityGroups = buildPriorityGroups(prs, priorityLabels);
      blocks.push({
        repo,
        totalCount: prs.length,
        visibleCount,
        priorityGroups,
        sections: [],
        hiddenBreakdown: new Map(),
      });
    } else {
      const { sections, hiddenBreakdown } = buildSections(prs);
      blocks.push({
        repo,
        totalCount: prs.length,
        visibleCount,
        priorityGroups: [],
        sections,
        hiddenBreakdown,
      });
    }
  }
  // Stable repo order — match the order PRs were scanned in (insertion order
  // of the underlying Map already does this).
  return blocks;
}

function buildSections(prs: ClassifiedPR[]): {
  sections: BucketSection[];
  hiddenBreakdown: Map<string, number>;
} {
  const sections: BucketSection[] = [];
  for (const bucket of BUCKET_ORDER) {
    const inBucket = prs
      .filter((c) => c.bucket === bucket)
      .sort((a, b) => Date.parse(a.pr.updatedAt) - Date.parse(b.pr.updatedAt));
    if (inBucket.length > 0) sections.push({ bucket, prs: inBucket });
  }
  const hiddenBreakdown = new Map<string, number>();
  for (const c of prs.filter((p) => p.bucket === 'hidden')) {
    const reason = c.reasons[0] ?? 'other';
    hiddenBreakdown.set(reason, (hiddenBreakdown.get(reason) ?? 0) + 1);
  }
  return { sections, hiddenBreakdown };
}

function buildPriorityGroups(prs: ClassifiedPR[], priorityLabels: string[]): PriorityGroup[] {
  // Assign each PR to the first matching priority label, or NO_PRIORITY_LABEL.
  const byLabel = new Map<string, ClassifiedPR[]>();
  for (const label of priorityLabels) byLabel.set(label, []);
  byLabel.set(NO_PRIORITY_LABEL, []);

  for (const c of prs) {
    const matched = priorityLabels.find((l) => c.pr.labels.includes(l));
    const key = matched ?? NO_PRIORITY_LABEL;
    byLabel.get(key)!.push(c);
  }

  const groups: PriorityGroup[] = [];
  for (const [label, groupPrs] of byLabel) {
    if (groupPrs.length === 0) continue;
    const { sections, hiddenBreakdown } = buildSections(groupPrs);
    groups.push({
      label,
      sections,
      totalCount: groupPrs.length,
      visibleCount: groupPrs.filter((c) => c.bucket !== 'hidden').length,
      hiddenBreakdown,
    });
  }
  return groups;
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
