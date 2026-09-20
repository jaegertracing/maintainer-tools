// GitHub Copilot code review posts a normal pull-request review whose body
// starts with the `<!-- ccr-overview-v2 -->` marker, followed by a verdict
// heading (`### 🟢 Approval recommended`) and a findings line where each
// severity is an `<img alt="Medium severity">`. This module turns the latest
// such review into a small structured summary for the triage report.

import type { PullRequest } from '@jaegertracing/maintainer-tools-checks';

import { sameLogin } from './logins.js';

// GraphQL reports bot actors without the `[bot]` suffix that the REST API and
// the web UI show, so both spellings are accepted.
export const COPILOT_LOGIN = 'copilot-pull-request-reviewer';

function isCopilot(login: string): boolean {
  return sameLogin(login, COPILOT_LOGIN) || sameLogin(login, `${COPILOT_LOGIN}[bot]`);
}

const OVERVIEW_MARKER = '<!-- ccr-overview';

export type CopilotLight = 'green' | 'yellow' | 'red';

export interface CopilotReview {
  light: CopilotLight | null;
  // Heading text without the traffic-light emoji, e.g. "Approval recommended".
  headline: string;
  findings: { high: number; medium: number; low: number };
  // Count of unresolved findings from the "Open (N)" section, when present.
  open: number | null;
  url: string | null;
  submittedAt: string;
}

const LIGHTS: Array<[string, CopilotLight]> = [
  ['🟢', 'green'],
  ['🟡', 'yellow'],
  ['🔴', 'red'],
];

export function copilotReview(pr: PullRequest): CopilotReview | null {
  let latest: PullRequest['reviews'][number] | undefined;
  for (const r of pr.reviews) {
    if (!r.author || !isCopilot(r.author)) continue;
    if (!r.body || !r.body.includes(OVERVIEW_MARKER)) continue;
    if (!latest || Date.parse(r.submittedAt) > Date.parse(latest.submittedAt)) latest = r;
  }
  if (!latest || !latest.body) return null;
  return parseOverview(latest.body, latest.url ?? null, latest.submittedAt);
}

export function parseOverview(
  body: string,
  url: string | null,
  submittedAt: string,
): CopilotReview {
  let light: CopilotLight | null = null;
  let headline = '';
  const heading = /^###\s*(.+)$/m.exec(body);
  if (heading) {
    headline = heading[1]!.trim();
    for (const [emoji, value] of LIGHTS) {
      if (headline.startsWith(emoji)) {
        light = value;
        headline = headline.slice(emoji.length).trim();
        break;
      }
    }
  }

  const findings = { high: 0, medium: 0, low: 0 };
  const findingsLine = /\*\*Findings:\*\*(.*)/.exec(body);
  if (findingsLine) {
    const re = /(\d+)\s*<picture>.*?alt="(\w+) severity"/gi;
    for (const m of findingsLine[1]!.matchAll(re)) {
      const severity = (m[2] ?? '').toLowerCase();
      const count = Number(m[1]);
      if (severity === 'high') findings.high += count;
      else if (severity === 'medium') findings.medium += count;
      else if (severity === 'low') findings.low += count;
    }
  }

  const openMatch = /<strong>Open \((\d+)\)<\/strong>/.exec(body);
  const open = openMatch ? Number(openMatch[1]) : null;

  return { light, headline, findings, open, url, submittedAt };
}

// Compact label used in both report views: the traffic light plus the
// non-zero severity counts, e.g. "🟢 1M 2L". An overview with no findings
// renders just the light; an unrecognised heading gets a neutral light so the
// review stays visible and linked.
export function copilotLabel(review: CopilotReview): string {
  const parts: string[] = [];
  const emoji = LIGHTS.find(([, v]) => v === review.light)?.[0] ?? '⚪';
  parts.push(emoji);
  if (review.findings.high > 0) parts.push(`${review.findings.high}H`);
  if (review.findings.medium > 0) parts.push(`${review.findings.medium}M`);
  if (review.findings.low > 0) parts.push(`${review.findings.low}L`);
  return parts.join(' ');
}

export function copilotTooltip(review: CopilotReview): string {
  const f = review.findings;
  const counts = [
    f.high > 0 ? `${f.high} high` : '',
    f.medium > 0 ? `${f.medium} medium` : '',
    f.low > 0 ? `${f.low} low` : '',
  ].filter(Boolean);
  const parts = [`Copilot: ${review.headline || 'no verdict'}`];
  parts.push(counts.length > 0 ? `Findings: ${counts.join(', ')}` : 'Findings: none');
  if (review.open !== null) parts.push(`${review.open} open`);
  return parts.join(' · ');
}
