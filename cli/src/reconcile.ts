// `maintainer-tools reconcile` subcommand: a run of the reconciler of RFC
// 0003. It derives the plan of every open pull request and
// reports the changes that bring each one to its plan. It makes them only
// with `--write`; without it the run is in shadow mode.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { parseArgs } from 'node:util';

import {
  ACTIONS_BOT_LOGIN,
  applyChanges,
  createChangeWriter,
  type GraphqlClient,
  reconcileBeforeWrite,
  reconcile,
} from '@jaegertracing/maintainer-tools-checks';
import { loadConfigInteractive } from './config-setup.js';
import { log } from './log.js';
import { openCacheIfEnabled } from './open-cache.js';
import { renderReconcileHtml } from './render/reconcile-html.js';
import { renderReconcileJson, renderReconcileMarkdown } from './render/reconcile.js';
import { makeClient } from './scan.js';
import { gatherSnapshot, readSnapshot, type TriageSnapshot, writeSnapshot } from './snapshot.js';
import { resolveToken } from './token.js';

const RECONCILE_HELP = `Usage: maintainer-tools reconcile [options]

Run the lifecycle reconciler: derive the labels, the comment
and the closing of every open pull request, and report what differs from
its state on GitHub. Without --write nothing is changed on GitHub.

Options:
  --config <path>     Path to JSON config (overrides discovery).
  --repo <slug>       Run against one repo (owner/repo) instead of all
                      configured repos.
  --format <fmt>      Output format: \`html\` (default), \`md\` or \`json\`. The
                      HTML report links each pull request and shows the
                      comment as the author would see it.
  --output <path>     Where to write the report. Pass \`-\` for stdout.
                      Default: ./reconcile.{html,md,json} (based on --format).
  --no-cache          Bypass the SQLite cache for this run.
  --save-snapshot <path>
                      Save the snapshot of this run to a file: everything
                      that was gathered from GitHub, and the clock.
  --snapshot <path>   Reconcile a snapshot written by --save-snapshot
                      instead of gathering one from GitHub. Needs no token
                      and no cache.
  --write             Make the reported changes on GitHub: labels, the
                      comment, and the closing. Needs the token of a
                      GitHub Actions workflow.
  --help              Show this help.

Token lookup order: $GH_TOKEN, $GITHUB_TOKEN, \`gh auth token\`.
`;

// GitHub asks for at least a second between two requests that change
// something.
const MILLISECONDS_BETWEEN_CHANGES = 1000;

type ReconcileFormat = 'html' | 'md' | 'json';

function parseReconcileFormat(raw: string | undefined): ReconcileFormat {
  if (raw === undefined || raw === 'html') return 'html';
  if (raw === 'md') return 'md';
  if (raw === 'json') return 'json';
  throw new Error(`--format must be \`html\`, \`md\` or \`json\` (got "${raw}")`);
}

