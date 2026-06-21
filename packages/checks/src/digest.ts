// Weekly-digest orchestration logic. Extracted so both the GitHub Action
// (`pr-weekly-digest/`) and the CLI (`maintainer-tools nudge`) call the
// same code path.

import type { CommentClient } from './comments/publisher.js';
import { isoWeek } from './comments/iso-week.js';
import { publishComment } from './comments/publisher.js';
import type { GraphqlClient } from './graphql.js';
import type { CheckResult } from './types.js';
import { runAll } from './predicates/index.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DigestParams {
  owner: string;
  repo: string;
  label: string;
  waitDays: number;
  dryRun: boolean;
  now?: Date;
  // Called with the rendered comment body for each PR that would be
  // nudged. Useful for CLI dry-run output.
  onComment?: (info: {
    prNumber: number;
    prTitle: string;
    prUrl: string;
    author: string | null;
    body: string;
  }) => void;
}

export interface DigestStats {
  considered: number;
  skippedFresh: number;
  skippedNoChecks: number;
  posted: number;
  patched: number;
  noop: number;
  minimized: number;
  errored: number;
}

export interface DigestLogger {
  info(msg: string): void;
  warning(msg: string): void;
}

export function renderDigestBody(
  author: string | null,
  triggered: CheckResult[],
  waitDays: number,
): string {
  const tag = author ? `@${author}` : 'there';
  const items = triggered.map((c) => `- ${c.summary}`).join('\n');
  return `Hi ${tag}, this PR has been waiting on you for over ${waitDays} days. Please address:

${items}

If you're blocked on a question to maintainers, comment \`/awaiting-input\` and we'll move this out of your queue while we discuss.`;
}

export async function runDigest(
  params: DigestParams,
  gql: GraphqlClient,
  commentClient: CommentClient,
  logger: DigestLogger,
): Promise<DigestStats> {
  const { owner, repo, label, waitDays, dryRun } = params;
  const now = params.now ?? new Date();
  const week = isoWeek(now);
  const cutoff = now.getTime() - waitDays * DAY_MS;

  logger.info(
    `pr-weekly-digest: ${owner}/${repo}  label=${label}  wait-days=${waitDays}  week=${week}  dry-run=${dryRun}`,
  );

  const candidates = await gql.listOpenPRsByLabel(owner, repo, label);
  logger.info(`found ${candidates.length} open PR(s) with label "${label}"`);

  const stale = candidates.filter((s) => Date.parse(s.updatedAt) <= cutoff);
  logger.info(`${stale.length} of those have been idle ≥ ${waitDays} days`);

  const stats: DigestStats = {
    considered: 0,
    skippedFresh: candidates.length - stale.length,
    skippedNoChecks: 0,
    posted: 0,
    patched: 0,
    noop: 0,
    minimized: 0,
    errored: 0,
  };

  for (const summary of stale) {
    stats.considered++;
    try {
      const pr = await gql.fetchPullRequest(owner, repo, summary.number);
      const triggered = runAll(pr).filter((c) => c.inDigest && c.triggered);
      if (triggered.length === 0) {
        stats.skippedNoChecks++;
        logger.info(`  #${pr.number}: no in-digest checks triggered — skipping`);
        continue;
      }

      const body = renderDigestBody(pr.author?.login ?? null, triggered, waitDays);
      const result = await publishComment(
        {
          owner,
          repo,
          issueNumber: pr.number,
          kind: 'weekly_digest',
          scope: `week=${week}`,
          body,
          minimizeOlder: true,
          dryRun,
        },
        commentClient,
      );

      const prefix = dryRun ? '[dry-run] ' : '';
      const minSuffix = result.minimized.length
        ? ` + minimized ${result.minimized.length} older`
        : '';
      switch (result.action) {
        case 'post':
          stats.posted++;
          stats.minimized += result.minimized.length;
          params.onComment?.({
            prNumber: pr.number,
            prTitle: pr.title,
            prUrl: pr.url,
            author: pr.author?.login ?? null,
            body,
          });
          logger.info(`  ${prefix}#${pr.number}: POST (${triggered.length} item(s))${minSuffix}`);
          break;
        case 'patch':
          stats.patched++;
          params.onComment?.({
            prNumber: pr.number,
            prTitle: pr.title,
            prUrl: pr.url,
            author: pr.author?.login ?? null,
            body,
          });
          logger.info(`  ${prefix}#${pr.number}: PATCH (${triggered.length} item(s))`);
          break;
        case 'skip':
          stats.noop++;
          logger.info(`  ${prefix}#${pr.number}: SKIP (${result.reason})`);
          break;
      }
    } catch (err) {
      stats.errored++;
      logger.warning(`  #${summary.number}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return stats;
}
