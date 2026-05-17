// Token resolution: $GH_TOKEN > $GITHUB_TOKEN > `gh auth token`. The last
// fallback shells out so a maintainer with `gh auth login` set up gets the
// CLI to work without any extra configuration.

import { execSync } from 'node:child_process';

export type TokenSource = 'GH_TOKEN' | 'GITHUB_TOKEN' | 'gh auth token';

export interface ResolvedToken {
  token: string;
  source: TokenSource;
}

export function resolveToken(): ResolvedToken {
  if (process.env.GH_TOKEN) return { token: process.env.GH_TOKEN, source: 'GH_TOKEN' };
  if (process.env.GITHUB_TOKEN) {
    return { token: process.env.GITHUB_TOKEN, source: 'GITHUB_TOKEN' };
  }
  try {
    const token = execSync('gh auth token', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (token) return { token, source: 'gh auth token' };
  } catch {
    // gh not installed or not authenticated; fall through to error.
  }
  throw new Error(
    'No GitHub token found. Set GH_TOKEN or GITHUB_TOKEN, or run `gh auth login` first.',
  );
}
