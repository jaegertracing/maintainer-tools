// Comment publisher: the one place that decides whether to POST, PATCH,
// or SKIP. Every action subfolder (pr-nudge slash-acks, pr-quota
// blocked/unblocked, pr-weekly-digest weekly) calls this with an intent
// and gets back a decision.
//
// Decision tree (per intent.kind+scope tuple, prior = most recent match):
//
//   prior?  same scope?  sha matches?   | action
//   ─────────────────────────────────────┼─────────────────────────────
//   no      —            —              | POST
//   yes     yes          yes            | SKIP
//   yes     yes          no             | PATCH (edit in place)
//   yes     no (older)   —              | POST a new one;
//                                       | if minimizeOlder + supported,
//                                       | mark the older one OUTDATED
//
// `scope` is the publisher's only stateful knob. Set it to an ISO week
// string for week-keyed digests, to a stable cycle id for one-shot acks
// that can recur across cycles, or leave undefined for "one comment of
// this kind, ever".
//
// `dryRun: true` flips the final POST / PATCH / MINIMIZE into a log
// entry; the read and decision steps are identical, which is what makes
// the dry-run output an accurate prediction of what real writes would do.

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
  // When true, after POSTing a new comment in a new scope, mark all
  // older same-kind comments (different scope) as OUTDATED via GitHub's
  // `minimizeComment` mutation. Only makes sense for kinds that roll
  // over (weekly_digest); one-shots leave it off. Requires the
  // CommentClient to implement `minimizeComment`; silently skipped if
  // it doesn't.
  minimizeOlder?: boolean;
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
  // Database IDs of comments we minimized as part of this call (only
  // populated when `minimizeOlder` + a same-kind older comment existed +
  // not dry-run). Empty array otherwise.
  minimized: number[];
}

// Decoupled from Octokit so the decision logic is easy to unit-test with
// an in-memory mock and so a future migration off octokit (or to a GitHub
// App token) is a one-file change.
export interface CommentClient {
  listComments(
    owner: string,
    repo: string,
    issueNumber: number,
  ): Promise<
    Array<{
      id: number;
      // Opaque GraphQL node id, used by `minimizeComment`. May be null
      // if the underlying transport doesn't expose it; minimize is a
      // no-op for such comments.
      nodeId: string | null;
      body: string;
      createdAt: string;
      author: string | null;
    }>
  >;
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
  // Optional — mark a comment as OUTDATED (GitHub renders it collapsed
  // with a "marked as outdated" label). If the client doesn't implement
  // it, publishComment silently skips minimization.
  minimizeComment?: (nodeId: string) => Promise<void>;
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

  const sameKind = parsed.filter((x) => x.meta.kind === intent.kind);
  const sameKindAndScope = sameKind
    .filter((x) => (x.meta.scope ?? null) === (intent.scope ?? null))
    .sort((a, b) => Date.parse(b.comment.createdAt) - Date.parse(a.comment.createdAt));
  const prior = sameKindAndScope[0];

  // Same-kind comments from OLDER scopes — candidates for minimization
  // when we're about to POST a fresh one.
  const olderSameKind = sameKind.filter((x) => (x.meta.scope ?? null) !== (intent.scope ?? null));

  if (!prior) {
    // No prior at this scope → POST. Also minimize older same-kind
    // comments if the intent opts in.
    if (dryRun) {
      return {
        action: 'post',
        dryRun,
        reason: 'no-prior',
        fullBody,
        minimized: intent.minimizeOlder ? olderSameKind.map((x) => x.comment.id) : [],
      };
    }
    const r = await client.createComment(intent.owner, intent.repo, intent.issueNumber, fullBody);
    const minimized: number[] = [];
    if (intent.minimizeOlder && client.minimizeComment) {
      // We re-minimize every older same-kind comment on every rollover.
      // This is N×(N-1)/2 calls over N rollovers for a stuck PR — could
      // be reduced by tracking minimized state, but the GitHub mutation
      // is idempotent (no-op + success on an already-minimized comment),
      // so the wasted calls are cheap and the logic stays simple.
      for (const old of olderSameKind) {
        if (!old.comment.nodeId) continue;
        await client.minimizeComment(old.comment.nodeId);
        minimized.push(old.comment.id);
      }
    }
    return {
      action: 'post',
      dryRun,
      commentId: r.id,
      url: r.url,
      reason: 'no-prior',
      fullBody,
      minimized,
    };
  }

  if (prior.meta.sha === sha) {
    return {
      action: 'skip',
      dryRun,
      commentId: prior.comment.id,
      reason: 'sha-match',
      fullBody,
      minimized: [],
    };
  }

  if (dryRun) {
    return {
      action: 'patch',
      dryRun,
      commentId: prior.comment.id,
      reason: 'sha-differs',
      fullBody,
      minimized: [],
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
    minimized: [],
  };
}
