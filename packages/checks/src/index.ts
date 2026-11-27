// Main entry. Predicates + GraphQL only — cache is a sub-path import
// (`@jaegertracing/maintainer-tools-checks/cache`) so action bundles built
// with @vercel/ncc do not statically pull in the native SQLite module.
export { CHECK_IDS } from './types.js';
export type {
  CheckId,
  CheckConclusion,
  CheckResult,
  FileChange,
  IssueMeta,
  IssueRef,
  PredicateOptions,
  PullRequest,
  ResolvedPredicateOptions,
} from './types.js';
export {
  classifyPath,
  computeComposition,
  FILE_CLASSES,
  type ClassTotals,
  type Composition,
  type FileClass,
} from './composition.js';
export { extractIssueRefs, hasIssueRef, issueUrl, parseRefKey, refKey } from './issue-refs.js';
export { runAll } from './predicates/index.js';
export { createGraphqlClient } from './graphql.js';
export type { GraphqlClient, PrSummary } from './graphql.js';
