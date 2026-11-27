// The difference between the plan of a pull request and its state: the
// changes that a run in write mode would make, in the order in which it
// would make them.

import { policyCommentsOf } from '../policy-comments.js';
import type { PolicyComment } from '../policy-comments.js';
import { labelPeriodStart, OWNED_LABELS } from '../rules/model.js';
import type { OwnedLabel } from '../rules/model.js';
import type { PullRequest } from '../types.js';
import { CLOSING_SENTENCE, RESOLVED_COMMENT_BODY } from './plan.js';
import type { Plan } from './plan.js';

export type Change =
  | { kind: 'add label'; label: OwnedLabel }
  | { kind: 'remove label'; label: OwnedLabel }
  | { kind: 'create comment'; body: string }
  | { kind: 'edit comment'; id: string; body: string }
  | { kind: 'minimize comment'; id: string }
  | { kind: 'close' };

// The labels that the comment explains. The labels of one group show one
// reason, so the author is told once for the group. `waiting-for-author`
// has no group, because the comment of the maintainer told the author.
const NOTICE_LABEL_GROUPS: readonly (readonly OwnedLabel[])[] = [
  ['missing-issue', 'unapproved-issue'],
  ['duplicate'],
  ['pr-quota-reached'],
  ['stale'],
];

// `pr-linked-issue` and `actions/stale` post their comment before they add
// their label: in jaeger and jaeger-ui the comment is up to one second older
// than the label that it explains. A policy comment therefore counts as the
// notice of a label that follows it within a minute. The allowance covers
// the comments of the reconciler too, because the reconciler edits the
// comment of a replaced action into its own without a new creation time.
const MILLISECONDS_NOTICE_MAY_PRECEDE_LABEL = 60 * 1000;

function sameBody(left: string, right: string): boolean {
  const normalized = (body: string): string => body.replaceAll('\r\n', '\n').trim();
  return normalized(left) === normalized(right);
}

// GitHub notifies the author of a new comment and not of an edited one. The
// author was therefore told about a label when a policy comment exists that
// was created after the pull request got the label. A label that this run
// adds has no such comment yet.
function wasToldAboutLabels(
  pr: PullRequest,
  plan: Plan,
  policyComments: readonly PolicyComment[],
): boolean {
  const groups = NOTICE_LABEL_GROUPS.filter((group) =>
    group.some((label) => plan.labels.includes(label)),
  );
  return groups.every((group) => {
    if (!group.some((label) => pr.labels.includes(label))) return false;
    const periodStart = labelPeriodStart(pr, group);
    // No event dates the label when the events were not gathered or when
    // more than 100 followed it. Any policy comment then counts as its
    // notice, or the pull request would get a new comment on every run.
    if (periodStart === undefined) return policyComments.length > 0;
    return policyComments.some(
      (comment) =>
        Date.parse(comment.createdAt) + MILLISECONDS_NOTICE_MAY_PRECEDE_LABEL >=
        Date.parse(periodStart),
    );
  });
}

function newestComment(comments: readonly PolicyComment[]): PolicyComment | undefined {
  return [...comments].sort(
    (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt),
  )[0];
}

function minimizeChangesExcept(
  commentToKeep: PolicyComment | undefined,
  comments: readonly PolicyComment[],
): Change[] {
  return comments
    .filter((comment) => comment.id !== commentToKeep?.id)
    .map((comment) => ({ kind: 'minimize comment', id: comment.id }));
}

// A new comment is the last entry of the thread and notifies the author. An
// edited comment does neither, and on a long thread GitHub may fold it away.
function newCommentInPlaceOf(body: string, visibleComments: readonly PolicyComment[]): Change[] {
  return [{ kind: 'create comment', body }, ...minimizeChangesExcept(undefined, visibleComments)];
}

function commentChanges(pr: PullRequest, plan: Plan): Change[] {
  const policyComments = policyCommentsOf(pr);
  // The comments that the bot posted are the record of what the author was
  // told, minimized or not. Only a visible one is edited or kept.
  const commentsOfBot = policyComments.filter((comment) => comment.isOfActionsBot);
  const visibleComments = commentsOfBot.filter((comment) => !comment.isMinimized);
  const newestCommentOfBot = newestComment(commentsOfBot);
  // A run that stopped after it posted its comment has posted the text
  // already, and the next run only minimizes the comments before it.
  const isPosted = (body: string): boolean =>
    newestCommentOfBot !== undefined && sameBody(newestCommentOfBot.body, body);
  if (plan.comment === null) {
    // The author is told that nothing blocks the pull request any more. A
    // pull request that has no comment of the reconciler was never told
    // otherwise by it, and the comment of a replaced action is left as it is.
    if (!commentsOfBot.some((comment) => comment.isOfReconciler)) return [];
    return isPosted(RESOLVED_COMMENT_BODY)
      ? minimizeChangesExcept(newestCommentOfBot, visibleComments)
      : newCommentInPlaceOf(RESOLVED_COMMENT_BODY, visibleComments);
  }
  if (plan.shouldClose) {
    // The reason has to stand next to the closing, at the end of the thread.
    // A run that stopped after the comment may have closed another pull
    // request before, and that closing can take a reason away from this
    // one. The comment that closes therefore counts as posted whatever
    // reasons it lists.
    const isClosingPosted =
      newestCommentOfBot?.isOfReconciler === true &&
      newestCommentOfBot.body.includes(CLOSING_SENTENCE);
    return isClosingPosted
      ? minimizeChangesExcept(newestCommentOfBot, visibleComments)
      : newCommentInPlaceOf(plan.comment, visibleComments);
  }
  if (!wasToldAboutLabels(pr, plan, policyComments)) {
    return newCommentInPlaceOf(plan.comment, visibleComments);
  }
  // The author knows every reason, so a change of the text is no news. A
  // comment that a maintainer posted or that a person minimized told the
  // author, and it stays the notice.
  const commentToKeep = newestComment(visibleComments);
  if (!commentToKeep) return [];
  return [
    ...(sameBody(commentToKeep.body, plan.comment)
      ? []
      : [{ kind: 'edit comment', id: commentToKeep.id, body: plan.comment } as const]),
    ...minimizeChangesExcept(commentToKeep, visibleComments),
  ];
}

// The order is the order in which a run in write mode applies the changes.
// Labels are added before others are removed, so a swap of the flag labels
// keeps the flagged period unbroken. The comment follows the labels, so it
// is newer than the label that it explains. Closing is last, after the
// comment says that the pull request is closed.
export function changesOf(pr: PullRequest, plan: Plan): Change[] {
  return [
    ...OWNED_LABELS.filter(
      (label) => plan.labels.includes(label) && !pr.labels.includes(label),
    ).map((label) => ({ kind: 'add label', label }) as const),
    ...OWNED_LABELS.filter(
      (label) => !plan.labels.includes(label) && pr.labels.includes(label),
    ).map((label) => ({ kind: 'remove label', label }) as const),
    ...commentChanges(pr, plan),
    ...(plan.shouldClose ? [{ kind: 'close' } as const] : []),
  ];
}
