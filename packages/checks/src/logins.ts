// The logins of the dependency bots. A PR that one of them opens is a
// reviewable merge, authored by a service account.
// GraphQL's `login` field omits the `[bot]` suffix even for an installed
// GitHub App — Renovate's own App reports as plain `renovate` — so the
// unbracketed forms are what a GraphQL consumer sees. `renovate-bot` is this
// org's self-hosted Renovate runner. The bracketed forms are kept too, as
// defense against any non-GraphQL-sourced PR data (fixtures, hand-written
// cache rows).
const DEPENDENCY_BOT_LOGINS = new Set<string>([
  'dependabot',
  'dependabot[bot]',
  'renovate',
  'renovate[bot]',
  'renovate-bot',
  'renovate-bot[bot]',
]);

export function isDependencyBotLogin(login: string): boolean {
  return DEPENDENCY_BOT_LOGINS.has(login.toLowerCase());
}

export function sameLogin(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export function hasLogin(logins: ReadonlySet<string>, login: string): boolean {
  for (const configured of logins) {
    if (sameLogin(configured, login)) return true;
  }
  return false;
}
