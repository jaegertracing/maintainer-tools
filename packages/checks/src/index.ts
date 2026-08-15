// Main entry. Predicates + GraphQL only — cache is a sub-path import
// (`@jaegertracing/maintainer-tools-checks/cache`) so action bundles built
// with @vercel/ncc do not statically pull in the native SQLite module.
export type {
  CheckId,
  CheckConclusion,
  CheckResult,
  FileChange,
  IssueMeta,
  IssueRef,
  PullRequest,
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
export {
  P0_PREDICATES,
  runAll,
  dcoMissing,
  ciFailing,
  mergeConflict,
  staleOnAuthor,
} from './predicates/index.js';
export { createGraphqlClient } from './graphql.js';
export type { GraphqlClient, PrSummary } from './graphql.js';
