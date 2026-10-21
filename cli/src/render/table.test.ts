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
  const html = renderTableView(
    [
      pullRequest({ number: 1, labels: ['bug'] }),
      pullRequest({ number: 2, labels: ['bugfix', 'docs'] }),
    ].map((pr) => classify(pr, context)),
    { viewer: 'maintainer-a', now },
  );
  const script = html.slice(
    html.indexOf('<script>') + '<script>'.length,
    html.lastIndexOf('</script>'),
  );
  const rowsJson = html.slice(
    html.indexOf('id="table-rows">') + 'id="table-rows">'.length,
    html.indexOf('</script>'),
  );
  const filters = new Map<string, string | string[]>();
  const listeners = new Map<string, () => void>();
  const scrolled: string[] = [];
  const links = [
    { dataset: { buckets: '["Needs triage"]' } },
    { dataset: { buckets: '["Needs triage","Review requested"]' } },
    { dataset: { buckets: '[]' } },
    { dataset: { repo: 'example/repo', bucket: 'Needs triage' } },
    { dataset: { repo: 'example/repo' } },
    { dataset: { buckets: '["Needs triage"]', label: 'bug' } },
  ].map((link, index) => ({
    ...link,
    addEventListener: (_event: string, handler: (event: { preventDefault(): void }) => void) => {
      listeners.set(String(index), () => handler({ preventDefault() {} }));
    },
  }));
  let tableMode = false;
  let bucketFilter: (values: string[], bucket: string) => boolean = () => false;
  let labelFilter: (needle: string, labels: string[]) => boolean = () => false;
  const built: Array<() => void> = [];
  const table = {
    on: (event: string, handler: () => void) => {
      if (event === 'tableBuilt') built.push(handler);
    },
    redraw() {},
    clearHeaderFilter: () => filters.clear(),
    setHeaderFilterValue: (field: string, value: string | string[]) => {
      filters.set(field, Array.isArray(value) ? [...value] : value);
    },
  };
  runInNewContext(script, {
    document: {
      getElementById: (id: string) => ({
        textContent: id === 'table-rows' ? rowsJson : '',
        addEventListener() {},
        ...(id === 'sort-panel' ? { scrollIntoView: () => scrolled.push(id) } : {}),
      }),
      querySelector: () => ({ offsetHeight: 0 }),
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
    location: { hash: '', pathname: '/triage.html', search: '' },
    window: { addEventListener() {} },
    history: { replaceState() {} },
    Tabulator: function (
      _selector: string,
      options: { columns: Array<{ field: string; headerFilterFunc: typeof bucketFilter }> },
    ) {
      bucketFilter = options.columns.find((column) => column.field === 'bucket')!.headerFilterFunc;
      labelFilter = options.columns.find((column) => column.field === 'labels')!
        .headerFilterFunc as unknown as typeof labelFilter;
      return table;
    },
  });

  // The page opens in the Categorized view, so the first label click has to
  // build the table and wait for it before filtering.
  assert.equal(tableMode, false);
  assert.ok(listeners.has('0'), 'bucket totals must have click handlers');
  listeners.get('0')!();
  assert.equal(filters.size, 0, 'outside Table view a bucket link leaves the filters alone');
  assert.equal(scrolled.length, 0, 'outside Table view a bucket link does not scroll');
  listeners.get('5')!();
  assert.equal(tableMode, true, 'a label count opens the Table view from the Categorized view');
  assert.equal(filters.size, 0, 'the filters wait until Tabulator has built its columns');
  // The table's own tableBuilt handler wires panels the stub does not model;
  // the click registers its filter handler after it.
  assert.equal(built.length, 2);
  built[1]!();
  assert.deepEqual(
    [...filters],
    [
      ['bucket', ['Needs triage']],
      ['labels', '"bug"'],
    ],
  );
  assert.deepEqual(scrolled, ['sort-panel']);
  scrolled.length = 0;

  filters.set('repo', 'other/repo');
  filters.set('author', 'someone');
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
  listeners.get('5')!();
  assert.deepEqual(
    [...filters],
    [
      ['bucket', ['Needs triage']],
      ['labels', '"bug"'],
    ],
  );
  assert.deepEqual(
    scrolled,
    ['sort-panel', 'sort-panel', 'sort-panel', 'sort-panel', 'sort-panel', 'sort-panel'],
    'every summary click scrolls the Sort panel into view',
  );
  assert.equal(labelFilter('"bug"', ['bug']), true);
  assert.equal(labelFilter('"bug"', ['bugfix']), false, 'a quoted value matches exactly');
  assert.equal(labelFilter('"BUG"', ['bug']), true, 'exact matching ignores case');
  assert.equal(labelFilter('bug', ['bugfix']), true, 'plain text matches as a substring');
  assert.equal(labelFilter('""', []), true, 'an empty quoted needle is no filter');
  tableMode = false;
  listeners.get('0')!();
  assert.deepEqual(
    [...filters],
    [
      ['bucket', ['Needs triage']],
      ['labels', '"bug"'],
    ],
    'outside Table view the repo and bucket links leave the filters alone',
  );
  assert.equal(scrolled.length, 6, 'outside Table view the repo and bucket links do not scroll');
  const builtBefore = built.length;
  listeners.get('5')!();
  assert.equal(tableMode, true, 'a label count reopens the Table view from the Categorized view');
  assert.equal(built.length, builtBefore, 'an already built table takes the filters at once');
  assert.deepEqual(
    [...filters],
    [
      ['bucket', ['Needs triage']],
      ['labels', '"bug"'],
    ],
  );
  assert.equal(scrolled.length, 7);
});

