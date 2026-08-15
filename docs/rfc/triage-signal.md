# RFC: Sharper triage signal

**Status:** Proposed
**Date:** 2026-08-14
**Extends:** [`maintainer-pr-triage-tooling.md`](maintainer-pr-triage-tooling.md)

## Scope

This is about the local `make triage` workflow only: one maintainer, one
SQLite cache, run on demand, output read by the person who ran it. No action, no
GitHub writes, no contributor-visible surface. The goal is a better answer to
"which of these do I look at now?"

## The problem: total diff size is the wrong number

A run on 2026-08-14 across `jaegertracing/jaeger`, `jaeger-ui`, and `jaeger-idl`
found 321 open PRs. The hide rules sent 226 to Blocked-on-author, which works.
95 reached the report:

| bucket                             | jaeger | jaeger-ui | jaeger-idl | total  |
| ---------------------------------- | ------ | --------- | ---------- | ------ |
| first-timer-awaiting               | 32     | 22        | 0          | 54     |
| fyi (needs triage)                 | 16     | 10        | 0          | 26     |
| youre-the-bottleneck               | 6      | 2         | 1          | 9      |
| high-trust-awaiting-first-response | 6      | 0         | 0          | 6      |
| **total**                          | **60** | **34**    | **1**      | **95** |

Each of those 95 rows offers one number to judge it by: `+additions/-deletions`.
Split the eight largest by file class and that number turns out to be misleading
on seven of them:

| PR               | source    | tests     | fixtures  | docs    | config | total      |
| ---------------- | --------- | --------- | --------- | ------- | ------ | ---------- |
| `jaeger#9263`    | 0         | 286       | 5,540     | 56      | 0      | 5,882      |
| `jaeger#9273`    | 2,269     | 0         | 0         | 283     | 91     | 2,643      |
| `jaeger-ui#4129` | 410       | 457       | 1,457     | 0       | 0      | 2,324      |
| `jaeger-ui#3440` | 438       | 361       | 0         | 0       | 0      | 799        |
| `jaeger-ui#4312` | 364       | 431       | 0         | 0       | 0      | 795        |
| `jaeger#9281`    | 217       | 461       | 20        | 0       | 3      | 701        |
| `jaeger#9075`    | 260       | 348       | 0         | 0       | 0      | 608        |
| `jaeger#9321`    | 61        | 497       | 30        | 0       | 0      | 588        |
| **total**        | **4,019** | **2,841** | **7,047** | **339** | **94** | **14,340** |

Only `jaeger#9273` is what its total claims. `jaeger#9263` reads as the largest
thing in the queue and changes no source at all. `jaeger#9321` reads as 588 lines
and is 61 lines of source behind 497 lines of tests. Source is 28% of the visible
bulk; fixtures alone are 49%.

Two more measurements of the 95:

**42 carry no flags at all.** Of the eleven flags the predicate library emits,
only four ever appear on a visible PR (`NO-ISSUE` 29, `NEEDS-LABEL` 22,
`NO-TESTS` 13, `RESOLVED-W/O-REPLY` 12). The other seven are hide rules, and a
triggered hide rule is what moves a PR out of view. So 42 rows arrive as a title,
an author, and a misleading line count.

**42 change 50 lines or fewer**, and 13 of the 14 PRs under 10 lines sit in the
54-row first-timer bucket, sorted only by staleness.

The classifier answers "is this waiting on me?" correctly and says nothing about
"how much of me does it want?".

## Phase 1: composition and ordering, no AI ✅

Delivered except the readiness score; see the status table at the end.

### Per-file diffstat ✅

`packages/checks/src/graphql.ts:136` selects
`files(first: 100) { nodes { path } }`. GitHub's `PullRequestChangedFile` carries
`additions`, `deletions`, and `changeType` on that same connection, so adding
them is a wider selection set on a query we already run: no extra round trip, no
new rate-limit cost. Cache `SCHEMA_VERSION` goes 3 → 4.

One honest limit: `first: 100` caps the file list, so a PR touching more than 100
files reports a partial split until we paginate. Nothing in the current visible
queue comes close.

### Category classifier ✅

