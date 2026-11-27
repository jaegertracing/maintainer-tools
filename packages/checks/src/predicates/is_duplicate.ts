// The predicate of the duplicates policy. For each issue, the oldest open
// pull request of the repository of the issue that closes it is the primary
// one, and every other open pull request of that repository that closes it
// is a duplicate.

import type { BaseFactValue } from '../rules/model.js';
import type { LinkedIssue, PredicateContext, PullRequest } from '../types.js';

// A maintainer puts this label on an issue that several pull requests may
// close, such as an issue for which the maintainer wants competing
// implementations.
const ALLOW_MULTIPLE_PRS_LABEL = 'allow-multiple-prs';

// GitHub compares the owner and the name of a repository without case.
function repositoryKey(owner: string, name: string): string {
  return `${owner}/${name}`.toLowerCase();
}

function repositoryKeyOf(pr: PullRequest): string {
  return repositoryKey(pr.repo.owner, pr.repo.name);
}

function issueKey(issue: LinkedIssue): string {
  return `${repositoryKey(issue.owner, issue.repo)}#${issue.number}`;
}

function isOlder(left: PullRequest, right: PullRequest): boolean {
  const leftCreatedAt = Date.parse(left.createdAt);
  const rightCreatedAt = Date.parse(right.createdAt);
  return (
    leftCreatedAt < rightCreatedAt ||
    (leftCreatedAt === rightCreatedAt && left.number < right.number)
  );
}

// The other open pull requests that share an issue with `pr` under the
// duplicates policy: those of its repository that close an issue of that
// repository that `pr` closes too, unless the issue allows several.
export function pullRequestsOfSameIssue(
  pr: PullRequest,
  pullRequests: readonly PullRequest[],
): PullRequest[] {
  const issueKeys = new Set(
    (pr.linkedIssues ?? [])
      .filter(
        (issue) =>
          repositoryKey(issue.owner, issue.repo) === repositoryKeyOf(pr) &&
          !issue.labels.includes(ALLOW_MULTIPLE_PRS_LABEL),
      )
      .map(issueKey),
  );
  if (issueKeys.size === 0) return [];
  return pullRequests.filter(
    (other) =>
      repositoryKeyOf(other) === repositoryKeyOf(pr) &&
      other.number !== pr.number &&
      (other.linkedIssues ?? []).some((issue) => issueKeys.has(issueKey(issue))),
  );
}

export function isDuplicatePredicate(
  pr: PullRequest,
  { openPullRequests }: PredicateContext,
): BaseFactValue {
  const olderPullRequests = pullRequestsOfSameIssue(
    pr,
    openPullRequests?.pullRequests ?? [],
  ).filter((other) => isOlder(other, pr));
  const holds = olderPullRequests.length > 0;
  return {
    holds,
    summary: holds
      ? `An older open PR closes the same issue (${olderPullRequests.map((other) => `#${other.number}`).join(', ')})`
      : 'No older open PR closes the same issue',
  };
}
