export const id = 241;
export const ids = [241];
export const modules = {

/***/ 241:
/***/ ((__unused_webpack___webpack_module__, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   getCachedOrFetch: () => (/* binding */ getCachedOrFetch),
/* harmony export */   openCache: () => (/* binding */ openCache)
/* harmony export */ });
/* harmony import */ var node_sqlite__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(99);
// SQLite cache keyed by (owner, repo, number, updated_at). Only PRs whose
// `updated_at` advanced since the last fetch are re-queried; everything else
// is served from cache. Keeps steady-state cost near zero for the triage
// scanner.
//
// Backed by Node's built-in `node:sqlite` (added in Node 22.5, stable in
// recent releases), so the cache has zero native-dep overhead — no gyp,
// no Xcode CLT, no platform-specific install scripts. The repo engines
// requirement is bumped to >= 22.5.0 in package.json.

// A cache file from before the report read the linked issues holds the
// table `issue_cache`, which nothing reads.
const SCHEMA = `
  DROP TABLE IF EXISTS issue_cache;
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
`;
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
//   6 — reviewThreads is now paginated in full, so entries cached before it
//       hold at most the first 100 threads
//   7 — added reviews[].url and reviews[].body for Copilot review verdicts
//   8 — added linkedIssues
//   9 — added the body of a policy comment
//  10 — added commits[].authorLogin
//  11 — added linkedIssues[].title and linkedIssues[].author
//  12 — added labelEvents, comments[].id, comments[].isMinimized,
//       comments[].authorIsBot, and the body of a comment of the Actions bot
const SCHEMA_VERSION = 12;
function openCache(path) {
    const db = new node_sqlite__WEBPACK_IMPORTED_MODULE_0__.DatabaseSync(path);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(SCHEMA);
    const getStmt = db.prepare('SELECT payload FROM pr_cache WHERE owner = ? AND repo = ? AND number = ?');
    const putStmt = db.prepare(`INSERT INTO pr_cache (owner, repo, number, updated_at, payload, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(owner, repo, number) DO UPDATE SET
       updated_at = excluded.updated_at,
       payload    = excluded.payload,
       fetched_at = excluded.fetched_at`);
    const getMergedStmt = db.prepare('SELECT count, fetched_at FROM merged_count_cache WHERE owner = ? AND repo = ? AND author = ?');
    const putMergedStmt = db.prepare(`INSERT INTO merged_count_cache (owner, repo, author, count, fetched_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(owner, repo, author) DO UPDATE SET
       count      = excluded.count,
       fetched_at = excluded.fetched_at`);
    return {
        get(owner, repo, number) {
            const row = getStmt.get(owner, repo, number);
            if (!row)
                return null;
            let parsed;
            try {
                parsed = JSON.parse(row.payload);
            }
            catch {
                return null;
            }
            // Schema mismatch (or legacy un-wrapped payload with no `v`) → miss.
            if (parsed.v !== SCHEMA_VERSION || !parsed.pr)
                return null;
            return parsed.pr;
        },
        put(pr) {
            const payload = { v: SCHEMA_VERSION, pr };
            putStmt.run(pr.repo.owner, pr.repo.name, pr.number, pr.updatedAt, JSON.stringify(payload), new Date().toISOString());
        },
        getMergedCount(owner, repo, author, maxAgeMs) {
            const row = getMergedStmt.get(owner, repo, author);
            if (!row)
                return null;
            const age = Date.now() - Date.parse(row.fetched_at);
            // A corrupted/manually-edited fetched_at parses to NaN, and `NaN >
            // maxAgeMs` is always false -- without this check the row would
            // never expire. Treat unparseable ages as stale instead.
            if (!Number.isFinite(age) || age > maxAgeMs)
                return null;
            // node:sqlite returns INTEGER columns as bigint once the value
            // exceeds Number.MAX_SAFE_INTEGER; normalize since the interface
            // promises a number (merged-PR counts never get remotely close to
            // that range, so no precision is lost here).
            return Number(row.count);
        },
        putMergedCount(owner, repo, author, count) {
            putMergedStmt.run(owner, repo, author, count, new Date().toISOString());
        },
        close() {
            db.close();
        },
    };
}
// Convenience: cached fetch. Caller passes in a fresh `updatedAt` (typically
// from the event payload) so we can decide whether to re-fetch without first
// burning a GraphQL request.
async function getCachedOrFetch(cache, owner, repo, number, freshUpdatedAt, fetcher) {
    const cached = cache.get(owner, repo, number);
    if (cached && freshUpdatedAt && cached.updatedAt === freshUpdatedAt) {
        return cached;
    }
    const fresh = await fetcher();
    cache.put(fresh);
    return fresh;
}
//# sourceMappingURL=cache.js.map

/***/ })

};