A pure function from path to class, first match winning, overridable per repo in
config:

- **generated** — `*.pb.go`, `*_gen.go`, `mocks/`, lockfiles. First, because
  generated test data is generated before it is test data.
- **fixtures** — `testdata/`, `fixtures/`, `*.json`.
- **tests** — `*_test.go`, `*.test.tsx`, `*.spec.ts`.
- **docs** — `*.md`, `docs/`.
- **config** — YAML, TOML, `Makefile`, `Dockerfile`.
- **source** — everything left over.

### Two report changes ✅

**The `diff` column shows the split, not the total.** One row per file class,
each keeping the familiar `+added/-deleted` pair, so nothing that was readable
before is lost. Only the source label carries ink, because it is the sort key:

```
src  +3/-3
test +31/-0
```

**Buckets sort by source lines, not by staleness.**
`cli/src/render/shared.ts` previously sorted every bucket by `updatedAt`
ascending. Sorting by source lines ascending lifts `jaeger#9321` (61 source
lines) above `jaeger#9273` (2,269) inside the same bucket, so the
clear-in-a-minute PRs collect at the top of the 54-row first-timer list rather
than being scattered through it by date. Staleness remains the tiebreak.

### Referenced issues ✅

Three signals keyed on the issue a PR claims to close. All mechanical.

**Which issue.** `predicates/no_linked_issue.ts` already held a regex for the
closing keywords but only called `.test()` on it. `issue-refs.ts` now owns one
pattern with two consumers — `hasIssueRef()` for the predicate, and
`extractIssueRefs()` for the numbers — so "does it have one" and "which one is
it" cannot drift.

Only closing keywords count. Bare `#N` mentions are not a claim to fix
anything, and measurement bears that out: of 59 distinct bare-mention targets
across the visible PRs, 33 were other pull requests ("follow-up to #123"), so
counting them would manufacture collisions that don't exist.

The pattern also has to ignore HTML comments. Jaeger's PR template ships
`<!-- Example: Resolves #123 -->` and contributors routinely leave it in place;
matching inside it credited those PRs with an issue they never linked and made
`#123` look like the most contested issue in the repo, with four PRs. This was a
pre-existing defect in `no_linked_issue`, which silently withheld `NO-ISSUE`
from every PR that kept the placeholder.

**Whether the author filed it.** A contributor who opens an issue and
immediately PRs against it has usually manufactured the task. 30 of the visible
PRs carry `SELF-FILED`. It does not apply to maintainers or interns, for whom
filing and then fixing is ordinary planned work — without that exemption the
flag fires on most of the team's own PRs and means nothing.

**Which other PRs claim it.** Duplicated effort is a property of the scanned
set, so only this pass can see it. The issue column names the colliding PRs
rather than only counting them, because deciding which to keep means opening the
others:

```
#8780
other PRs: #8784, #9277
```

25 issues across the queue are claimed by more than one open PR, covering 54
PRs. Two clusters have three PRs each: `jaeger#8780` collected three separate
2–8 line fixes for the same ClickHouse flake, and `jaeger#9173` three fixes to
the same span comparison.

An open PR against an already-closed issue gets `ISSUE-CLOSED`, which comes free
with the same lookup.

Issue metadata is the only part that costs a request: distinct references are
batched ~50 per aliased GraphQL query and cached in an `issue_cache` table on a
6-hour TTL, reusing the pattern `merged_count_cache` established for values with
no cheap change signal. A second run the same day hit 168 of 171 from cache.
`--no-issues` skips the pass.

### Readiness score — not built

A pure module folding the category split together with mechanical readiness (CI
green, no merge conflict, DCO signed, required labels present, no unresolved
threads) and whether the PR touches a configured sensitive path (`*.proto`,
`model/`, `cmd/`, the storage interfaces).

Deferred rather than delivered. The existing predicates already surface each of
those facts as its own row flag, so a single combined score has to prove it
tells a maintainer something the flags don't. Worth revisiting after some time
reading the composition and issue columns.

## Phase 2: a local model pass for what the score cannot decide

### Where it lives

