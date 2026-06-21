// pr-weekly-digest GitHub Action entrypoint.
// Thin shell: reads inputs, delegates to the shared `runDigest` function.

import * as core from '@actions/core';
import * as github from '@actions/github';
import { createGraphqlClient } from '@jaegertracing/maintainer-tools-checks';
import { octokitCommentClient } from '@jaegertracing/maintainer-tools-checks/comments';
import { runDigest } from '@jaegertracing/maintainer-tools-checks/digest';

async function run(): Promise<void> {
  const token = core.getInput('github-token', { required: true });
  const dryRun = core.getBooleanInput('dry-run');
  const label = core.getInput('label') || 'waiting-for-author';
  const waitDays = Number(core.getInput('wait-days') || '7');
  if (!Number.isFinite(waitDays) || waitDays < 0) {
    throw new Error(`wait-days must be a non-negative number (got ${core.getInput('wait-days')})`);
  }

  const { owner, repo } = github.context.repo;
  const gql = createGraphqlClient(token);
  const octokit = github.getOctokit(token);
  const commentClient = octokitCommentClient(octokit);

  const stats = await runDigest({ owner, repo, label, waitDays, dryRun }, gql, commentClient, {
    info: (msg) => core.info(msg),
    warning: (msg) => core.warning(msg),
  });

  core.info('');
  core.info('=== Summary ===');
  core.info(`considered:         ${stats.considered}`);
  core.info(`skipped (fresh):    ${stats.skippedFresh}`);
  core.info(`skipped (no-op):    ${stats.noop}`);
  core.info(`skipped (no chk):   ${stats.skippedNoChecks}`);
  core.info(`posted:             ${stats.posted}`);
  core.info(`patched:            ${stats.patched}`);
  core.info(`minimized (older):  ${stats.minimized}`);
  core.info(`errored:            ${stats.errored}`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    const date = new Date().toISOString().slice(0, 10);
    await core.summary
      .addHeading(`Weekly digest — ${owner}/${repo} — ${date}${dryRun ? ' (dry-run)' : ''}`)
      .addTable([
        [
          { data: 'metric', header: true },
          { data: 'count', header: true },
        ],
        ['considered', String(stats.considered)],
        ['posted', String(stats.posted)],
        ['patched', String(stats.patched)],
        ['minimized (older)', String(stats.minimized)],
        ['no-op (sha match)', String(stats.noop)],
        ['skipped (no checks)', String(stats.skippedNoChecks)],
        ['skipped (fresh)', String(stats.skippedFresh)],
        ['errored', String(stats.errored)],
      ])
      .write();
  }
}

run().catch((err: unknown) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
