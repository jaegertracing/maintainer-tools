// Markdown variant of the triage report, suitable for pasting into chat,
// email, or a GitHub issue body.

import { BUCKET_LABELS, type ClassifiedPR } from '../buckets.js';
import { type BucketSection, formatAge, groupByRepo } from './shared.js';

export interface MarkdownOptions {
  viewer: string;
  now: Date;
  authorOpenCounts: Map<string, Map<string, number>>;
}

export function renderMarkdown(classified: ClassifiedPR[], opts: MarkdownOptions): string {
  const blocks = groupByRepo(classified);
  const date = opts.now.toISOString().slice(0, 16).replace('T', ' ');
  const out: string[] = [];

  out.push(`# PR Triage — ${date} UTC — @${opts.viewer}`);
  out.push('');

  for (const block of blocks) {
    out.push(`## ${block.repo} (${block.visibleCount} / ${block.totalCount} visible)`);
    out.push('');
    const counts = opts.authorOpenCounts.get(block.repo) ?? new Map();
    for (const section of block.sections) {
      out.push(renderSection(section, opts.viewer, opts.now, counts));
      out.push('');
    }
  }

  return out.join('\n');
}

function renderSection(
  section: BucketSection,
  viewer: string,
  now: Date,
  counts: Map<string, number>,
): string {
  const label = BUCKET_LABELS[section.bucket];
  const head = `### ${label} (${section.prs.length})`;
  if (section.bucket === 'hidden') {
    return `${head}\n\n_Not actionable until the contributor moves._`;
  }
  const rows = section.prs.map((c) => renderRow(c, viewer, now, counts));
  return `${head}\n\n${rows.join('\n')}`;
}

function renderRow(
  c: ClassifiedPR,
  viewer: string,
  now: Date,
  counts: Map<string, number>,
): string {
  const pr = c.pr;
  const author = pr.author?.login ?? '(unknown)';
  const youTag = author === viewer ? ' (you)' : '';
  const openCount = counts.get(author) ?? 1;
  const flags = c.flags.length ? ` _[${c.flags.join(', ')}]_` : '';
  return `- [#${pr.number}](${pr.url}) \`+${pr.additions}/-${pr.deletions}\` ${escapeMd(pr.title)} — @${author}${youTag} [${openCount} open] — ${formatAge(pr, now)}${flags}`;
}

function escapeMd(s: string): string {
  return s.replace(/([\\`*_{}[\]()#+\-.!|])/g, '\\$1');
}
