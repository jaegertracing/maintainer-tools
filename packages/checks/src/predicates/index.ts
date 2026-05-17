export { dcoMissing } from './dco_missing.js';
export { ciFailing } from './ci_failing.js';
export { mergeConflict } from './merge_conflict.js';
export { staleOnAuthor } from './stale_on_author.js';

import type { CheckId, CheckResult, PullRequest } from '../types.js';
import { dcoMissing } from './dco_missing.js';
import { ciFailing } from './ci_failing.js';
import { mergeConflict } from './merge_conflict.js';
import { staleOnAuthor } from './stale_on_author.js';

export const P0_PREDICATES: Record<CheckId, (pr: PullRequest) => CheckResult> = {
  dco_missing: dcoMissing,
  ci_failing: ciFailing,
  merge_conflict: mergeConflict,
  stale_on_author: staleOnAuthor,
};

export function runAll(pr: PullRequest, ids?: readonly CheckId[]): CheckResult[] {
  const selected = ids ?? (Object.keys(P0_PREDICATES) as CheckId[]);
  return selected.map((id) => P0_PREDICATES[id](pr));
}
