// Flat table view of every classified PR, hidden ones included, rendered with
// Tabulator (https://tabulator.info). The bucket view answers "what should I
// look at next"; this view answers ad-hoc questions such as "all PRs from
// priority authors, whatever bucket they landed in". Sorting is multi-column
// (shift-click a header, or arrange the chips in the Sort panel) and every
// column has a header filter with autocompletion over its current values.
//
// Tabulator's JS and CSS are inlined from node_modules so the report stays a
// single self-contained file.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { computeComposition, type PullRequest } from '@jaegertracing/maintainer-tools-checks';

import { BUCKET_LABELS, BUCKET_ORDER, type ClassifiedPR } from '../buckets.js';
import { copilotLabel, copilotTooltip } from '../copilot.js';
import { sameLogin } from '../logins.js';
import { ageInDays, NO_PRIORITY_LABEL } from './shared.js';

export interface TableOptions {
  viewer: string;
  now: Date;
  priorityLabels?: string[];
}

// One row of the table, serialised to JSON into the page. Field names are
// what the column definitions in TABLE_SCRIPT reference.
export interface TableRow {
  repo: string;
  number: number;
  url: string;
  title: string;
  author: string;
  authorUrl: string;
  isViewer: boolean;
  bucket: string;
  bucketOrder: number;
  priorityLabel: string;
  hideReasons: string[];
  flags: string[];
  priorityAuthor: boolean;
  reviewRequested: boolean;
  viewerReviewed: boolean;
  firstTimer: boolean;
  dependencyBot: boolean;
  codeownersHit: boolean;
  maintainerEngaged: boolean;
  copilot: string;
  copilotLight: string;
  copilotUrl: string;
  copilotTip: string;
  srcLines: number;
  additions: number;
  deletions: number;
  changedFiles: number;
  ageDays: number;
  updatedAt: string;
  createdAt: string;
  labels: string[];
  issues: string[];
  dco: string;
  ci: string;
  mergeable: string;
  openThreads: number;
}

export function buildTableRows(classified: ClassifiedPR[], opts: TableOptions): TableRow[] {
  return classified.map((c) => {
    const pr = c.pr;
    const author = pr.author?.login ?? '(unknown)';
    const review = c.copilot;
    const priorityLabel = (opts.priorityLabels ?? []).find((l) => pr.labels.includes(l));
    return {
      repo: `${pr.repo.owner}/${pr.repo.name}`,
      number: pr.number,
      url: pr.url,
      title: pr.title,
      author,
      authorUrl: `https://github.com/${author}`,
      isViewer: sameLogin(author, opts.viewer),
      bucket: BUCKET_LABELS[c.bucket],
      bucketOrder: BUCKET_ORDER.indexOf(c.bucket),
      priorityLabel: priorityLabel ?? (opts.priorityLabels?.length ? NO_PRIORITY_LABEL : ''),
      hideReasons: c.facets.hideReasons.map(hideReasonLabel),
      flags: c.flags,
      priorityAuthor: c.facets.priorityAuthor,
      reviewRequested: c.facets.reviewRequested,
      viewerReviewed: c.facets.viewerReviewed,
      firstTimer: c.facets.firstTimer,
      dependencyBot: c.facets.dependencyBot,
      codeownersHit: c.facets.codeownersHit,
      maintainerEngaged: c.facets.maintainerEngaged,
      copilot: review ? copilotLabel(review) : '',
      copilotLight: review?.light ?? '',
      copilotUrl: review?.url ?? '',
      copilotTip: review ? copilotTooltip(review) : '',
      srcLines: computeComposition(pr).sourceLines,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changedFiles,
      ageDays: Math.floor(ageInDays(pr, opts.now)),
      updatedAt: pr.updatedAt.slice(0, 10),
      createdAt: pr.createdAt.slice(0, 10),
      labels: pr.labels,
      issues: (pr.computed?.issueRefs ?? []).map((r) => issueLabel(r, pr)),
      dco: c.checks.some((k) => k.id === 'dco_missing' && k.triggered) ? 'missing' : 'ok',
      ci: (pr.statusCheckRollup ?? 'none').toLowerCase(),
      mergeable: pr.mergeable.toLowerCase(),
      openThreads: (pr.reviewThreads ?? []).filter((t) => !t.isResolved).length,
    };
  });
}

function hideReasonLabel(raw: string): string {
  const stripped = raw.startsWith('hide:') ? raw.slice(5) : raw;
  return stripped.replace(/_/g, '-').toUpperCase();
}

function issueLabel(ref: { owner: string; repo: string; number: number }, pr: PullRequest): string {
  const same = ref.owner === pr.repo.owner && ref.repo === pr.repo.name;
  return same ? `#${ref.number}` : `${ref.owner}/${ref.repo}#${ref.number}`;
}

