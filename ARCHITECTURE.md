# Architecture

A code-level companion to the design doc in
[`docs/rfc/maintainer-pr-triage-tooling.md`](docs/rfc/maintainer-pr-triage-tooling.md).
The RFC is the _why_; this document is the _how_ — where things live, how
data flows, and which extension points exist.

## One library, many consumers

Everything in this repo orbits a single shared TypeScript module:

```
packages/checks/                  shared predicate library
├── src/types.ts                  CheckResult + PullRequest shape
├── src/predicates/*.ts           pure functions: (PR) → CheckResult
├── src/graphql.ts                Octokit GraphQL data layer
└── src/cache.ts                  SQLite cache via node:sqlite (CLI use, see below)
```

Two kinds of consumer sit on top of it:

1. **GitHub Actions** — `pr-nudge/`, later `pr-quota/`, `pr-weekly-digest/`.
   Each is a self-contained subfolder with its own `action.yml` and a
   committed `dist/index.js` produced by `@vercel/ncc`. Triggered by repo
   events; writes back via the GitHub API (Check Runs, labels, comments).
2. **Local CLI** — `cli/`, exposed as `maintainer-tools triage`. Runs on a
   maintainer's laptop; reads the same library, scans configured repos via
   the SQLite cache, classifies each open PR into one of seven attention
   buckets, and writes a self-contained HTML triage report. Never touches
   the GitHub write API.

Both consumers share **one** TypeScript definition of every check predicate
("DCO missing", "merge conflict", "CI failing", …). That's the central
property of the architecture: a contributor-facing nudge and a
maintainer-facing triage bucket are computed from the same code path, so
they can't drift.

## Predicate model

Every check is a pure function:

```typescript
(pr: PullRequest) => CheckResult;
```

A `CheckResult` declares _which surfaces_ it publishes to:

| Field             | Meaning                                                    |
| ----------------- | ---------------------------------------------------------- |
| `triggered`       | Did the predicate's condition match for this PR?           |
| `publishesCheck`  | If true, emit a GitHub Check Run                           |
| `checkConclusion` | success / failure / neutral / skipped / action_required    |
| `inDigest`        | Include in the weekly digest comment                       |
| `hidesFromTriage` | Drop the PR from the maintainer's triage report            |
| `summary`         | Short line, reused verbatim across surfaces                |
| `details`         | Longer remediation paragraph (Checks panel "Details" link) |

Three rules keep predicates trustworthy:

1. **Pure.** No I/O, no `new Date()` without an injected `now`, no logging.
   Side effects belong in the action subfolder that consumes the result.
2. **Idempotent inputs.** A predicate takes the _current_ state of a PR
   (not the event that just fired). Re-running on the same `PullRequest`
   always returns the same `CheckResult`. See "State-based, not
   event-reactive" in the RFC for why this matters.
3. **Surface-declarative.** A predicate doesn't _do_ anything — it
   _declares_ what should happen. The consumer interprets the declaration
   and decides whether to actually emit, given its own dry-run state,
   permission scope, and rate-limit budget.

The full predicate set: `dco_missing`, `ci_failing`, `merge_conflict`,
`stale_on_author`, `quota_exceeded`, `description_empty`, `no_linked_issue`,
`no_tests_for_code_change`, `unresolved_from_reviewer`,
`resolved_without_reply`. New predicates are added by dropping a file into
`src/predicates/`, exporting it from `predicates/index.ts`, and adding its
ID to `ALL_PREDICATES` (a back-compat `P0_PREDICATES` alias is also
exported for older imports).

## Data flow

```
┌──────────────────┐
│ GitHub event /   │
│ CLI invocation   │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐    ┌─────────────────┐
│ graphql.ts       │ ←→ │ cache.ts        │
│ fetchPullRequest │    │ (CLI only)      │
└────────┬─────────┘    └─────────────────┘
         │ PullRequest
         ▼
┌──────────────────┐
│ runAll(pr, ids)  │   ← packages/checks/src/predicates/index.ts
└────────┬─────────┘
         │ CheckResult[]
         ▼
┌──────────────────┐
│ Consumer-specific│   ← pr-nudge/src/index.ts (Check Runs)
│ side effects     │     CLI (HTML report)
└──────────────────┘
```

`fetchPullRequest` runs **one** GraphQL query per PR that pulls every
field any current or planned predicate might need (commits, mergeable
state, status rollup, labels, author). A new predicate that needs a new
field updates this query and the `PullRequest` type — keeping the
fan-out cost constant regardless of how many predicates exist.

## The cache

`packages/checks/src/cache.ts` is a **persistent** SQLite cache that lives
on a maintainer's laptop, not per-run scratch space and not anything the
actions touch. The key is `(owner, repo, number)`; the freshness column is
`updated_at` (ISO 8601 from GitHub).

Workflow when the CLI runs:

