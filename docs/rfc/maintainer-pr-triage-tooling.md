# RFC: Maintainer PR Triage and Nudge Tooling

* **Status**: RFC
* **Last Updated**: 2026-05-18

---

## TL;DR

A single TypeScript codebase, with a shared library of PR-state predicates, that powers two consumers:

1. **Triage** — a personalized HTML report that surfaces the PRs a maintainer should look at *now*, grouped by repo and by attention category.
2. **Nudge** — a writer that publishes per-PR check status to the **GitHub Checks panel**, manages a small set of state labels, and posts at most one weekly digest comment per stuck PR.

The tool absorbs the two bespoke JS scripts the org currently curl-fetches from `jaegertracing/jaeger/.github/scripts/` (`waiting-for-author.js`, `pr-quota-manager.js`) and ships from this repo (`jaegertracing/maintainer-tools`) as a set of **GitHub Actions** in per-tool subfolders, consumed via `uses: jaegertracing/maintainer-tools/<tool>@vX.Y.Z`. No marketplace listing required for cross-repo `uses:` to work. `actions/stale` and other third-party action configs are left alone.

---

## Context & Problem

A maintainer's actual questions about open PRs aren't first-class queries on GitHub:

- *Whose PRs am I currently blocking?*
- *Which first-time contributors are still awaiting a first response?*
- *Which PRs are technically ready for review but have a mechanical issue (DCO, red CI, conflict, missing label) that I shouldn't have to flag by hand?*
- *Which review conversations did the author silently mark resolved without addressing them?*
- *Which PRs from a high-trust author should jump the queue?*

All five are derivable from the GraphQL API, but every maintainer reinvents the derivation in their head every time. The result is the org defaulting to GitHub email — a non-discriminate firehose — for triage, and to a scatter of one-off workflows (each with its own JS file curl-fetched from a central repo) for nudging.

Crucially, *deciding* "this PR is ready for human attention" and *deciding* "this PR needs a mechanical nudge" share the same input signals. Splitting them into independent tools forces each to compute the same predicates ("is DCO present?", "is CI green?", "has the author replied since the last review?") and creates drift the moment one is updated without the other.

---

## Existing Workflows in Scope

| Workflow | What it does | Status under this RFC |
|---|---|---|
| `waiting-for-author.yml` (`waiting-for-author.js`) | Labels PRs `waiting-for-author` based on which side acted last. | **Migrate** — predicate becomes state-based composite (see Architecture) |
| `pr-quota-manager.yml` (`pr-quota-manager.js`) | Caps how many PRs a single contributor can have open simultaneously. | **Migrate** |
| `stale.yml` (`actions/stale@v9`) | Closes stale issues/PRs after 90d/60d + 14d. | **Keep as-is.** Reimplementing a battle-tested third-party action is no-win. The triage consumer reads the `stale` label it applies. |
| All CI-status workflows (DCO, changelog-label, build, lint, tests, codeql, bundle size) | Produce required red/green status checks. | **Out of scope.** Different operational layer. |

The two migrated scripts share a distribution pattern today: each repo's workflow YAML `curl`s the JS from `jaegertracing/jaeger/.github/scripts/` and runs it under `actions/github-script@v9`. This was a deliberate low-overhead alternative to publishing a marketplace action — but once a dedicated tool repo exists, the same repo can expose `action.yml` files in per-tool subfolders and be consumed via native `uses:` with no marketplace step required. This RFC replaces the curl-fetch with `uses:`.

---

## Goals and Non-Goals

**Goals:**

- Centralize PR-check definitions in one TypeScript module that both triage and nudge consume — no drift.
- Subsume the two bespoke nudge scripts without changing contributor-facing behavior.
- Surface high-priority signals explicitly (review-requested-on-you, blocking-on-you, from-high-trust-author).
- Move mechanical pass/fail off PR comments and into the **GitHub Checks panel**, where the contributor already looks.
- Idempotent: re-running produces the same output for the same state.

**Non-Goals:**

- Reviewing diffs, summarizing PR content, or acting as a merge bot.
- Hosting as a service. Runs on a maintainer's laptop or as a per-repo GitHub Action; no central deployment.
- Replacing third-party actions that already do their job (`actions/stale` etc.).
- Cross-org operation. v1 scope is repos a maintainer explicitly lists.

---

## Architecture

### Language: TypeScript on Node, distributed as GitHub Actions

