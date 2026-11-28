// The HTML report of a run of the reconciler in shadow mode. It shows, for
// every pull request that a run in write mode would change, a link to the
// pull request, the changes, and the comment as the author would see it.

import { OWNED_LABELS } from '@jaegertracing/maintainer-tools-checks';
import type { Change, PullRequest, Reconciliation } from '@jaegertracing/maintainer-tools-checks';

import { escape } from './escape.js';

const CHANGE_KINDS: readonly Change['kind'][] = [
  'add label',
  'remove label',
  'create comment',
  'edit comment',
  'minimize comment',
  'close',
];

function repoOf(pr: PullRequest): string {
  return `${pr.repo.owner}/${pr.repo.name}`;
}

function inlineFormat(text: string): string {
  return escape(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/(^|\s)@([\w-]+)/g, '$1<strong>@$2</strong>');
}

// Converts what a plan writes into a comment: paragraphs, a list, inline
// code, links and mentions. The hidden marker is left out, as GitHub does.
function commentToHtml(body: string): string {
  const html: string[] = [];
  let isInList = false;
  for (const line of body.split('\n')) {
    const isItem = line.startsWith('- ');
    if (isItem !== isInList) {
      html.push(isItem ? '<ul>' : '</ul>');
      isInList = isItem;
    }
    if (isItem) html.push(`<li>${inlineFormat(line.slice(2))}</li>`);
    else if (line.trim() !== '' && !line.startsWith('<!--')) {
      html.push(`<p>${inlineFormat(line.trim())}</p>`);
    }
  }
  if (isInList) html.push('</ul>');
  return html.join('\n');
}

function labelChips(labels: readonly string[], cssClass: string): string {
  return labels.map((label) => `<span class="chip ${cssClass}">${escape(label)}</span>`).join(' ');
}

function changeText(change: Change): string {
  switch (change.kind) {
    case 'add label':
    case 'remove label':
      return `${change.kind} <code>${escape(change.label)}</code>`;
    default:
      return change.kind;
  }
}

function renderCard({ pr, plan, changes }: Reconciliation): string {
  const labelsNow = OWNED_LABELS.filter((label) => pr.labels.includes(label));
  const added = plan.labels.filter((label) => !labelsNow.includes(label));
  const removed = labelsNow.filter((label) => !plan.labels.includes(label));
  const kept = labelsNow.filter((label) => plan.labels.includes(label));
  const commentChange = changes.find(
    (change) => change.kind === 'create comment' || change.kind === 'edit comment',
  );
  const kinds = [...new Set(changes.map((change) => change.kind))];
  // A pull request that stopped being blocked has no comment in its plan,
  // and the run posts the comment that says so.
  const shownBody = commentChange?.body ?? plan.comment;
  const comment =
    shownBody === null
      ? ''
      : `<div class="comment ${commentChange ? 'comment-new' : ''}">
  <div class="comment-caption">${
    commentChange
      ? commentChange.kind === 'create comment'
        ? 'Comment that would be posted, which notifies the author'
        : 'Text that the existing comment would be edited to, without a notification'
      : 'Comment of the plan. The run posts and edits nothing, because the author was already told'
  }</div>
${commentToHtml(shownBody)}
</div>`;
  return `<article class="card" data-kinds="${escape(kinds.join('|'))}">
  <div class="card-header">
    <a href="${escape(pr.url)}">${escape(repoOf(pr))}#${pr.number}</a>
    <span class="title">${escape(pr.title)}</span>
    <span class="author">${pr.author ? `@${escape(pr.author.login)}` : '(deleted account)'}</span>
    ${plan.shouldClose ? '<span class="chip chip-close">would be closed</span>' : ''}
  </div>
  <div class="card-body">
    <div class="labels">Labels: ${labelChips(kept, 'chip-kept')} ${labelChips(added, 'chip-added')} ${labelChips(removed, 'chip-removed')}${
      kept.length + added.length + removed.length === 0 ? 'none' : ''
    }</div>
    <div class="changes">Changes: ${changes.map(changeText).join('; ')}</div>
    ${Object.entries(plan.reasons)
      .map(
        ([output, reasons]) =>
          `<div class="reason">Why <code>${escape(output)}</code>: ${escape(reasons.join('; '))}</div>`,
      )
      .join('\n    ')}
  </div>
${comment}
</article>`;
}

function renderRepository(repo: string, reconciliations: readonly Reconciliation[]): string {
  const changed = reconciliations.filter(({ changes }) => changes.length > 0);
  const count = (kind: Change['kind']): number =>
    reconciliations.flatMap(({ changes }) => changes).filter((change) => change.kind === kind)
      .length;
  return `<section>
<h2>${escape(repo)}</h2>
<p class="meta">${reconciliations.length} open pull requests, of which ${changed.length} differ from the plan.</p>
<table class="totals"><tr>${CHANGE_KINDS.map((kind) => `<th>${kind}</th>`).join('')}</tr>
<tr>${CHANGE_KINDS.map((kind) => `<td>${count(kind)}</td>`).join('')}</tr></table>
${changed.map(renderCard).join('\n')}
</section>`;
}