export function renderTableView(classified: ClassifiedPR[], opts: TableOptions): string {
  const rows = buildTableRows(classified, opts);
  return `<section id="view-table" class="view" hidden>
  <div class="table-panels">
    <div class="panel" id="sort-panel">
      <span class="panel-label">Sort</span>
      <span class="chips" id="sort-chips"></span>
      <span class="panel-hint">click a header to sort, shift-click to add a column; drag chips to reorder, click a chip to flip direction</span>
    </div>
    <div class="panel" id="filter-panel">
      <span class="panel-label">Filters</span>
      <span class="chips" id="filter-chips"></span>
      <button type="button" id="clear-filters" hidden>Clear all</button>
      <span class="panel-hint">type in the boxes under each header; lists autocomplete from the visible rows</span>
      <span class="row-count" id="row-count"></span>
    </div>
  </div>
  <div id="triage-table"></div>
</section>
<script type="application/json" id="table-rows">${jsonForScript(rows)}</script>
<script>${TABLE_SCRIPT}</script>`;
}

// `</script>` inside a JSON string literal would end the element early.
function jsonForScript(rows: TableRow[]): string {
  return JSON.stringify(rows).replace(/</g, '\\u003c');
}

export function tabulatorAssets(): { js: string; css: string } {
  const require = createRequire(import.meta.url);
  const js = readFileSync(require.resolve('tabulator-tables/dist/js/tabulator.min.js'), 'utf8');
  const css = readFileSync(
    require.resolve('tabulator-tables/dist/css/tabulator_simple.min.css'),
    'utf8',
  );
  return { js: js.replace(/<\/script/gi, '<\\/script'), css: css.replace(/<\/style/gi, '') };
}

export const TABLE_CSS = `
  .view[hidden] { display: none; }
  body.table-mode { max-width: none; margin: 1em 1.5em; }
  header .toolbar .view-switch { margin-left: 1em; }
  header .toolbar .view-switch button[aria-pressed="true"] { background: #1f2328; color: white; border-color: #1f2328; }
  .table-panels { display: flex; flex-direction: column; gap: 0.5em; margin-bottom: 0.8em; }
  .panel { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4em; padding: 0.5em 0.7em; border: 1px solid #d0d7de; border-radius: 6px; background: #f6f8fa; font-size: 0.85em; }
  .panel-label { font-weight: 600; margin-right: 0.4em; }
  .panel-hint { color: #8c959f; margin-left: auto; }
  .row-count { color: #57606a; margin-left: 0.8em; }
  .chips { display: inline-flex; flex-wrap: wrap; gap: 0.3em; }
  .chip { display: inline-flex; align-items: center; gap: 0.3em; padding: 0.15em 0.5em; border: 1px solid #d0d7de; border-radius: 12px; background: white; cursor: pointer; user-select: none; }
  .chip.dragging { opacity: 0.4; }
  .chip .x { color: #8c959f; margin-left: 0.2em; }
  .chip .x:hover { color: #cf222e; }
  .chip .dir { color: #57606a; }
  #clear-filters { font-size: 1em; padding: 0.15em 0.6em; border: 1px solid #d0d7de; border-radius: 12px; background: white; cursor: pointer; }
  #triage-table { font-size: 0.85em; border: 1px solid #d0d7de; border-radius: 6px; }
  #triage-table .tabulator-header .tabulator-col .tabulator-header-filter input { font-size: 0.9em; padding: 0.15em 0.3em; }
  #triage-table .cell-flags .flag { white-space: nowrap; }
  #triage-table .tabulator-cell a { color: #0969da; text-decoration: none; }
  #triage-table .tabulator-cell a:hover { text-decoration: underline; }
  #triage-table .tabulator-row.row-hidden { color: #8c959f; }
  .copilot-green { color: #1f883d; }
  .copilot-yellow { color: #9a6700; }
  .copilot-red { color: #cf222e; }
`;