`cli/src/assess.ts`, an enrichment pass in the same position and shape as
`cli/src/quota.ts`'s `enrichQuotaState` — cross-PR context the per-PR GraphQL
query cannot supply, applied between the scan and the classifier:

```
scan → quota enrich → assess enrich → classify → render
```

CLI-only, so it does not belong in `packages/checks`. Nothing in an action
consumes it, which is what would otherwise have forced a subpath export to keep a
model dependency out of the ncc bundles.

### Transport

`claude -p --output-format json`, as a subprocess with no tools enabled. The CLI
assembles the prompt itself from the PR state it already holds plus the patch
(one REST call with `Accept: application/vnd.github.diff`), so the prompt is
fully determined by us, logged, and reproducible. No API key, no billing setup,
no new dependency.

### Verdict schema

Bounded, so the renderer shows it as chips beside the existing flags rather than
as prose.

```ts
interface Assessment {
  lane: 'merge-now' | 'quick-review' | 'deep-review' | 'needs-decision' | 'bounce-to-author';
  effort: 'minutes' | 'half-hour' | 'hours';
  why: string; // one sentence, rendered as the chip's tooltip
  riskAreas: string[]; // closed vocabulary, not free text
  blockers: string[]; // what the author must change
  questions: string[]; // what a maintainer must decide
  suggestedChangelogLabel?: string;
  possibleDuplicateOf?: string[]; // as owner/repo#N
}
```

The five lanes:

| lane               | meaning                                                        |
| ------------------ | -------------------------------------------------------------- |
| `merge-now`        | Mechanically ready and trivially small. Approve and land it.    |
| `quick-review`     | Small and self-contained; minutes of real reading.              |
| `deep-review`      | Touches a sensitive path or carries real design surface.         |
| `needs-decision`   | Blocked on a maintainer call, not on more review.               |
| `bounce-to-author` | Concrete, statable changes needed before review is worth it.    |

**The model can only lower a PR's readiness, never raise it.** A `merge-now` lane
requires every mechanical precondition from phase 1 to already hold, and any
predicate that fired wins over the model's opinion. A model that hallucinates
"this looks fine" therefore cannot promote a PR with red CI or an unsigned
commit. The model narrows a set the deterministic layer already declared
eligible, which keeps the predicate library the source of truth.

### One job beyond the lane

**The missing `changelog:` label.** `NEEDS-LABEL` fires on 22 of the 95, where CI
is red purely on the label gate. Six of the ten labels map straight from the
conventional-commit prefix, so the deterministic layer proposes those. The other
four are judgement calls — headline feature or minor one, breaking or not,
experimental or not, trivial enough to skip — and are worth a model's read of the
diff. The report shows a suggestion and a link; you still apply the label.

### Semantic duplicate detection is not worth building

A model reading diffs could find PRs that fix the same thing without referencing
a common issue. Measurement says that set is close to empty. The two suspect
pairs that motivated the idea — `jaeger#9277`/`#8891` on the ClickHouse
cache-TTL flake, and `jaeger#9279`/`#9283` on the trace end-time computation —
both turned out to share an issue reference, so phase 1's collision grouping
catches them with no model, no diff comparison, and no per-set prompt. The
`#8780` cluster is in fact three PRs, not two, which the mechanical pass found
and a title comparison would have missed.

Contributors on this queue reliably link the issue they are working from: 199 of
318 open PRs carry a closing reference. A model pass would be paying tokens to
re-find what the reference already states. Revisit only if collisions start
showing up that share no issue.

### Not re-running on unchanged PRs

A new table in the SQLite database the CLI already opens, keyed on two
fingerprints:

- `code_fp` — `headSha` + `baseRefOid`. Identifies the diff exactly.
- `context_fp` — labels, review states, unresolved-thread count, status rollup,
  mergeable.

Plus `prompt_version` and `model`, so editing the prompt invalidates
deliberately.

| `code_fp` | `context_fp` | prompt / model | action                                                   |
| --------- | ------------ | -------------- | -------------------------------------------------------- |
| match     | match        | match          | serve the cached verdict; zero model calls               |
| match     | changed      | match          | keep the code judgement, recompute the lane gate locally |
| changed   | any          | match          | re-run                                                   |
| any       | any          | changed        | re-run, as a deliberate global invalidation              |

