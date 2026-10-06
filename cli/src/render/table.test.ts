import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

import type { PullRequest } from '@jaegertracing/maintainer-tools-checks';

import { classify, type ClassifyContext } from '../buckets.js';
import { NO_PRIORITY_LABEL } from './shared.js';
import { buildTableRows, renderTableView } from './table.js';

const now = new Date('2026-09-20T12:00:00Z');

const context: ClassifyContext = {
  viewer: 'maintainer-a',
  maintainers: new Set(['maintainer-a']),
  priorityAuthors: new Set(['priority-author']),
  codeownerPaths: ['src/**'],
  now,
  ignoreReviewRequestedOnYou: false,
};

function pullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    repo: { owner: 'example', name: 'repo' },
    number: 7,
    title: 'Fix the thing',
    url: 'https://github.com/example/repo/pull/7',
    author: { login: 'priority-author', typename: 'User' },
    authorAssociation: 'CONTRIBUTOR',
    isDraft: false,
    mergeable: 'MERGEABLE',
    createdAt: '2026-09-10T08:00:00Z',
    updatedAt: '2026-09-18T08:00:00Z',
    labels: ['priority:high', 'area/storage'],
    additions: 10,
    deletions: 2,
    changedFiles: 2,
    files: ['src/a.go', 'src/a_test.go'],
    statusCheckRollup: 'FAILURE',
    commits: [
      {
        sha: 'abc',
        messageHeadline: 'Fix the thing',
        messageBody: '',
        authorEmail: 'a@example.com',
        committedDate: '2026-09-18T08:00:00Z',
        parents: 1,
      },
    ],
    reviewRequests: [],
    reviews: [],
    comments: [],
    body: 'Closes #3 and Fixes other/repo#9',
    reviewThreads: [
      { isResolved: false, resolvedBy: null, comments: [] },
      { isResolved: true, resolvedBy: 'x', comments: [] },
    ],
    computed: {
      issueRefs: [
        { owner: 'example', repo: 'repo', number: 3 },
        { owner: 'other', repo: 'repo', number: 9 },
      ],
    },
    ...overrides,
  };
}

test('buildTableRows keeps the overridden signals next to the bucket', () => {
  const classified = classify(pullRequest(), context);
  const [row] = buildTableRows([classified], {
    viewer: 'maintainer-a',
    now,
    priorityLabels: ['priority:high', 'priority:low'],
  });

  assert.ok(row);
  assert.equal(row.repo, 'example/repo');
  assert.equal(row.bucket, 'Blocked on author');
  assert.equal(row.bucketOrder, 8);
  assert.equal(row.repoOrder, 0);
  assert.equal(row.priorityOrder, 0);
  assert.equal(row.isViewer, false);
  assert.equal(row.priorityAuthor, true);
  assert.deepEqual(row.hideReasons, ['DCO-MISSING', 'CI-FAILING']);
  assert.equal(row.dco, 'missing');
  assert.equal(row.ci, 'failure');
  assert.equal(row.mergeable, 'mergeable');
  assert.equal(row.priorityLabel, 'priority:high');
  assert.equal(row.codeownersHit, true);
  assert.equal(row.openThreads, 1);
  assert.equal(row.ageDays, 2 + 4 / 24);
  assert.equal(row.ageLabel, '2d');
  assert.equal(row.updatedAt, '2026-09-18');
  assert.deepEqual(row.issues, ['#3', 'other/repo#9']);
  assert.equal(row.copilot, '');
});

test('buildTableRows carries the per-class diff breakdown as rendered HTML', () => {
  const classified = classify(
    pullRequest({
      files: ['src/a.ts', 'src/a.test.ts'],
      fileStats: [
        { path: 'src/a.ts', additions: 12, deletions: 3, changeType: 'MODIFIED' },
        { path: 'src/a.test.ts', additions: 40, deletions: 0, changeType: 'ADDED' },
      ],
    }),
    context,
  );
  const [row] = buildTableRows([classified], { viewer: 'maintainer-a', now });

  assert.ok(row);
  assert.match(row.diff, /dc-source[^>]*>src<\/span><span class="dc-nums">.*\+12.*-3/);
  assert.match(row.diff, /dc-tests[^>]*>test<\/span><span class="dc-nums">.*\+40.*-0/);
  assert.doesNotMatch(row.diff, /dc-docs/);
  assert.equal(row.diffTip, '1 source file: +12 / -3\n1 test file: +40 / -0');
});

