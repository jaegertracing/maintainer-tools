// Footer-based comment identification.
//
// Every bot comment carries a trailing HTML-comment footer:
//
//   <!-- maintainer-tools: kind=weekly_digest week=2026-W20 sha=abc... -->
//
// This is the *only* persistence layer the publisher needs. Each PR's
// comment thread on GitHub is the database; the footer is its schema.
// `kind` distinguishes one comment type from another, `sha` is a stable
// short hash of the body (without footer) so re-renders that produce
// identical text can be skipped, and any other tokens (e.g. `week=YYYY-Www`)
// form the "scope" key — comments are considered candidates for in-place
// edit iff they share both `kind` and full scope with the new intent.
//
// The footer is parsed by tokenizing on whitespace and splitting `k=v` —
// no JSON, no fragile multi-line formatting. The last footer in the body
// wins, in case the message text itself ever contains the marker prefix.

import { createHash } from 'node:crypto';

export type CommentKind = 'weekly_digest' | 'quota_blocked' | 'quota_unblocked' | 'slash_ack';

const KNOWN_KINDS: ReadonlySet<CommentKind> = new Set<CommentKind>([
  'weekly_digest',
  'quota_blocked',
  'quota_unblocked',
  'slash_ack',
]);

export interface FooterMeta {
  kind: CommentKind;
  // Optional free-form scope tokens, formatted `key=value` and joined by
  // single spaces, e.g. `week=2026-W20`. Two comments share scope iff
  // their parsed scope strings are equal.
  scope?: string;
  // Short SHA-256 prefix (16 hex chars) of the body BEFORE the footer is
  // appended. Used to skip no-op edits.
  sha: string;
}

const FOOTER_PREFIX = '<!-- maintainer-tools:';
const FOOTER_SUFFIX = '-->';

export function formatFooter(meta: FooterMeta): string {
  const parts = [`kind=${meta.kind}`];
  if (meta.scope) parts.push(meta.scope);
  parts.push(`sha=${meta.sha}`);
  return `${FOOTER_PREFIX} ${parts.join(' ')} ${FOOTER_SUFFIX}`;
}

export function parseFooter(body: string): FooterMeta | null {
  const start = body.lastIndexOf(FOOTER_PREFIX);
  if (start === -1) return null;
  const end = body.indexOf(FOOTER_SUFFIX, start);
  if (end === -1) return null;

  const inner = body.slice(start + FOOTER_PREFIX.length, end).trim();
  const tokens = new Map<string, string>();
  for (const tok of inner.split(/\s+/)) {
    const eq = tok.indexOf('=');
    if (eq === -1) continue;
    tokens.set(tok.slice(0, eq), tok.slice(eq + 1));
  }

  const kindRaw = tokens.get('kind');
  const sha = tokens.get('sha');
  if (!kindRaw || !sha || !KNOWN_KINDS.has(kindRaw as CommentKind)) return null;

  // Everything except kind/sha forms the scope, in original token order.
  const scopeTokens: string[] = [];
  for (const tok of inner.split(/\s+/)) {
    if (tok.startsWith('kind=') || tok.startsWith('sha=')) continue;
    if (tok.includes('=')) scopeTokens.push(tok);
  }
  const scope = scopeTokens.length > 0 ? scopeTokens.join(' ') : undefined;

  return { kind: kindRaw as CommentKind, scope, sha };
}

// Short hash of body text (without footer). 16 hex chars is plenty for
// detecting identity — collisions are astronomically rare and the worst
// case is a missed edit, not a wrong write.
export function bodyHash(body: string): string {
  return createHash('sha256').update(body).digest('hex').slice(0, 16);
}