The load-bearing choice is that **the key is not `updatedAt`**.
`cli/src/scan.ts:isFresh` invalidates its cache on
`(updatedAt, headSha, headRollup)`, which is right for the PR blob because any of
the three can change what a predicate concludes. An assessment is narrower: a
comment thread bumps `updatedAt` without changing a line of code, and the model's
read of the diff is still valid. Keying the verdict on `updatedAt` would re-pay
for every comment, which is exactly the churn worth avoiding.

Cold start on today's queue is 95 calls. After that it is however many PRs
changed code since the last run — today's run fetched 63 changed PRs out of 321,
and most of those were hidden, so the daily figure is single digits.

### Flags

- `--assess` turns the pass on. Off by default, so `make triage` keeps working
  exactly as it does today.
- `--assess-max-diff-kb <n>` caps how much patch is sent for any one PR, so a
  single 5,000-line fixture drop cannot dominate a run.

That is the whole surface. Cost control is the fingerprint cache, not a budget
ceiling.

### Failure handling

If `claude` is missing, the subprocess fails, or the response does not parse as
the schema, the assessment is `null`, the row renders exactly as it does today,
and the run exits 0. The report never depends on the model being reachable.

### Report surfaces

**A lane chip per row**, reusing the `.flag[data-tip]` CSS tooltip already in
`cli/src/render/html.ts:186`, so the one-sentence `why` shows on hover with no
new UI vocabulary.

**A cross-repo lane summary at the top of the report** — "Merge now (11) · Quick
review (23) · Deep review (18) · Needs decision (6) · Bounce to author (37)" —
each expanding to a flat list that ignores repo and bucket. Trivial PRs are
scattered across every bucket, and the repo → priority → bucket nesting cannot
put them in one place.

**`--explain` gains the verdict**: the full JSON, which cache tier served it, and
the prompt version that produced it.

## Phases

| Phase                     | Status                                     |
| ------------------------- | ------------------------------------------ |
| **1** — composition, ordering, referenced issues | ✅ except the readiness score |
| **2** — local model pass for review lanes | Not started                       |
| ~~**3** — semantic duplicate detection~~ | Dropped; phase 1 subsumes it       |

Phase 1, item by item. All local, no model involved:

| Item                                                                | Where                                        | Status |
| ------------------------------------------------------------------- | -------------------------------------------- | ------ |
| `additions`/`deletions`/`changeType` on the existing `files` query  | `packages/checks/src/graphql.ts`             | ✅     |
| `fileStats` on `PullRequest`; cache `SCHEMA_VERSION` 3 → 4          | `packages/checks/src/types.ts`, `cache.ts`   | ✅     |
| File-class classifier and `computeComposition()`                    | `packages/checks/src/composition.ts`         | ✅     |
| Shared closing-keyword pattern, HTML comments excluded              | `packages/checks/src/issue-refs.ts`          | ✅     |
| Batched issue lookup (~50/query) and `issue_cache` on a 6-hour TTL  | `packages/checks/src/graphql.ts`, `cache.ts` | ✅     |
| Issue-ref parsing, metadata attach, cross-PR collision grouping     | `cli/src/issues.ts`                          | ✅     |
| `SELF-FILED`, `ISSUE-COLLISION`, `ISSUE-CLOSED` flags               | `cli/src/buckets.ts`                         | ✅     |
| Per-class diff rows; issue column listing the colliding PRs         | `cli/src/render/html.ts`                     | ✅     |
| Bucket sort by source lines, staleness as tiebreak                  | `cli/src/render/shared.ts`                   | ✅     |
| `--no-issues`                                                       | `cli/src/index.ts`                           | ✅     |
| Readiness score                                                     | —                                            | Deferred |

## Calibration

Once phase 2 has run for a couple of weeks, compare the `merge-now` lane against what
actually merged the same day it was assessed. The cache retains every verdict
with the fingerprint that produced it, so the check costs nothing but a query.

Until then, the lanes are additive: phase 2 changes no bucket assignment and no
sort order beyond phase 1's, so a wrong lane costs one misplaced chip in a local HTML file.
