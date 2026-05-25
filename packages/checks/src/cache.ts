// SQLite cache keyed by (owner, repo, number, updated_at). Only PRs whose
// `updated_at` advanced since the last fetch are re-queried; everything else
// is served from cache. Keeps steady-state cost near zero for the triage
// scanner.
//
// Backed by Node's built-in `node:sqlite` (added in Node 22.5, stable in
// recent releases), so the cache has zero native-dep overhead — no gyp,
// no Xcode CLT, no platform-specific install scripts. The repo engines
// requirement is bumped to >= 22.5.0 in package.json.

import { DatabaseSync } from 'node:sqlite';
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

interface CacheRow {
  payload: string;
}

// Bump whenever the PullRequest shape gains, removes, or changes the
// meaning of a field that predicates read. Cached rows whose stored
// version doesn't match are treated as cache misses and re-fetched,
// which avoids stale-shape bugs (e.g. a PR cached before `commits[].parents`
// was added would return undefined for it, defeating the merge-commit
// exemption in `dco_missing` and causing a false positive).
//
// History:
//   1 — initial shape (P0 + P1)
//   2 — added commits[].parents for dco_missing merge exemption
//   3 — added headCheckRuns for label-only CI failure detection
const SCHEMA_VERSION = 3;

interface CachePayload {
  v: number;
  pr: PullRequest;
}

export function openCache(path: string): PrCache {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);

  const getStmt = db.prepare(
    'SELECT payload FROM pr_cache WHERE owner = ? AND repo = ? AND number = ?',
  );
  const putStmt = db.prepare(
    `INSERT INTO pr_cache (owner, repo, number, updated_at, payload, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(owner, repo, number) DO UPDATE SET
       updated_at = excluded.updated_at,
       payload    = excluded.payload,
       fetched_at = excluded.fetched_at`,
  );

  return {
    get(owner, repo, number) {
      const row = getStmt.get(owner, repo, number) as CacheRow | undefined;
      if (!row) return null;
      let parsed: CachePayload;
      try {
        parsed = JSON.parse(row.payload) as CachePayload;
      } catch {
        return null;
      }
      // Schema mismatch (or legacy un-wrapped payload with no `v`) → miss.
      if (parsed.v !== SCHEMA_VERSION || !parsed.pr) return null;
      return parsed.pr;
    },
    put(pr) {
      const payload: CachePayload = { v: SCHEMA_VERSION, pr };
      putStmt.run(
        pr.repo.owner,
        pr.repo.name,
        pr.number,
        pr.updatedAt,
        JSON.stringify(payload),
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
