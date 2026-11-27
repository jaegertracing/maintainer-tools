# Architecture

A code-level companion to the design doc in
[`docs/rfc/0001-maintainer-pr-triage-tooling.md`](docs/rfc/0001-maintainer-pr-triage-tooling.md).
The RFC is the _why_; this document is the _how_ — where things live, how
data flows, and which extension points exist.

## One library, many consumers

Everything in this repo orbits a single shared TypeScript module:

```
packages/checks/                  shared predicate library
├── src/types.ts                  PullRequest shape and the check IDs
├── src/predicates/*.ts           one predicate per check
├── src/policy.ts                 every fact and every rule of the checks
├── src/rules/*.ts                the rule form: policy, evaluator, startup check
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
   the SQLite cache, classifies each open PR into one of nine attention
   buckets, and writes a self-contained HTML triage report. Never touches
   the GitHub write API.

Both consumers share **one** TypeScript definition of every check predicate
("DCO missing", "merge conflict", "CI failing", …). That's the central
property of the architecture: a contributor-facing nudge and a
maintainer-facing triage bucket are computed from the same code path, so
they can't drift.

## Vocabulary of the rule form

The rule form in `src/rules/` states as data which facts of a pull request
lead to which output. This section defines each of its terms, and the code
and the comments in `src/rules/` use the terms with these meanings only. The
type that carries a term is named after it, and the comment on the type
repeats the definition.

- **Base fact** (`BaseFact`): a named boolean of one pull request whose value
  comes from a predicate.
- **Predicate** (`Predicate`): the function that reads a pull request and
  returns the value of one base fact. The predicates are the only code in a
  policy.
- **Derived fact** (`DerivedFact`): a named boolean of one pull request that
  rules decide from other facts. "Fact" alone means a base fact or a derived
  fact.
- **Output** (`Output`): a decision that the rules make about a pull request
  and that one tool acts on. When the output `triage_hidden` holds for a pull
  request, the triage CLI lists it in the Hidden bucket of the report. When
  `weekly_digest` holds, the `pr-weekly-digest` action has something to list
  in the comment that reminds the author of a quiet pull request. Rules
  decide an output, and no rule reads one. An output is not a fact, so a fact
  and an output may have the same name.
- **Rule** (`Rule`): one `.when()` or `.unless()` call, recorded as data. It
  names a list of facts, which are its **premises**, and one derived fact or
  output, which is its **conclusion** (`Conclusion`). `hidden.when(draft)`
  records the rule "if `draft` holds, `hidden` holds". No single rule decides
  its conclusion: the evaluator reads all the rules of one conclusion.
- **Reason** and **veto**: the two kinds of rule. A reason makes its
  conclusion hold, and a veto stops its conclusion from holding, whatever
  reasons hold. `.when(a, b)` declares a reason with the premises `a` and
  `b`, and `.unless(a)` declares a veto.
  Only a derived fact and an output have these two methods, and the function
  that records a rule is private to the policy, which passes it only to
  them. A rule therefore cannot decide a base fact or have a conclusion that
  the policy does not declare. The two methods accept facts only, so a rule
  cannot read an output.
- **Holds**: a base fact holds when its predicate returns true. A rule holds
  when all of its premises hold. A derived fact or an output holds when at
  least one of its reasons holds and none of its vetoes does.
- **Change source** (`ChangeSource`): who can change the value of a base
  fact: the author, a maintainer, or time.
- **Policy** (`Policy`): the container of the base facts, the derived facts,
  the outputs and the rules.
- **Rule set** (`RuleSet`): a policy that `loadRuleSet()` has loaded for
  evaluation.
- **Verdict** (`Verdict`): the result of a rule set for one pull request. It
  names the facts that hold (`factsThatHold`) and the outputs that hold
  (`outputsThatHold`), and it lists the rules that hold (`rulesThatHold`).
  `holds(fact)` returns whether one fact holds. It takes the fact object and
  not its name, so that a misspelled name does not compile.
  `reasons(conclusion)` and `vetoes(conclusion)` return the premise texts of
  the reasons and of the vetoes that held for the conclusion.
- **Supporting fact** (`supportingFacts()`): a base fact that makes an output
  hold, directly or through derived facts, by reasons that held.
  `supportingFacts()` returns the supporting facts that have a summary.
- **Violation** (`RuleSetViolation`): a defect that makes a rule set
  unusable: a dependency cycle, an output that no person can clear, or a
  rule that never holds. The startup check rejects a rule set that has one
  by throwing an
  `InvalidRuleSetError`, which lists the violations.
- **Output that no person can clear**: an output that a person cannot stop
  from holding. The output holds for some values of the base facts that time
  changes, and with those values it holds whatever values the other base
  facts take. It is a violation. The startup check therefore rejects
  `triageHidden.when(monthOld, quiet)` when time is the change source of both
  facts, because once both hold, nothing that a person does stops the output
  from holding.

Base fact, derived fact, rule and output are concepts of Datalog, which calls
them extensional fact, intensional fact, rule and output relation. A policy
is a Datalog program without recursion. The other terms, predicate included,
are terms of this package.

## Predicate model

The checks are written in the rule form, with the terms of the section above.
The module of a check in `src/predicates/` exports the predicate of the check.
One file, `src/policy.ts`, declares every fact and every rule, so
that file alone says which facts of the checks hide a PR and which the digest
lists. It declares
the base fact that has the ID of each check, and then the rules of each
output:

```typescript
const mergeConflict = policy.baseFact('merge_conflict', mergeConflictPredicate, {
  changedBy: 'author',
});

