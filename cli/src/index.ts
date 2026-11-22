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
import { type ClassifiedPR, BUCKET_ORDER, BUCKET_LABELS } from './buckets.js';
import { loadConfigInteractive } from './config-setup.js';
import { log } from './log.js';
import { enrichIssueState } from './issues.js';
import { enrichQuotaState } from './quota.js';
import { renderExplain } from './render/explain.js';
import { renderHtml } from './render/html.js';
import { renderJson } from './render/json.js';
import { renderXlsx } from './render/xlsx.js';
import { makeClient, scanRepos } from './scan.js';
import { snapshotSource, sourceSavingSnapshot, type TriageSource } from './snapshot.js';
import { resolveToken } from './token.js';
import { buildTriagePolicy, classifyAll } from './triage-policy.js';
import { runNudge } from './nudge.js';

const HELP = `Usage: maintainer-tools <command> [options]

Commands:
  triage    Scan configured repos and emit a triage report.
  nudge     Dry-run the weekly digest nudge (HTML report).

Run \`maintainer-tools <command> --help\` for command-specific flags.
`;

type OutputFormat = 'html' | 'xlsx' | 'json';

const DEFAULT_OUTPUTS: Record<OutputFormat, string> = {
  html: 'triage.html',
  xlsx: 'triage.xlsx',
  json: 'triage.json',
};

