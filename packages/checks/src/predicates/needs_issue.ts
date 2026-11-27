// The predicates of the linked-issue policy: a pull request from an outside
// contributor links an open `help wanted` issue of the organization. The
// rules that combine them into `needs_issue` are in policy.ts.

import { canWriteToRepositoryOf, collaboratorsOfRepository } from '../collaborators.js';
import { isDependencyBotLogin, sameLogin } from '../logins.js';
import type { BaseFactValue } from '../rules/model.js';
import type { LinkedIssue, PredicateContext, PullRequest } from '../types.js';

const APPROVED_ISSUE_LABEL = 'help wanted';
const NO_ISSUE_NEEDED_LABEL = 'no-issue-needed';

// The owner of the PR's repository comes from the config, in the spelling of
// whoever wrote it, so it is compared as a login.
function isApproved(issue: LinkedIssue, pr: PullRequest): boolean {
  return (
    sameLogin(issue.owner, pr.repo.owner) &&
    issue.state === 'OPEN' &&
    issue.labels.includes(APPROVED_ISSUE_LABEL)
  );
}

// The fact does not hold for a PR whose linked issues were not gathered,
// which is a PR of a snapshot file from before the field existed.
export function noApprovedIssuePredicate(pr: PullRequest): BaseFactValue {
  const { linkedIssues } = pr;
  const holds = linkedIssues !== undefined && !linkedIssues.some((issue) => isApproved(issue, pr));
  return {
    holds,
    summary: holds
      ? 'PR links no open `help wanted` issue'
      : 'PR links an open `help wanted` issue, or its linked issues were not gathered',
  };
}

export function noIssueNeededPredicate(pr: PullRequest): boolean {
  return pr.labels.includes(NO_ISSUE_NEEDED_LABEL);
}

export function authorCanWritePredicate(pr: PullRequest, context: PredicateContext): boolean {
  if (!pr.author) return false;
  return canWriteToRepositoryOf(pr, pr.author.login, context);
}

// Without the collaborators, a maintainer cannot be told from an outside
// contributor, and `needs_issue` would hold for the PRs of every maintainer.
export function collaboratorsNotGatheredPredicate(
  pr: PullRequest,
  context: PredicateContext,
): boolean {
  return collaboratorsOfRepository(pr, context) === undefined;
}

export function authorIsDependencyBotPredicate(pr: PullRequest): boolean {
  if (!pr.author) return false;
  return isDependencyBotLogin(pr.author.login);
}