export async function runReconcile(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string' },
      repo: { type: 'string' },
      format: { type: 'string' },
      output: { type: 'string' },
      'no-cache': { type: 'boolean', default: false },
      'save-snapshot': { type: 'string' },
      snapshot: { type: 'string' },
      write: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  });
  if (values.help) {
    process.stdout.write(RECONCILE_HELP);
    return;
  }
  if (values.snapshot && (values['save-snapshot'] || values['no-cache'])) {
    throw new Error('--snapshot excludes --save-snapshot and --no-cache.');
  }
  if (values.snapshot && values.write) {
    throw new Error('--snapshot excludes --write: a saved snapshot is not the state of GitHub.');
  }
  const format = parseReconcileFormat(values.format);
  const output = values.output ?? `reconcile.${format}`;
  const snapshotPath = values.snapshot ?? values['save-snapshot'];
  if (snapshotPath && output !== '-' && resolve(snapshotPath) === resolve(output)) {
    throw new Error(`The snapshot and the report cannot be the same file: ${resolve(output)}.`);
  }

  const cfg = await loadConfigInteractive(values.config);
  if (values.repo && !cfg.repos.includes(values.repo)) {
    throw new Error(`--repo ${values.repo} is not one of the configured repos.`);
  }
  const repos = values.repo ? [values.repo] : cfg.repos;

  let snapshot: TriageSnapshot;
  // The client and the token of a run that gathers from GitHub, which a
  // run in write mode uses again.
  let gitHub: { client: GraphqlClient; token: string } | undefined;
  if (values.snapshot) {
    log(`snapshot: ${values.snapshot}`);
    const saved = readSnapshot(values.snapshot, cfg.repos);
    // Without the merged counts every author is within the quota, and the
    // plan would remove `pr-quota-reached` from each pull request.
    if (!saved.mergedCounts) {
      throw new Error(
        `The snapshot ${values.snapshot} was gathered with --no-quota, and the quota cannot be decided from it.`,
      );
    }
    // The quota and the duplicates of a pull request are decided from the
    // other open pull requests, and the plan would remove both labels where
    // those are missing.
    if (saved.isPartial) {
      throw new Error(
        `The snapshot ${values.snapshot} was gathered with --pr or --limit, and it does not hold every open pull request.`,
      );
    }
    snapshot = {
      ...saved,
      pullRequests: saved.pullRequests.filter((pr) =>
        repos.includes(`${pr.repo.owner}/${pr.repo.name}`),
      ),
    };
  } else {
    const { token, source } = resolveToken();
    log(`token: ${source}`);
    const cache = await openCacheIfEnabled(cfg.cachePath, values['no-cache']);
    log(cache ? `cache: ${cfg.cachePath}` : 'cache: disabled');
    gitHub = { client: makeClient(token), token };
    if (values.write) {
      // The reconciler takes a comment for its own only when the bot of
      // GitHub Actions posted it. Comments under another login would be
      // posted again by every run.
      const login = await gitHub.client.fetchViewerLogin();
      if (login !== `${ACTIONS_BOT_LOGIN}[bot]`) {
        throw new Error(
          `--write needs the token of a GitHub Actions workflow, and this token is of ${login}.`,
        );
      }
    }
    snapshot = await gatherSnapshot(gitHub.client, cache, {
      repos,
      viewer: cfg.viewer,
      // The quota workflow that the reconciler replaces exempts nobody by
      // name, and the list of the config is one maintainer's view.
      quotaExemptLogins: new Set(),
      skipQuota: false,
    });
    cache?.close();
  }
  // The gathering goes on without the collaborators of a repository whose
  // query failed. The plan of each pull request there would then be decided
  // from a fact that is missing, so the run ends.
  const reposWithoutCollaborators = [
    ...new Set(snapshot.pullRequests.map((pr) => `${pr.repo.owner}/${pr.repo.name}`)),
  ].filter((repo) => !snapshot.collaborators?.[repo]);
  if (reposWithoutCollaborators.length > 0) {
    throw new Error(
      `The collaborators of ${reposWithoutCollaborators.join(', ')} were not gathered, and no plan can be derived without them.`,
    );
  }
  if (values['save-snapshot']) {
    writeSnapshot(values['save-snapshot'], snapshot);
    log(`wrote snapshot ${resolve(values['save-snapshot'])}`);
  }

  const openPullRequests = {
    pullRequests: snapshot.pullRequests,
    mergedCounts: snapshot.mergedCounts,
    quotaExemptLogins: new Set<string>(),
    collaborators: snapshot.collaborators,
  };
  const now = new Date(snapshot.now);
  const client = gitHub?.client;
  const reconciliations =
    values.write && client
      ? await reconcileBeforeWrite(openPullRequests, now, cfg.ages, (pr) => {
          log(
            `write: fetching ${pr.repo.owner}/${pr.repo.name}#${pr.number} again before it is closed`,
          );
          return client.fetchPullRequest(pr.repo.owner, pr.repo.name, pr.number);
        })
      : reconcile(openPullRequests, now, cfg.ages);
  const changed = reconciliations.filter(({ changes }) => changes.length > 0);
  log(`reconcile: ${reconciliations.length} open PR(s), ${changed.length} differ from the plan`);

  const payload =
    format === 'json'
      ? renderReconcileJson(reconciliations)
      : format === 'md'
        ? renderReconcileMarkdown(reconciliations, snapshot.now)
        : renderReconcileHtml(reconciliations, snapshot.now);
  if (output === '-') {
    process.stdout.write(payload);
  } else {
    const absPath = resolve(output);
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, payload);
    log(`wrote ${absPath} (${payload.length} bytes)`);
  }

  if (values.write && gitHub) {
    const applied = await applyChanges(reconciliations, createChangeWriter(gitHub.token), () =>
      setTimeout(MILLISECONDS_BETWEEN_CHANGES),
    );
    log(
      `write: made ${applied.changesMade} change(s), left ${applied.postponed.length} PR(s) to the next run, and changed none of ${applied.noLongerOpen.length} PR(s) that are no longer open`,
    );
  }
}
