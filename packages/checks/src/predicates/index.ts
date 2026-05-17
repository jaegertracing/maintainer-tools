export { dcoMissing } from './dco_missing.js';
export { ciFailing } from './ci_failing.js';
export { mergeConflict } from './merge_conflict.js';
export { staleOnAuthor } from './stale_on_author.js';
export { quotaExceeded } from './quota_exceeded.js';
export { descriptionEmpty } from './description_empty.js';
export { noLinkedIssue } from './no_linked_issue.js';
export { noTestsForCodeChange } from './no_tests_for_code_change.js';
export { unresolvedFromReviewer } from './unresolved_from_reviewer.js';
export { resolvedWithoutReply } from './resolved_without_reply.js';

import type { CheckId, CheckResult, PullRequest } from '../types.js';
import { dcoMissing } from './dco_missing.js';
import { ciFailing } from './ci_failing.js';
import { mergeConflict } from './merge_conflict.js';
import { staleOnAuthor } from './stale_on_author.js';
import { quotaExceeded } from './quota_exceeded.js';
import { descriptionEmpty } from './description_empty.js';
import { noLinkedIssue } from './no_linked_issue.js';
import { noTestsForCodeChange } from './no_tests_for_code_change.js';
import { unresolvedFromReviewer } from './unresolved_from_reviewer.js';
import { resolvedWithoutReply } from './resolved_without_reply.js';

// Renamed from P0_PREDICATES — the registry no longer reflects a single
// phase. All in-tree predicates live here; callers pass an explicit
// `ids` list if they want a subset (the pr-nudge action does this via
// its `rules` input).
export const ALL_PREDICATES: Record<CheckId, (pr: PullRequest) => CheckResult> = {
  dco_missing: dcoMissing,
  ci_failing: ciFailing,
  merge_conflict: mergeConflict,
  stale_on_author: staleOnAuthor,
  quota_exceeded: quotaExceeded,
  description_empty: descriptionEmpty,
  no_linked_issue: noLinkedIssue,
  no_tests_for_code_change: noTestsForCodeChange,
  unresolved_from_reviewer: unresolvedFromReviewer,
  resolved_without_reply: resolvedWithoutReply,
};

// Back-compat alias for existing imports.
export const P0_PREDICATES = ALL_PREDICATES;

export function runAll(pr: PullRequest, ids?: readonly CheckId[]): CheckResult[] {
  const selected = ids ?? (Object.keys(ALL_PREDICATES) as CheckId[]);
  return selected.map((id) => ALL_PREDICATES[id](pr));
}
