// Copyright (c) 2026 The Jaeger Authors.
// SPDX-License-Identifier: Apache-2.0

import type { AuthorTypename, PullRequest } from './types.js';

export function sameLogin(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (
    typeof left !== 'string' ||
    typeof right !== 'string' ||
    left.trim() === '' ||
    right.trim() === ''
  ) {
    return false;
  }
  return left.trim().toLowerCase() === right.trim().toLowerCase();
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
  'coderabbitai',
  'coderabbitai[bot]',
  'coderabbit-ai',
  'coderabbit-ai[bot]',
  'sonarcloud',
  'sonarcloud[bot]',
  'deepsource-autofix',
  'deepsource-autofix[bot]',
  'snyk-bot',
]);

export function isDependencyBotAuthor(
  login: string | null | undefined,
  typename?: AuthorTypename | null,
): boolean {
  if (!login) return false;
  const l = login.trim().toLowerCase();
  // GitHub has returned dependency accounts as both Bot and User actors over
  // time. The reserved login is the stable identity; typename is not.
  return DEPENDENCY_BOT_LOGINS.has(l);
}

export function isBotLogin(login: string | null | undefined): boolean {
  if (!login) return false;
  const l = login.trim().toLowerCase();
  return l.endsWith('[bot]') || KNOWN_BOT_LOGINS.has(l);
}

export type ActorIdentityKind = 'human' | 'non_human' | 'unknown';

export function getActorIdentityKind(
  typename: AuthorTypename | null | undefined,
  login: string | null | undefined,
): ActorIdentityKind {
  if (isDependencyBotAuthor(login, typename)) {
    return 'non_human';
  }
  if (isBotLogin(login)) {
    return 'non_human';
  }
  if (typeof login === 'string' && login.trim().toLowerCase().endsWith('[bot]')) {
    return 'non_human';
  }
  if (typename === 'User' || typename === 'EnterpriseUserAccount') {
    return 'human';
  }
  if (typename === 'Bot' || typename === 'Organization' || typename === 'Mannequin') {
    return 'non_human';
  }
  if ((typename === null || typename === undefined) && isBotLogin(login)) {
    return 'non_human';
  }
  return 'unknown';
}

export function isHumanActor(
  typename: AuthorTypename | null | undefined,
  login?: string | null,
): boolean {
  if (isDependencyBotAuthor(login, typename)) return false;
  if (isBotLogin(login)) return false;
  if (typeof login === 'string' && login.trim().toLowerCase().endsWith('[bot]')) return false;
  if (typename === 'User' || typename === 'EnterpriseUserAccount') {
    return true;
  }
  if (typename === 'Bot' || typename === 'Organization' || typename === 'Mannequin') {
    return false;
  }
  return false;
}

export function isNonHumanActor(
  typename: AuthorTypename | null | undefined,
  login?: string | null,
): boolean {
  return getActorIdentityKind(typename, login) === 'non_human';
}

export function isBotActor(
  typename: AuthorTypename | null | undefined,
  login: string | null | undefined,
): boolean {
  if (!login) return false;
  return typename === 'Bot' || isBotLogin(login);
}

export function isHumanApprover(
  review: { author: string | null; authorTypename?: AuthorTypename | null },
  authorLogin: string | null | undefined,
): boolean {
  if (!review.author || !authorLogin || sameLogin(review.author, authorLogin)) {
    return false;
  }
  return getActorIdentityKind(review.authorTypename, review.author) === 'human';
}

export function isBotAuthor(pr: PullRequest): boolean {
  if (!pr.author) return false;
  return isBotActor(pr.author.typename, pr.author.login);
}
