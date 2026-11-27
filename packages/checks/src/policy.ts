// The policy of the checks: every base fact, every derived fact and every
// rule. The module of a check exports only its predicate, so this file is
// the one place that says which facts of the checks hide a PR from the
// triage report and which the weekly digest lists.
//
// The order of the rules of an output is visible in the reports. The triage
// report gives the reasons for hiding, the weekly digest prints its lines,
// and a decision table lists its base facts, in the order of those rules.

import { loadRuleSet } from './rules/evaluate.js';
import { Policy } from './rules/model.js';
import type { BaseFact } from './rules/model.js';
import { assertRuleSetIsValid } from './rules/startup-check.js';
import { appliesFactName, CHECK_IDS } from './types.js';
import type { CheckId } from './types.js';
import { ciFailingPredicate, labelOnlyFailurePredicate } from './predicates/ci_failing.js';
import { dcoMissingPredicate } from './predicates/dco_missing.js';
import { descriptionEmptyPredicate } from './predicates/description_empty.js';
import { mergeConflictPredicate } from './predicates/merge_conflict.js';
import {
  authorCanWritePredicate,
  authorIsDependencyBotPredicate,
  collaboratorsNotGatheredPredicate,
  noApprovedIssuePredicate,
  noIssueNeededPredicate,
} from './predicates/needs_issue.js';
import {
  linkedIssueExemptPredicate,
  missingIssueLabelPredicate,
  noLinkedIssuePredicate,
} from './predicates/no_linked_issue.js';
import { noTestsForCodeChangePredicate } from './predicates/no_tests_for_code_change.js';
import { isDuplicatePredicate } from './predicates/is_duplicate.js';
import { overQuotaPredicate } from './predicates/over_quota.js';
import { resolvedWithoutReplyPredicate } from './predicates/resolved_without_reply.js';
import { staleOnAuthorPredicate } from './predicates/stale_on_author.js';
import { unresolvedFromReviewerPredicate } from './predicates/unresolved_from_reviewer.js';

const policy = new Policy();

// Base facts.

export const dcoMissing = policy.baseFact('dco_missing', dcoMissingPredicate, {
  changedBy: 'author',
});
const ciFailing = policy.baseFact('ci_failing', ciFailingPredicate, { changedBy: 'author' });
// The triage report flags a PR for which `label_only_failure` holds as
// NEEDS-LABEL.
export const labelOnlyFailure = policy.baseFact('label_only_failure', labelOnlyFailurePredicate, {
  changedBy: 'maintainer',
});
export const mergeConflict = policy.baseFact('merge_conflict', mergeConflictPredicate, {
  changedBy: 'author',
});
export const staleOnAuthor = policy.baseFact('stale_on_author', staleOnAuthorPredicate, {
  changedBy: 'author',
});
const overQuota = policy.baseFact('over_quota', overQuotaPredicate, {
  changedBy: 'author',
});
const isDuplicate = policy.baseFact('is_duplicate', isDuplicatePredicate, {
  changedBy: 'author',
});
const descriptionEmpty = policy.baseFact('description_empty', descriptionEmptyPredicate, {
  changedBy: 'author',
});
// The digest and the check run of `pr-nudge` read `no_linked_issue`, which
// looks for a closing keyword in the PR description. The triage report
// reads `needs_issue`, which looks at the issues that GitHub links.
const noLinkedIssue = policy.baseFact('no_linked_issue', noLinkedIssuePredicate, {
  changedBy: 'author',
});
const noApprovedIssue = policy.baseFact('no_approved_issue', noApprovedIssuePredicate, {
  changedBy: 'author',
});
const noIssueNeeded = policy.baseFact('no_issue_needed', noIssueNeededPredicate, {
  changedBy: 'maintainer',
});
const authorCanWrite = policy.baseFact('author_can_write', authorCanWritePredicate, {
  changedBy: 'maintainer',
});
const authorIsDependencyBot = policy.baseFact(
  'author_is_dependency_bot',
  authorIsDependencyBotPredicate,
  { changedBy: 'maintainer' },
);
const collaboratorsNotGathered = policy.baseFact(
  'collaborators_not_gathered',
  collaboratorsNotGatheredPredicate,
  { changedBy: 'maintainer' },
);
const missingIssueLabel = policy.baseFact('missing_issue_label', missingIssueLabelPredicate, {
  changedBy: 'author',
});
const linkedIssueExempt = policy.baseFact('linked_issue_exempt', linkedIssueExemptPredicate, {
  changedBy: 'maintainer',
});
// A veto needs a reason to cancel. This fact holds for every PR, so that a
// derived fact whose rules are all exemptions has a reason.
const isPullRequest = policy.baseFact('is_pull_request', () => true, { changedBy: 'maintainer' });
export const noTestsForCodeChange = policy.baseFact(
  'no_tests_for_code_change',
  noTestsForCodeChangePredicate,
  { changedBy: 'author' },
);
export const unresolvedFromReviewer = policy.baseFact(
  'unresolved_from_reviewer',
  unresolvedFromReviewerPredicate,
  { changedBy: 'author' },
);
// No rule reads this fact. The triage report shows it as a row flag, so that
// a maintainer can decide whether to reopen the thread.
export const resolvedWithoutReply = policy.baseFact(
  'resolved_without_reply',
  resolvedWithoutReplyPredicate,
  { changedBy: 'author' },
);

