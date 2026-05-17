#!/usr/bin/env node
// `maintainer-tools` CLI entrypoint.
//
// Subcommands:
//   triage   — scan configured repos and emit an HTML report
//
// Run `maintainer-tools triage --help` for flags.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import type { PullRequest } from '@jaegertracing/maintainer-tools-checks';
import { classify, type ClassifiedPR } from './buckets.js';
import { loadConfig } from './config.js';
import { log } from './log.js';
import { enrichQuotaState } from './quota.js';
import { renderHtml } from './render/html.js';
import { makeClient, scanRepos } from './scan.js';
import { resolveToken } from './token.js';

const HELP = `Usage: maintainer-tools <command> [options]

Commands:
  triage    Scan configured repos and emit a triage report.

Run \`maintainer-tools <command> --help\` for command-specific flags.
`;

const DEFAULT_OUTPUT = 'triage.html';

const TRIAGE_HELP = `Usage: maintainer-tools triage [options]

Options:
  --config <path>     Path to JSON config (overrides discovery).
  --output <path>     Where to write the HTML report. Pass \`-\` for stdout.
                      Default: ./${DEFAULT_OUTPUT}
  --no-cache          Bypass the SQLite cache for this run.
  --no-quota          Skip the per-author quota computation. Faster, but
                      relies solely on the \`pr-quota-reached\` label for
                      identifying quota-blocked PRs.
  --limit <n>         Cap PRs scanned per repo (for testing). PRs are
                      list-ordered by updated-desc, so this samples the
                      most recently active.
  --pr <spec>         Triage just one PR. \`spec\` may be:
                        owner/repo#NNN
                        https://github.com/owner/repo/pull/NNN
                        NNN  (uses the first configured repo)
                      Bypasses the per-repo list query — useful for
                      investigating a specific PR.
  --viewer <login>    Override the viewer (default: GraphQL viewer).
  --help              Show this help.

Token lookup order: $GH_TOKEN, $GITHUB_TOKEN, \`gh auth token\`.
`;

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (!cmd || cmd === '--help' || cmd === '-h') {
    process.stdout.write(HELP);
    return;
  }
  if (cmd === 'triage') {
    await runTriage(process.argv.slice(3));
    return;
  }
  process.stderr.write(`unknown command: ${cmd}\n${HELP}`);
  process.exit(2);
}

async function runTriage(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string' },
      output: { type: 'string' },
      'no-cache': { type: 'boolean', default: false },
      'no-quota': { type: 'boolean', default: false },
      limit: { type: 'string' },
      pr: { type: 'string' },
      viewer: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(TRIAGE_HELP);
    return;
  }

  const limit = parseLimit(values.limit);
  const output = values.output ?? DEFAULT_OUTPUT;

  log('loading config');
  const cfg = loadConfig(values.config);
  log(
    `config: ${cfg.repos.length} repo(s), ${cfg.maintainers.length} maintainer(s), ${cfg.interns.length} intern(s)`,
  );

  const { token, source } = resolveToken();
  log(`token: ${source}`);
  const client = makeClient(token);

  const cache = await openCacheIfEnabled(cfg.cachePath, values['no-cache']);
  log(cache ? `cache: ${cfg.cachePath}` : 'cache: disabled');

  let viewer = values.viewer ?? cfg.viewer;
  if (viewer) {
    log(`viewer: @${viewer} (from config)`);
  } else {
    log('viewer: fetching from GraphQL...');
    viewer = await client.fetchViewerLogin();
    log(`viewer: @${viewer}`);
  }

  let prs: PullRequest[];
  if (values.pr) {
    const ref = parsePrSpec(values.pr, cfg.repos);
    log(`single PR mode: ${ref.owner}/${ref.repo}#${ref.number} (bypassing list query)`);
    const fresh = await client.fetchPullRequest(ref.owner, ref.repo, ref.number);
    cache?.put(fresh);
    prs = [fresh];
  } else {
    log(
      `scanning ${cfg.repos.length} repo(s): ${cfg.repos.join(', ')}` +
        (limit !== undefined ? ` (limit ${limit} per repo)` : ''),
    );
    const result = await scanRepos(cfg.repos, client, cache, { limit });
    log(
      `scan complete: ${result.prs.length} open PR(s) — ${result.cacheHits} cached, ${result.cacheMisses} fetched`,
    );
    prs = result.prs;
  }

  cache?.close();

  if (values['no-quota']) {
    log('quota: computation skipped (--no-quota); label-only mode');
  } else {
    const exemptLogins = new Set([...cfg.maintainers, ...cfg.interns]);
    await enrichQuotaState(prs, client, { exemptLogins });
  }

  log('classifying PRs into buckets');
  const now = new Date();
  const classified = classifyAll(prs, viewer, cfg, now);
  const perRepoCounts = computePerRepoOpenCounts(prs);
  log(`bucket totals: ${formatBucketTotals(classified)}`);

  log('rendering HTML');
  const report = renderHtml(classified, { viewer, now, authorOpenCounts: perRepoCounts });

  if (output === '-') {
    log('writing report to stdout');
    process.stdout.write(report);
    return;
  }

  const absPath = resolve(output);
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, report);
  log(`wrote ${absPath} (${report.length} bytes)`);
}