test('buildTableRows falls back to the whole-PR total without per-file stats', () => {
  const classified = classify(
    pullRequest({ fileStats: undefined, additions: 7, deletions: 2, changedFiles: 2 }),
    context,
  );
  const [row] = buildTableRows([classified], { viewer: 'maintainer-a', now });

  assert.ok(row);
  assert.doesNotMatch(row.diff, /dc-label/);
  assert.match(row.diff, /\+7.*-2/);
  assert.equal(row.diffTip, '2 files: +7 / -2');
});

test('buildTableRows marks a breakdown that covers only the first 100 files', () => {
  // computeComposition flags truncation whenever changedFiles exceeds the
  // per-file stats it was given, so a small shortfall exercises the branch.
  const fileStats = Array.from({ length: 3 }, (_, i) => ({
    path: `src/f${i}.ts`,
    additions: 1,
    deletions: 0,
    changeType: 'MODIFIED',
  }));
  const classified = classify(
    pullRequest({ files: fileStats.map((f) => f.path), fileStats, changedFiles: 5 }),
    context,
  );
  const [row] = buildTableRows([classified], { viewer: 'maintainer-a', now });

  assert.ok(row);
  assert.match(row.diff, /dc-trunc/);
  assert.equal(
    row.diffTip,
    '3 source files: +3 / -0\nMore than 100 files changed; this split covers the first 100 only.',
  );
});

test('buildTableRows preserves hourly ages for sorting and display', () => {
  const rows = buildTableRows(
    ['2026-09-20T10:00:00Z', '2026-09-20T02:00:00Z', '2026-09-19T12:00:00Z'].map((updatedAt) =>
      classify(pullRequest({ updatedAt }), context),
    ),
    { viewer: 'maintainer-a', now },
  );

  assert.deepEqual(
    rows.map((row) => ({ days: row.ageDays, label: row.ageLabel })),
    [
      { days: 2 / 24, label: '2h' },
      { days: 10 / 24, label: '10h' },
      { days: 1, label: '1d' },
    ],
  );
});

test('buildTableRows carries the Copilot verdict and marks the viewer as author', () => {
  const body =
    '<!-- ccr-overview-v2 -->\n### 🟡 Review recommended\n**Findings:** 2 <picture><img alt="High severity"></picture>\n';
  const classified = classify(
    pullRequest({
      author: { login: 'maintainer-a', typename: 'User' },
      reviews: [
        {
          author: 'copilot-pull-request-reviewer',
          state: 'COMMENTED',
          submittedAt: '2026-09-18T09:00:00Z',
          url: 'https://example/review',
          body,
        },
      ],
    }),
    context,
  );
  const [row] = buildTableRows([classified], { viewer: 'maintainer-a', now });

  assert.ok(row);
  assert.equal(row.isViewer, true);
  assert.equal(row.copilot, '🟡 2H');
  assert.equal(row.copilotLight, 'yellow');
  assert.equal(row.copilotUrl, 'https://example/review');
  assert.equal(row.copilotTip, 'Copilot: Review recommended · Findings: 2 high');
});

test('buildTableRows numbers repos in the order they were scanned', () => {
  const first = classify(
    pullRequest({ repo: { owner: 'z', name: 'later-alphabetically' } }),
    context,
  );
  const second = classify(pullRequest({ repo: { owner: 'a', name: 'earlier' } }), context);
  const rows = buildTableRows([first, second, first], { viewer: 'maintainer-a', now });

  assert.deepEqual(
    rows.map((r) => r.repoOrder),
    [0, 1, 0],
  );
});

