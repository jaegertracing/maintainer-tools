// Copyright (c) 2026 The Jaeger Authors.
// SPDX-License-Identifier: Apache-2.0

import type { PullRequest } from './types.js';

export function sameLogin(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (!left || !right) return false;
  return left.toLowerCase() === right.toLowerCase();
}

export function hasLogin(logins: Set<string> | ReadonlySet<string>, login: string): boolean {
  for (const configured of logins) {
    if (sameLogin(configured, login)) return true;
  }
  return false;
}

// Logins treated as dependency bots — PRs they open are reviewable
// merges authored by a service account.
export const DEPENDENCY_BOT_LOGINS: ReadonlySet<string> = new Set<string>([
  'dependabot',
  'dependabot[bot]',
  'renovate',
  'renovate[bot]',
  'renovate-bot',
  'renovate-bot[bot]',
]);

// Known bot logins returned by GitHub GraphQL (which omits [bot] suffixes),
// along with [bot] suffixed forms for fixture/cache compatibility.
export const KNOWN_BOT_LOGINS: ReadonlySet<string> = new Set<string>([
  ...DEPENDENCY_BOT_LOGINS,
  'copilot-pull-request-reviewer',
  'copilot-pull-request-reviewer[bot]',
  'github-actions',
  'github-actions[bot]',
  'codecov',
  'codecov[bot]',
  'release-please',
  'release-please[bot]',
]);

export function isDependencyBotAuthor(login: string | null | undefined): boolean {
  if (!login) return false;
  return DEPENDENCY_BOT_LOGINS.has(login.toLowerCase());
}

export function isBotLogin(login: string | null | undefined): boolean {
  if (!login) return false;
  const l = login.toLowerCase();
  return l.endsWith('[bot]') || KNOWN_BOT_LOGINS.has(l);
}

export function isBotAuthor(pr: PullRequest): boolean {
  if (!pr.author) return false;
  if (pr.author.typename === 'Bot') return true;
  return isBotLogin(pr.author.login);
}
