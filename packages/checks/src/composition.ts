// Diff composition: what a PR's changed lines actually are.
//
// A PR's `+additions/-deletions` total is a poor predictor of review effort
// because test data dominates it. In the Jaeger queue on 2026-08-14, the
// largest visible PR (5,882 lines) changed zero source lines — it was 5,540
// lines of JSON fixtures — and another that read as 588 lines was 61 lines of
// source behind 497 lines of tests. Splitting the total by file class is what
// makes `sourceLines` available as the number to sort and judge by.

import type { FileChange, PullRequest } from './types.js';

export type FileClass = 'generated' | 'fixtures' | 'tests' | 'docs' | 'config' | 'source';

// Ordered most-specific first; the first matching rule wins. Order is the
// whole design: `mocks/foo_test.go` is generated before it is a test, and
// `testdata/x.json` is a fixture before it is JSON config.
const RULES: Array<{ cls: FileClass; re: RegExp }> = [
  { cls: 'generated', re: /(^|\/)(vendor|node_modules)\// },
  {
    cls: 'generated',
    re: /(\.pb\.go|\.pb\.gw\.go|_gen\.go|\.gen\.go|\.generated\.[jt]sx?)$|(^|\/)mocks?\/|(^|\/)package-lock\.json$|(^|\/)go\.sum$|\.snap$/,
  },
  { cls: 'fixtures', re: /(^|\/)(testdata|fixtures?|__fixtures__|snapshots?)\// },
  { cls: 'tests', re: /(_test\.go|\.test\.[jt]sx?|\.spec\.[jt]sx?)$|(^|\/)(tests?|__tests__)\// },
  { cls: 'docs', re: /\.(md|mdx|rst|txt)$|(^|\/)docs?\//i },
  {
    cls: 'config',
    re: /\.(ya?ml|toml|ini|cfg|properties)$|(^|\/)(Makefile|Dockerfile[^/]*|\.dockerignore|\.gitignore|\.golangci\.ya?ml)$/,
  },
  // Plain JSON that isn't in a fixture directory is usually still data rather
  // than source (package.json, tsconfig, sample payloads). Checked after the
  // config rule so YAML/TOML land in `config` and JSON lands here.
  { cls: 'fixtures', re: /\.json$/ },
];

export function classifyPath(path: string): FileClass {
  for (const { cls, re } of RULES) {
    if (re.test(path)) return cls;
  }
  return 'source';
}

export interface ClassTotals {
  additions: number;
  deletions: number;
  files: number;
}

export interface Composition {
  byClass: Record<FileClass, ClassTotals>;
  // Changed lines (additions + deletions) in files classified `source`.
  sourceLines: number;
  // Changed lines across every class. Equals the PR's own additions +
  // deletions when per-file data is present and the PR has ≤ 100 files.
  totalLines: number;
  // False when the PR has no per-file data (cached before `fileStats`
  // existed), in which case every line is attributed to `source` so the PR
  // sorts as if it were all code. Erring toward "needs attention" is the safe
  // direction for a missing signal.
  exact: boolean;
  // True when GitHub's 100-file page truncated the list, so the split covers
  // only the first 100 files.
  truncated: boolean;
}

export const FILE_CLASSES: FileClass[] = [
  'source',
  'tests',
  'fixtures',
  'docs',
  'config',
  'generated',
];

function emptyTotals(): Record<FileClass, ClassTotals> {
  const out = {} as Record<FileClass, ClassTotals>;
  for (const c of FILE_CLASSES) out[c] = { additions: 0, deletions: 0, files: 0 };
  return out;
}

export function computeComposition(pr: PullRequest): Composition {
  const byClass = emptyTotals();
  const stats: FileChange[] | undefined = pr.fileStats;
  const total = pr.additions + pr.deletions;

  if (!stats || stats.length === 0) {
    byClass.source = { additions: pr.additions, deletions: pr.deletions, files: pr.changedFiles };
    return { byClass, sourceLines: total, totalLines: total, exact: false, truncated: false };
  }

  for (const f of stats) {
    const t = byClass[classifyPath(f.path)];
    t.additions += f.additions;
    t.deletions += f.deletions;
    t.files += 1;
  }
  const src = byClass.source;
  let counted = 0;
  for (const c of FILE_CLASSES) counted += byClass[c].additions + byClass[c].deletions;

  return {
    byClass,
    sourceLines: src.additions + src.deletions,
    totalLines: counted,
    exact: true,
    truncated: pr.changedFiles > stats.length,
  };
}