policy.triageHidden.when(dcoMissing).when(mergeConflict);
```

The order of the rules of an output is visible in the reports. The triage
report gives the reasons for hiding, the digest prints its lines, and a
decision table lists its base facts, in the order of those rules.

- `policy.baseFact(name, predicate, { changedBy })` declares a base fact. The
  predicate is a pure function of the PR and the predicate context, which
  holds the injected clock and, when the consumer gathers them, the open PRs
  of the run. It returns
  the boolean, or an object with the boolean, the `summary` line that every
  surface prints verbatim, and the `details` paragraph behind the "Details"
  link of a check run (`BaseFactValue`). `changedBy` is the change source of
  the fact.
- `policy.derivedFact(name)` declares a derived fact, which takes its rules
  from `.when()` and `.unless()`.
- `policy.triageHidden` is the Hidden bucket of the triage report, and
  `policy.weeklyDigest` is the digest comment. An output takes `.when()` and
  `.unless()` like a derived fact, and it cannot be passed to them.
- A check run is not an output. `predicates/index.ts` lists the checks that
  have a check run, each with the conclusion of the run when the fact of the
  check holds: `failure`, or `neutral` for a check that is not strict enough
  to fail CI. The run concludes `success` when the fact does not hold.
- A check "applies" to a PR when `pr-nudge` publishes a check run of the
  check for it. A check with a check run applies to every PR, unless the
  policy declares the fact `<id>_applies`, and then it applies to the PRs
  that the fact holds for. The policy declares it for the linked-issue check
  as a derived fact with one veto for each exemption. Its reason reads a base fact that holds for
  every PR, because a veto alone gives a fact no reason to hold:

  ```typescript
  policy
    .derivedFact(appliesFactName('no_linked_issue'))
    .when(isPullRequest)
    .unless(missingIssueLabel)
    .unless(linkedIssueExempt);
  ```

Every statement records data and evaluates nothing. `policy.ts` loads the
policy as a rule set and exports the rule set and not the policy, so no other
module can add a fact or a rule. It checks the rule set
once when the package loads (`src/rules/startup-check.ts`): a dependency cycle, an
output that no person can clear, or a rule that never holds stops every
consumer before it queries GitHub. `policy.ts` also stops every consumer when
a check ID in `CHECK_IDS` is not the name of a base fact. The decision tables in
[`docs/decision-tables/`](docs/decision-tables/README.md) are for a person, and no tool reads them. The test
`src/decision-tables.test.ts` generates them from the same rule set and fails
when a committed file differs, so a change of the rules shows as a diff of
the tables. `pnpm run decision-tables` in `packages/checks` runs that test in
the mode that writes the files.

`ruleSet.evaluate(pr, { now })` evaluates the rules for one PR and returns a
`Verdict`, which every consumer reads directly:

| Member                | Meaning                                                                 |
| --------------------- | ----------------------------------------------------------------------- |
| `factsThatHold`       | The names of the facts that hold                                        |
| `outputsThatHold`     | The names of the outputs that hold                                      |
| `rulesThatHold`       | The rules that hold                                                     |
| `holds(fact)`         | Whether one fact holds, asked with the fact object                      |
| `reasons(conclusion)` | The premise texts of the reasons that held for the conclusion           |
| `vetoes(conclusion)`  | The premise texts of the vetoes that held for the conclusion            |
| `summary(factName)`   | The `summary` of a base fact whose predicate returned one, or undefined |
| `details(factName)`   | The same for the `details`                                              |

A consumer passes the fact object to `holds()`
(`verdict.holds(mergeConflict)`) and prints the summary of the
fact. Code that handles every check in a loop takes the fact from
`CHECK_FACTS`, which holds the base fact of each check by check ID. To say why an output holds,
`supportingFacts(verdict, output)` returns the base facts that
make the output hold, directly or through a derived fact, and have a
summary: the triage report names them as the reasons of the Hidden bucket,
and the digest prints one line for each. `checkRunConclusion(id, verdict)`
is the conclusion of the check run of a check, or undefined when the check
has no check run or does not apply to the PR.

Three properties keep the checks trustworthy:

1. **Pure.** No I/O, no `new Date()` without an injected `now`, no logging.
   Side effects belong in the action subfolder that consumes the result.
2. **Idempotent inputs.** A predicate takes the _current_ state of a PR
   (not the event that just fired). Re-running on the same `PullRequest`
   always returns the same result. See "State-based, not event-reactive" in
   the RFC for why this matters.
3. **Surface-declarative.** A rule doesn't _do_ anything — it _declares_
   what should happen. The consumer interprets the declaration and decides
   whether to actually emit, given its own dry-run state, permission scope,
   and rate-limit budget.

The full set of checks: `dco_missing`, `ci_failing`, `merge_conflict`,
`stale_on_author`, `over_quota`, `description_empty`, `no_linked_issue`,
`no_tests_for_code_change`, `unresolved_from_reviewer`,
`resolved_without_reply`. To add a check, export its
predicate from a new file in `src/predicates/`, declare its base fact and its
rules in `src/policy.ts` with the ID of the check as the name of the fact, and add
its ID to `CHECK_IDS` in `types.ts`. A check with a check run is also listed
in `CONCLUSION_WHEN_CHECK_HOLDS` in `predicates/index.ts`.

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
│ ruleSet.evaluate │   ← packages/checks/src/policy.ts
└────────┬─────────┘
         │ Verdict
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
├── src/index.ts        thin glue: parse inputs, fetch PR, evaluate the rules, emit Check Runs
├── dist/index.js       COMMITTED — @vercel/ncc bundle of src + deps
└── tsconfig.json
```

