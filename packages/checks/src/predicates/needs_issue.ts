// The predicates of the linked-issue policy: a pull request from an outside
// contributor links an open `help wanted` issue of the organization. The
// rules that combine them into `needs_issue` are in policy.ts.

import { canWriteToRepositoryOf, collaboratorsOfRepository } from '../collaborators.js';
import { isDependencyBotLogin, sameLogin } from '../logins.js';
import type { BaseFactValue } from '../rules/model.js';
import type { LinkedIssue, PredicateContext, PullRequest } from '../types.js';

const APPROVED_ISSUE_LABEL = 'help wanted';
const NO_ISSUE_NEEDED_LABEL = 'no-issue-needed';
const LINKED_ISSUE_POLICY_URL =
  'https://github.com/jaegertracing/jaeger/blob/main/CONTRIBUTING_GUIDELINES.md#link-each-pull-request-to-an-issue';

// The owner of the PR's repository comes from the config, in the spelling of
// whoever wrote it, so it is compared as a login.
function isApproved(issue: LinkedIssue, pr: PullRequest): boolean {
  return (
    sameLogin(issue.owner, pr.repo.owner) &&
    issue.state === 'OPEN' &&
    issue.labels.includes(APPROVED_ISSUE_LABEL)
  );
}

// What the comment tells the author about each linked issue that does not
// count, or that no issue is linked.
function whyNoIssueIsApproved(pr: PullRequest): string {
  const issues = pr.linkedIssues ?? [];
  if (issues.length === 0) return 'no issue is linked';
  return issues
    .map((issue) => {
      const isOfRepository =
        sameLogin(issue.owner, pr.repo.owner) && sameLogin(issue.repo, pr.repo.name);
      const name = isOfRepository
        ? `#${issue.number}`
        : `${issue.owner}/${issue.repo}#${issue.number}`;
      if (!sameLogin(issue.owner, pr.repo.owner)) return `${name} belongs to another organization`;
      if (issue.state !== 'OPEN') return `${name} is closed`;
      return `${name} is not labelled \`${APPROVED_ISSUE_LABEL}\``;
    })
    .join(', ');
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
    details: holds
      ? `This pull request must link an open issue that is labelled \`${APPROVED_ISSUE_LABEL}\`: ${whyNoIssueIsApproved(pr)}. See the [linked issue policy](${LINKED_ISSUE_POLICY_URL}).`
      : undefined,
  };
}

// Whether the pull request links an open issue of the organization. With
// `needs_issue`, it tells an issue that a maintainer has not approved from
// no issue at all.
export function linksOpenIssuePredicate(pr: PullRequest): boolean {
  return (pr.linkedIssues ?? []).some(
    (issue) => sameLogin(issue.owner, pr.repo.owner) && issue.state === 'OPEN',
  );
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
