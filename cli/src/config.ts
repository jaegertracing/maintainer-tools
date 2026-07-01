// Configuration loader for the triage CLI.
//
// Lookup order: `--config <path>` > $MAINTAINER_TOOLS_CONFIG >
// ./.maintainer-tools.json > ~/.config/maintainer-tools/config.json.
// All fields are optional; missing fields fall back to sensible defaults.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface TriageConfig {
  // Login of the maintainer running the report ("you"). If omitted, the CLI
  // calls the GraphQL `viewer` query.
  viewer?: string;
  // Repos to scan, formatted `owner/name`.
  repos: string[];
  // Logins treated as "high-trust authors" — their PRs surface in the
  // "high-trust authors awaiting first response" bucket. Maintainers
  // appearing here implicitly count as maintainer-side activity for the
  // first-response heuristic in *every* bucket.
  maintainers: string[];
  // Logins treated as interns / similar trusted role. Same bucket as
  // maintainers for triage purposes, but called out separately.
  interns: string[];
  // Per-repo path globs the viewer is a CODEOWNER for. Glob syntax is
  // minimal: `*` (within a path segment), `**` (across segments), and
  // literal characters. Matched against PR file paths.
  codeowners: Record<string, string[]>;
  // Filesystem path for the SQLite cache (see packages/checks/src/cache.ts).
  cachePath: string;
  // Ordered priority labels, highest to lowest (e.g. ["priority:high",
  // "priority:medium", "priority:low"]). When non-empty, the report adds a
  // priority grouping level between repo and bucket: PRs are matched to the
  // first label in the list they carry; unmatched PRs fall into an explicit
  // "(no priority)" group rendered last. When empty, the report renders the
  // flat bucket view used before priority labels were introduced.
  priorityLabels: string[];
  // When true, an outstanding GitHub review request on the viewer no longer
  // fast-tracks a PR into "review-requested-on-you" (which otherwise
  // overrides every hide rule). Anyone who can open a PR can request review
  // from you, so the bucket carries no trust signal on its own; PRs fall
  // through to normal classification instead. Default false.
  ignoreReviewRequestedOnYou: boolean;
}

interface RawConfig {
  viewer?: string;
  repos?: string[];
  maintainers?: string[];
  interns?: string[];
  codeowners?: Record<string, string[]>;
  cachePath?: string;
  priorityLabels?: string[];
  ignoreReviewRequestedOnYou?: boolean;
}

const DEFAULT_CACHE_PATH = join(
  process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'),
  'maintainer-tools',
  'pr-cache.sqlite',
);

const DEFAULT_CONFIG_PATHS = [
  join(process.cwd(), '.maintainer-tools.json'),
  join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
    'maintainer-tools',
    'config.json',
  ),
];

export function loadConfig(explicitPath?: string): TriageConfig {
  const path = explicitPath ?? process.env.MAINTAINER_TOOLS_CONFIG ?? findFirstExisting();
  if (!path) {
    throw new Error(
      `No config found. Looked at: ${DEFAULT_CONFIG_PATHS.join(', ')}. ` +
        `Pass --config <path>, set $MAINTAINER_TOOLS_CONFIG, or create one of the default paths. ` +
        `Sample configs: cli/config.example.json (generic) and cli/config.example.jaeger.json (Jaeger org).`,
    );
  }

  const raw = JSON.parse(readFileSync(resolve(path), 'utf8')) as RawConfig;
  if (!raw.repos || raw.repos.length === 0) {
    throw new Error(`Config at ${path} must include a non-empty "repos" array.`);
  }
  for (const r of raw.repos) {
    if (!r.includes('/')) {
      throw new Error(`Repo "${r}" must be in "owner/name" form.`);
    }
  }

  return {
    viewer: raw.viewer,
    repos: raw.repos,
    maintainers: raw.maintainers ?? [],
    interns: raw.interns ?? [],
    codeowners: raw.codeowners ?? {},
    cachePath: raw.cachePath ?? DEFAULT_CACHE_PATH,
    priorityLabels: validatePriorityLabels(raw.priorityLabels, path),
    ignoreReviewRequestedOnYou: validateBoolean(
      raw.ignoreReviewRequestedOnYou,
      'ignoreReviewRequestedOnYou',
      path,
    ),
  };
}

function validatePriorityLabels(value: unknown, configPath: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`Config at ${configPath}: "priorityLabels" must be an array of strings.`);
  }
  return value as string[];
}

function validateBoolean(value: unknown, field: string, configPath: string): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') {
    throw new Error(`Config at ${configPath}: "${field}" must be a boolean.`);
  }
  return value;
}

function findFirstExisting(): string | undefined {
  for (const p of DEFAULT_CONFIG_PATHS) {
    try {
      readFileSync(p, 'utf8');
      return p;
    } catch {
      // not found, keep looking
    }
  }
  return undefined;
}