// Parse `--pr <spec>` into a fully-qualified PR reference. Accepted forms:
//   owner/repo#NNN
//   https://github.com/owner/repo/pull/NNN
//   NNN  (falls back to the first configured repo)
function parsePrSpec(
  raw: string,
  configuredRepos: string[],
): { owner: string; repo: string; number: number } {
  // Full GitHub URL form.
  const urlMatch = raw.match(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/);
  if (urlMatch) {
    return { owner: urlMatch[1]!, repo: urlMatch[2]!, number: Number(urlMatch[3]) };
  }
  // owner/repo#NNN form.
  const slugMatch = raw.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/);
  if (slugMatch) {
    return { owner: slugMatch[1]!, repo: slugMatch[2]!, number: Number(slugMatch[3]) };
  }
  // Bare number → first configured repo.
  const bare = raw.replace(/^#/, '');
  if (/^\d+$/.test(bare)) {
    if (configuredRepos.length === 0) {
      throw new Error(`--pr ${raw}: no repos configured to default to`);
    }
    const [owner, repo] = configuredRepos[0]!.split('/', 2) as [string, string];
    return { owner, repo, number: Number(bare) };
  }
  throw new Error(`--pr ${raw}: expected owner/repo#NNN, a GitHub PR URL, or a bare number`);
}

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`--limit must be a positive integer (got ${raw})`);
  }
  return n;
}

function formatBucketTotals(classified: ClassifiedPR[]): string {
  const counts = new Map<string, number>();
  for (const c of classified) counts.set(c.bucket, (counts.get(c.bucket) ?? 0) + 1);
  return [...counts.entries()].map(([k, v]) => `${k}=${v}`).join(', ') || '(none)';
}

async function openCacheIfEnabled(
  path: string,
  disabled: boolean,
): Promise<import('@jaegertracing/maintainer-tools-checks/cache').PrCache | null> {
  if (disabled) return null;
  try {
    const cacheMod = await import('@jaegertracing/maintainer-tools-checks/cache');
    mkdirSync(dirname(path), { recursive: true });
    return cacheMod.openCache(path);
  } catch (err) {
    // `node:sqlite` is built into Node 22.5+, so the realistic failure modes
    // here are (a) running on an older Node where the module isn't available,
    // or (b) a filesystem error opening the cache file (perms, full disk,
    // path unwritable). Either way, fall back to cacheless rather than
    // crashing; the triage still works, just pays full GraphQL cost.
    log(`warning: cache disabled (${err instanceof Error ? err.message : String(err)})`);
    return null;
  }
}

function classifyAll(
  prs: PullRequest[],
  viewer: string,
  cfg: ReturnType<typeof loadConfig>,
  now: Date,
): ClassifiedPR[] {
  const maintainers = new Set(cfg.maintainers);
  const interns = new Set(cfg.interns);
  return prs.map((pr) =>
    classify(pr, {
      viewer,
      maintainers,
      interns,
      codeownerPaths: cfg.codeowners[`${pr.repo.owner}/${pr.repo.name}`] ?? [],
      now,
    }),
  );
}

function computePerRepoOpenCounts(prs: PullRequest[]): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const pr of prs) {
    const slug = `${pr.repo.owner}/${pr.repo.name}`;
    let inner = out.get(slug);
    if (!inner) {
      inner = new Map();
      out.set(slug, inner);
    }
    const login = pr.author?.login;
    if (login) inner.set(login, (inner.get(login) ?? 0) + 1);
  }
  return out;
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
