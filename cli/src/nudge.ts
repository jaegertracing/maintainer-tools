// `maintainer-tools nudge` subcommand.
// Runs the same weekly-digest logic as the GitHub Action in dry-run mode,
// rendering the would-be comments into an HTML report.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { createGraphqlClient } from '@jaegertracing/maintainer-tools-checks';
import type { CommentClient } from '@jaegertracing/maintainer-tools-checks/comments';
import { runDigest } from '@jaegertracing/maintainer-tools-checks/digest';
import { loadConfig } from './config.js';
import { log } from './log.js';
import { type NudgeEntry, renderNudgeHtml } from './render/nudge-html.js';
import { resolveToken } from './token.js';

const NUDGE_HELP = `Usage: maintainer-tools nudge [options]

Dry-run the weekly digest nudge against configured repos.
Renders an HTML report showing the comment that would be posted to each PR.

Options:
  --config <path>     Path to JSON config (overrides discovery).
  --output <path>     Where to write the HTML report (default: nudge.html).
  --label <name>      Label to filter PRs (default: waiting-for-author).
  --wait-days <n>     Minimum idle days before nudging (default: 7).
  --repo <slug>       Run against a single repo (owner/repo) instead of
                      all configured repos.
  --help              Show this help.

Token lookup order: $GH_TOKEN, $GITHUB_TOKEN, \`gh auth token\`.
`;

// A no-op CommentClient for dry-run: returns empty comment history so the
// publisher always decides "POST" (no prior comment found). This gives an
// accurate picture of what the first nudge would look like.
function noopCommentClient(): CommentClient {
  return {
    async listComments() {
      return [];
    },
    async createComment(_owner, _repo, _issueNumber, _body) {
      return { id: 0, url: '' };
    },
    async updateComment(_owner, _repo, _commentId, _body) {
      return { id: 0, url: '' };
    },
  };
}

function parseRepoSlug(slug: string): { owner: string; repo: string } {
  const parts = slug.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`--repo must be in owner/repo format (got "${slug}")`);
  }
  return { owner: parts[0], repo: parts[1] };
}

export async function runNudge(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string' },
      output: { type: 'string' },
      label: { type: 'string' },
      'wait-days': { type: 'string' },
      repo: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(NUDGE_HELP);
    return;
  }

  const label = values.label ?? 'waiting-for-author';
  const waitDays = values['wait-days'] !== undefined ? Number(values['wait-days']) : 7;
  if (!Number.isFinite(waitDays) || waitDays < 0) {
    throw new Error(`--wait-days must be a non-negative number (got ${values['wait-days']})`);
  }
  const output = values.output ?? 'nudge.html';

  log('loading config');
  const cfg = loadConfig(values.config);

  const { token, source } = resolveToken();
  log(`token: ${source}`);
  const gql = createGraphqlClient(token);
  const commentClient = noopCommentClient();

  const repos = values.repo ? [values.repo] : cfg.repos;
  log(`repos: ${repos.join(', ')}  label=${label}  wait-days=${waitDays}  dry-run=true`);

  const entries: NudgeEntry[] = [];

  for (const slug of repos) {
    const { owner, repo } = parseRepoSlug(slug);
    const stats = await runDigest(
      {
        owner,
        repo,
        label,
        waitDays,
        dryRun: true,
        onComment: (info) => {
          entries.push({ repo: slug, ...info });
        },
      },
      gql,
      commentClient,
      { info: (msg) => log(msg), warning: (msg) => log(`warning: ${msg}`) },
    );

    log('');
    log(`=== ${slug} summary ===`);
    log(`  considered:       ${stats.considered}`);
    log(`  skipped (fresh):  ${stats.skippedFresh}`);
    log(`  skipped (no chk): ${stats.skippedNoChecks}`);
    log(`  would post:       ${stats.posted}`);
    log(`  would patch:      ${stats.patched}`);
    log(`  no-op:            ${stats.noop}`);
    log(`  errored:          ${stats.errored}`);
  }

  const now = new Date();
  const html = renderNudgeHtml(entries, { now });
  const absPath = resolve(output);
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, html);
  log(`\nwrote ${absPath} (${entries.length} nudge(s))`);
}