1. Cheap "list PRs for repo" query returns `{ number, updated_at }` pairs.
2. For each pair, look up the cached row.
3. If cached `updated_at` matches → return cached `PullRequest` blob.
4. Otherwise → fire the expensive per-PR query and overwrite the cache.

This keeps the steady-state cost of a daily `maintainer-tools triage` run
near zero: only PRs that actually moved are re-fetched.

### Who uses what

| Consumer                      | Where it runs                      | Uses the cache? |
| ----------------------------- | ---------------------------------- | --------------- |
| `pr-nudge` action             | GitHub-hosted runner, per PR event | No              |
| `pr-quota` action (P6)        | GitHub-hosted runner, per PR event | No              |
| `pr-weekly-digest` action     | GitHub-hosted runner, daily cron   | No              |
| `maintainer-tools triage` CLI | Maintainer's laptop, on demand     | Yes             |

Two reasons the actions don't use it. (a) Ephemeral filesystem: GitHub-hosted
runners are wiped after every job, so a SQLite file would never survive to
the next invocation without `actions/cache`. (b) Wrong access pattern: each
action fires on one PR and exits — cache hit rate is approximately zero. The
cache's value comes from amortizing "fetch 250 PRs across 5 repos" down to
"fetch the 3 that moved overnight," which is a CLI scenario.

If we ever want multi-PR scanning inside an action (e.g. an org-wide nightly
job), the options are (a) accept the cold-fetch cost, (b) plug in
`actions/cache` around the SQLite file, or (c) keep state in a GitHub issue
body / gist. None of those are on the roadmap.

The cache is backed by Node's built-in `node:sqlite` module (added in
22.5.0, stable in recent releases). No native compilation, no install
scripts, no platform-specific binaries. Repo engines requirement is
`>=22.5.0` for that reason; GitHub Actions still ship on the `node20`
runtime since they don't touch the cache. To keep the cache out of every
action's ncc bundle, it is exposed via a **subpath** import
(`@jaegertracing/maintainer-tools-checks/cache`) rather than from the
main barrel; the action runtime never imports `node:sqlite`.

## Actions: layout and bundling

Each top-level `<tool>/` folder is one GitHub Action:

```
pr-nudge/
├── action.yml          declares inputs, the `node20` runtime, and `dist/index.js`
├── src/index.ts        thin glue: parse inputs, fetch PR, runAll(), emit Check Runs
├── dist/index.js       COMMITTED — @vercel/ncc bundle of src + deps
└── tsconfig.json
```

The `dist/index.js` file is committed. That's how GitHub JS actions ship:
the workflow `uses: jaegertracing/maintainer-tools/pr-nudge@<sha>` clones
the action subfolder at that ref and runs `dist/index.js` directly — no
`npm install`, no build step on the consumer side. The `lint-build` CI
job rebuilds and fails on `git diff --quiet pr-nudge/dist`, which is what
guarantees the committed bundle matches its source.

An action subfolder is intentionally a _thin_ layer:

- Parse `with:` inputs via `@actions/core`.
- Resolve the PR reference from the event payload (`pull_request`,
  `issue_comment` on a PR, …).
- Call `fetchPullRequest` from the shared library.
- Call `runAll(pr, rules)` from the shared library.
- For each result, dispatch to the appropriate surface (Check Run, label,
  comment).

The bulk of the work — fetching, predicate evaluation, summary text —
lives in `packages/checks`. The action is just plumbing.

### Why per-tool subfolders, not one mega-action

Two reasons. (a) Independent release cadence: `pr-nudge` and
`pr-quota` can hit v1.x at different times. (b) Independent
permission scope in consuming workflows: `pr-quota` needs label-write
and comment-write; `pr-weekly-digest` only needs comment-write. Granting
the union of permissions to one mega-action would be a regression on
least-privilege.

## State-based, not event-reactive

The two scripts being migrated (`waiting-for-author.js`,
`pr-quota-manager.js`) react to "what just happened" — they fire on
`synchronize` or `issue_comment: created` and decide based on the event.
That model is fragile against out-of-order events and missed webhooks.

The replacement is **state-based**: an action triggered by _any_
relevant event re-evaluates the PR's current state from scratch via
`fetchPullRequest`, runs the predicates, and writes the result. The
event payload is used only to pick _which_ PR to look at. Missed events
self-heal on the next trigger; double-fires are idempotent.

## Surfaces

Three output surfaces, in decreasing volume:

1. **Checks panel** — primary. Every `publishesCheck: true` result becomes
   a `checks.create` call on the PR's head SHA. Zero notifications,
   native UI affordance.
2. **Labels** — state. `waiting-for-author`, `awaiting-maintainer-input`,
   `pr-quota-reached`. Searchable, filterable. Currently read-only;
   write support lands in P5 (`pr-nudge` migration) and P6 (`pr-quota`).
3. **Comments** — rare. Weekly digest, slash-command acks, `quota_exceeded`'s
   one-shot explanation. Every bot comment ends with an HTML-comment
   footer the bot uses to find and **edit in place** rather than reposting.