TypeScript matches the GitHub Actions JS runtime and gives end-to-end typing from `@octokit/graphql-schema` through every check function. Each action is bundled to its own self-contained `dist/index.js` via `@vercel/ncc` and committed alongside its `action.yml`.

Consuming workflows reference each action by its subfolder path:

```yaml
- uses: jaegertracing/maintainer-tools/pr-nudge@v1.2.0
  with:
    rules: waiting_for_author
```

No marketplace listing is required for cross-repo `uses:` to work — the action is consumed straight from the source repo at the pinned tag or SHA. This gets native version pinning, Dependabot/Renovate support, GitHub's pinned-SHA security warnings, and standard `with:` input semantics, all without the listing/discovery overhead that originally pushed the org toward curl-fetch.

### Repo layout

This repo (`jaegertracing/maintainer-tools`, plural — it hosts several actions plus their shared predicate library):

```
jaegertracing/maintainer-tools/
├── packages/
│   └── checks/                   # shared predicate library, GraphQL layer, SQLite cache
├── pr-nudge/
│   ├── action.yml                # event-triggered: synchronize, issue_comment, review
│   └── dist/index.js             # ncc-bundled
├── pr-weekly-digest/
│   ├── action.yml                # cron-triggered
│   └── dist/index.js
├── pr-quota/
│   ├── action.yml                # event-triggered, narrower scope than pr-nudge
│   └── dist/index.js
├── cli/                          # `maintainer-tools triage`, run locally on a maintainer's laptop
└── package.json                  # workspace root
```

Each subfolder's `action.yml` declares its own inputs and bundles only the predicate code it needs from `packages/checks/`. Actions can release at independent semver tags (`pr-nudge/v1.3`, `pr-weekly-digest/v0.2`). The shared library guarantees there's one TypeScript definition of "DCO missing" or "merge conflict" no matter which action consumes it.

The two scripts being migrated currently live in `jaegertracing/jaeger`, a Go repo with no TypeScript infrastructure — not a viable home. A workspace inside `jaegertracing/jaeger-ui` would reuse that repo's existing TS stack but conflates maintainer tooling with the UI app and complicates the action-repo layout. Bootstrap cost of this dedicated repo is modest: tsconfig, Vitest, oxlint, `@vercel/ncc`, per-action `action.yml`, and a release workflow — roughly 1–2 days.

### Predicate library

Each check is a pure function `(pr: PullRequest) => CheckResult`. A `CheckResult` declares which **surfaces** it publishes to, independently of whether it `triggered`:

- `publishesCheck` + `checkConclusion` — emit a GitHub Check Run, visible in the Checks panel.
- `inDigest` — appear in the weekly digest comment for `waiting-for-author > 7d` PRs.
- `hidesFromTriage` — drop the PR from the maintainer's triage report.

The `summary` string is reused verbatim across the Checks panel and the digest so there's no parallel phrasing to maintain. Comments are *not* a per-check surface: the only bot comments are the weekly digest, slash-command acknowledgments, and `quota_exceeded`'s one-shot explanation.

### State-based, not event-reactive

The existing `waiting-for-author.js` reacts to "what just happened" — it fires on `synchronize` or `issue_comment: created` and decides based on the event. This is fragile: out-of-order events, maintainer drive-by comments, and author replies that don't resolve outstanding issues all confuse it.

The proposed `waitingForAuthor` predicate is **a pure function of current PR state**, recomputed on every relevant event. It is the OR of every "author must act first" predicate (`dco_missing`, `ci_failing`, `merge_conflict`, `quota_exceeded`, `description_empty`, "last review requesting changes from a maintainer"). The only side effect is applying or removing the `waiting-for-author` label, fully determined by the predicate result. Idempotent, self-healing on missed events, and the `details.reasons` field lets the triage report and label tooltip explain *why* — `waiting-for-author (ci_failing, dco_missing)` — instead of being a black box.

### Author-question handling

Edge case: an author opens a PR with mechanical issues and writes "I want to discuss approach X before fixing lint." Under the state-based OR they'd be incorrectly flagged `waiting-for-author`. Three layered mechanisms handle this, weakest to strongest:

1. **Heuristic.** If the most recent substantive activity (excluding bots, emoji reactions, CI noise) is an unanswered author comment, `waitingForAuthor` softly returns `triggered=false`. The triage report flags such PRs as `[POSSIBLE-QUESTION]`. Zero contributor action required; catches the common case.

