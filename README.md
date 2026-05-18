# Maintainer PR Triage and Nudge Tooling

A set of small tools that answer the questions a maintainer actually has
about their open PRs:

- _Whose PRs am I currently blocking?_
- _Which contributors need a nudge to keep moving?_
- _Which mechanical problems (missing DCO, red CI, merge conflict, …) should
  the contributor see without me flagging by hand?_

Everything here builds on one shared library of PR-state **predicates** so
the triage report and the bot nudges agree on what "stuck" means. The
predicates are pure functions of a PR's current GraphQL state — no
event-reactive logic, no surprises on re-runs.

## What's shipped

| Component                                                        | Lives in            | Who runs it                     | Output                                                                                      |
| ---------------------------------------------------------------- | ------------------- | ------------------------------- | ------------------------------------------------------------------------------------------- |
| **[Triage report (CLI)](#triage-report-cli)**                    | `cli/`              | A maintainer, locally on demand | Self-contained HTML file grouping open PRs by attention category                            |
| **[`pr-nudge` action](#pr-nudge-github-action)**                 | `pr-nudge/`         | GitHub Actions, per PR event    | GitHub Checks panel entries summarising mechanical issues                                   |
| **[`pr-weekly-digest` action](#pr-weekly-digest-github-action)** | `pr-weekly-digest/` | GitHub Actions, daily cron      | One PR comment per `waiting-for-author` PR per ISO week, edited in place when state changes |

All three consume the same [predicate catalog](#predicate-catalog).

---

## Triage report (CLI)

A maintainer-local command that scans the GitHub repos you configure,
classifies every open PR into one of several attention buckets, and writes a
self-contained HTML file you double-click open.

Never writes anything back to GitHub.

### Quickstart

```bash
git clone https://github.com/jaegertracing/maintainer-tools
cd maintainer-tools
npm ci
```

No build step — the CLI runs straight from TypeScript source via
[`tsx`](https://github.com/privatenumber/tsx). Edits to the CLI or the
shared library take effect on the next `npm run triage`.

Make a config file at `~/.config/maintainer-tools/config.json`:

```json
{
  "viewer": "your-github-login",
  "repos": ["jaegertracing/jaeger", "jaegertracing/jaeger-ui"],
  "maintainers": ["yurishkuro", "albertteoh", "..."],
  "interns": [],
  "codeowners": {
    "jaegertracing/jaeger": ["cmd/jaeger/**", "internal/**"]
  },
  "priorityLabels": ["priority:high", "priority:medium", "priority:low"]
}
```

Authenticate `gh` (or set `$GH_TOKEN` / `$GITHUB_TOKEN`):

```bash
gh auth login
```

Then run:

```bash
npm run triage
# → writes ./triage.html (and logs progress to the terminal)
open triage.html
```

### Configuration

The CLI looks for a JSON config in this order:

1. `--config <path>` on the command line.
2. `$MAINTAINER_TOOLS_CONFIG` environment variable.
3. `./.maintainer-tools.json` in the current directory.
4. `~/.config/maintainer-tools/config.json` (respects `$XDG_CONFIG_HOME`).

Schema:

| Field            | Type                  | Description                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repos`          | `string[]` (required) | Repos to scan, `"owner/name"` form.                                                                                                                                                                                                                                                                                                                                                                                                            |
| `viewer`         | `string`              | Your GitHub login. If omitted, the CLI fetches it via the `viewer` GraphQL query.                                                                                                                                                                                                                                                                                                                                                              |
| `maintainers`    | `string[]`            | Logins whose review or comment activity counts as "a maintainer has engaged" for the "awaiting first response" buckets, AND whose PRs are quota-exempt.                                                                                                                                                                                                                                                                                        |
| `interns`        | `string[]`            | Logins whose PRs surface in the high-trust-author bucket and are quota-exempt. Unlike `maintainers`, intern activity on other PRs does NOT count as a maintainer response — put reviewer logins in `maintainers`, not here.                                                                                                                                                                                                                    |
| `codeowners`     | `{[repo]: string[]}`  | Per-repo path globs you co-own; PRs touching matching files appear in the CODEOWNERS-hits bucket. Glob syntax: `*` (one segment), `**` (any depth).                                                                                                                                                                                                                                                                                            |
| `cachePath`      | `string`              | Override the on-disk SQLite cache path. Default: `$XDG_CACHE_HOME/maintainer-tools/pr-cache.sqlite`.                                                                                                                                                                                                                                                                                                                                           |
| `priorityLabels` | `string[]`            | Ordered list of GitHub labels used as priority tiers, highest to lowest (e.g. `["priority:high", "priority:medium", "priority:low"]`). When non-empty, the report adds a **priority grouping level** between repo and bucket: each PR is placed in the first matching tier; PRs carrying none of the listed labels fall into a separate **(no priority)** group rendered last. When omitted or empty, the report renders the flat bucket view. |

Starter files: [`cli/config.example.json`](cli/config.example.json) (generic template) and [`cli/config.example.jaeger.json`](cli/config.example.jaeger.json) (Jaeger org).

For the available command-line flags, run:

```bash
npm run triage -- --help
```

Token resolution (in order): `$GH_TOKEN`, `$GITHUB_TOKEN`, `gh auth token`.

### What the report looks like

Each repo gets its own block. Within a repo, PRs are split into
priority-ordered buckets. High-signal buckets are expanded by default,
low-signal ones collapsed.

When `priorityLabels` is configured, an additional grouping level sits between
the repo header and the bucket sections. PRs are grouped by priority tier
first (in the order the labels appear in the config), then further split into
the usual buckets within each tier. PRs that carry none of the configured
labels are collected under **(no priority)** and rendered last, visually
de-emphasized. This lets maintainers focus on high-priority work while still
seeing the full picture in a single report.

| Bucket                                              | What it means                                                                                                                                                                                                                                       | Default state |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| **Review requested on you**                         | Someone added you to the Reviewers field.                                                                                                                                                                                                           | Expanded      |
| **You're the bottleneck**                           | You've reviewed this PR before; the author has acted since (commit pushed or commented).                                                                                                                                                            | Expanded      |
| **High-trust authors awaiting first response**      | Author is a maintainer / intern; no maintainer has engaged yet.                                                                                                                                                                                     | Expanded      |
| **First-time contributors awaiting first response** | Author's `authorAssociation` is `FIRST_TIME_*`; no maintainer has engaged yet.                                                                                                                                                                      | Expanded      |
| **CODEOWNERS hits**                                 | PR touches files matching your configured codeowner globs.                                                                                                                                                                                          | Collapsed     |
| **FYI**                                             | Catch-all for everything else open.                                                                                                                                                                                                                 | Collapsed     |
| **Dependency bots**                                 | Author is `dependabot[bot]` / `renovate[bot]` / `renovate-bot[bot]`.                                                                                                                                                                                | Collapsed     |
| **Hidden**                                          | Not actionable until the contributor moves. Drafts, non-dependency bots, and any PR a predicate marked as hide-from-triage (DCO missing, CI red, merge conflict, quota-exceeded, stale, empty description). Shown collapsed with a `reason` column. | Collapsed     |

An explicit review request on you **overrides** every hide rule — if a
maintainer tagged you, you'll see the PR even if it has merge conflicts.

Each row also carries inline **flags** when relevant:

| Flag                    | Meaning                                                                    |
| ----------------------- | -------------------------------------------------------------------------- |
| `BLOCKER`               | PR labelled `release-blocker` / `blocker`.                                 |
| `QUESTION`              | PR labelled `awaiting-maintainer-input`.                                   |
| `MERGE-CONFLICT`        | `mergeable === CONFLICTING`.                                               |
| `STALE`                 | Activity older than the staleness threshold.                               |
| `NO-ISSUE`              | No `Fixes/Closes/Resolves #N` in the body.                                 |
| `NO-TESTS`              | Source files changed but no test files touched.                            |
| `UNRESOLVED`            | Unresolved review thread with new commits since the last reviewer comment. |
| `RESOLVED-W/O-REPLY: N` | Author resolved `N` threads without replying to the reviewer.              |
| `DRAFT`                 | PR is a draft.                                                             |
| `BOT`                   | Bot author.                                                                |

### How fresh the data is

The CLI keeps an on-disk SQLite cache keyed on `(owner, repo, number,
updatedAt, headSha, headRollup)`. A PR is re-fetched if any of those
changed — that includes CI status flipping on the head commit, even when
GitHub doesn't bump `updatedAt`. Use `--no-cache` to force a full refresh.

---

## `pr-nudge` GitHub Action

Runs the predicate library on a single PR and publishes a **GitHub
Checks panel** entry for each predicate that opts into that surface (the
mechanical pass/fail ones — see the [catalog](#predicate-catalog)).
Predicates that don't publish a Check Run are still evaluated and
logged. Triggered per PR event.

The Checks panel is the right place for mechanical pass/fail signals
because (a) the contributor already looks there for CI status,
(b) it doesn't produce notifications, and (c) it doesn't clutter the PR
conversation.

### Use it from your workflow

```yaml
# .github/workflows/pr-nudge.yml
name: 'PR Nudge'

# `pull_request_target` (not `pull_request`) so workflows triggered by
# fork PRs receive a write-scoped GITHUB_TOKEN — the default
# `pull_request` event gives forks a read-only token, which would
# silently strip `checks: write` and the action would 403. pr-nudge
# never checks out the PR's code, so the usual `pull_request_target`
# caveat (don't execute untrusted code with elevated permissions)
# doesn't apply.
on:
  pull_request_target:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  checks: write

jobs:
  nudge:
    runs-on: ubuntu-latest
    steps:
      - uses: jaegertracing/maintainer-tools/pr-nudge@v0.1.0
        with:
          rules: dco_missing,ci_failing,merge_conflict
```

Pin the `@ref` to a tagged release for stability; Renovate / Dependabot
will surface upgrade PRs.

### Inputs

| Input          | Default                                                 | Description                                                                                                                                                                                                                                        |
| -------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github-token` | `${{ github.token }}`                                   | Token for reads and Check Run writes.                                                                                                                                                                                                              |
| `rules`        | `dco_missing,ci_failing,merge_conflict,stale_on_author` | Comma-separated predicate IDs to run. Defaults to the four most load-bearing predicates; pass the explicit list to opt into more (e.g. `description_empty,no_linked_issue,no_tests_for_code_change`). See [Predicate catalog](#predicate-catalog). |
| `dry-run`      | `false`                                                 | If `true`, log every would-be Check Run but don't create them.                                                                                                                                                                                     |

### What it does

1. Resolves the PR from the triggering event (`pull_request` /
   `pull_request_target` / `issue_comment` on a PR).
2. Fetches the PR via one GraphQL query.
3. Runs the requested predicates.
4. Publishes one Check Run on the PR's head SHA per predicate that
   declares `publishesCheck: true` (currently `dco_missing`,
   `merge_conflict`, `description_empty`, `no_linked_issue`,
   `no_tests_for_code_change`).

Predicate results are **state-based**: re-running on the same PR state
produces the same Check Runs, so out-of-order events and missed webhooks
self-heal.

---

## `pr-weekly-digest` GitHub Action

Cron-driven action that nudges contributors whose PR has been stuck
waiting on them. Posts one digest comment per PR per ISO week, listing
what to address; edits in place when the situation changes mid-week;
collapses last week's comment when a new week's posts.

### Use it from your workflow

```yaml
# .github/workflows/pr-weekly-digest.yml
name: 'PR Weekly Digest'

on:
  schedule:
    - cron: '0 9 * * *' # daily at 09:00 UTC
  workflow_dispatch:
    inputs:
      dry-run:
        description: 'Log what would be posted without writing'
        type: boolean
        default: true

permissions:
  contents: read
  pull-requests: write
  issues: write

concurrency:
  group: pr-weekly-digest
  cancel-in-progress: false

jobs:
  digest:
    runs-on: ubuntu-latest
    steps:
      - uses: jaegertracing/maintainer-tools/pr-weekly-digest@v0.4.0
        with:
          dry-run: ${{ inputs.dry-run == null && 'true' || inputs.dry-run }}
```

A copy-pasteable template is at
[`pr-weekly-digest/example-workflow.yml`](pr-weekly-digest/example-workflow.yml).

> **Start with `dry-run: true`.** The action logs every would-be POST /
> PATCH / SKIP and writes a job-summary table without touching GitHub.
> Review the logs for a couple of weeks before flipping to `false`.

### Inputs

| Input          | Default               | Description                                                                                  |
| -------------- | --------------------- | -------------------------------------------------------------------------------------------- |
| `github-token` | `${{ github.token }}` | Token for reads and comment writes.                                                          |
| `wait-days`    | `7`                   | Minimum days a PR must be inactive before nudging.                                           |
| `label`        | `waiting-for-author`  | Label that gates which PRs the digest considers.                                             |
| `dry-run`      | `true`                | If `true`, log decisions but don't call the GitHub API. Default-on to make the rollout safe. |

### What a digest comment looks like

```
Hi @octocat, this PR has been waiting on you for over a week. Please address:

- DCO missing on 1 commit(s): 906c67e
- CI status rollup is FAILURE
- PR does not reference an issue with `Fixes #N` / `Closes #N` / `Resolves #N`
- 2 unresolved review thread(s); author has pushed since last reviewer comment

If you're blocked on a question to maintainers, comment `/awaiting-input`
and we'll move this out of your queue while we discuss.
```

Plus an HTML comment footer (`<!-- maintainer-tools: kind=weekly_digest
week=YYYY-Www sha=… -->`) which is invisible to the reader. The action
uses the footer to find its own comments on the next run and decide
between editing in place or posting fresh.

### When the action posts vs. edits vs. stays quiet

| Prior comment on this PR? | Same ISO week?  | Body identical? | Action takes                                                        |
| ------------------------- | --------------- | --------------- | ------------------------------------------------------------------- |
| No                        | —               | —               | **POSTs** new                                                       |
| Yes                       | yes             | yes             | **SKIPs** — nothing to do                                           |
| Yes                       | yes             | no              | **PATCHes** in place — body changed                                 |
| Yes                       | no (older week) | —               | **POSTs** new + **minimizes** the older one as "marked as outdated" |

Minimized comments stay on the PR (collapsed, expandable on click) so the
history is preserved without cluttering the active thread.

### What triggers a nudge

A PR is nudged if **all** of these are true:

1. It carries the `label` (default `waiting-for-author`).
2. Its `updatedAt` is at least `wait-days` old. Any maintainer activity
   bumps `updatedAt` and naturally suppresses the nudge for that week.
3. At least one `inDigest: true` predicate triggers (see catalog).

If none trigger, the PR is silently skipped — it carries the label but
nothing needs to be said.

---

## Predicate catalog

The shared library of PR-state checks. Each predicate is a pure function
of a PR's current GraphQL state.

| ID                         | What it detects                                                                                                           | Used by                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `dco_missing`              | A non-merge commit lacks `Signed-off-by:`.                                                                                | Triage (hides), pr-nudge (Check), pr-weekly-digest (item)            |
| `ci_failing`               | Status check rollup is `FAILURE` or `ERROR`.                                                                              | Triage (hides), pr-weekly-digest (item)                              |
| `merge_conflict`           | `mergeable === CONFLICTING`.                                                                                              | Triage (hides), pr-nudge (Check), pr-weekly-digest (item)            |
| `stale_on_author`          | PR carries the `stale` label or hasn't been touched for `staleDays`.                                                      | Triage (hides)                                                       |
| `quota_exceeded`           | Author has more than their tiered quota of open PRs OR carries the `pr-quota-reached` label.                              | Triage (hides)                                                       |
| `description_empty`        | PR body is empty or just template stubs.                                                                                  | Triage (hides), pr-nudge (Check), pr-weekly-digest (item)            |
| `no_linked_issue`          | No `Fixes/Closes/Resolves #N` in the body. Exempt for `docs` / `documentation` / `ci` / `trivial` / `chore` labelled PRs. | pr-nudge (neutral Check), pr-weekly-digest (item), triage (row flag) |
| `no_tests_for_code_change` | Source files changed but no test files touched. Same exemption labels.                                                    | pr-nudge (neutral Check), pr-weekly-digest (item), triage (row flag) |
| `unresolved_from_reviewer` | A review thread is unresolved and the author pushed commits since the last reviewer comment.                              | pr-weekly-digest (item), triage (row flag)                           |
| `resolved_without_reply`   | Author resolved one or more review threads without posting a reply to the reviewer.                                       | Triage (row flag with count)                                         |

"Hides" means the predicate sends matching PRs to the triage report's
**Hidden** bucket (still visible if you expand it; the reason chip shows
which predicate hid it). "Check" means it emits a Check Run via
`pr-nudge`. "Item" means it shows up as a bullet in the weekly digest
comment.

A bot-author check (`renovate[bot]`, `dependabot[bot]`, etc.) is handled
directly in the triage classifier rather than as a predicate — those PRs
get their own **Dependency bots** bucket.

---

## Quota policy

`quota_exceeded` reproduces the tiered policy from the legacy
`pr-quota-manager.js`:

| Merged PRs by this author in the repo | Concurrent open PRs allowed |
| ------------------------------------- | --------------------------- |
| 0                                     | 1                           |
| 1                                     | 2                           |
| 2                                     | 3                           |
| 3 or more                             | 10 (effectively unlimited)  |

The triage CLI computes this itself (one GraphQL search query per
multi-PR author per run); the `pr-quota-reached` label managed by the
upstream workflow is treated as a corroborating signal.

---

## Authentication

**Triage CLI** — token resolved at startup in this order, first hit wins:

1. **`$GH_TOKEN`** environment variable.
2. **`$GITHUB_TOKEN`** environment variable.
3. **`gh auth token`** — shells out to the GitHub CLI's stored credential.

If `gh auth login` is configured, the CLI just works with no extra setup.

**GitHub Actions** (`pr-nudge`, `pr-weekly-digest`) — each takes a
`github-token` input that defaults to `${{ github.token }}` (the
workflow-issued token). Override only if you need an alternative
identity, e.g. a fine-grained PAT stored in `secrets.MY_PAT`.

Required scopes / permissions:

| Component                   | Required permissions                                      |
| --------------------------- | --------------------------------------------------------- |
| Triage CLI                  | `repo` (read), `read:user`                                |
| `pr-nudge` workflow         | `contents: read`, `checks: write`                         |
| `pr-weekly-digest` workflow | `contents: read`, `pull-requests: write`, `issues: write` |

---

## Node.js version

The CLI's local cache uses Node's built-in `node:sqlite` module, which
landed in **Node 22.5**. Older Node versions will run the CLI with the
cache disabled (a warning is logged, every PR is re-fetched). The
GitHub Actions ship on the `node20` runtime — they don't touch the
cache, so they're unaffected.

---

## Further reading

- [`docs/rfc/maintainer-pr-triage-tooling.md`](docs/rfc/maintainer-pr-triage-tooling.md)
  — the design document, including phase roadmap and trade-offs.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — how the repo is laid out
  internally, the data flow, the publisher decision tree, and extension
  points for new predicates/actions.
- [`AGENTS.md`](AGENTS.md) — contributor and AI-agent setup notes.
