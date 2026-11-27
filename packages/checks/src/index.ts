// Main entry. Predicates + GraphQL only — cache is a sub-path import
// (`@jaegertracing/maintainer-tools-checks/cache`) so action bundles built
// with @vercel/ncc do not statically pull in the native SQLite module.
export { CHECK_IDS, DEFAULT_POLICY_AGES, parsePolicyAges } from './types.js';
export type {
  CheckId,
  FileChange,
  IssueRef,
  LinkedIssue,
  OpenPullRequests,
  RepositoryPermission,
  PullRequest,
  PolicyAges,
  PredicateContext,
} from './types.js';
export { hasLogin, isDependencyBotLogin, sameLogin } from './logins.js';
export { authorQuotas, quotaCandidates } from './quota.js';
export type { QuotaCandidate } from './quota.js';
export {
  classifyPath,
  computeComposition,
  FILE_CLASSES,
  type ClassTotals,
  type Composition,
  type FileClass,
} from './composition.js';
export { hasIssueRef, issueUrl, refKey } from './issue-refs.js';
export { commitsOfAuthor } from './predicates/authors_turn.js';
export { pullRequestsOfSameIssue } from './predicates/is_duplicate.js';
export {
  authorsTurn,
  CHECK_FACTS,
  dcoMissing,
  labelOnlyFailure,
  mergeConflict,
  needsIssue,
  noTestsForCodeChange,
  resolvedWithoutReply,
  ruleSet,
  staleOnAuthor,
  unresolvedFromReviewer,
} from './policy.js';
export { supportingFacts } from './rules/evaluate.js';
export type { Verdict } from './rules/evaluate.js';
export { OutputName, OWNED_LABELS } from './rules/model.js';
export type { OwnedLabel } from './rules/model.js';
export { policyCommentsOf } from './policy-comments.js';
export { lastActivityByPersonAt } from './predicates/idle.js';
export { reconcile } from './reconciler/reconcile.js';
export type { Reconciliation } from './reconciler/reconcile.js';
export type { Change } from './reconciler/difference.js';
export type { Plan } from './reconciler/plan.js';
export { createGraphqlClient } from './graphql.js';
export type { GraphqlClient, PrSummary } from './graphql.js';
