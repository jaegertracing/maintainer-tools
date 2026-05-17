// Token resolution: $GH_TOKEN > $GITHUB_TOKEN > `gh auth token`. The last
// fallback shells out so a maintainer with `gh auth login` set up gets the
// CLI to work without any extra configuration.

import { execSync } from 'node:child_process';

export function resolveToken(): string {
  const fromEnv = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    const token = execSync('gh auth token', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (token) return token;
  } catch {
    // gh not installed or not authenticated; fall through to error.
  }
  throw new Error(
    'No GitHub token found. Set GH_TOKEN or GITHUB_TOKEN, or run `gh auth login` first.',
  );
}