export function renderReconcileHtml(
  reconciliations: readonly Reconciliation[],
  now: string,
): string {
  const repos = new Map<string, Reconciliation[]>();
  for (const reconciliation of reconciliations) {
    const repo = repoOf(reconciliation.pr);
    repos.set(repo, [...(repos.get(repo) ?? []), reconciliation]);
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Reconciler shadow run — ${escape(now)}</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <h1>Reconciler shadow run</h1>
  <p class="meta">Observed at ${escape(now)}. Nothing was changed on GitHub.</p>
  <div class="filters">Show: ${['all', ...CHANGE_KINDS]
    .map((kind) => `<button data-kind="${kind}">${kind}</button>`)
    .join(' ')}</div>
</header>
${[...repos].map(([repo, ofRepo]) => renderRepository(repo, ofRepo)).join('\n')}
<footer>Generated by <code>maintainer-tools reconcile</code>.</footer>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

const SCRIPT = `
for (const button of document.querySelectorAll('.filters button')) {
  button.addEventListener('click', () => {
    const kind = button.dataset.kind;
    for (const other of document.querySelectorAll('.filters button')) {
      other.classList.toggle('active', other === button);
    }
    for (const card of document.querySelectorAll('.card')) {
      card.hidden = kind !== 'all' && !card.dataset.kinds.split('|').includes(kind);
    }
  });
}
`;

const CSS = `
:root { --bg: #ffffff; --fg: #1f2328; --muted: #59636e; --card: #f6f8fa; --border: #d1d9e0;
  --link: #0969da; --code: #eff1f3; --added: #dafbe1; --removed: #ffebe9; --kept: #eff1f3; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #0d1117; --fg: #e6edf3; --muted: #9198a1; --card: #161b22; --border: #30363d;
    --link: #58a6ff; --code: #262c36; --added: #12381f; --removed: #4a1d1d; --kept: #262c36; }
}
* { box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
  font-size: 14px; line-height: 1.5; background: var(--bg); color: var(--fg);
  max-width: 960px; margin: 0 auto; padding: 1.5rem 1rem; }
h1 { font-size: 1.5rem; margin: 0; }
h2 { font-size: 1.2rem; margin: 2rem 0 0.25rem; }
a { color: var(--link); }
code { background: var(--code); padding: 0.1em 0.3em; border-radius: 4px; font-size: 0.9em; }
.meta { color: var(--muted); margin: 0.25rem 0 0.75rem; }
.filters button { font: inherit; padding: 0.2em 0.7em; border: 1px solid var(--border);
  border-radius: 999px; background: var(--card); color: var(--fg); cursor: pointer; }
.filters button.active { border-color: var(--link); color: var(--link); }
table.totals { border-collapse: collapse; margin-bottom: 1rem; font-variant-numeric: tabular-nums; }
table.totals th, table.totals td { border: 1px solid var(--border); padding: 0.25em 0.7em;
  text-align: right; font-weight: normal; }
table.totals th { color: var(--muted); }
.card { border: 1px solid var(--border); border-radius: 6px; margin-bottom: 1rem; overflow: hidden; }
.card-header { background: var(--card); padding: 0.5rem 0.75rem; display: flex; gap: 0.6rem;
  flex-wrap: wrap; align-items: baseline; border-bottom: 1px solid var(--border); }
.card-header a { font-weight: 600; white-space: nowrap; }
.card-header .title { flex: 1 1 16rem; }
.card-header .author { color: var(--muted); }
.card-body { padding: 0.5rem 0.75rem; }
.reason { color: var(--muted); }
.chip { display: inline-block; padding: 0 0.5em; border-radius: 999px; font-size: 0.85em;
  border: 1px solid var(--border); }
.chip-kept { background: var(--kept); }
.chip-added { background: var(--added); }
.chip-added::before { content: '+ '; }
.chip-removed { background: var(--removed); text-decoration: line-through; }
.chip-close { background: var(--removed); font-weight: 600; }
.comment { margin: 0 0.75rem 0.75rem; padding: 0.5rem 0.75rem; border: 1px solid var(--border);
  border-left: 3px solid var(--border); border-radius: 6px; }
.comment-new { border-left-color: var(--link); }
.comment-caption { color: var(--muted); font-size: 0.85em; margin-bottom: 0.25rem; }
.comment p { margin: 0.3rem 0; }
.comment ul { margin: 0.3rem 0; padding-left: 1.3rem; }
footer { color: var(--muted); margin-top: 2rem; font-size: 0.85em; }
`;
