// This module renders a PR's line counts per file class for both the bucket
// view and the table view, so the two show the same cell. Only non-zero
// classes render, so a pure source change stays short while a fixture drop is
// visibly a fixture drop. Source leads because it is the sort key.

import {
  computeComposition,
  FILE_CLASSES,
  type ClassTotals,
  type Composition,
  type FileClass,
  type PullRequest,
} from '@jaegertracing/maintainer-tools-checks';

import { escape } from './escape.js';

const CLASS_ABBREV: Record<FileClass, string> = {
  source: 'src',
  tests: 'test',
  fixtures: 'fix',
  docs: 'doc',
  config: 'cfg',
  generated: 'gen',
};

const CLASS_NOUN: Record<FileClass, string> = {
  source: 'source',
  tests: 'test',
  fixtures: 'fixture',
  docs: 'doc',
  config: 'config',
  generated: 'generated',
};

// Plain-text version of the per-label tooltips, for hosts such as Tabulator
// whose cells clip the CSS tooltip and render their own instead.
export function diffSummary(pr: PullRequest): string {
  const comp = computeComposition(pr);
  if (!comp.exact)
    return `${pluralize(pr.changedFiles, 'file')}: +${pr.additions} / -${pr.deletions}`;
  const parts = nonZeroClasses(comp).map((cls) => fileCountTip(cls, comp.byClass[cls]));
  if (parts.length === 0) return '';
  if (comp.truncated) parts.push(TRUNCATED_TIP);
  return parts.join('\n');
}

const TRUNCATED_TIP = 'More than 100 files changed; this split covers the first 100 only.';

function fileCountTip(cls: FileClass, t: ClassTotals): string {
  return `${pluralize(t.files, `${CLASS_NOUN[cls]} file`)}: +${t.additions} / -${t.deletions}`;
}

function pluralize(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

export function renderDiff(pr: PullRequest): string {
  const comp = computeComposition(pr);
  if (!comp.exact) {
    // No per-file data (cached before fileStats existed). Show the whole-PR
    // total rather than a breakdown we cannot stand behind.
    return `<span class="diff">${addDel(pr.additions, pr.deletions)}</span>`;
  }
  const rows = nonZeroClasses(comp).map((cls) => {
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

function nonZeroClasses(comp: Composition): FileClass[] {
  return FILE_CLASSES.filter((cls) => {
    const t = comp.byClass[cls];
    return t.additions + t.deletions > 0;
  });
}

function addDel(additions: number, deletions: number): string {
  return `<span class="add">+${additions}</span>/<span class="del">-${deletions}</span>`;
}
