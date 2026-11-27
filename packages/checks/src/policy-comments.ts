// A "policy comment" is a comment by which the automation tells the author
// about a policy. A policy comment is not activity on the pull request,
// whoever posted it, so the rules have to tell it from a comment of a
// person. See "Time and history" in RFC 0003.

// The hidden markers of the pr-linked-issue and the pr-duplicates actions. A
// person does not write a hidden marker by accident, so a marker identifies
// a policy comment whoever posted it. The other policy comments carry no
// marker and need none here: the bot of GitHub Actions posts them, and a
// comment of that bot is the activity of nobody.
const POLICY_COMMENT_MARKERS = [
  '<!-- jaeger-pr-linked-issue -->',
  '<!-- jaeger-pr-per-issue-limit -->',
];

export function isPolicyComment(body: string): boolean {
  return POLICY_COMMENT_MARKERS.some((marker) => body.includes(marker));
}
