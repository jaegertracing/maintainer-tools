// SQLite cache keyed by (owner, repo, number, updated_at). Only PRs whose
// `updated_at` advanced since the last fetch are re-queried; everything else
// is served from cache. Keeps steady-state cost near zero for the triage
// scanner and avoids API-quota blowups on large repos.

import Database from 'better-sqlite3';
import type { PullRequest } from './types.js';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS pr_cache (
    owner       TEXT NOT NULL,
    repo        TEXT NOT NULL,
    number      INTEGER NOT NULL,
    updated_at  TEXT NOT NULL,
    payload     TEXT NOT NULL,
    fetched_at  TEXT NOT NULL,
    PRIMARY KEY (owner, repo, number)
  );
`;

export interface PrCache {
  get(owner: string, repo: string, number: number): PullRequest | null;
  put(pr: PullRequest): void;
  close(): void;
}

export function openCache(path: string): PrCache {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);

  const getStmt = db.prepare<[string, string, number]>(
    'SELECT payload FROM pr_cache WHERE owner = ? AND repo = ? AND number = ?',
  );
  const putStmt = db.prepare<[string, string, number, string, string, string]>(
    `INSERT INTO pr_cache (owner, repo, number, updated_at, payload, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(owner, repo, number) DO UPDATE SET
       updated_at = excluded.updated_at,
       payload    = excluded.payload,
       fetched_at = excluded.fetched_at`,
  );

  return {
    get(owner, repo, number) {
      const row = getStmt.get(owner, repo, number) as { payload: string } | undefined;
      return row ? (JSON.parse(row.payload) as PullRequest) : null;
    },
    put(pr) {
      putStmt.run(
        pr.repo.owner,
        pr.repo.name,
        pr.number,
        pr.updatedAt,
        JSON.stringify(pr),
        new Date().toISOString(),
      );
    },
    close() {
      db.close();
    },
  };
}

// Convenience: cached fetch. Caller passes in a fresh `updatedAt` (typically
// from the event payload) so we can decide whether to re-fetch without first
// burning a GraphQL request.
export async function getCachedOrFetch(
  cache: PrCache,
  owner: string,
  repo: string,
  number: number,
  freshUpdatedAt: string | null,
  fetcher: () => Promise<PullRequest>,
): Promise<PullRequest> {
  const cached = cache.get(owner, repo, number);
  if (cached && freshUpdatedAt && cached.updatedAt === freshUpdatedAt) {
    return cached;
  }
  const fresh = await fetcher();
  cache.put(fresh);
  return fresh;
}
