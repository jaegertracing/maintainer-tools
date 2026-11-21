// Copyright (c) 2026 The Jaeger Authors.
// SPDX-License-Identifier: Apache-2.0

import type {
  ActorClassification,
  DashboardData,
  DashboardItem,
  DashboardSection,
  DashboardSectionKey,
  PullRequest,
} from '../types.js';
import { classifyActor, parseDateSafe, type ClassifyActorOptions } from '../actor.js';

const INACTIVE_AUTHOR_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function escapeMarkdown(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/@/g, '&#64;')
    .replace(/\[/g, '&#91;')
    .replace(/\]/g, '&#93;')
    .replace(/`/g, '&#96;');
}

export function formatAge(ms: number): string {
  if (ms < 60_000) return '< 1m';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function renderLogin(login: string | null | undefined): string {
  if (!login) return 'ghost';
  const label = escapeMarkdown(login);
  const target = encodeURIComponent(login);
  return `[${label}](https://github.com/${target})`;
}

function renderAuthor(pr: PullRequest, classification: ActorClassification): string {
  const loginLink = renderLogin(pr.author?.login);
  if (classification.isBotAuthored && !classification.isDependencyBot) {
    return `${loginLink} \`[bot]\``;
  }
  return loginLink;
}

function renderReviewRequest(
  req: PullRequest['reviewRequests'][number],
  repoOwner: string,
): string {
  const label = escapeMarkdown(req.login);
  const target = encodeURIComponent(req.login);
  if (req.kind === 'team') {
    const owner = encodeURIComponent(repoOwner);
    return `[${label}](https://github.com/orgs/${owner}/teams/${target})`;
  }
  if (req.kind === 'enterprise_team') {
    if (req.enterpriseSlug) {
      const enterprise = encodeURIComponent(req.enterpriseSlug);
      return `[${label}](https://github.com/enterprises/${enterprise}/teams/${target})`;
    }
    return label;
  }
  return `[${label}](https://github.com/${target})`;
}

function renderPrLink(pr: PullRequest): string {
  const title = escapeMarkdown(pr.title);
  return `[#${pr.number}](${pr.url}) ${title}`;
}

function renderWarnings(classification: ActorClassification): string {
  return classification.warnings?.includes('resolved_without_reply') ? ' `resolved-w/o-reply`' : '';
}

export function groupDashboardItems(
  prs: PullRequest[],
  repo: { owner: string; name: string },
  now: Date = new Date(),
  options?: { maxRowsPerSection?: number; classifier?: ClassifyActorOptions },
): DashboardData {
  const sectionsMap = new Map<DashboardSectionKey, DashboardItem[]>([
    ['ready_to_merge', []],
    ['waiting_on_reviewers', []],
    ['waiting_on_authors', []],
    ['draft_prs', []],
    ['dependency_updates', []],
  ]);

  for (const pr of prs) {
    const classification = classifyActor(pr, options?.classifier);
    const turnStartedMs = parseDateSafe(classification.turnStartedAt);
    const waitingDurationMs = turnStartedMs <= 0 ? 0 : Math.max(0, now.getTime() - turnStartedMs);
    const isInactiveAuthor =
      classification.nextActor === 'author' &&
      !classification.isDraft &&
      !classification.warnings?.includes('activity_data_incomplete') &&
      waitingDurationMs >= INACTIVE_AUTHOR_MS;

    const item: DashboardItem = {
      pr,
      classification,
      waitingDurationMs,
      isInactiveAuthor,
    };

    if (classification.nextActor === 'bot') {
      sectionsMap.get('dependency_updates')!.push(item);
    } else if (classification.isDraft) {
      sectionsMap.get('draft_prs')!.push(item);
    } else if (classification.nextActor === 'maintainer') {
      sectionsMap.get('ready_to_merge')!.push(item);
    } else if (classification.nextActor === 'author') {
      sectionsMap.get('waiting_on_authors')!.push(item);
    } else {
      sectionsMap.get('waiting_on_reviewers')!.push(item);
    }
  }

  // Sort descending by waiting time (oldest waiting first), with pr.number ascending as deterministic tie-breaker
  for (const items of sectionsMap.values()) {
    items.sort((a, b) => b.waitingDurationMs - a.waitingDurationMs || a.pr.number - b.pr.number);
  }

  const maxRows = options?.maxRowsPerSection;
  const buildSection = (key: DashboardSectionKey, title: string): DashboardSection => {
    const allItems = sectionsMap.get(key)!;
    const totalCount = allItems.length;
    const items =
      maxRows !== undefined && maxRows < totalCount ? allItems.slice(0, maxRows) : allItems;
    const omittedCount = totalCount - items.length;
    const section: DashboardSection = {
      key,
      title,
      items,
      totalCount,
      omittedCount,
    };
    if (key === 'waiting_on_authors') {
      section.inactiveAuthorCount = allItems.filter((i) => i.isInactiveAuthor).length;
    }
    return section;
  };

  const sections: DashboardSection[] = [
    buildSection('ready_to_merge', 'Ready to merge'),
    buildSection('waiting_on_reviewers', 'Waiting on reviewers'),
    buildSection('waiting_on_authors', 'Waiting on authors'),
    buildSection('draft_prs', 'Draft pull requests'),
    buildSection('dependency_updates', 'Dependency updates'),
  ];

  return {
    repo,
    sections,
    generatedAt: now.toISOString(),
  };
}

export const ROW_LIMIT_STEPS = [40, 20, 10, 5, 2, 1] as const;

export interface RenderOptions {
  maxRowsPerSection?: number;
  countOnlyCollapsed?: boolean;
  countOnlyAll?: boolean;
}

function renderSectionHeader(section: DashboardSection): string {
  if (section.key === 'waiting_on_authors' && (section.inactiveAuthorCount ?? 0) > 0) {
    return `### ${section.title} (${section.totalCount} - ${section.inactiveAuthorCount} inactive 7d+)`;
  }
  return `### ${section.title} (${section.totalCount})`;
}

function renderTable(
  section: DashboardSection,
  maxRows: number,
  countOnly: boolean,
  repoOwner: string,
): { content: string; omitted: number } {
  if (section.items.length === 0) {
    return { content: '_No pull requests in this section._\n', omitted: 0 };
  }

  if (countOnly) {
    const noun = section.totalCount === 1 ? 'pull request' : 'pull requests';
    return { content: `_${section.totalCount} ${noun}._\n`, omitted: section.totalCount };
  }

  const itemsToRender = section.items.slice(0, maxRows);
  const omitted = section.totalCount - itemsToRender.length;
  const rows: string[] = [];

  switch (section.key) {
    case 'ready_to_merge': {
      rows.push('| PR | Author | Turn | Reason |');
      rows.push('| :--- | :--- | :--- | :--- |');
      for (const item of itemsToRender) {
        rows.push(
          `| ${renderPrLink(item.pr)} | ${renderAuthor(item.pr, item.classification)} | ${formatAge(item.waitingDurationMs)} | \`${item.classification.reason}\`${renderWarnings(item.classification)} |`,
        );
      }
      break;
    }
    case 'waiting_on_reviewers': {
      rows.push('| PR | Author | Reviewers | Turn | Status |');
      rows.push('| :--- | :--- | :--- | :--- | :--- |');
      for (const item of itemsToRender) {
        const reviewers =
          item.pr.reviewRequests.length > 0
            ? item.pr.reviewRequests.map((r) => renderReviewRequest(r, repoOwner)).join(', ')
            : '_None requested_';
        rows.push(
          `| ${renderPrLink(item.pr)} | ${renderAuthor(item.pr, item.classification)} | ${reviewers} | ${formatAge(item.waitingDurationMs)} | \`${item.classification.reason}\`${renderWarnings(item.classification)} |`,
        );
      }
      break;
    }
    case 'waiting_on_authors': {
      rows.push('| PR | Author | Blocker | Turn |');
      rows.push('| :--- | :--- | :--- | :--- |');
      for (const item of itemsToRender) {
        const ageBadge = item.isInactiveAuthor
          ? `${formatAge(item.waitingDurationMs)} \`7d+\``
          : formatAge(item.waitingDurationMs);
        rows.push(
          `| ${renderPrLink(item.pr)} | ${renderAuthor(item.pr, item.classification)} | \`${item.classification.reason}\`${renderWarnings(item.classification)} | ${ageBadge} |`,
        );
      }
      break;
    }
    case 'draft_prs': {
      rows.push('| PR | Author | Turn |');
      rows.push('| :--- | :--- | :--- |');
      for (const item of itemsToRender) {
        rows.push(
          `| ${renderPrLink(item.pr)} | ${renderAuthor(item.pr, item.classification)} | ${formatAge(item.waitingDurationMs)}${renderWarnings(item.classification)} |`,
        );
      }
      break;
    }
    case 'dependency_updates': {
      rows.push('| PR | Author | Status | Turn |');
      rows.push('| :--- | :--- | :--- | :--- |');
      for (const item of itemsToRender) {
        const status = item.pr.isDraft ? '`draft`' : '`ready`';
        rows.push(
          `| ${renderPrLink(item.pr)} | ${renderAuthor(item.pr, item.classification)} | ${status} | ${formatAge(item.waitingDurationMs)}${renderWarnings(item.classification)} |`,
        );
      }
      break;
    }
  }

  if (omitted > 0) {
    rows.push(`\n_... and ${omitted} not shown._`);
  }

  return { content: rows.join('\n') + '\n', omitted };
}

function assembleBody(data: DashboardData, options: RenderOptions): string {
  const maxRows = options.maxRowsPerSection ?? ROW_LIMIT_STEPS[0];
  const countOnlyAll = options.countOnlyAll ?? false;
  const countOnly = options.countOnlyCollapsed ?? false;
  const parts: string[] = [];

  parts.push(
    `# Pull Request Triage Dashboard for ${escapeMarkdown(data.repo.owner)}/${escapeMarkdown(data.repo.name)}\n`,
  );

  for (const section of data.sections) {
    const isCollapsed = section.key === 'draft_prs' || section.key === 'dependency_updates';
    const countOnlyForSection = countOnlyAll || (isCollapsed && countOnly);
    const { content } = renderTable(section, maxRows, countOnlyForSection, data.repo.owner);

    if (isCollapsed) {
      parts.push('<details>');
      parts.push(`<summary><strong>${section.title} (${section.totalCount})</strong></summary>\n`);
      parts.push(content);
      parts.push('</details>\n');
    } else {
      parts.push(renderSectionHeader(section));
      parts.push('');
      parts.push(content);
    }
  }

  return parts.join('\n');
}

const MAX_RECOMMENDED_BYTES = 60_000;
const MAX_HARD_CEILING_BYTES = 65_000;

export function renderDashboard(data: DashboardData, options: RenderOptions = {}): string {
  const initialMaxRows = options.maxRowsPerSection ?? ROW_LIMIT_STEPS[0];
  let countOnlyCollapsed = options.countOnlyCollapsed ?? false;
  const initialCountOnlyAll = options.countOnlyAll ?? false;

  const buildOutput = (rows: number, collapsedOnly: boolean, allCountOnly: boolean): string => {
    return assembleBody(data, {
      maxRowsPerSection: rows,
      countOnlyCollapsed: collapsedOnly,
      countOnlyAll: allCountOnly,
    });
  };

  let rendered = buildOutput(initialMaxRows, countOnlyCollapsed, initialCountOnlyAll);
  let totalBytes = Buffer.byteLength(rendered, 'utf-8');
  if (totalBytes <= MAX_RECOMMENDED_BYTES) {
    return rendered;
  }

  if (!countOnlyCollapsed) {
    countOnlyCollapsed = true;
    rendered = buildOutput(initialMaxRows, countOnlyCollapsed, false);
    totalBytes = Buffer.byteLength(rendered, 'utf-8');
    if (totalBytes <= MAX_RECOMMENDED_BYTES) {
      return rendered;
    }
  }

  for (const limit of ROW_LIMIT_STEPS) {
    if (limit >= initialMaxRows) continue;
    rendered = buildOutput(limit, countOnlyCollapsed, false);
    totalBytes = Buffer.byteLength(rendered, 'utf-8');
    if (totalBytes <= MAX_RECOMMENDED_BYTES) {
      return rendered;
    }
  }

  rendered = buildOutput(1, true, true);
  totalBytes = Buffer.byteLength(rendered, 'utf-8');
  if (totalBytes <= MAX_RECOMMENDED_BYTES) {
    return rendered;
  }

  if (totalBytes > MAX_HARD_CEILING_BYTES) {
    const fallbackHeader = `# Pull Request Triage Dashboard for ${escapeMarkdown(data.repo.owner)}/${escapeMarkdown(data.repo.name)}\n\n_Output truncated due to payload size limits._\n`;
    return Buffer.byteLength(fallbackHeader, 'utf-8') <= MAX_HARD_CEILING_BYTES
      ? fallbackHeader
      : '# Pull Request Triage Dashboard\n\n_Output truncated due to payload size limits._\n';
  }

  return rendered;
}
