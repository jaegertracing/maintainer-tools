#!/usr/bin/env node
// `maintainer-tools` CLI entrypoint.
//
// Subcommands:
//   triage   — scan configured repos and emit an HTML/markdown report
//
// Run `maintainer-tools triage --help` for flags.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';

import type { PullRequest } from '@jaegertracing/maintainer-tools-checks';
import { classify, type ClassifiedPR } from './buckets.js';
import { loadConfig } from './config.js';
import { renderHtml } from './render/html.js';
import { renderMarkdown } from './render/markdown.js';
import { makeClient, scanRepos } from './scan.js';
import { resolveToken } from './token.js';

const HELP = `Usage: maintainer-tools <command> [options]

Commands:
  triage    Scan configured repos and emit a triage report.

Run \`maintainer-tools <command> --help\` for command-specific flags.
`;

const TRIAGE_HELP = `Usage: maintainer-tools triage [options]

Options:
  --config <path>     Path to JSON config (overrides discovery).
  --format <fmt>      html | markdown (default: html).
  --output <path>     Write report here (default: stdout).
  --no-cache          Bypass the SQLite cache for this run.
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
      format: { type: 'string', default: 'html' },
      output: { type: 'string' },
      'no-cache': { type: 'boolean', default: false },
      viewer: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(TRIAGE_HELP);
    return;
  }
  if (values.format !== 'html' && values.format !== 'markdown') {
    throw new Error(`Unknown --format: ${values.format} (expected html|markdown)`);
  }

  const cfg = loadConfig(values.config);
  const token = resolveToken();
  const client = makeClient(token);

  const cache = await openCacheIfEnabled(cfg.cachePath, values['no-cache']);

  const viewer = values.viewer ?? cfg.viewer ?? (await client.fetchViewerLogin());
  process.stderr.write(`maintainer-tools triage: viewer=@${viewer}, repos=${cfg.repos.length}\n`);

  const { prs, cacheHits, cacheMisses } = await scanRepos(cfg.repos, client, cache);
  process.stderr.write(
    `scanned ${prs.length} open PRs (cache hits: ${cacheHits}, fetched: ${cacheMisses})\n`,
  );

  cache?.close();

  const now = new Date();
  const classified = classifyAll(prs, viewer, cfg, now);
  const perRepoCounts = computePerRepoOpenCounts(prs);

  const report =
    values.format === 'markdown'
      ? renderMarkdown(classified, { viewer, now, authorOpenCounts: perRepoCounts })
      : renderHtml(classified, { viewer, now, authorOpenCounts: perRepoCounts });

  if (values.output) {
    mkdirSync(dirname(values.output), { recursive: true });
    writeFileSync(values.output, report);
    process.stderr.write(`wrote ${values.output}\n`);
  } else {
    process.stdout.write(report);
  }
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
    // `better-sqlite3` is an optional dep; if it failed to build locally, we
    // proceed cache-less rather than crashing. The triage still works, just
    // pays full GraphQL cost on every run.
    process.stderr.write(
      `warning: cache disabled (${err instanceof Error ? err.message : String(err)})\n`,
    );
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