The `dist/index.js` file is committed. That's how GitHub JS actions ship:
the workflow `uses: jaegertracing/maintainer-tools/pr-nudge@<sha>` clones
the action subfolder at that ref and runs `dist/index.js` directly — no
`make install`, no build step on the consumer side. The `lint-build` CI
job rebuilds and fails on `git diff --quiet pr-nudge/dist`, which is what
guarantees the committed bundle matches its source.

An action subfolder is intentionally a _thin_ layer:

- Parse `with:` inputs via `@actions/core`.
- Resolve the PR reference from the event payload (`pull_request`,
  `issue_comment` on a PR, …).
- Call `fetchPullRequest` from the shared library.
- Call `ruleSet.evaluate(pr, { now })` from the shared library.
- Read the facts of the verdict and dispatch to the appropriate surface
  (Check Run, label, comment).

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

1. **Checks panel** — primary. Every requested check that has a check run and applies becomes
   a `checks.create` call on the PR's head SHA. Zero notifications,
   native UI affordance.
2. **Labels** — state. `waiting-for-author`, `awaiting-maintainer-input`,
   `pr-quota-reached`. Searchable, filterable. Currently read-only;
   write support lands in P5 (`pr-nudge` migration) and P6 (`pr-quota`).
3. **Comments** — rare. Weekly digest, slash-command acks, `over_quota`'s
   one-shot explanation. Every bot comment ends with an HTML-comment
   footer the bot uses to find and **edit in place** rather than reposting.

The mapping from a fact to a surface is fixed by the rules, not the
consumer. `packages/checks/src/policy.ts` declares `policy.weeklyDigest.when(fact)` for a check
that appears in the digest; no check calls into the digest writer.

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

## Triage CLI: gathering and deciding

A triage run is two layers with one data structure between them:

```
GitHub, cache, clock ──▶ gatherSnapshot() ──▶ TriageSnapshot ──▶ classifySnapshot() ──▶ renderers
                         cli/src/snapshot.ts                      cli/src/triage-policy.ts
```

- **Gathering** is the only layer that talks to GitHub, uses the SQLite
  cache or reads the clock. `gatherSnapshot()` returns a `TriageSnapshot`:
  the open PRs as fetched, the merged-PR counts of the authors that can
  exceed a quota, the metadata of the issues that the PRs claim to close,
  the permission of each collaborator, the viewer, and the time of the run.
  A PR carries the issues that GitHub closes when it is merged, as
  `linkedIssues`, and the text of each comment that
  `packages/checks/src/policy-comments.ts` recognizes as a policy comment.
  No rule reads these inputs. They are gathered for the lifecycle policies
  of RFC 0003.
- **Deciding** is `classifySnapshot()`, a function of the snapshot and the
  config. It computes the issue collisions, and it classifies every PR. It
  passes the open PRs of the snapshot and the merged-PR counts to the rules
  as `openPullRequests` of the predicate context, because the quota of an
  author is a property of the set and not of one PR.

