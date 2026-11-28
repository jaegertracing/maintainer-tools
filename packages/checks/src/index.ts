// Main entry. Predicates + GraphQL only — cache is a sub-path import
// (`@jaegertracing/maintainer-tools-checks/cache`) so action bundles built
// with @vercel/ncc do not statically pull in the native SQLite module.
export { CHECK_IDS, DEFAULT_POLICY_AGES, parsePolicyAges } from './types.js';
export type {
  CheckId,
  CheckConclusion,
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
export { checkRunConclusion } from './predicates/index.js';
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
export { OutputName } from './rules/model.js';
export { createGraphqlClient } from './graphql.js';
export type { GraphqlClient, PrSummary } from './graphql.js';
