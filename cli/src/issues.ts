// Referenced-issue enrichment.
//
// Three signals the per-PR GraphQL query cannot supply on its own:
//
//   1. Which issue a PR claims to close — parsed from the body, free.
//   2. Whether that issue was opened by the PR author. A contributor who files
//      an issue and immediately opens a PR against it has usually manufactured
//      the task rather than found a problem the project already wanted fixed.
//      Needs the issue's author, so it costs a request.
//   3. Which other open PRs claim the same issue. Duplicated effort is a
//      property of the scanned set, not of any single PR, so it can only be
//      computed here. On the Jaeger queue this is not rare: 6 issues carried
//      14 of the 95 visible PRs, including one issue with three separate PRs
//      all making the same one-line fix.

import {
  extractIssueRefs,
  refKey,
  type GraphqlClient,
  type IssueMeta,
  type IssueRef,
  type PullRequest,
} from '@jaegertracing/maintainer-tools-checks';
import type { PrCache } from '@jaegertracing/maintainer-tools-checks/cache';

import { log } from './log.js';

// An issue's author never changes; its open/closed state does. Six hours keeps
// the "already closed" signal usefully fresh while making repeat runs on the
// same day free.
const DEFAULT_ISSUE_TTL_MS = 6 * 60 * 60 * 1000;

export interface IssueFetchOptions {
  cache?: PrCache | null;
  issueTtlMs?: number;
}

function prKey(pr: PullRequest): string {
  return `${pr.repo.owner}/${pr.repo.name}#${pr.number}`;
}

function issueRefsOf(pr: PullRequest): IssueRef[] {
  return extractIssueRefs(pr.body ?? '', pr.repo.owner, pr.repo.name);
}

// Returns the metadata of every issue that a PR claims to close, keyed by
// `refKey()`. An issue that GitHub did not resolve has no entry.
export async function fetchIssueMeta(
  prs: PullRequest[],
  client: GraphqlClient,
  opts: IssueFetchOptions = {},
): Promise<Record<string, IssueMeta>> {
  const ttl = opts.issueTtlMs ?? DEFAULT_ISSUE_TTL_MS;
  const cache = opts.cache ?? null;

  const wanted = new Map<string, IssueRef>();
  let withRefs = 0;
  for (const pr of prs) {
    const refs = issueRefsOf(pr);
    if (refs.length > 0) withRefs++;
    for (const ref of refs) wanted.set(refKey(ref), ref);
  }
  log(
    `issues: ${withRefs}/${prs.length} PR(s) reference an issue; ${wanted.size} distinct issue(s)`,
  );
  if (wanted.size === 0) return {};

  // Resolve metadata, cache first.
  const meta: Record<string, IssueMeta> = {};
  const misses: IssueRef[] = [];
  for (const [key, ref] of wanted) {
    const hit = cache?.getIssue(ref.owner, ref.repo, ref.number, ttl);
    if (hit) meta[key] = hit;
    else misses.push(ref);
  }
  let fetchedCount = 0;
  if (misses.length > 0) {
    const fetched = await client.fetchIssues(misses);
    fetchedCount = fetched.size;
    for (const [key, m] of fetched) {
      meta[key] = m;
      const ref = wanted.get(key);
      if (ref && cache) cache.putIssue(ref.owner, ref.repo, ref.number, m);
    }
  }
  log(
    `issues: metadata — ${wanted.size - misses.length} cached, ${misses.length} fetched` +
      (misses.length > fetchedCount ? `, ${misses.length - fetchedCount} unresolved` : ''),
  );
  return meta;
}

export function attachIssueState(prs: PullRequest[], issues: Record<string, IssueMeta>): void {
  // Pass 1: parse refs out of every body.
  let hasIssueRefs = false;
  for (const pr of prs) {
    const refs = issueRefsOf(pr);
    pr.computed = { ...pr.computed, issueRefs: refs };
    if (refs.length > 0) hasIssueRefs = true;
  }
  if (!hasIssueRefs) return;

  // Pass 2: attach metadata and compute collisions across the scanned set.
  const byIssue = new Map<string, string[]>();
  for (const pr of prs) {
    for (const ref of pr.computed?.issueRefs ?? []) {
      const key = refKey(ref);
      const arr = byIssue.get(key);
      if (arr) arr.push(prKey(pr));
      else byIssue.set(key, [prKey(pr)]);
    }
  }

  let collisionPrs = 0;
  for (const pr of prs) {
    const refs = pr.computed?.issueRefs ?? [];
    const metaForPr: Record<string, IssueMeta> = {};
    const others = new Set<string>();
    for (const ref of refs) {
      const key = refKey(ref);
      const issueMeta = issues[key];
      if (issueMeta) metaForPr[key] = issueMeta;
      for (const other of byIssue.get(key) ?? []) {
        if (other !== prKey(pr)) others.add(other);
      }
    }
    pr.computed = {
      ...pr.computed,
      issueMeta: metaForPr,
      collidingPrs: [...others],
    };
    if (others.size > 0) collisionPrs++;
  }

  const clusters = [...byIssue.entries()].filter(([, v]) => v.length > 1);
  if (clusters.length === 0) {
    log('issues: no two open PRs claim the same issue');
    return;
  }
  log(`issues: ${clusters.length} issue(s) claimed by more than one open PR (${collisionPrs} PRs)`);
  for (const [key, prList] of clusters.sort((a, b) => b[1].length - a[1].length)) {
    log(`issues:   ${key} <- ${prList.join(', ')}`);
  }
}