`cli/src/quota.ts` gathers the merged-PR counts with `fetchMergedCounts()`,
and the `over_quota` check decides the quota from them in
`packages/checks/src/quota.ts`. A consumer that does not gather the open PRs
as a set, such as `pr-nudge` and the weekly digest, evaluates a PR without
`openPullRequests`, so for it the quota is decided by the `pr-quota-reached`
label alone. `cli/src/issues.ts` has a part in both layers, so it has one
function for each: `fetchIssueMeta()` and `attachIssueState()`.

### Comparing two versions of the classifier

`triage --save-snapshot <file>` writes the snapshot, and
`triage --snapshot <file>` skips the gathering and decides from the file. A
change that must not alter the report is therefore checked against real data:
one run saves its snapshot, and each version of the code classifies that file
and writes the JSON report:

```bash
make triage ARGS="--save-snapshot /tmp/snapshot.json"
make triage ARGS="--snapshot /tmp/snapshot.json --format json --output /tmp/before.json"
# switch to the changed code
make triage ARGS="--snapshot /tmp/snapshot.json --format json --output /tmp/after.json"
diff /tmp/before.json /tmp/after.json
```

The JSON report holds, for each repository, the number of every PR with what
was decided for it: its bucket, its reasons, its flags, its facets, its
Copilot verdict and the result of each predicate. The fetched PR is not in
the report, because it is in the snapshot. Repositories, PRs and object keys
are sorted, and the report carries no time of the run, so an empty `diff`
means that both versions classified every PR the same way. Both runs must use
the same config, because the maintainers, the priority authors and the
CODEOWNERS paths are inputs of the classification. A run with `--snapshot`
needs no token and no cache, and it rejects the flags that control the
gathering, such as `--limit` and `--pr`.

## Triage CLI: bucket classifier

`cli/src/buckets.ts` is a pure function that lands every open PR in
exactly one of nine priority-ordered buckets:

1. **priority-authors** — author is another user in the configured `maintainers`,
   `interns`, or `priorityAuthors` list. Actionable PRs remain in this bucket
   throughout review.
2. **review-requested-on-you** — viewer in `reviewRequests`. The request
   overrides every hide rule. This signal is disabled entirely when
   `TriageConfig.ignoreReviewRequestedOnYou` is `true` (GitHub review
   requests carry no trust signal — anyone, including the PR author, can
   send one).
3. **changes-requested-revised** — viewer requested changes, and the author
   has pushed or commented since.
4. **youre-the-bottleneck** — viewer has reviewed previously, author has
   pushed or commented since.
5. **first-timer-awaiting** — `authorAssociation` is `FIRST_TIME_*`, no
   maintainer activity yet.
6. **codeowners-hits** — PR files match the viewer's configured CODEOWNERS
   globs for the repo.
7. **fyi** — catch-all for open PRs with no stronger signal.
8. **dependency-bots** — author is `dependabot[bot]` / `renovate[bot]` /
   `renovate-bot[bot]`.
9. **hidden** — drafts, bot-authored, `waiting-for-author`, or anything with
   a base fact that makes the `triage_hidden` output hold and has a summary.
   Rendered as its own collapsed section with a `reason` column, not merely
   counted.

Hide rules run before bucket assignment. The lone exception is
`review-requested-on-you`: an explicit review request overrides hide rules
because GitHub's request is treated as a deliberate signal. A priority-author
PR with a review request remains in `priority-authors`. When
`ignoreReviewRequestedOnYou` is set, the override and the review-request
bucket are switched off, so hide rules apply unconditionally.

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

| Want to…                | Touch…                                                                                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add a new check         | New predicate file in `packages/checks/src/predicates/`, its fact and rules in `packages/checks/src/policy.ts`, its ID in `CHECK_IDS` in `types.ts` |
| Expose a new PR field   | Extend `PullRequest` in `types.ts` + the GraphQL query in `graphql.ts`                                                                              |
| Add a new action        | New top-level `<tool>/` subfolder following `pr-nudge/`'s layout                                                                                    |
| Change a surface        | Which facts lead to it: the rules in `packages/checks/src/policy.ts`. How it is written: each action's `src/index.ts`                               |
| Add a new event trigger | Update `resolvePrRef()` in the relevant action; document in `action.yml`                                                                            |
| Add/rebalance a bucket  | `cli/src/buckets.ts` — adjust `BUCKET_ORDER` and the branches in `classify()`                                                                       |
| Adjust HTML look        | `cli/src/render/html.ts` — CSS is inlined at the bottom of the file                                                                                 |

## See also

- [`docs/rfc/0001-maintainer-pr-triage-tooling.md`](docs/rfc/0001-maintainer-pr-triage-tooling.md) — full design rationale, predicate table, implementation phases.
- [`AGENTS.md`](AGENTS.md) — contributor and AI-agent instructions: build/lint commands, commit conventions, DCO sign-off requirement.
