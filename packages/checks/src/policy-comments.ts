// A "policy comment" is a comment by which the automation tells the author
// about a policy. A policy comment is not activity on the pull request,
// whoever posted it, so the rules have to tell it from a comment of a
// person. See "Time and history" in RFC 0003.

import type { PullRequest } from './types.js';

// The marker by which the reconciler finds its comment again.
export const LIFECYCLE_COMMENT_MARKER = '<!-- jaeger-pr-lifecycle -->';

// The hidden markers of the reconciler and of the pr-linked-issue and the
// pr-duplicates actions. A person does not write a hidden marker by
// accident, so a marker identifies a policy comment whoever posted it.
const POLICY_COMMENT_MARKERS = [
  LIFECYCLE_COMMENT_MARKER,
  '<!-- jaeger-pr-linked-issue -->',
  '<!-- jaeger-pr-per-issue-limit -->',
];

// The comments of the quota workflow and of `actions/stale` carry no
// marker. A phrase identifies one only in a comment of the bot of GitHub
// Actions, which also posts comments that tell the author about no policy.
const POLICY_PHRASES_OF_ACTIONS_BOT = [
  'This PR is currently **on hold**',
  'PR quota unlocked!',
  'has been automatically marked as stale',
];

// The login that GraphQL returns for `github-actions[bot]`, the account of
// the reconciler and of the actions that it replaces.
export const ACTIONS_BOT_LOGIN = 'github-actions';

export function isPolicyComment(body: string): boolean {
  return POLICY_COMMENT_MARKERS.some((marker) => body.includes(marker));
}

// A policy comment as the reconciler reads it, to decide whether the author
// was told and which comment to edit.
export interface PolicyComment {
  id: string;
  createdAt: string;
  body: string;
  isMinimized: boolean;
  // The reconciler can edit and minimize only a comment of its own account.
  isOfActionsBot: boolean;
  // Whether the comment carries the marker of the reconciler. Every other
  // policy comment is one of an action that the reconciler replaces.
  isOfReconciler: boolean;
}

// The policy comments of a pull request. A comment without a node ID, which
// is one of a snapshot file from before the ID was gathered, is left out,
// because the reconciler can neither edit nor minimize it.
export function policyCommentsOf(pr: PullRequest): PolicyComment[] {
  return pr.comments.flatMap((comment) => {
    const { body, id } = comment;
    if (body === undefined || id === undefined) return [];
    const isOfActionsBot = comment.authorIsBot === true && comment.author === ACTIONS_BOT_LOGIN;
    const hasPhrase =
      isOfActionsBot && POLICY_PHRASES_OF_ACTIONS_BOT.some((phrase) => body.includes(phrase));
    if (!isPolicyComment(body) && !hasPhrase) return [];
    return [
      {
        id,
        createdAt: comment.createdAt,
        body,
        isMinimized: comment.isMinimized === true,
        isOfActionsBot,
        // The reconciler posts as the bot of GitHub Actions, so its marker
        // in the comment of another account is a copy.
        isOfReconciler: isOfActionsBot && body.includes(LIFECYCLE_COMMENT_MARKER),
      },
    ];
  });
}