test('the bottom scrollbar mirrors the table holder with the same scroll range', () => {
  const html = renderTableView([], { viewer: 'maintainer-a', now });
  const script = html.slice(
    html.indexOf('<script>') + '<script>'.length,
    html.lastIndexOf('</script>'),
  );
  const handlers = new Map<string, () => void>();
  // Both fakes clamp scrollLeft to their range, as a browser does.
  const holder = {
    scrollWidth: 3000,
    clientWidth: 998,
    left: 0,
    get scrollLeft() {
      return Math.min(this.left, this.scrollWidth - this.clientWidth);
    },
    set scrollLeft(v: number) {
      this.left = Math.max(0, Math.min(v, this.scrollWidth - this.clientWidth));
    },
    listeners: new Map<string, () => void>(),
    addEventListener(event: string, fn: () => void) {
      this.listeners.set(event, fn);
    },
  };
  const hscroll = {
    hidden: true,
    clientWidth: 1000,
    get scrollWidth() {
      return parseInt(this.firstElementChild.style.width, 10) || 0;
    },
    left: 0,
    get scrollLeft() {
      return Math.min(this.left, this.scrollWidth - this.clientWidth);
    },
    set scrollLeft(v: number) {
      this.left = Math.max(0, Math.min(v, this.scrollWidth - this.clientWidth));
    },
    firstElementChild: { style: { width: '' } },
    listeners: new Map<string, () => void>(),
    addEventListener(event: string, fn: () => void) {
      this.listeners.set(event, fn);
    },
  };
  const panels = { height: 72.6, getBoundingClientRect: () => ({ height: panels.height }) };
  const cssVars = new Map<string, string>();
  let onPanelsResize: (() => void) | undefined;
  runInNewContext(script, {
    document: {
      getElementById: (id: string) =>
        id === 'hscroll'
          ? hscroll
          : { textContent: '[]', innerHTML: '', hidden: false, addEventListener() {} },
      querySelector: (selector: string) => (selector === '.table-panels' ? panels : null),
      querySelectorAll: () => [],
      body: { classList: { toggle() {}, contains: () => true } },
    },
    location: { hash: '#table' },
    history: { replaceState() {} },
    window: { addEventListener() {} },
    ResizeObserver: class {
      constructor(fn: () => void) {
        onPanelsResize = fn;
      }
      observe() {}
    },
    Tabulator: function () {
      return {
        on: (event: string, fn: () => void) => handlers.set(event, fn),
        element: {
          querySelector: () => holder,
          style: {
            setProperty: (name: string, value: string) => cssVars.set(name, value),
          },
        },
        getSorters: () => [],
        getHeaderFilters: () => [],
        getDataCount: () => 0,
      };
    },
  });

  handlers.get('tableBuilt')!();
  assert.equal(cssVars.get('--panels-height'), '72px', 'the header tucks under the panels');
  panels.height = 101.2;
  onPanelsResize!();
  assert.equal(cssVars.get('--panels-height'), '101px', 'the offset follows the panel height');
  assert.equal(hscroll.hidden, false);
  assert.equal(hscroll.firstElementChild.style.width, '3002px');
  holder.scrollLeft = 2002;
  holder.listeners.get('scroll')!();
  assert.equal(hscroll.scrollLeft, 2002, 'the mirror follows the holder to its far end');
  hscroll.listeners.get('scroll')!();
  holder.scrollLeft = 1500;
  holder.listeners.get('scroll')!();
  holder.scrollLeft = 1510;
  hscroll.listeners.get('scroll')!();
  assert.equal(
    holder.scrollLeft,
    1510,
    "the mirror's echo of 1500 does not undo a later wheel move",
  );
  hscroll.scrollLeft = 700;
  hscroll.listeners.get('scroll')!();
  assert.equal(holder.scrollLeft, 700, 'the holder follows the mirror');
  hscroll.scrollLeft = 690;
  holder.listeners.get('scroll')!();
  assert.equal(hscroll.scrollLeft, 690, "the holder's echo of 700 does not undo a later drag");
  // Drag the mirror to 300, scroll the holder to 500 and back to 300: each
  // echo is consumed once, so the return to 300 still reaches the mirror.
  hscroll.scrollLeft = 300;
  hscroll.listeners.get('scroll')!();
  assert.equal(holder.scrollLeft, 300);
  holder.listeners.get('scroll')!();
  holder.scrollLeft = 500;
  holder.listeners.get('scroll')!();
  assert.equal(hscroll.scrollLeft, 500);
  hscroll.listeners.get('scroll')!();
  holder.scrollLeft = 300;
  holder.listeners.get('scroll')!();
  assert.equal(
    hscroll.scrollLeft,
    300,
    'a genuine return to an old offset is not treated as an echo',
  );
  hscroll.listeners.get('scroll')!();
  hscroll.scrollLeft = 0;
  hscroll.listeners.get('scroll')!();
  assert.equal(holder.scrollLeft, 0, 'a drag to the left edge is not mistaken for an echo');
  holder.listeners.get('scroll')!();

  // A column drag widens the holder before any Tabulator event resizes the
  // mirror; the holder's own scroll handler notices the range mismatch.
  holder.scrollWidth = 3500;
  holder.scrollLeft = 2400;
  holder.listeners.get('scroll')!();
  assert.equal(
    hscroll.firstElementChild.style.width,
    '3502px',
    'the spacer follows a wider holder',
  );
  assert.equal(hscroll.scrollLeft, 2400);
  hscroll.listeners.get('scroll')!();

  // The table narrows so the mirror's range is the wider one: a drag past the
  // holder's end clamps, the clamped echo resizes the mirror, and the marker
  // does not swallow a later genuine pass through the dragged offset.
  holder.scrollWidth = 2000;
  hscroll.scrollLeft = 2400;
  hscroll.listeners.get('scroll')!();
  assert.equal(holder.scrollLeft, 1002, 'the holder clamps');
  holder.listeners.get('scroll')!();
  assert.equal(
    hscroll.firstElementChild.style.width,
    '2002px',
    'the clamped echo resizes the mirror',
  );
  assert.equal(hscroll.scrollLeft, 1002);
  holder.scrollWidth = 3500;
  holder.scrollLeft = 2400;
  holder.listeners.get('scroll')!();
  assert.equal(hscroll.scrollLeft, 2400, 'the old drag offset is no longer treated as an echo');
  hscroll.listeners.get('scroll')!();

  holder.scrollWidth = 998;
  handlers.get('renderComplete')!();
  assert.equal(hscroll.hidden, true, 'no overflow hides the mirror');
  holder.scrollWidth = 1998;
  handlers.get('renderComplete')!();
  assert.equal(hscroll.hidden, false);
  assert.equal(hscroll.firstElementChild.style.width, '2000px', 'the spacer is resized on re-show');
});
