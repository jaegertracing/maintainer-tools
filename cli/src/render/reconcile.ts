// The report of a run of the reconciler in shadow mode: the totals of each
// repository, then every pull request that a run in write mode would
// change.

import {
  lastActivityByPersonAt,
  OWNED_LABELS,
  policyCommentsOf,
} from '@jaegertracing/maintainer-tools-checks';
import type { Change, PullRequest, Reconciliation } from '@jaegertracing/maintainer-tools-checks';

const CHANGE_KINDS: readonly Change['kind'][] = [
  'add label',
  'remove label',
  'create comment',
  'edit comment',
  'minimize comment',
  'close',
];

function printChange(change: Change): string {
  switch (change.kind) {
    case 'add label':
    case 'remove label':
      return `${change.kind} \`${change.label}\``;
    case 'edit comment':
    case 'minimize comment':
      return `${change.kind} ${change.id}`;
    default:
      return change.kind;
  }
}

function repoOf(pr: PullRequest): string {
  return `${pr.repo.owner}/${pr.repo.name}`;
}

function ownedLabelsOf(pr: PullRequest): string[] {
  return OWNED_LABELS.filter((label) => pr.labels.includes(label));
}

function labelList(labels: readonly string[]): string {
  return labels.map((label) => `\`${label}\``).join(', ') || 'none';
}

function byRepository(reconciliations: readonly Reconciliation[]): Map<string, Reconciliation[]> {
  const groups = new Map<string, Reconciliation[]>();
  for (const reconciliation of reconciliations) {
    const repo = repoOf(reconciliation.pr);
    groups.set(repo, [...(groups.get(repo) ?? []), reconciliation]);
  }
  return groups;
}

export function renderReconcileMarkdown(
  reconciliations: readonly Reconciliation[],
  now: string,
): string {
  const lines = [
    `# Shadow run of the reconciler`,
    '',
    `Observed at ${now}. Nothing was changed on GitHub.`,
    '',
  ];
  for (const [repo, ofRepo] of byRepository(reconciliations)) {
    const changed = ofRepo.filter(({ changes }) => changes.length > 0);
    const count = (kind: Change['kind']): number =>
      ofRepo.flatMap(({ changes }) => changes).filter((change) => change.kind === kind).length;
    lines.push(
      `## ${repo}`,
      '',
      `Open pull requests: ${ofRepo.length}, of which ${changed.length} differ from the plan.`,
      '',
      '| Change | Count |',
      '| --- | --- |',
      ...CHANGE_KINDS.map((kind) => `| ${kind} | ${count(kind)} |`),
      '',
    );
    for (const { pr, plan, changes } of changed) {
      lines.push(
        `### [#${pr.number}](${pr.url}) by ${pr.author?.login ?? 'a deleted account'}`,
        '',
        `- Labels now: ${labelList(ownedLabelsOf(pr))}`,
        `- Labels planned: ${labelList(plan.labels)}`,
        `- Changes: ${changes.map(printChange).join('; ')}`,
        ...Object.entries(plan.reasons).map(
          ([output, reasons]) => `- Reason for \`${output}\`: ${reasons.join('; ')}`,
        ),
        `- Last activity by a person: ${new Date(lastActivityByPersonAt(pr)).toISOString()}`,
        `- Policy comments now: ${
          policyCommentsOf(pr)
            .map(
              (comment) =>
                `${comment.isOfReconciler ? 'reconciler' : 'replaced action'} of ${comment.createdAt}`,
            )
            .join(', ') || 'none'
        }`,
        '',
      );
      const commentChange = changes.find(
        (change) => change.kind === 'create comment' || change.kind === 'edit comment',
      );
      if (commentChange) {
        lines.push(
          commentChange.kind === 'create comment'
            ? 'Comment that would be posted:'
            : 'Text that the existing comment would be edited to:',
          '',
          ...commentChange.body.split('\n').map((line) => `> ${line}`),
          '',
        );
      }
    }
  }
  return lines.join('\n');
}

// The JSON report holds what was decided for every pull request and has no
// time of the run in it, so two runs over one snapshot can be compared byte
// for byte.
export function renderReconcileJson(reconciliations: readonly Reconciliation[]): string {
  return (
    JSON.stringify(
      reconciliations.map(({ pr, plan, changes }) => ({
        repo: repoOf(pr),
        number: pr.number,
        labelsNow: ownedLabelsOf(pr),
        plan,
        changes,
      })),
      null,
      2,
    ) + '\n'
  );
}