2. **Slash command.** Anyone with comment access — including external contributors who lack label permission — types `/awaiting-input [reason]` in a PR comment. The bot applies the `awaiting-maintainer-input` label (operational model = prow's `/lgtm`, `/hold`, `/wip`). `/no-awaiting-input` clears it, as does pushing new commits (`synchronize` event). The bot's brief acknowledgment confirms the change.

3. **Weekly digest as discoverability lever.** Contributors don't read CONTRIBUTING.md. Once a PR has been `waiting-for-author` ≥ 7 days, the bot posts a single comment per ISO week tagging the author, listing what to address, and explicitly mentioning the slash command: *"If you're waiting on a question to maintainers, comment `/awaiting-input` and we'll move it out of your queue."* Idempotency via `kind=weekly_digest week=YYYY-Www` signature footer — re-running the workflow during the same week edits in place.

While `awaiting-maintainer-input` is set, the PR is not labeled `waiting-for-author`, does not receive the weekly digest, surfaces in the maintainer's triage as `[QUESTION]`, and is exempted from `actions/stale`'s closure countdown (via `exempt-pr-labels`).

### Output surfaces

Three surfaces, in decreasing volume:

- **GitHub Checks panel** (primary). Every mechanical predicate publishes here, side-by-side with CI. The "Details" link expands into a short remediation paragraph. Zero notifications, native UI affordance, no documentation hunt.
- **Labels** (state). `waiting-for-author`, `awaiting-maintainer-input`, `quota-exceeded`, `stale` (read from `actions/stale`). Searchable, filterable, consumed by triage tools.
- **Comments** (rare). Weekly digest, slash-command acks, `quota_exceeded`'s one-shot. Every bot comment ends with an HTML-comment footer `<!-- maintainer-tools: kind=… sha=… -->`; the consumer fetches existing bot comments and edits-in-place rather than reposting (the only correct way to be idempotent against GitHub's append-only comment model).

### Data and auth

One GraphQL query per PR pulls every field every check might need (reviews, conversations, status checks, CODEOWNERS, linked issues, labels, file paths). A local SQLite cache keyed by `(repo, number, updated_at)` keeps steady-state cost near zero — only PRs that changed are re-fetched.

