import assert from 'node:assert/strict';
import test from 'node:test';

import type { PullRequest } from '@jaegertracing/maintainer-tools-checks';

import {
  COPILOT_LOGIN,
  copilotLabel,
  copilotReview,
  copilotTooltip,
  parseOverview,
} from './copilot.js';

const PIC = (severity: string) =>
  `<picture><source media="(prefers-color-scheme: dark)" srcset="x-dark.svg"><img src="x.png" alt="${severity} severity" width="62" height="18"></picture>`;

const BODY = `<!-- ccr-overview-v2 -->

## Copilot review overview

### 🟢 Approval recommended

The conversion paths are coherently implemented.

**Review effort:** Balanced
**Findings:** 1 ${PIC('Medium')} · 2 ${PIC('Low')}

<details open>
<summary><strong>Open (3)</strong></summary>

- ${PIC('Medium')} [The order of operations…](#discussion_r1)
</details>
`;

test('parseOverview extracts the light, headline, findings and open count', () => {
  const r = parseOverview(BODY, 'https://example/review', '2026-09-20T00:00:00Z');
  assert.equal(r.light, 'green');
  assert.equal(r.headline, 'Approval recommended');
  assert.deepEqual(r.findings, { high: 0, medium: 1, low: 2 });
  assert.equal(r.open, 3);
  assert.equal(copilotLabel(r), '🟢 1M 2L');
  assert.equal(
    copilotTooltip(r),
    'Copilot: Approval recommended · Findings: 1 medium, 2 low · 3 open',
  );
});

test('parseOverview reads counts from a bare img and skips deeper headings', () => {
  const body =
    '<!-- ccr-overview-v2 -->\n#### Not the verdict\n### 🟡 Review recommended\n**Findings:** 3 <img alt="High severity"> · 1 <img alt="Low severity">\n';
  const r = parseOverview(body, null, 'x');
  assert.equal(r.light, 'yellow');
  assert.equal(r.headline, 'Review recommended');
  assert.deepEqual(r.findings, { high: 3, medium: 0, low: 1 });
});

test('parseOverview tolerates a body with no findings line', () => {
  const r = parseOverview('<!-- ccr-overview-v2 -->\n### 🔴 Changes requested\n', null, 'x');
  assert.equal(r.light, 'red');
  assert.deepEqual(r.findings, { high: 0, medium: 0, low: 0 });
  assert.equal(r.open, null);
  assert.equal(copilotLabel(r), '🔴');
});

test('parseOverview keeps a review with an unrecognised heading visible', () => {
  const r = parseOverview('<!-- ccr-overview-v2 -->\n### Something new\n', 'u', 'x');
  assert.equal(r.light, null);
  assert.equal(r.headline, 'Something new');
  assert.equal(copilotLabel(r), '⚪');
  assert.equal(copilotTooltip(r), 'Copilot: Something new · Findings: none');
});

test('copilotReview picks the latest Copilot overview and ignores other reviews', () => {
  const pr = {
    reviews: [
      { author: 'human', state: 'APPROVED', submittedAt: '2026-09-21T00:00:00Z', body: BODY },
      {
        author: COPILOT_LOGIN,
        state: 'COMMENTED',
        submittedAt: '2026-09-19T00:00:00Z',
        body: BODY.replace('🟢 Approval recommended', '🟡 Review recommended'),
        url: 'old',
      },
      {
        author: `${COPILOT_LOGIN}[bot]`,
        state: 'COMMENTED',
        submittedAt: '2026-09-20T00:00:00Z',
        body: BODY,
        url: 'new',
      },
      { author: COPILOT_LOGIN, state: 'COMMENTED', submittedAt: '2026-09-22T00:00:00Z' },
      {
        author: COPILOT_LOGIN,
        state: 'COMMENTED',
        submittedAt: '2026-09-23T00:00:00Z',
        body: 'Just an inline comment review with no overview.',
        url: 'no-marker',
      },
    ],
  } as unknown as PullRequest;
  const r = copilotReview(pr);
  assert.ok(r);
  assert.equal(r.url, 'new');
  assert.equal(r.light, 'green');
});

test('copilotReview returns null without a Copilot overview', () => {
  const pr = {
    reviews: [{ author: 'human', state: 'APPROVED', submittedAt: 'x' }],
  } as unknown as PullRequest;
  assert.equal(copilotReview(pr), null);
});
