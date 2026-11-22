// pr-nudge entrypoint.
//
// Reads the PR referenced by the triggering event (pull_request /
// pull_request_target / issue_comment on a PR), evaluates the rules, and
// publishes one Check Run per requested check that has a check run and
// applies to the PR.
// Label management for `waiting_for_author` is wired up in P3; for now this
// action's write surface is limited to Check Runs to keep blast radius small
// during the P0 bootstrap.

import * as core from '@actions/core';
import * as github from '@actions/github';
import {
  CHECK_FACTS,
  CHECK_IDS,
  type CheckId,
  createGraphqlClient,
  ruleSet,
} from '@jaegertracing/maintainer-tools-checks';

import { newCheckRun } from './check-runs.js';

const KNOWN_IDS: ReadonlySet<CheckId> = new Set(CHECK_IDS);

interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

function resolvePrRef(): PrRef | null {
  const ctx = github.context;
  const repo = ctx.repo;
  // pull_request / pull_request_target
  const prPayload = (ctx.payload as { pull_request?: { number: number } }).pull_request;
  if (prPayload?.number) {
    return { owner: repo.owner, repo: repo.repo, number: prPayload.number };
  }
  // issue_comment on a PR (issues have a `pull_request` field when they are PRs)
  const issuePayload = (ctx.payload as { issue?: { number: number; pull_request?: unknown } })
    .issue;
  if (issuePayload?.pull_request && issuePayload.number) {
    return { owner: repo.owner, repo: repo.repo, number: issuePayload.number };
  }
  // check_run / check_suite — head SHA is on the payload; pull_requests list
  // is best-effort. Skipped here; the workflow should constrain `on:` for now.
  return null;
}

function parseRules(input: string): CheckId[] {
  const ids = input
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean) as CheckId[];
  const unknown = ids.filter((id) => !KNOWN_IDS.has(id));
  if (unknown.length) {
    throw new Error(`Unknown rule id(s): ${unknown.join(', ')}`);
  }
  return ids;
}

async function run(): Promise<void> {
  const token = core.getInput('github-token', { required: true });
  const rules = parseRules(core.getInput('rules'));
  const dryRun = core.getBooleanInput('dry-run');

  const ref = resolvePrRef();
  if (!ref) {
    core.warning('pr-nudge: triggering event does not reference a PR; nothing to do.');
    return;
  }

  const gql = createGraphqlClient(token);
  const pr = await gql.fetchPullRequest(ref.owner, ref.repo, ref.number);
  core.info(`pr-nudge: evaluating ${ref.owner}/${ref.repo}#${ref.number}`);

  const verdict = ruleSet.evaluate(pr, { now: new Date() });
  for (const id of rules) {
    const tag = verdict.holds(CHECK_FACTS[id]) ? 'TRIGGERED' : 'ok';
    core.info(`[${tag}] ${id}: ${verdict.summary(id)!}`);
  }

  const octokit = github.getOctokit(token);
  const head = pr.commits[pr.commits.length - 1];
  if (!head) {
    core.warning('pr-nudge: PR has no commits; skipping Check Run publication.');
    return;
  }

  for (const id of rules) {
    const checkRun = newCheckRun(id, verdict);
    if (!checkRun) continue;
    if (dryRun) {
      core.info(`[dry-run] would publish Check Run: ${id} -> ${checkRun.conclusion}`);
      continue;
    }
    await octokit.rest.checks.create({
      owner: ref.owner,
      repo: ref.repo,
      head_sha: head.sha,
      status: 'completed',
      ...checkRun,
    });
    core.info(`Published Check Run: ${id} (${checkRun.conclusion})`);
  }
}

run().catch((err: unknown) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