// Runs in the browser. Reads the rows from the JSON script element, builds the
// Tabulator instance on first switch to the table view, and keeps the Sort and
// Filters panels in step with the table's own state.
const TABLE_SCRIPT = `
(() => {
  const ROWS = JSON.parse(document.getElementById('table-rows').textContent);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const chips = (values, cls) => values.map((v) => '<span class="flag ' + cls(v) + '">' + esc(v) + '</span>').join(' ');
  const flagClass = (v) => 'flag-' + (v.split(':')[0] || v).trim().replace(/[^A-Za-z0-9-]/g, '-');

  // Tabulator inserts tooltips and list items as HTML, so every value that
  // came from a PR (titles, labels, author logins) is escaped first.
  const escapedItem = (label) => esc(label);
  const listParams = (field) => ({
    valuesLookup: () => {
      const seen = new Set();
      for (const row of table.getData('active')) for (const v of row[field]) seen.add(v);
      return [...seen].sort();
    },
    itemFormatter: escapedItem,
    autocomplete: true, clearable: true, listOnEmpty: true, freetext: true,
  });
  const listFilter = (needle, values) => {
    const n = String(needle).toLowerCase();
    return values.some((v) => String(v).toLowerCase().includes(n));
  };
  const enumParams = { valuesLookup: 'active', itemFormatter: escapedItem, autocomplete: true, clearable: true, listOnEmpty: true, freetext: true };
  const boolParams = { values: [{ label: 'yes', value: 'true' }, { label: 'no', value: 'false' }], clearable: true };
  const boolFilter = (needle, value) => String(value) === needle;
  const numFilter = (needle, value) => {
    const m = /^\\s*(<=|>=|<|>|=)?\\s*(-?\\d+(?:\\.\\d+)?)\\s*$/.exec(needle);
    if (!m) return true;
    const n = Number(m[2]);
    switch (m[1]) {
      case '<': return value < n;
      case '<=': return value <= n;
      case '>': return value > n;
      case '>=': return value >= n;
      default: return value === n;
    }
  };

  const text = (title, field, extra) => Object.assign({ title, field, headerFilter: 'input' }, extra);
  const en = (title, field, extra) => Object.assign({ title, field, headerFilter: 'list', headerFilterParams: enumParams }, extra);
  const bool = (title, field, extra) => Object.assign({
    title, field, hozAlign: 'center', formatter: 'tickCross', formatterParams: { crossElement: false },
    // Live filtering would re-apply the typed label ("yes") in place of the
    // selected value ("true") after the list closes, matching nothing.
    headerFilter: 'list', headerFilterParams: boolParams, headerFilterFunc: boolFilter, headerFilterLiveFilter: false, width: 70,
  }, extra);
  const list = (title, field, cls, extra) => Object.assign({
    title, field, cssClass: 'cell-flags',
    formatter: (cell) => chips(cell.getValue(), cls),
    headerFilter: 'list', headerFilterParams: listParams(field), headerFilterFunc: listFilter,
    sorter: (a, b) => a.join(' ').localeCompare(b.join(' ')),
  }, extra);
  const num = (title, field, extra) => Object.assign({
    title, field, hozAlign: 'right', sorter: 'number',
    headerFilter: 'input', headerFilterPlaceholder: '>= n', headerFilterFunc: numFilter, width: 80,
  }, extra);

  const columns = [
    en('repo', 'repo', { frozen: true }),
    num('PR', 'number', {
      frozen: true, width: 80, headerFilterPlaceholder: '#',
      formatter: (cell) => '<a href="' + esc(cell.getRow().getData().url) + '" target="_blank" rel="noopener noreferrer">#' + cell.getValue() + '</a>',
    }),
    text('title', 'title', { minWidth: 260, widthGrow: 3, tooltip: (e, cell) => esc(cell.getValue()) }),
    en('author', 'author', {
      formatter: (cell) => {
        const r = cell.getRow().getData();
        return '<a href="' + esc(r.authorUrl) + '" target="_blank" rel="noopener noreferrer">@' + esc(r.author) + '</a>' + (r.isViewer ? ' <span class="role-tag">you</span>' : '');
      },
    }),
    en('bucket', 'bucket', {
      sorter: (a, b, aRow, bRow) => aRow.getData().bucketOrder - bRow.getData().bucketOrder,
    }),
    ROWS.some((r) => r.priorityLabel) ? en('priority', 'priorityLabel') : null,
    list('hide reasons', 'hideReasons', () => 'flag-HIDE'),
    list('flags', 'flags', flagClass),
    en('Copilot', 'copilot', {
      hozAlign: 'center', width: 100,
      formatter: (cell) => {
        const r = cell.getRow().getData();
        if (!r.copilot) return '';
        const inner = '<span class="copilot-' + esc(r.copilotLight) + '" title="' + esc(r.copilotTip) + '">' + esc(r.copilot) + '</span>';
        return r.copilotUrl ? '<a href="' + esc(r.copilotUrl) + '" target="_blank" rel="noopener noreferrer">' + inner + '</a>' : inner;
      },
    }),
    bool('priority author', 'priorityAuthor'),
    bool('requested', 'reviewRequested'),
    bool('you reviewed', 'viewerReviewed'),
    bool('first-timer', 'firstTimer'),
    bool('CODEOWNERS', 'codeownersHit'),
    bool('maintainer engaged', 'maintainerEngaged'),
    bool('dep bot', 'dependencyBot'),
    en('DCO', 'dco', { width: 90 }),
    en('CI', 'ci', { width: 90 }),
    en('mergeable', 'mergeable', { width: 110 }),
    num('open threads', 'openThreads'),
    num('src lines', 'srcLines'),
    num('+', 'additions'),
    num('-', 'deletions'),
    num('files', 'changedFiles'),
    num('age (d)', 'ageDays'),
    en('updated', 'updatedAt', { width: 110 }),
    en('created', 'createdAt', { width: 110 }),
    list('labels', 'labels', () => 'flag-LABEL'),
    list('issues', 'issues', () => 'flag-ISSUE'),
  ].filter(Boolean);

  let table = null;
  function ensureTable() {
    if (table) { table.redraw(true); return; }
    table = new Tabulator('#triage-table', {
      data: ROWS,
      columns,
      layout: 'fitDataStretch',
      height: '78vh',
      columnHeaderSortMulti: true,
      movableColumns: true,
      rowFormatter: (row) => { if (row.getData().bucket === ${JSON.stringify(BUCKET_LABELS.hidden)}) row.getElement().classList.add('row-hidden'); },
      // Tabulator applies the last sorter first, so the primary key goes last.
      initialSort: [
        { column: 'ageDays', dir: 'desc' },
        { column: 'srcLines', dir: 'asc' },
        { column: 'bucket', dir: 'asc' },
      ],
    });
    table.on('dataSorted', renderSortChips);
    table.on('dataFiltered', renderFilterChips);
    table.on('tableBuilt', () => { renderSortChips(); renderFilterChips(); });
  }

  // --- Sort panel: chips in priority order (primary first). Tabulator keeps
  // its list the other way round, so the two conversions below reverse it.
  const sortChips = document.getElementById('sort-chips');
  const primaryFirst = () => table.getSorters().slice().reverse();
  const applySort = (list) => table.setSort(list.slice().reverse().map((s) => ({ column: s.field, dir: s.dir })));
  let dragIndex = null;
  function renderSortChips() {
    const sorters = primaryFirst();
    sortChips.innerHTML = sorters.length === 0 ? '<span class="dim">none</span>' : '';
    sorters.forEach((s, i) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.draggable = true;
      chip.innerHTML = esc(s.column.getDefinition().title) + ' <span class="dir">' + (s.dir === 'asc' ? '▲' : '▼') + '</span><span class="x" title="remove">×</span>';
      chip.addEventListener('click', (e) => {
        const next = primaryFirst();
        if (e.target.classList.contains('x')) next.splice(i, 1);
        else next[i].dir = next[i].dir === 'asc' ? 'desc' : 'asc';
        applySort(next);
      });
      chip.addEventListener('dragstart', () => { dragIndex = i; chip.classList.add('dragging'); });
      chip.addEventListener('dragend', () => chip.classList.remove('dragging'));
      chip.addEventListener('dragover', (e) => e.preventDefault());
      chip.addEventListener('drop', (e) => {
        e.preventDefault();
        if (dragIndex === null || dragIndex === i) return;
        const next = primaryFirst();
        const [moved] = next.splice(dragIndex, 1);
        next.splice(i, 0, moved);
        dragIndex = null;
        applySort(next);
      });
      sortChips.appendChild(chip);
    });
  }

  // --- Filters panel: one chip per active header filter.
  const filterChips = document.getElementById('filter-chips');
  const clearBtn = document.getElementById('clear-filters');
  const rowCount = document.getElementById('row-count');
  function renderFilterChips(_filters, activeRows) {
    const filters = table.getHeaderFilters();
    filterChips.innerHTML = filters.length === 0 ? '<span class="dim">none</span>' : '';
    for (const f of filters) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      const title = table.getColumn(f.field).getDefinition().title;
      const shown = f.value === 'true' ? 'yes' : f.value === 'false' ? 'no' : f.value;
      chip.innerHTML = esc(title) + ': <b>' + esc(shown) + '</b><span class="x" title="remove">×</span>';
      chip.addEventListener('click', () => table.setHeaderFilterValue(f.field, ''));
      filterChips.appendChild(chip);
    }
    clearBtn.hidden = filters.length === 0;
    const shown = Array.isArray(activeRows) ? activeRows.length : table.getDataCount('active');
    rowCount.textContent = shown + ' of ' + ROWS.length + ' PRs';
  }
  clearBtn.addEventListener('click', () => table.clearHeaderFilter());

  // --- View switch. The chosen view is kept in the URL hash so a reload or a
  // bookmark lands on the same one.
  const views = { buckets: document.getElementById('view-buckets'), table: document.getElementById('view-table') };
  const buttons = document.querySelectorAll('.view-switch button');
  function show(name) {
    for (const [k, el] of Object.entries(views)) el.hidden = k !== name;
    document.body.classList.toggle('table-mode', name === 'table');
    buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === name)));
    if (name === 'table') ensureTable();
    history.replaceState(null, '', name === 'table' ? '#table' : location.pathname + location.search);
  }
  buttons.forEach((b) => b.addEventListener('click', () => show(b.dataset.view)));
  show(location.hash === '#table' ? 'table' : 'buckets');
})();
`;