const TRIAGE_HELP = `Usage: maintainer-tools triage [options]

Options:
  --config <path>     Path to JSON config (overrides discovery).
  --format <fmt>      Output format: \`html\` (default), \`xlsx\` or \`json\`.
                      \`xlsx\` opens in Excel, Numbers, or Google Sheets —
                      drop into a Google Drive Desktop folder for sync.
                      \`json\` holds what was decided for every PR and
                      has no time of the run in it, so two runs over the
                      same snapshot can be compared byte for byte.
  --output <path>     Where to write the report. Pass \`-\` for stdout.
                      Default: ./triage.{html,xlsx,json} (based on --format).
  --no-cache          Bypass the SQLite cache for this run.
  --save-snapshot <path>
                      Save the snapshot of this run to a file: everything
                      that the run fetched from GitHub, and the clock. The
                      run bypasses the SQLite cache, as with --no-cache.
  --snapshot <path>   Classify a snapshot written by --save-snapshot
                      instead of fetching from GitHub. Needs no token and
                      no cache, and excludes the flags that control what
                      the run fetches: --save-snapshot, --no-cache,
                      --no-quota, --no-issues, --limit, --pr, --viewer.
  --no-quota          Skip the per-author quota computation. Faster, but
                      relies solely on the \`pr-quota-reached\` label for
                      identifying quota-blocked PRs.
  --no-issues         Skip referenced-issue enrichment. Drops the issue
                      column and the SELF-FILED / ISSUE-COLLISION /
                      ISSUE-CLOSED flags; saves one batched query per run.
  --limit <n>         Cap PRs scanned per repo (for testing). PRs are
                      list-ordered by updated-desc, so this samples the
                      most recently active.
  --pr <spec>         Triage just one PR. \`spec\` may be:
                        owner/repo#NNN
                        https://github.com/owner/repo/pull/NNN
                        NNN  (uses the first configured repo)
                      Bypasses the per-repo list query — useful for
                      investigating a specific PR.
  --explain           Requires --pr. Skips report rendering and prints a
                      plain-text breakdown to stdout instead: bucket,
                      every reason, every predicate check result, and row
                      flags. Use this to see why a specific PR landed
                      where it did.
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
  if (cmd === 'nudge') {
    await runNudge(process.argv.slice(3));
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
      format: { type: 'string' },
      output: { type: 'string' },
      'no-cache': { type: 'boolean', default: false },
      'save-snapshot': { type: 'string' },
      snapshot: { type: 'string' },
      'no-quota': { type: 'boolean', default: false },
      'no-issues': { type: 'boolean', default: false },
      limit: { type: 'string' },
      pr: { type: 'string' },
      explain: { type: 'boolean', default: false },
      viewer: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(TRIAGE_HELP);
    return;
  }
  if (values.explain && !values.pr) {
    throw new Error('--explain requires --pr <spec>.');
  }

  const limit = parseLimit(values.limit);
  const format = parseFormat(values.format);
  const output = values.output ?? DEFAULT_OUTPUTS[format];
  rejectConflictingSnapshotFlags(values, output);

  log('loading config');
  const cfg = await loadConfigInteractive(values.config);
  const policy = buildTriagePolicy(cfg);
  log(
    `config: ${cfg.repos.length} repo(s), ${cfg.maintainers.length} maintainer(s), ${cfg.interns.length} intern(s), ${cfg.priorityAuthors.length} priority author(s)`,
  );

  const source = chooseSource(values, cfg);
  const { client } = source;

  const cache = await openCacheIfEnabled(cfg.cachePath, !source.useCache);
  log(cache ? `cache: ${cfg.cachePath}` : 'cache: disabled');

  let viewer = source.viewer;
  if (viewer) {
    log(`viewer: @${viewer} (from config)`);
  } else {
    log('viewer: fetching...');
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

  if (source.skipQuota) {
    log('quota: computation skipped; label-only mode');
  } else {
    await enrichQuotaState(prs, client, { exemptLogins: policy.priorityAuthors, cache });
  }

  if (source.skipIssues) {
    log('issues: enrichment skipped');
  } else {
    await enrichIssueState(prs, client, { cache });
  }

  cache?.close();

  log('classifying PRs into buckets');
  const now = source.clock();
  const classified = classifyAll(prs, viewer, policy, now);
  source.saveSnapshot?.(viewer, now);

  if (values.explain) {
    process.stdout.write(renderExplain(classified[0]!, now));
    return;
  }

  const perRepoCounts = computePerRepoOpenCounts(prs);
  log(`bucket totals: ${formatBucketTotals(classified)}`);

  log(`rendering ${format.toUpperCase()}`);
  const payload = await renderReport(format, classified, {
    viewer,
    now,
    authorOpenCounts: perRepoCounts,
    priorityLabels: cfg.priorityLabels,
  });

  if (output === '-') {
    log('writing report to stdout');
    process.stdout.write(payload);
    return;
  }

  const absPath = resolve(output);
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, payload);
  const size = typeof payload === 'string' ? payload.length : payload.byteLength;
  log(`wrote ${absPath} (${size} bytes)`);
}

function rejectConflictingSnapshotFlags(values: Record<string, unknown>, output: string): void {
  // A run that loads the snapshot from a file fetches nothing, so a flag
  // that controls what the run fetches would be silently ignored.
  const fetchFlag = [
    'save-snapshot',
    'no-cache',
    'no-quota',
    'no-issues',
    'limit',
    'pr',
    'viewer',
  ].find((flag) => values[flag]);
  if (values.snapshot && fetchFlag) {
    throw new Error(`--snapshot cannot be combined with --${fetchFlag}.`);
  }
  // The JSON report is named triage.json by default, which is also a natural
  // name for a snapshot, and the report would overwrite it.
  const snapshotPath = values.snapshot ?? values['save-snapshot'];
  if (
    typeof snapshotPath === 'string' &&
    !values.explain &&
    output !== '-' &&
    resolve(snapshotPath) === resolve(output)
  ) {
    throw new Error(`The snapshot and the report cannot be the same file: ${resolve(output)}.`);
  }
}

// chooseSource() is the only place that knows whether the run reads GitHub or
// a snapshot file. Every later step reads the returned source.
function chooseSource(
  flags: {
    snapshot?: string;
    'save-snapshot'?: string;
    viewer?: string;
    'no-cache': boolean;
    'no-quota': boolean;
    'no-issues': boolean;
  },
  config: { viewer?: string; repos: string[] },
): TriageSource {
  if (flags.snapshot) {
    log(`snapshot: ${flags.snapshot}`);
    return snapshotSource(flags.snapshot, config.repos);
  }
  const { token, source: tokenSource } = resolveToken();
  log(`token: ${tokenSource}`);
  const source: TriageSource = {
    client: makeClient(token),
    clock: () => new Date(),
    viewer: flags.viewer ?? config.viewer,
    useCache: !flags['no-cache'],
    skipQuota: flags['no-quota'],
    skipIssues: flags['no-issues'],
  };
  return flags['save-snapshot'] ? sourceSavingSnapshot(source, flags['save-snapshot']) : source;
}

async function renderReport(
  format: OutputFormat,
  classified: ClassifiedPR[],
  opts: Parameters<typeof renderHtml>[1],
): Promise<string | Uint8Array> {
  switch (format) {
    case 'xlsx':
      return renderXlsx(classified, { viewer: opts.viewer, now: opts.now });
    case 'json':
      return renderJson(classified);
    case 'html':
      return renderHtml(classified, opts);
  }
}

function parseFormat(raw: string | undefined): OutputFormat {
  if (raw === undefined) return 'html';
  if (raw === 'html' || raw === 'xlsx' || raw === 'json') return raw;
  throw new Error(`--format must be 'html', 'xlsx' or 'json' (got ${raw})`);
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
  const rows = BUCKET_ORDER.filter((b) => counts.has(b)).map(
    (b) => [BUCKET_LABELS[b], counts.get(b)!] as const,
  );
  if (rows.length === 0) return '(none)';
  const labelW = Math.max(...rows.map(([l]) => l.length));
  const countW = Math.max(...rows.map(([, n]) => String(n).length));
  return (
    '\n' + rows.map(([l, n]) => `  ${l.padEnd(labelW)}    ${String(n).padStart(countW)}`).join('\n')
  );
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
