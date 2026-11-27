import { sameLogin } from './logins.js';
import type { PredicateContext, PullRequest, RepositoryPermission } from './types.js';

const WRITE_PERMISSIONS: ReadonlySet<RepositoryPermission> = new Set([
  'ADMIN',
  'MAINTAIN',
  'WRITE',
]);

// Returns undefined when the run did not gather the collaborators of the
// repository of the pull request.
export function collaboratorsOfRepository(
  pr: PullRequest,
  { openPullRequests }: PredicateContext,
): Record<string, RepositoryPermission> | undefined {
  return openPullRequests?.collaborators?.[`${pr.repo.owner}/${pr.repo.name}`];
}

export function canWriteToRepositoryOf(
  pr: PullRequest,
  login: string,
  context: PredicateContext,
): boolean {
  return Object.entries(collaboratorsOfRepository(pr, context) ?? {}).some(
    ([collaborator, permission]) =>
      sameLogin(collaborator, login) && WRITE_PERMISSIONS.has(permission),
  );
}
