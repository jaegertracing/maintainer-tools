// XLSX triage report. Single worksheet, repo as a column, one boolean
// column per predicate flag. Frozen header + auto-filter give the user
// Excel/Numbers/Google-Sheets sort & filter for free (drop into a Google
// Drive Desktop folder for sync).

import ExcelJS from 'exceljs';

import { BUCKET_LABELS, BUCKET_ORDER, type Bucket, type ClassifiedPR } from '../buckets.js';
import { ageInDays } from './shared.js';

export interface XlsxOptions {
  viewer: string;
  now: Date;
}

// Boolean flag columns rendered as "✓" / empty. RESOLVED-W/O-REPLY is
// numeric (the offender count) so it sorts and filters as a number.
const FLAG_COLUMNS = [
  'DRAFT',
  'BOT',
  'BLOCKER',
  'MERGE-CONFLICT',
  'STALE',
  'QUESTION',
  'WAITING-FOR-AUTHOR',
  'NEEDS-LABEL',
  'NO-ISSUE',
  'NO-TESTS',
  'UNRESOLVED',
] as const;

const RESOLVED_COL = 'RESOLVED-W/O-REPLY';

// ARGB cell-fill colors mirroring the HTML report's bucket accents
// (cli/src/render/html.ts). Lower-signal buckets share the neutral gray.
const BUCKET_COLORS: Record<Bucket, string> = {
  'review-requested-on-you': 'FFD29922',
  'youre-the-bottleneck': 'FFCF222E',
  'high-trust-awaiting-first-response': 'FF1F883D',
  'first-timer-awaiting': 'FF8250DF',
  'codeowners-hits': 'FFD0D7DE',
  fyi: 'FFD0D7DE',
  'dependency-bots': 'FFD0D7DE',
  hidden: 'FFEAEEF2',
};

// Buckets dark enough that white text reads better than black.
const DARK_BUCKETS = new Set<Bucket>([
  'review-requested-on-you',
  'youre-the-bottleneck',
  'high-trust-awaiting-first-response',
  'first-timer-awaiting',
]);

export async function renderXlsx(
  classified: ClassifiedPR[],
  opts: XlsxOptions,
): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  wb.creator = `maintainer-tools triage (@${opts.viewer})`;
  wb.created = opts.now;
  const ws = wb.addWorksheet('Triage');

  // Default order matches the HTML report: bucket priority, then oldest
  // updatedAt within each bucket. Users re-sort via the auto-filter
  // dropdowns in whichever app opens the file.
  const sorted = [...classified].sort((a, b) => {
    const ba = BUCKET_ORDER.indexOf(a.bucket);
    const bb = BUCKET_ORDER.indexOf(b.bucket);
    if (ba !== bb) return ba - bb;
    return Date.parse(a.pr.updatedAt) - Date.parse(b.pr.updatedAt);
  });

  ws.columns = [
    { header: 'repo', key: 'repo', width: 28 },
    { header: 'bucket', key: 'bucket', width: 24 },
    { header: '#', key: 'num', width: 8 },
    { header: '+', key: 'adds', width: 7 },
    { header: '-', key: 'dels', width: 7 },
    { header: 'title', key: 'title', width: 60 },
    { header: 'author', key: 'author', width: 20 },
    { header: 'age (d)', key: 'age', width: 8 },
    { header: 'updated', key: 'updated', width: 12 },
    ...FLAG_COLUMNS.map((f) => ({ header: f, key: f, width: 8 })),
    { header: RESOLVED_COL, key: RESOLVED_COL, width: 10 },
    { header: 'reason', key: 'reason', width: 32 },
  ];

  for (const c of sorted) {
    const pr = c.pr;
    // c.flags includes prefixes like "RESOLVED-W/O-REPLY: 3" — split on `:`
    // so the boolean lookup matches the bare flag name.
    const flagHeads = new Set(c.flags.map((f) => f.split(':')[0]?.trim() ?? ''));
    const resolvedFlag = c.flags.find((f) => f.startsWith(RESOLVED_COL));
    const resolvedCount = resolvedFlag ? Number(resolvedFlag.split(':')[1]?.trim() ?? '0') : 0;

    const author = pr.author?.login;
    const rowData: Record<string, unknown> = {
      repo: `${pr.repo.owner}/${pr.repo.name}`,
      bucket: BUCKET_LABELS[c.bucket],
      num: { text: `#${pr.number}`, hyperlink: pr.url },
      adds: pr.additions,
      dels: pr.deletions,
      title: pr.title,
      author: author ? { text: author, hyperlink: `https://github.com/${author}` } : '(unknown)',
      age: Math.floor(ageInDays(pr, opts.now)),
      updated: new Date(pr.updatedAt),
      [RESOLVED_COL]: resolvedCount > 0 ? resolvedCount : '',
      reason: c.reasons[0] ?? '',
    };
    for (const flag of FLAG_COLUMNS) {
      rowData[flag] = flagHeads.has(flag) ? '✓' : '';
    }
    const row = ws.addRow(rowData);

    // Color the bucket cell. Hyperlink cells get the standard blue
    // underline applied automatically.
    const bucketCell = row.getCell('bucket');
    bucketCell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: BUCKET_COLORS[c.bucket] },
    };
    bucketCell.font = {
      color: { argb: DARK_BUCKETS.has(c.bucket) ? 'FFFFFFFF' : 'FF1F2328' },
      bold: true,
    };

    // BLOCKER stands out independently of bucket — a stale PR in FYI that
    // sprouted a release-blocker label still needs to be visible at a glance.
    if (flagHeads.has('BLOCKER')) {
      const cell = row.getCell('BLOCKER');
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFCF222E' },
      };
      cell.font = { color: { argb: 'FFFFFFFF' }, bold: true };
      cell.alignment = { horizontal: 'center' };
    }

    // Center the rest of the check-mark flag cells so the ✓ glyph reads
    // as an icon rather than left-justified text.
    for (const flag of FLAG_COLUMNS) {
      if (flag === 'BLOCKER') continue;
      row.getCell(flag).alignment = { horizontal: 'center' };
    }
    row.getCell('num').alignment = { horizontal: 'right' };
    row.getCell('age').alignment = { horizontal: 'right' };
    row.getCell(RESOLVED_COL).alignment = { horizontal: 'right' };

    // ISO date is the only format that sorts correctly across locales
    // when the file is opened in Sheets vs Excel vs Numbers.
    row.getCell('updated').numFmt = 'yyyy-mm-dd';
  }

  // Freeze the header row so it stays put while scrolling, and turn on
  // auto-filter so every column gets its own dropdown.
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: ws.rowCount, column: ws.columnCount },
  };

  const header = ws.getRow(1);
  header.font = { bold: true };
  header.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFF6F8FA' },
  };
  header.alignment = { vertical: 'middle' };

  // exceljs's `Buffer` declaration is `interface Buffer extends ArrayBuffer`,
  // but at runtime in Node it returns an actual Node `Buffer` (a Uint8Array
  // subclass) — safe to write to disk or stdout via fs/process.stdout.
  const buf = await wb.xlsx.writeBuffer();
  return buf as unknown as Uint8Array;
}