// Derived facts.

// A maintainer can apply the missing label, so a failure of the label gates
// alone leaves the PR reviewable. Any other CI failure waits for the author.
const ciFailingWithoutLabelOnlyFailure = policy
  .derivedFact('ci_failing_without_label_only_failure')
  .when(ciFailing)
  .unless(labelOnlyFailure);

// A pull request from an outside contributor is not reviewed until it links
// an open `help wanted` issue of the organization. A maintainer exempts one
// pull request with the `no-issue-needed` label.
export const needsIssue = policy
  .derivedFact('needs_issue')
  .when(noApprovedIssue)
  .unless(noIssueNeeded)
  .unless(authorCanWrite)
  .unless(authorIsDependencyBot)
  .unless(collaboratorsNotGathered);

// The `missing-issue` label already tells the author what to fix, so a
// digest line would repeat it.
const noLinkedIssueWithoutMissingIssueLabel = policy
  .derivedFact('no_linked_issue_without_missing_issue_label')
  .when(noLinkedIssue)
  .unless(missingIssueLabel);

// The check run of `no_linked_issue` is published for a PR only when this
// fact holds. A check run would repeat the `missing-issue` label, and an
// exempt PR needs no issue.
policy
  .derivedFact(appliesFactName('no_linked_issue'))
  .when(isPullRequest)
  .unless(missingIssueLabel)
  .unless(linkedIssueExempt);

// The triage report hides a PR that a maintainer cannot act on until the
// author does something.
policy.triageHidden
  .when(dcoMissing)
  .when(ciFailingWithoutLabelOnlyFailure)
  // RFC 0001 lists `merge_conflict` as not hidden. It is hidden because a
  // maintainer can do nothing until the author rebases.
  .when(mergeConflict)
  .when(staleOnAuthor)
  .when(overQuota)
  .when(descriptionEmpty)
  .when(needsIssue)
  // Only the primary pull request of an issue is reviewed.
  .when(isDuplicate)
  .when(unresolvedFromReviewer);

// The weekly digest lists what the author has to fix. `actions/stale` owns
// the reminder for a stale PR, and the quota workflow posts its own comment,
// so the digest has no line for either.
policy.weeklyDigest
  .when(dcoMissing)
  .when(ciFailingWithoutLabelOnlyFailure)
  .when(mergeConflict)
  .when(descriptionEmpty)
  .when(noLinkedIssueWithoutMissingIssueLabel)
  .when(noTestsForCodeChange)
  .when(unresolvedFromReviewer);

// The policy is not exported, so no other module can declare a fact or a
// rule that this rule set does not contain. A rule set with a violation
// stops every consumer when it loads, before the consumer queries GitHub.
export const ruleSet = loadRuleSet(policy);
assertRuleSetIsValid(ruleSet);

// The base fact of a check has the ID of the check as its name.
export function baseFactsByCheckId(baseFacts: readonly BaseFact[]): Record<CheckId, BaseFact> {
  const baseFactOfCheck = (id: CheckId): BaseFact => {
    const baseFact = baseFacts.find(({ name }) => name === id);
    if (!baseFact) throw new Error(`the check ${id} has no base fact`);
    return baseFact;
  };
  return Object.fromEntries(CHECK_IDS.map((id) => [id, baseFactOfCheck(id)])) as Record<
    CheckId,
    BaseFact
  >;
}

// The base fact of each check, for code that handles every check in a loop.
// Code that reads one check passes the constant of its fact to
// `verdict.holds()`. A check ID without a base fact throws here when the
// package loads, which stops every consumer.
export const CHECK_FACTS = baseFactsByCheckId(ruleSet.baseFacts);