test('buildTableRows falls back to the no-priority label only when tiers are configured', () => {
  const classified = classify(pullRequest({ labels: [] }), context);
  const [withTiers] = buildTableRows([classified], {
    viewer: 'maintainer-a',
    now,
    priorityLabels: ['priority:high'],
  });
  const [withoutTiers] = buildTableRows([classified], { viewer: 'maintainer-a', now });

  assert.equal(withTiers?.priorityLabel, NO_PRIORITY_LABEL);
  assert.equal(withTiers?.priorityOrder, 1);
  assert.equal(withoutTiers?.priorityLabel, '');
});

test('summary links replace filters and match multiple buckets exactly', () => {
  const html = renderTableView([], { viewer: 'maintainer-a', now });
  const script = html.slice(
    html.indexOf('<script>') + '<script>'.length,
    html.lastIndexOf('</script>'),
  );
  const filters = new Map<string, string | string[]>();
  const listeners = new Map<string, () => void>();
  const links = [
    { dataset: { buckets: '["Needs triage"]' } },
    { dataset: { buckets: '["Needs triage","Review requested"]' } },
    { dataset: { buckets: '[]' } },
    { dataset: { repo: 'example/repo', bucket: 'Needs triage' } },
    { dataset: { repo: 'example/repo' } },
  ].map((link, index) => ({
    ...link,
    addEventListener: (_event: string, handler: (event: { preventDefault(): void }) => void) => {
      listeners.set(String(index), () => handler({ preventDefault() {} }));
    },
  }));
  let tableMode = false;
  let bucketFilter: (values: string[], bucket: string) => boolean = () => false;
  const table = {
    on() {},
    clearHeaderFilter: () => filters.clear(),
    setHeaderFilterValue: (field: string, value: string | string[]) => {
      filters.set(field, Array.isArray(value) ? [...value] : value);
    },
  };
  runInNewContext(script, {
    document: {
      getElementById: () => ({ textContent: '[]', addEventListener() {} }),
      querySelectorAll: (selector: string) => {
        if (!selector.startsWith('.summary-table')) return [];
        return links.filter(
          (link) =>
            (selector.includes('a[data-repo]') && link.dataset.repo !== undefined) ||
            (selector.includes('a[data-buckets]') && link.dataset.buckets !== undefined),
        );
      },
      body: {
        classList: {
          toggle: (_name: string, enabled: boolean) => {
            tableMode = enabled;
          },
          contains: () => tableMode,
        },
      },
    },
    location: { hash: '#table' },
    history: { replaceState() {} },
    Tabulator: function (
      _selector: string,
      options: { columns: Array<{ field: string; headerFilterFunc: typeof bucketFilter }> },
    ) {
      bucketFilter = options.columns.find((column) => column.field === 'bucket')!.headerFilterFunc;
      return table;
    },
  });

  filters.set('repo', 'other/repo');
  filters.set('author', 'someone');
  assert.ok(listeners.has('0'), 'bucket totals must have click handlers');
  listeners.get('0')!();
  assert.deepEqual([...filters], [['bucket', ['Needs triage']]]);
  listeners.get('1')!();
  assert.deepEqual([...filters], [['bucket', ['Needs triage', 'Review requested']]]);
  assert.equal(bucketFilter(['Needs triage', 'Review requested'], 'Needs triage'), true);
  assert.equal(bucketFilter(['Needs triage', 'Review requested'], 'Blocked on author'), false);
  assert.equal(bucketFilter(['Needs triage'], 'Needs'), false);
  listeners.get('2')!();
  assert.equal(filters.size, 0);
  listeners.get('3')!();
  assert.deepEqual(
    [...filters],
    [
      ['repo', 'example/repo'],
      ['bucket', ['Needs triage']],
    ],
  );
  listeners.get('4')!();
  assert.deepEqual([...filters], [['repo', 'example/repo']]);
  tableMode = false;
  listeners.get('0')!();
  assert.deepEqual([...filters], [['repo', 'example/repo']]);
});
