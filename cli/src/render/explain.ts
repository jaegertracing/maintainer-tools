// Plain-text diagnostic dump for a single classified PR: which bucket it
// landed in and why, every predicate result, and the row flags. Written for
// `maintainer-tools triage --pr <spec> --explain` — answers "why is this PR
// sitting where it is?" without needing to open the HTML report and guess.

import type { CheckResult } from '@jaegertracing/maintainer-tools-checks';
import { BUCKET_DESCRIPTIONS, BUCKET_LABELS, type ClassifiedPR } from '../buckets.js';
import { ageInDays } from './shared.js';

export function renderExplain(c: ClassifiedPR, now: Date): string {
  const pr = c.pr;
  const lines: string[] = [];

  lines.push(`${pr.repo.owner}/${pr.repo.name}#${pr.number} — ${pr.title}`);
  lines.push(pr.url);
  lines.push('');
  lines.push(`author      @${pr.author?.login ?? '(unknown)'}`);
  lines.push(`updated     ${Math.floor(ageInDays(pr, now))}d ago (${pr.updatedAt})`);
  lines.push(`draft       ${pr.isDraft ? 'yes' : 'no'}`);
  lines.push('');
  lines.push(`Bucket: ${BUCKET_LABELS[c.bucket]} (${c.bucket})`);
  lines.push(`  ${BUCKET_DESCRIPTIONS[c.bucket]}`);
  lines.push('');
  lines.push('Reasons:');
  if (c.reasons.length === 0) {
    lines.push('  (none recorded)');
  } else {
    for (const reason of c.reasons) {
      lines.push(`  - ${describeReason(reason, c.checks)}`);
    }
  }
  lines.push('');
  lines.push('Predicate checks:');
  for (const check of c.checks) {
    const mark = check.triggered ? 'x' : ' ';
    const hide = check.hidesFromTriage && check.triggered ? ' hides' : '';
    lines.push(`  [${mark}] ${check.id.padEnd(28)}${hide.padEnd(6)} ${check.summary}`);
  }
  lines.push('');
  lines.push(`Row flags: ${c.flags.length > 0 ? c.flags.join(', ') : '(none)'}`);

  return lines.join('\n') + '\n';
}

// Hidden-bucket reasons are `hide:<predicate_id>`; resolve them to the
// predicate's own summary so the explanation matches the Checks table
// below instead of just repeating the bare id.
function describeReason(reason: string, checks: CheckResult[]): string {
  if (!reason.startsWith('hide:')) return reason;
  const id = reason.slice(5);
  const check = checks.find((c) => c.id === id);
  return check ? `${id} — ${check.summary}` : reason;
}
