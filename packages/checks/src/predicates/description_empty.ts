import type { CheckResult, PullRequest } from '../types.js';

// Threshold for "no real content". 20 chars is generous — even a one-line
// "fixes #1234 typo in README" comfortably clears it, while empty bodies
// and template skeletons (`## What\n## Why\n`) collapse below.
const MIN_BODY_LENGTH = 20;

export function descriptionEmpty(pr: PullRequest): CheckResult {
  const meaningful = strippedLength(pr.body ?? '');
  const triggered = meaningful < MIN_BODY_LENGTH;
  return {
    id: 'description_empty',
    triggered,
    summary: triggered
      ? `PR description is empty or only template stubs (${meaningful} chars of content)`
      : 'PR description present',
    details: triggered
      ? 'Add a short summary of what changed and why. A PR with no description forces every reviewer to reconstruct the intent from the diff.'
      : undefined,
    publishesCheck: true,
    checkConclusion: triggered ? 'failure' : 'success',
    inDigest: triggered,
    // Hide from triage — an empty-description PR isn't review-ready;
    // pr-nudge will surface it to the author via the waiting-for-author
    // composite.
    hidesFromTriage: triggered,
  };
}

// Count "meaningful" body characters: strip markdown headings, list markers,
// HTML comments, and whitespace. Doesn't try to be perfect — just enough to
// distinguish a real description from `## What\n\n## Why\n\n## How\n`.
function strippedLength(body: string): number {
  return stripHtmlComments(body)
    .replace(/^#+\s.*$/gm, '') // markdown headings
    .replace(/^[-*]\s*$/gm, '') // empty list markers
    .replace(/\s+/g, '').length; // all whitespace
}

// Linear-time HTML-comment stripper. Avoids the polynomial backtracking
// CodeQL flags on `/<!--[\s\S]*?-->/g` against pathological input like
// `<!--<!--<!--...` with no closing `-->`. Also forecloses the "incomplete
// multi-character sanitization" warning since each `<!-- ... -->` pair is
// consumed by index slice rather than a regex substitution that could
// leave a partial marker behind.
function stripHtmlComments(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const start = s.indexOf('<!--', i);
    if (start === -1) {
      out += s.slice(i);
      break;
    }
    out += s.slice(i, start);
    const end = s.indexOf('-->', start + 4);
    if (end === -1) {
      // Unclosed comment — match the prior regex's behavior of leaving the
      // tail alone rather than swallowing the rest of the input.
      out += s.slice(start);
      break;
    }
    i = end + 3;
  }
  return out;
}