The mapping from `CheckResult` to surface is fixed by the predicate, not
the consumer. A predicate that wants to surface in the digest sets
`inDigest: true`; it does not call into the digest writer.

### Comment publisher decision table

The publisher (`packages/checks/src/comments/publisher.ts`) looks up
prior bot comments on the PR by `(kind, scope)` and decides what to do
based on the body's SHA. For a `weekly_digest` comment with
`scope=week=YYYY-Www`:

| prior? | same week? | same sha? | action                                                 |
| ------ | ---------- | --------- | ------------------------------------------------------ |
| no     | —          | —         | **POST** (first time this PR)                          |
| yes    | yes        | yes       | **SKIP** (re-run, body unchanged)                      |
| yes    | yes        | no        | **PATCH** (edit in place; body changed)                |
| yes    | no (older) | —         | **POST** new + optionally minimize older as `OUTDATED` |

For one-shot kinds (`quota_blocked`, `slash_ack`) the caller passes a
scope that doesn't roll over, so the bottom row doesn't occur — the
publisher just does POST / PATCH / SKIP.

## Caching, retries, and rate limits (status)

- Cache: **implemented**, CLI-only.
- Per-PR retries on transient GraphQL failures: **not yet** — relying on
  Octokit's defaults. Likely needed before P5 cutover.
- Secondary-rate-limit handling: **not yet**. Will batch using `node-octokit`
  throttling plugin once we have a multi-PR consumer (CLI).

## Triage CLI: bucket classifier

`cli/src/buckets.ts` is a pure function that lands every open PR in
exactly one of seven priority-ordered buckets:

1. **review-requested-on-you** — viewer in `reviewRequests`. Strongest
   signal; overrides every hide rule. Disabled entirely when
   `TriageConfig.ignoreReviewRequestedOnYou` is `true` (GitHub review
   requests carry no trust signal — anyone, including the PR author, can
   send one).
2. **youre-the-bottleneck** — viewer has reviewed previously, author has
   pushed or commented since.
3. **high-trust-awaiting-first-response** — author is in the configured
   `maintainers` or `interns` list, no maintainer has reviewed/commented.
4. **first-timer-awaiting** — `authorAssociation` is `FIRST_TIME_*`, no
   maintainer activity yet.
5. **codeowners-hits** — PR files match the viewer's configured CODEOWNERS
   globs for the repo.
6. **fyi** — catch-all for open PRs with no stronger signal.
7. **hidden** — drafts, bot-authored, `waiting-for-author`, or anything a
   predicate marked `hidesFromTriage`. Counts only; not listed.

Hide rules run before bucket assignment. The lone exception is
`review-requested-on-you`: an explicit review request overrides hide rules
because GitHub's request is treated as a deliberate signal — unless
`ignoreReviewRequestedOnYou` is set, in which case the override (and the
bucket itself) is switched off and hide rules apply unconditionally.

The renderer (`cli/src/render/html.ts`) consumes the classified list
as-is. The HTML output is self-contained (inline CSS, no external assets),
organized repo → bucket, with high-signal buckets expanded and low-signal
collapsed.

## Repository conventions

- ES modules everywhere (`"type": "module"`, NodeNext resolution). Relative
  imports must use `.js` extensions — that's TypeScript's NodeNext
  requirement for emitting a Node-compatible ES module.
- Strict TypeScript, including `noUncheckedIndexedAccess`. Index access
  on arrays/objects is `T | undefined`; consumers must narrow.
- One Prettier config, applied repo-wide; long-form docs (`docs/`,
  RFC) are exempted via `.prettierignore` to avoid noisy churn.
- DCO sign-off is mandatory on every commit (`git commit -s`).

## Extension points

| Want to…                | Touch…                                                                           |
| ----------------------- | -------------------------------------------------------------------------------- |
| Add a new predicate     | New file in `packages/checks/src/predicates/`, export from `predicates/index.ts` |
| Expose a new PR field   | Extend `PullRequest` in `types.ts` + the GraphQL query in `graphql.ts`           |
| Add a new action        | New top-level `<tool>/` subfolder following `pr-nudge/`'s layout                 |
| Change a surface        | The mapping is in each action's `src/index.ts` (e.g. `pr-nudge/src/index.ts`)    |
| Add a new event trigger | Update `resolvePrRef()` in the relevant action; document in `action.yml`         |
| Add/rebalance a bucket  | `cli/src/buckets.ts` — adjust `BUCKET_ORDER` and the branches in `classify()`    |
| Adjust HTML look        | `cli/src/render/html.ts` — CSS is inlined at the bottom of the file              |

## See also

- [`docs/rfc/maintainer-pr-triage-tooling.md`](docs/rfc/maintainer-pr-triage-tooling.md) — full design rationale, predicate table, implementation phases.
- [`AGENTS.md`](AGENTS.md) — contributor and AI-agent instructions: build/lint commands, commit conventions, DCO sign-off requirement.
