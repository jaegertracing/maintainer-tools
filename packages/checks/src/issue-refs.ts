// Parsing the issues a PR claims to close.
//
// One pattern serves two consumers: `no_linked_issue` asks whether any
// reference exists, and the triage CLI needs the actual numbers so it can
// group PRs that claim the same issue. Keeping both on this module is what
// stops the "does it have one" and "which one is it" answers from drifting.
//
// Only GitHub's closing keywords count. A bare `#N` mention is not a claim to
// fix anything, and measuring the Jaeger queue bears that out: of 59 distinct
// bare-mention targets across the visible PRs, 33 were other pull requests
// ("follow-up to #123"), so treating bare mentions as issue links would
// manufacture collisions that don't exist.

import type { IssueRef } from './types.js';

const KEYWORDS = 'fix|fixes|fixed|close|closes|closed|resolve|resolves|resolved';

// Two accepted forms after the keyword:
//   [owner/repo]#123
//   https://github.com/owner/repo/issues/123
//
// GitHub itself does not honour `Fixes: #123` for auto-closing, but the
// colon form is common in Jaeger PR bodies and clearly states intent, so it
// is accepted here. That makes this a record of what the author claims, not a
// prediction of what GitHub will close on merge.
const REF_RE = new RegExp(
  String.raw`\b(?:${KEYWORDS})\b[:\s]+(?:(?<slugOwner>[\w.-]+)\/(?<slugRepo>[\w.-]+))?#(?<num>\d+)` +
    String.raw`|\b(?:${KEYWORDS})\b[:\s]+https?:\/\/github\.com\/(?<urlOwner>[\w.-]+)\/(?<urlRepo>[\w.-]+)\/issues\/(?<urlNum>\d+)`,
  'gi',
);

// Jaeger's PR template ships the line `<!-- Example: Resolves #123 -->`, and
// contributors routinely leave it in place. Matching inside HTML comments
// therefore credits those PRs with an issue they never linked, and makes #123
// look like the most contested issue in the repo — it collected four PRs on
// the 2026-08-14 scan. Commented-out text is not a claim, so drop it first.
// Scanned with indexOf rather than a `<!--[\s\S]*?-->` regex: the lazy
// quantifier restarts at every `<!--`, so a body with many unclosed ones costs
// O(n^2) and PR bodies are attacker-controlled input (CodeQL
// js/polynomial-redos). This pass is linear.
function stripComments(body: string): string {
  let out = '';
  let i = 0;
  for (;;) {
    const start = body.indexOf('<!--', i);
    if (start === -1) return out + body.slice(i);
    out += body.slice(i, start) + ' ';
    const end = body.indexOf('-->', start + 4);
    // GitHub hides everything after an unterminated `<!--` when it renders the
    // body, so a reference below one is not a claim a reader would ever see.
    if (end === -1) return out;
    i = end + 3;
  }
}

export function hasIssueRef(body: string): boolean {
  // Fresh lastIndex per call: REF_RE is global and shared.
  REF_RE.lastIndex = 0;
  return REF_RE.test(stripComments(body));
}

// Extract every claimed issue, de-duplicated. Bare `#N` resolves against the
// referring PR's own repo.
export function extractIssueRefs(
  body: string,
  defaultOwner: string,
  defaultRepo: string,
): IssueRef[] {
  const out: IssueRef[] = [];
  const seen = new Set<string>();
  REF_RE.lastIndex = 0;
  for (const m of stripComments(body).matchAll(REF_RE)) {
    const g = m.groups;
    if (!g) continue;
    const numRaw = g.num ?? g.urlNum;
    if (!numRaw) continue;
    const ref: IssueRef = {
      owner: g.slugOwner ?? g.urlOwner ?? defaultOwner,
      repo: g.slugRepo ?? g.urlRepo ?? defaultRepo,
      number: Number(numRaw),
    };
    const key = refKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

export function refKey(ref: IssueRef): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`;
}

// Inverse of `refKey`. Used to turn the stored `owner/repo#number` strings
// back into links; the format is one we produce ourselves, so a parse failure
// means a bug rather than bad input.
export function parseRefKey(key: string): IssueRef | null {
  const m = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(key);
  if (!m) return null;
  return { owner: m[1]!, repo: m[2]!, number: Number(m[3]) };
}

export function issueUrl(ref: IssueRef): string {
  return `https://github.com/${ref.owner}/${ref.repo}/issues/${ref.number}`;
}
