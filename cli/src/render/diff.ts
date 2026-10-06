// Per-class line-count breakdown of a PR, shared by the bucket view and the
// table view so the two render the same cell.

import {
  computeComposition,
  FILE_CLASSES,
  type FileClass,
  type PullRequest,
} from '@jaegertracing/maintainer-tools-checks';

import { escape } from './escape.js';

// Per-class breakdown instead of one total. Only non-zero classes render, so a
// pure source change stays as short as it was before, while a fixture drop is
// visibly a fixture drop. Source leads because it is the sort key.
const CLASS_ABBREV: Record<FileClass, string> = {
  source: 'src',
  tests: 'test',
  fixtures: 'fix',
  docs: 'doc',
  config: 'cfg',
  generated: 'gen',
};

// Plain-text version of the per-label tooltips, for hosts such as Tabulator
// whose cells clip the CSS tooltip and render their own instead.
export function diffSummary(pr: PullRequest): string {
  const comp = computeComposition(pr);
  if (!comp.exact) return `${pr.changedFiles} files: +${pr.additions} / -${pr.deletions}`;
  const parts = FILE_CLASSES.filter((cls) => {
    const t = comp.byClass[cls];
    return t.additions + t.deletions > 0;
  }).map((cls) => fileCountTip(cls, comp.byClass[cls]));
  if (comp.truncated) parts.push(TRUNCATED_TIP);
  return parts.join('\n');
}

const TRUNCATED_TIP = 'More than 100 files changed; this split covers the first 100 only.';

function fileCountTip(
  cls: FileClass,
  t: { files: number; additions: number; deletions: number },
): string {
  return `${t.files} ${cls} file${t.files === 1 ? '' : 's'}: +${t.additions} / -${t.deletions}`;
}

export function renderDiff(pr: PullRequest): string {
  const comp = computeComposition(pr);
  if (!comp.exact) {
    // No per-file data (cached before fileStats existed). Show the whole-PR
    // total rather than a breakdown we cannot stand behind.
    return `<span class="diff">${addDel(pr.additions, pr.deletions)}</span>`;
  }
  const rows = FILE_CLASSES.filter((cls) => {
    const t = comp.byClass[cls];
    return t.additions + t.deletions > 0;
  }).map((cls) => {
    const t = comp.byClass[cls];
    return (
      `<span class="dc-label dc-${cls}" data-tip="${escape(fileCountTip(cls, t))}">${CLASS_ABBREV[cls]}</span>` +
      `<span class="dc-nums">${addDel(t.additions, t.deletions)}</span>`
    );
  });
  if (rows.length === 0) return '<span class="dim">—</span>';
  if (comp.truncated) {
    rows.push(
      `<span class="dc-label dc-trunc" data-tip="${TRUNCATED_TIP}">+…</span><span class="dc-nums"></span>`,
    );
  }
  return `<div class="diff dcs">${rows.join('')}</div>`;
}

function addDel(additions: number, deletions: number): string {
  return `<span class="add">+${additions}</span>/<span class="del">-${deletions}</span>`;
}
