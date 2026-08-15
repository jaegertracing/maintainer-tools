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
import type { IssueMeta, PullRequest } from './types.js';

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
  CREATE TABLE IF NOT EXISTS merged_count_cache (
    owner       TEXT NOT NULL,
    repo        TEXT NOT NULL,
    author      TEXT NOT NULL,
    count       INTEGER NOT NULL,
    fetched_at  TEXT NOT NULL,
    PRIMARY KEY (owner, repo, author)
  );
  CREATE TABLE IF NOT EXISTS issue_cache (
    owner       TEXT NOT NULL,
    repo        TEXT NOT NULL,
    number      INTEGER NOT NULL,
    author      TEXT,
    state       TEXT NOT NULL,
    title       TEXT NOT NULL,
    is_pr       INTEGER NOT NULL,
    fetched_at  TEXT NOT NULL,
    PRIMARY KEY (owner, repo, number)
  );
`;

export interface PrCache {
  get(owner: string, repo: string, number: number): PullRequest | null;
  put(pr: PullRequest): void;
  // Merged-PR-count cache for quota enrichment (cli/src/quota.ts). Unlike
  // pr_cache, there's no cheap "has this changed" signal (it's a property
  // of (repo, author), not of one PR), so freshness is TTL-based: the
  // caller passes maxAgeMs and gets a miss (null) if the cached row is
  // older than that.
  getMergedCount(owner: string, repo: string, author: string, maxAgeMs: number): number | null;
  putMergedCount(owner: string, repo: string, author: string, count: number): void;
  // Referenced-issue metadata for the triage report's issue columns. Like
  // merged counts, an issue has no cheap "has this changed" signal, so
  // freshness is TTL-based. An issue's author never changes; `state` does,
  // which is what the TTL is really for.
  getIssue(owner: string, repo: string, number: number, maxAgeMs: number): IssueMeta | null;
  putIssue(owner: string, repo: string, number: number, meta: IssueMeta): void;
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
//   4 — added fileStats (per-file additions/deletions) for diff composition
//   5 — added headCheckRunsTruncated; widened the check-context page to 100,
//       so entries cached at the old page size hold a shorter prefix
const SCHEMA_VERSION = 5;

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
  const getMergedStmt = db.prepare(
    'SELECT count, fetched_at FROM merged_count_cache WHERE owner = ? AND repo = ? AND author = ?',
  );
  const putMergedStmt = db.prepare(
    `INSERT INTO merged_count_cache (owner, repo, author, count, fetched_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(owner, repo, author) DO UPDATE SET
       count      = excluded.count,
       fetched_at = excluded.fetched_at`,
  );
  const getIssueStmt = db.prepare(
    'SELECT author, state, title, is_pr, fetched_at FROM issue_cache WHERE owner = ? AND repo = ? AND number = ?',
  );
  const putIssueStmt = db.prepare(
    `INSERT INTO issue_cache (owner, repo, number, author, state, title, is_pr, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(owner, repo, number) DO UPDATE SET
       author     = excluded.author,
       state      = excluded.state,
       title      = excluded.title,
       is_pr      = excluded.is_pr,
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
    getMergedCount(owner, repo, author, maxAgeMs) {
      const row = getMergedStmt.get(owner, repo, author) as
        { count: number | bigint; fetched_at: string } | undefined;
      if (!row) return null;
      const age = Date.now() - Date.parse(row.fetched_at);
      // A corrupted/manually-edited fetched_at parses to NaN, and `NaN >
      // maxAgeMs` is always false -- without this check the row would
      // never expire. Treat unparseable ages as stale instead.
      if (!Number.isFinite(age) || age > maxAgeMs) return null;
      // node:sqlite returns INTEGER columns as bigint once the value
      // exceeds Number.MAX_SAFE_INTEGER; normalize since the interface
      // promises a number (merged-PR counts never get remotely close to
      // that range, so no precision is lost here).
      return Number(row.count);
    },
    putMergedCount(owner, repo, author, count) {
      putMergedStmt.run(owner, repo, author, count, new Date().toISOString());
    },
    getIssue(owner, repo, number, maxAgeMs) {
      const row = getIssueStmt.get(owner, repo, number) as
        | {
            author: string | null;
            state: string;
            title: string;
            is_pr: number | bigint;
            fetched_at: string;
          }
        | undefined;
      if (!row) return null;
      const age = Date.now() - Date.parse(row.fetched_at);
      if (!Number.isFinite(age) || age > maxAgeMs) return null;
      return {
        author: row.author,
        state: row.state as IssueMeta['state'],
        title: row.title,
        isPullRequest: Number(row.is_pr) === 1,
      };
    },
    putIssue(owner, repo, number, meta) {
      putIssueStmt.run(
        owner,
        repo,
        number,
        meta.author,
        meta.state,
        meta.title,
        meta.isPullRequest ? 1 : 0,
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