In the GitHub Action context, the tool reads `GITHUB_TOKEN` (or a workflow-provided PAT like today's `secrets.PR_QUOTA_MANAGER_PAT`) and constructs its own Octokit — standard for a JS action. In the local CLI context, a fine-grained PAT from `$GH_TOKEN` (so existing `gh auth` setup works).

---

## Check Predicates

Each predicate declares which surface(s) it publishes to (Check = GitHub Checks panel, Digest = weekly digest, Label = manages a label, Hidden = hides from triage).

| Check | What it detects | Check? | Digest? | Label? | Hidden? |
|---|---|:---:|:---:|:---:|:---:|
| `dco_missing` | A commit on the branch lacks `Signed-off-by` for its author | fail | yes | — | yes |
| `ci_failing` | Status check rollup is FAILURE | reads | yes | — | yes |
| `merge_conflict` | `mergeable === CONFLICTING` | fail | yes | — | no |
| `description_empty` | PR body empty or only template stubs | fail | yes | — | yes |
| `no_linked_issue` | No `Fixes/Closes/Resolves #N` and PR not labeled `docs`/`ci`/`trivial` | neutral | gentle | — | no |
| `no_tests_for_code_change` | Source files changed but no `*_test.*` / `*.test.*` changes | neutral | gentle | — | no |
| `unresolved_from_reviewer` | A reviewer's comment is unresolved and the author has pushed since | neutral | gentle | — | no |
| `resolved_without_reply` | Author marked a conversation resolved with no reply to the reviewer | — | — | — | flag in triage |
| `stale_on_author` | PR carries the `stale` label, or author silent for N days | — | — | reads `stale` | yes |
| `stale_on_you` | You're a requested reviewer, last activity > N days ago, was from author | — | — | — | no (own bucket) |
| `bot_authored` | Author login is `renovate[bot]`, `dependabot[bot]`, etc. | — | — | — | yes |
| `waiting_for_author` *(migrated)* | OR of "author must act" predicates; suppressed by `awaiting-maintainer-input` label or the unanswered-author-comment heuristic | — | — | manages `waiting-for-author` | yes (unless suppressed) |
| `quota_exceeded` *(migrated)* | PR carries `quota-exceeded` label or author has > M open PRs in repo | — | — | manages `quota-exceeded`. Posts a one-shot comment when the cap is first hit. | yes |

The two migrated checks default to the same contributor-facing behavior as their current JS implementations to avoid regressions during cutover. `stale_on_author` is triage-only — `actions/stale` continues to own the nudge half.

---

## Triage Report

### Output: HTML

The triage consumer writes a single self-contained HTML file (no external assets, all CSS inline). HTML rather than markdown because:

- `<details>` / `<summary>` give native collapsibility for dense buckets (FYI, CODEOWNERS hits, Hidden) without scroll fatigue.
- Real hyperlinks to PRs, authors, and review conversations work on click.
- Visual density (badges, color-coded staleness, two-column layout) is achievable without a build step.
- The file is double-clickable from the desktop and serves from `~/Documents/triage.html` without needing a viewer that renders markdown.

A `--format=markdown` flag exists for piping into chat or email; `--format=terminal` exists for SSH sessions.

### Layout

The HTML is organized **by repository first, then by attention category within each repo**. This matches how a maintainer context-switches: one repo at a time, with all the categories visible at once for that repo before moving to the next.

Each PR row carries the same columns: `#number`, line-count diff, title, author with role tag, **author's open-PR count in this repo**, inline flags, and time-waiting. The open-PR count gives the maintainer a quick signal about contributor cadence — a regular contributor with 5 open PRs is a different review context than a one-shot 1-PR drive-by, and it doubles as visible confirmation of quota state at a glance.

```
[Header: "PR Triage — 2026-05-16 09:00 — @yurishkuro"]

[Repo: jaegertracing/jaeger]                        12 / 47 visible
  ▸ Review requested on you (3)                     [expanded by default]
      - #6543  [+412/-87]  Add OTLP gRPC retry middleware  — @alice (maintainer) [3 open]  — 2d
      - #2987  [+34/-12]   Fix span color regression       — @bob [1 open]                  — 6h
      - #412   [+8/-0]     Add v3 protobuf field           — @carol (intern) [2 open] [BLOCKER]  — 4d
  ▸ You're the bottleneck (1)                       [expanded]
      - #6501  [+1203/-450]  Refactor query service       — @dave [5 open]  — author replied 18h ago
  ▸ High-trust authors awaiting first response (2)  [expanded]
  ▸ First-time contributors awaiting first response (1) [expanded]
  ▸ CODEOWNERS hits (4)                             [collapsed]
  ▸ FYI (6)                                         [collapsed]
  ▸ Hidden (23: waiting=18, drafts=2, bots=3)       [collapsed]

[Repo: jaegertracing/jaeger-ui]                     4 / 19 visible
  ▸ Review requested on you (1)                     [expanded]
      …
  ▸ FYI (2)                                         [collapsed]
  ▸ Hidden (15)                                     [collapsed]

[Repo: jaegertracing/jaeger-idl]                    0 / 3 visible
  (empty — only Hidden contains anything)
```

Top of each repo block shows "visible / total" so a glance tells the maintainer whether a repo needs attention at all. Empty buckets are omitted entirely; the four high-priority buckets default expanded, the lower-signal buckets default collapsed but with a count.

### Attention categories (within each repo)

1. **Review requested on you.** Someone clicked your name in Reviewers. Single strongest signal.
2. **You're the bottleneck.** You're a listed reviewer and last activity is the author/contributor — ball is in your court. Includes PRs you previously reviewed where the author has since pushed or replied.
3. **High-trust authors awaiting first response.** PR author is in `maintainers` or `interns`, no maintainer has commented or reviewed yet.
4. **First-time contributors awaiting first response.** Their first contribution to the org, no maintainer response. Surfaced separately because the cost of ignoring a first-timer is contributor loss, not delay.
5. **CODEOWNERS hits.** PR touches files in your CODEOWNERS paths; not explicitly requested.
6. **FYI.** Open PRs not in any of the above.
7. **Hidden.** Counts only. `waiting-for-author`, drafts, bot-authored (with separate auto-merge-eligible count). Not actionable until the contributor moves.

Within each bucket, PRs sort by staleness (oldest first). Per-row fields: `[+X/-Y]` line counts; `[N open]` author's open-PR count in this repo; inline flags `[BLOCKER]` (release-blocker label or current milestone), `[RESOLVED-W/O-REPLY: N]`, `[QUESTION]` (`awaiting-maintainer-input`), `[POSSIBLE-QUESTION]` (heuristic).

---

## Implementation Plan

Phases are ordered by dependency, not calendar. **Dry-run is a rollout
*mode*, not a phase**: every action that writes to GitHub (P4 onward)
ships with `dry-run: true` as its default, runs in that mode for 2–4
weeks against real PR state, and gets a follow-up PR that flips the
default once a maintainer is satisfied with the log output. The same
decision tree executes either way; only the final HTTP mutation is
gated.

The check predicates (P3) land *before* the workflow migrations (P4/P5)
because every new check is consumed by the triage CLI immediately — they
need no GitHub writes — and the migrations want the full predicate set
available so they don't regress signal coverage when they replace the
existing JS.

| Phase | Scope |
|---|---|
| **P0** ✅ | New `jaegertracing/maintainer-tools` repo. Workspace layout, shared `packages/checks/` predicate library + Octokit GraphQL data layer + SQLite cache (`node:sqlite`). Four most-load-bearing checks (`dco_missing`, `ci_failing`, `merge_conflict`, `stale_on_author`). First action subfolder (`pr-nudge/`) with its `action.yml`, committed `dist/index.js` built by `@vercel/ncc`. |
| **P1** ✅ | Triage HTML output. All seven attention buckets, hide rules wired to predicate library, dependency-bots split out from generic-bot Hidden. CLI-side quota enrichment so the first-timer bucket is accurate without depending on the upstream `pr-quota-reached` label. Run locally; zero contributor-visible risk. |
| **P2** ✅ | Shared comment publisher in `packages/checks/`. Pure helpers (`formatFooter`, `parseFooter`, `bodyHash`, `isoWeek`) plus a `publishComment({kind, scope, body}, client, {dryRun})` writer that does the read → footer-parse → render → SHA-hash → POST/PATCH/SKIP decision in one place. Every later phase that posts or edits a PR comment consumes this module — without it, P4's slash-command acks, P5's quota one-shot, and P5.5's weekly digest would each reinvent the same idempotency logic. `--dry-run` is a flag on the publisher; the decision tree runs identically, only the mutation step is replaced with a log line. |
| **P3** | Net-new check predicates: `description_empty`, `no_linked_issue`, `no_tests_for_code_change`, `unresolved_from_reviewer`, `resolved_without_reply`. (`bot_authored` is already covered by the classifier's existing dep-bot / generic-bot split.) Implemented in `packages/checks/src/predicates/`, wired into the triage CLI's classifier as hide-rules or per-row flags as appropriate. Local-only; no contributor-visible surface — the Checks-panel and digest outputs come later when the actions land. Each ships as `triggered: bool` only; calibration data over a few weeks of triage reports decides whether they're ready to surface on contributor-facing channels. |
| **P4** | Migrate `waiting-for-author.yml`. Replace the `curl + actions/github-script` block with `uses: jaegertracing/maintainer-tools/pr-nudge@vX.Y.Z` configured for the `waiting_for_author` rule. State-based composite predicate, heuristic suppression of unanswered-author-comment PRs, slash-command handler (`/awaiting-input` / `/no-awaiting-input`) for the `awaiting-maintainer-input` label — using the P2 publisher for the ack comments. Ship with the `dry-run` default on; compare would-be label transitions against the existing JS for ≥ 1 week of real events before flipping. Same change applied to every consuming repo's workflow YAML in the same wave. |
| **P5** | Add `pr-quota/` action subfolder. Migrate `pr-quota-manager.yml` to `uses: jaegertracing/maintainer-tools/pr-quota@vX.Y.Z`. Preserve `workflow_dispatch` + `dryRun` input. Quota math moves from `cli/src/quota.ts` into `packages/checks/` so the action and the CLI share one policy implementation (the CLI's existing computation pre-figures this — same tiers, same `pr-quota-reached` label). One-shot blocking / unblocking comments use the P2 publisher (`kind=quota_blocked` / `kind=quota_unblocked`). Same dry-run default rollout. |
| **P5.5** | Add `pr-weekly-digest/` action subfolder. New `maintainer-tools-weekly-digest.yml` workflow with `uses: jaegertracing/maintainer-tools/pr-weekly-digest@vX.Y.Z` on a daily cron; one digest comment per PR per ISO week, idempotent via the P2 publisher's `kind=weekly_digest week=YYYY-Www` footer (same-week reruns edit in place, next-week run posts fresh). Same dry-run default rollout. P3's checks are what populate the digest body, so this phase mostly wires the cron, not new signal. |
| **P6** *(optional)* | Cross-maintainer dashboard summarizing buckets for the whole maintainer group. Build only if maintainers want it. |

After P5, `stale.yml` is untouched. The two migrated workflow files (`waiting-for-author.yml`, `pr-quota-manager.yml`) stay in place — their `curl + actions/github-script` blocks are replaced by a single `uses: jaegertracing/maintainer-tools/<tool>@vX.Y.Z` step. Once all consuming repos migrate, the old JS files in `jaegertracing/jaeger/.github/scripts/` are deleted (or frozen at a `v0` tag for laggard repos still curl-fetching).

---

## Risks and Open Questions

- **False positives.** A bot publishing a failing Check or a digest line on a correctly-signed-off PR is reputationally damaging. Per-check comments are eliminated in favor of the once-per-week digest *specifically* because comments are far more visible than Checks panel entries. Heuristic checks (`no_tests_for_code_change`, `resolved_without_reply`) ship as `neutral` with `inDigest: false` until calibration. Every rule has a per-repo opt-out.

- **Migration regression.** The two migrated scripts currently work; the replacement must match, not approximate. For P4 and P5, run dry-run alongside the existing script for ~50 real PR events, diff would-be outputs, only flip after the diff is empty or explainable.

- **Cross-repo cutover coordination.** The JS files are consumed by every Jaeger-org repo. Migrating one repo to `uses:` while others still curl-fetch the old JS leaves two implementations running side-by-side. Mitigation: migrate the central `jaegertracing/jaeger` repo first (or in the same wave), and freeze the old JS at a `v0` tag — so any laggard repo continues to work unchanged until it's ready to switch to `uses:`. The new `uses:` syntax also makes per-repo version pinning explicit (Renovate/Dependabot will surface upgrade PRs), so subsequent rollouts are visible rather than implicit.

- **Governance of bot comments.** A bot comment is the project speaking. The RFC process for adding a new check should require sign-off from at least two maintainers on the comment text.

- **MAINTAINERS.md drift.** If the high-trust user list isn't kept current, the "high-trust authors" bucket misclassifies. Mitigation: a `pr-tool sync-maintainers` subcommand and a triage-report warning when last sync > 14 days ago.

- **Heuristic edge cases.** "Last substantive activity is unanswered author comment" misclassifies an author musing aloud. "Conversation resolved without reply" misclassifies a typo-fix the author resolved via commit. Both default to non-nudge surfacing (flag in triage, no Checks-panel failure) until per-repo data shows otherwise.

- **Out of scope, future work.** Issues triage (assigned-to-me, mentioning-me, unlabeled-new-bugs); org-wide GitHub App rather than per-maintainer install; first-time contributor welcome comment.

---

## References

- `.github/workflows/waiting-for-author.yml`, `.github/workflows/pr-quota-manager.yml` (in each consuming repo) — workflows whose `script:` blocks are replaced by `uses: jaegertracing/maintainer-tools/<tool>@vX.Y.Z`.
- `https://github.com/jaegertracing/jaeger/.github/scripts/` — current location of the curl-fetched JS files being retired.
- `.github/workflows/stale.yml` — kept as-is; the maintainer tool reads the `stale` label this action applies.
- [GitHub GraphQL v4 API](https://docs.github.com/en/graphql) and [Checks API](https://docs.github.com/en/rest/checks/runs) — primary data sources / output.
- [GitHub JavaScript Action structure](https://docs.github.com/en/actions/sharing-automations/creating-actions/creating-a-javascript-action) — `action.yml` + committed `dist/index.js` pattern.
- [Prow command reference](https://prow.k8s.io/command-help) — operational model for slash commands.
- [`@vercel/ncc`](https://github.com/vercel/ncc) — bundles TS + deps into the single JS file each action ships.
- `MAINTAINERS.md`, `CODEOWNERS`, `CONTRIBUTING.md` (in each consuming repo) — source-of-truth files the tool reads.
