// pr-weekly-digest entrypoint.
//
// Greenfield action (P4): nudge PRs whose `waiting-for-author` label has
// been stale for ≥ `wait-days`. One comment per PR per ISO week.
// Idempotency comes entirely from the P2 publisher's footer — a
// re-run within the same week with the same body is a no-op SKIP, a
// re-run with different content is a PATCH, a run after the week
// rolls over POSTs fresh.
//
// Triggered events: a daily cron schedule is the expected use, but
// `workflow_dispatch` also works for manual runs.

import * as core from '@actions/core';
import * as github from '@actions/github';
import {
  type CheckResult,
  createGraphqlClient,
  runAll,
} from '@jaegertracing/maintainer-tools-checks';
import {
  isoWeek,
  octokitCommentClient,
  publishComment,
} from '@jaegertracing/maintainer-tools-checks/comments';

const DAY_MS = 24 * 60 * 60 * 1000;

interface RunStats {
  considered: number;
  skippedFresh: number;
  skippedNoChecks: number;
  posted: number;
  patched: number;
  noop: number;
  errored: number;
}

async function run(): Promise<void> {
  const token = core.getInput('github-token', { required: true });
  const dryRun = core.getBooleanInput('dry-run');
  const label = core.getInput('label') || 'waiting-for-author';
  const waitDays = Number(core.getInput('wait-days') || '7');
  if (!Number.isFinite(waitDays) || waitDays < 0) {
    throw new Error(`wait-days must be a non-negative number (got ${core.getInput('wait-days')})`);
  }

  const { owner, repo } = github.context.repo;
  const now = new Date();
  const week = isoWeek(now);
  const cutoff = now.getTime() - waitDays * DAY_MS;

  core.info(
    `pr-weekly-digest: ${owner}/${repo}  label=${label}  wait-days=${waitDays}  week=${week}  dry-run=${dryRun}`,
  );

  const gql = createGraphqlClient(token);
  const candidates = await gql.listOpenPRsByLabel(owner, repo, label);
  core.info(`found ${candidates.length} open PR(s) with label "${label}"`);

  // Filter to PRs idle long enough to be worth nudging. updatedAt is a
  // conservative proxy for "label has been stuck" — any maintainer reply
  // or label change would bump it, naturally suppressing the nudge.
  const stale = candidates.filter((s) => Date.parse(s.updatedAt) <= cutoff);
  core.info(`${stale.length} of those have been idle ≥ ${waitDays} days`);

  const stats: RunStats = {
    considered: 0,
    skippedFresh: candidates.length - stale.length,
    skippedNoChecks: 0,
    posted: 0,
    patched: 0,
    noop: 0,
    errored: 0,
  };

  const octokit = github.getOctokit(token);
  const commentClient = octokitCommentClient(octokit);

  for (const summary of stale) {
    stats.considered++;
    try {
      const pr = await gql.fetchPullRequest(owner, repo, summary.number);
      const triggered = runAll(pr).filter((c) => c.inDigest && c.triggered);
      if (triggered.length === 0) {
        // PR has the label but no in-digest predicates fire — probably
        // a label drift. Skip; pr-nudge (P5) will reconcile the label.
        stats.skippedNoChecks++;
        core.info(`  #${pr.number}: no in-digest checks triggered — skipping`);
        continue;
      }

      const body = renderDigestBody(pr.author?.login ?? null, triggered);
      const result = await publishComment(
        {
          owner,
          repo,
          issueNumber: pr.number,
          kind: 'weekly_digest',
          scope: `week=${week}`,
          body,
          dryRun,
        },
        commentClient,
      );

      const prefix = dryRun ? '[dry-run] ' : '';
      switch (result.action) {
        case 'post':
          stats.posted++;
          core.info(`  ${prefix}#${pr.number}: POST (${triggered.length} item(s))`);
          break;
        case 'patch':
          stats.patched++;
          core.info(`  ${prefix}#${pr.number}: PATCH (${triggered.length} item(s))`);
          break;
        case 'skip':
          stats.noop++;
          core.info(`  ${prefix}#${pr.number}: SKIP (${result.reason})`);
          break;
      }
    } catch (err) {
      stats.errored++;
      core.warning(`  #${summary.number}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  core.info('');
  core.info('=== Summary ===');
  core.info(`considered:        ${stats.considered}`);
  core.info(`skipped (fresh):   ${stats.skippedFresh}`);
  core.info(`skipped (no-op):   ${stats.noop}`);
  core.info(`skipped (no chk):  ${stats.skippedNoChecks}`);
  core.info(`posted:            ${stats.posted}`);
  core.info(`patched:           ${stats.patched}`);
  core.info(`errored:           ${stats.errored}`);

  // The digest output is also a job summary so it's findable in the
  // Actions UI without scrolling through logs. `GITHUB_STEP_SUMMARY` is
  // only set inside an Actions runner; outside (local smoke tests) skip
  // the write so we don't crash on a missing-env-var.
  if (process.env.GITHUB_STEP_SUMMARY) {
    await core.summary
      .addHeading(`Weekly digest — ${owner}/${repo} — ${week}${dryRun ? ' (dry-run)' : ''}`)
      .addTable([
        [
          { data: 'metric', header: true },
          { data: 'count', header: true },
        ],
        ['considered', String(stats.considered)],
        ['posted', String(stats.posted)],
        ['patched', String(stats.patched)],
        ['no-op (sha match)', String(stats.noop)],
        ['skipped (no checks)', String(stats.skippedNoChecks)],
        ['skipped (fresh)', String(stats.skippedFresh)],
        ['errored', String(stats.errored)],
      ])
      .write();
  }
}

function renderDigestBody(author: string | null, triggered: CheckResult[]): string {
  const tag = author ? `@${author}` : 'there';
  const items = triggered.map((c) => `- ${c.summary}`).join('\n');
  return `Hi ${tag}, this PR has been waiting on you for over a week. Please address:

${items}

If you're blocked on a question to maintainers, comment \`/awaiting-input\` and we'll move this out of your queue while we discuss.`;
}

run().catch((err: unknown) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
