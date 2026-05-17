// Comment publisher: the one place that decides whether to POST, PATCH,
// or SKIP. Every action subfolder (pr-nudge slash-acks, pr-quota
// blocked/unblocked, pr-weekly-digest weekly) calls this with an intent
// and gets back a decision.
//
// Decision tree:
//
//   sha       = bodyHash(intent.body)
//   fullBody  = intent.body + "\n\n" + footer({kind, scope, sha})
//   priors    = bot comments on this PR whose footer parses cleanly AND
//               whose (kind, scope) match the intent
//   prior     = most recent of priors
//
//   if !prior            -> POST(fullBody)
//   if prior.sha == sha  -> SKIP                  (rendered text unchanged)
//   else                 -> PATCH(prior.id, fullBody)
//
// `scope` is the publisher's only stateful knob. Set it to an ISO week
// string for week-keyed digests, to a stable cycle id for one-shot acks
// that can recur across cycles, or leave undefined for "one comment of
// this kind, ever".
//
// `dryRun: true` flips the final POST/PATCH into a log entry; the read
// and decision steps are identical, which is what makes the dry-run
// output an accurate prediction of what real writes would do.

import { bodyHash, type CommentKind, formatFooter, parseFooter } from './footer.js';

export interface PublishIntent {
  owner: string;
  repo: string;
  // Pull request number (issue-comments API uses issue numbers; PR
  // numbers are the same namespace).
  issueNumber: number;
  kind: CommentKind;
  // Pre-rendered comment body, WITHOUT the footer. The publisher
  // appends the footer.
  body: string;
  // Optional scope (e.g. `week=2026-W20`). Comments with the same
  // (kind, scope) tuple are considered the same logical comment for
  // edit-in-place; comments with different scope are independent.
  scope?: string;
  dryRun?: boolean;
}

export type PublishAction = 'post' | 'patch' | 'skip';

export interface PublishResult {
  action: PublishAction;
  dryRun: boolean;
  commentId?: number;
  url?: string;
  reason: 'no-prior' | 'sha-differs' | 'sha-match';
  fullBody: string;
}

// Decoupled from Octokit so the decision logic is easy to unit-test with
// an in-memory mock and so a future migration off octokit (or to a GitHub
// App token) is a one-file change.
export interface CommentClient {
  listComments(
    owner: string,
    repo: string,
    issueNumber: number,
  ): Promise<Array<{ id: number; body: string; createdAt: string; author: string | null }>>;
  createComment(
    owner: string,
    repo: string,
    issueNumber: number,
    body: string,
  ): Promise<{ id: number; url: string }>;
  updateComment(
    owner: string,
    repo: string,
    commentId: number,
    body: string,
  ): Promise<{ id: number; url: string }>;
}

export async function publishComment(
  intent: PublishIntent,
  client: CommentClient,
): Promise<PublishResult> {
  const sha = bodyHash(intent.body);
  const footer = formatFooter({ kind: intent.kind, scope: intent.scope, sha });
  const fullBody = `${intent.body}\n\n${footer}`;
  const dryRun = intent.dryRun ?? false;

  const comments = await client.listComments(intent.owner, intent.repo, intent.issueNumber);
  // Bot identity isn't trusted as a filter — we identify our own comments
  // by their footer. That works even when multiple bot accounts post via
  // github-actions[bot], or when GHAS rotates the run account, etc.
  const parsed = comments
    .map((c) => ({ comment: c, meta: parseFooter(c.body) }))
    .filter(
      (x): x is { comment: (typeof comments)[number]; meta: NonNullable<typeof x.meta> } =>
        x.meta !== null,
    );

  const sameKindAndScope = parsed
    .filter((x) => x.meta.kind === intent.kind && (x.meta.scope ?? null) === (intent.scope ?? null))
    .sort((a, b) => Date.parse(b.comment.createdAt) - Date.parse(a.comment.createdAt));
  const prior = sameKindAndScope[0];

  if (!prior) {
    if (dryRun) return { action: 'post', dryRun, reason: 'no-prior', fullBody };
    const r = await client.createComment(intent.owner, intent.repo, intent.issueNumber, fullBody);
    return { action: 'post', dryRun, commentId: r.id, url: r.url, reason: 'no-prior', fullBody };
  }

  if (prior.meta.sha === sha) {
    return {
      action: 'skip',
      dryRun,
      commentId: prior.comment.id,
      reason: 'sha-match',
      fullBody,
    };
  }

  if (dryRun) {
    return {
      action: 'patch',
      dryRun,
      commentId: prior.comment.id,
      reason: 'sha-differs',
      fullBody,
    };
  }
  const r = await client.updateComment(intent.owner, intent.repo, prior.comment.id, fullBody);
  return {
    action: 'patch',
    dryRun,
    commentId: r.id,
    url: r.url,
    reason: 'sha-differs',
    fullBody,
  };
}
