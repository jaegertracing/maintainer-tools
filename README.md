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
| **[Reconciler shadow run (CLI)](#reconciler-shadow-run-cli)**    | `cli/`              | A maintainer, locally on demand | Report of the labels, comments and closings that the lifecycle reconciler would apply       |
| **[`pr-weekly-digest` action](#pr-weekly-digest-github-action)** | `pr-weekly-digest/` | GitHub Actions, daily cron      | One PR comment per `waiting-for-author` PR per ISO week, edited in place when state changes |

All three read the facts of the same [predicate catalog](#predicate-catalog).

---

## Triage report (CLI)

A maintainer-local command that scans the GitHub repos you configure,
classifies every open PR into one of several attention buckets, and writes a
self-contained HTML file you double-click open.

Never writes anything back to GitHub.

### Quickstart

Enable pnpm with `corepack enable pnpm`. Corepack downloads and runs the
version pinned in the `packageManager` field in `package.json`.

```bash
git clone https://github.com/jaegertracing/maintainer-tools
cd maintainer-tools
make install
```

No build step — the CLI runs straight from TypeScript source via
[`tsx`](https://github.com/privatenumber/tsx). Edits to the CLI or the
shared library take effect on the next `make triage`.

Make a config file at `~/.config/maintainer-tools/config.json`:

```json
{
  "repos": ["jaegertracing/jaeger", "jaegertracing/jaeger-ui"],
  "maintainers": ["yurishkuro", "albertteoh", "..."],
  "interns": [],
  "codeowners": {
    "jaegertracing/jaeger": ["cmd/jaeger/**", "internal/**"]
  },
  "priorityLabels": ["priority:high", "priority:medium", "priority:low"]
}
```

(`viewer` is omitted above — see the schema table below; the CLI fetches it via GraphQL when unset.)

Authenticate `gh` (or set `$GH_TOKEN` / `$GITHUB_TOKEN`):

```bash
gh auth login
```

Then run:

```bash
make triage
# → writes ./triage.html (and logs progress to the terminal)
open triage.html
```

### Configuration

The CLI looks for a JSON config in this order:

1. `--config <path>` on the command line.
2. `./.maintainer-tools.json` in the current directory.
3. `~/.config/maintainer-tools/config.json` (respects `$XDG_CONFIG_HOME`).

If none of these exist and the command is run in a terminal, it offers to
copy a sample config (generic or Jaeger org) to
`~/.config/maintainer-tools/config.json`, then exits so you can edit it
before rerunning. In a non-interactive context (CI, a script), it exits
immediately with an error listing the paths it checked.

Schema:

| Field                        | Type                  | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repos`                      | `string[]` (required) | Repos to scan, `"owner/name"` form.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `viewer`                     | `string`              | Your GitHub login. If omitted, the CLI fetches it via the `viewer` GraphQL query.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `maintainers`                | `string[]`            | Logins whose actionable PRs surface in the highest-priority author bucket for every viewer except the PR author, and whose PRs are quota-exempt. Their review or comment activity also counts as "a maintainer has engaged" for the "awaiting first response" bucket.                                                                                                                                                                                                                                            |
| `interns`                    | `string[]`            | Logins whose actionable PRs surface in the highest-priority author bucket for every viewer except the PR author, and whose PRs are quota-exempt. Unlike `maintainers`, intern activity on other PRs does NOT count as a maintainer response — put reviewer logins in `maintainers`, not here.                                                                                                                                                                                                                    |
| `priorityAuthors`            | `string[]`            | Additional logins whose actionable PRs surface in the **Priority authors** bucket and whose PRs are quota-exempt. Their activity does not count as a maintainer response on other PRs.                                                                                                                                                                                                                                                                                                                           |
| `codeowners`                 | `{[repo]: string[]}`  | Per-repo path globs you co-own; PRs touching matching files appear in the CODEOWNERS-hits bucket. Glob syntax: `*` (one segment), `**` (any depth).                                                                                                                                                                                                                                                                                                                                                              |
| `cachePath`                  | `string`              | Override the on-disk SQLite cache path. Default: `$XDG_CACHE_HOME/maintainer-tools/pr-cache.sqlite`.                                                                                                                                                                                                                                                                                                                                                                                                             |
| `priorityLabels`             | `string[]`            | Ordered list of GitHub labels used as priority tiers, highest to lowest (e.g. `["priority:high", "priority:medium", "priority:low"]`). When non-empty, the report adds a **priority grouping level** between repo and bucket: each PR is placed in the first matching tier; PRs carrying none of the listed labels fall into a separate **(no priority)** group rendered last. When omitted or empty, the report renders the flat bucket view.                                                                   |
| `ignoreReviewRequestedOnYou` | `boolean`             | Default `false`. Set `true` to disable the **Review requested on you** bucket — GitHub review requests can be sent by anyone (including the PR author), not just maintainers, so the signal is easy to game. When `true`, PRs with an outstanding request on you fall through to normal classification (and hide rules apply normally — no more override).                                                                                                                                                       |
| `ages`                       | `{[age]: number}`     | The ages, in whole days, at which the policies act. `idleDays` (default 60): a PR on which no person has acted for this long is idle. `idleNoticeDays` (default 14): the time between the `stale` label and the closing of an idle PR. `flagNoticeDays` (default 7): the time between the flag label and the closing of a PR without an approved issue. `staleOnAuthorDays` (default 30): the triage report marks a PR whose last update is older as `STALE-ON-AUTHOR`. An age that is left out has its default. |

Starter files: [`cli/config.example.json`](cli/config.example.json) (generic template) and [`cli/config.example.jaeger.json`](cli/config.example.jaeger.json) (Jaeger org).

For the available command-line flags, run:

```bash
make triage ARGS=--help
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

| Bucket                                              | What it means                                                                                                                                                                                                                                                                 | Default state |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| **Priority authors**                                | Author is another configured maintainer, intern, or priority author. Actionable PRs remain in this highest-priority bucket throughout review.                                                                                                                                 | Expanded      |
| **Review requested on you**                         | Someone added you to the Reviewers field.                                                                                                                                                                                                                                     | Expanded      |
| **You requested changes; author has revised**       | You requested changes, and the author has pushed or commented since.                                                                                                                                                                                                          | Expanded      |
| **You're the bottleneck**                           | You've reviewed this PR before; the author has acted since (commit pushed or commented).                                                                                                                                                                                      | Expanded      |
| **First-time contributors awaiting first response** | Author's `authorAssociation` is `FIRST_TIME_*`; no maintainer has engaged yet.                                                                                                                                                                                                | Expanded      |
| **CODEOWNERS hits**                                 | PR touches files matching your configured codeowner globs.                                                                                                                                                                                                                    | Collapsed     |
| **FYI**                                             | Catch-all for everything else open.                                                                                                                                                                                                                                           | Collapsed     |
| **Dependency bots**                                 | Author is `dependabot`, `renovate`, or `renovate-bot`. Always lands here, even draft/CI-red/conflicted — Renovate and Dependabot manage their own PRs.                                                                                                                        | Collapsed     |
| **Hidden**                                          | Not actionable until the contributor moves. Drafts, non-dependency bots, and any PR a predicate marked as hide-from-triage (DCO missing, CI red, merge conflict, quota-exceeded, stale, empty description, missing issue, duplicate). Shown collapsed with a `reason` column. | Collapsed     |

An explicit review request on you **overrides** every hide rule and the
Dependency bots bucket alike — if a maintainer tagged you, you'll see the
PR even if it has merge conflicts, or is from Renovate or Dependabot.
Set `ignoreReviewRequestedOnYou: true` to turn this bucket off entirely (see
the schema table above); PRs with an outstanding request on you then get
classified normally instead of jumping the queue.

Each bucket's report section also carries a one-line description of what it
means, rendered under the header — so the report is self-explanatory without
needing this table.

Each row also carries inline **flags** when relevant:

| Flag                       | Meaning                                                                      |
| -------------------------- | ---------------------------------------------------------------------------- |
| `BLOCKER`                  | PR labelled `release-blocker` / `blocker`.                                   |
| `QUESTION`                 | PR labelled `awaiting-maintainer-input`.                                     |
| `MERGE-CONFLICT`           | `mergeable === CONFLICTING`.                                                 |
| `STALE-ON-AUTHOR`          | Activity older than the staleness threshold.                                 |
| `NO-APPROVED-ISSUE`        | The PR needs an issue under the [linked-issue policy](#linked-issue-policy). |
| `NO-TESTS`                 | Source files changed but no test files touched.                              |
| `UNRESOLVED-FROM-REVIEWER` | Unresolved review thread with new commits since the last reviewer comment.   |
| `RESOLVED-W/O-REPLY: N`    | Author resolved `N` threads without replying to the reviewer.                |
| `DRAFT`                    | PR is a draft.                                                               |
| `BOT-AUTHORED`             | Bot author.                                                                  |

When GitHub Copilot has reviewed the PR, the row also shows its verdict as a
chip linking to the review: a traffic light and the finding counts by
severity, e.g. `🟢 1M 2L` for "approval recommended, one medium and two low
findings". Hover the chip for the full wording.

### Table view

The **Table** button in the report header switches to a flat table of every
PR, hidden ones included, one row per PR. Alongside the bucket, each row
carries the signals the classifier weighed as separate columns (priority
author, review requested on you, first-timer, CODEOWNERS hit, dependency bot,
maintainer engaged) plus every reason that would hide it, so a PR from a
priority author that is hidden for a missing DCO sign-off is one filter away.

- **Sort**: click a header to sort, shift-click another to make it the
  primary key with the previous keys as tiebreakers. The Sort panel lists the
  active keys as chips, primary first; drag them to change priority, click
  one to flip its direction, or remove it with `×`.
- **Filter**: type in the box under a header. Enumerated and list-valued
  columns (author, flags, labels, ...) autocomplete from the values in
  the visible rows; numeric columns accept `>= 5`-style expressions. Active
  filters appear as chips in the Filters panel with a **Clear all** button.
  The bucket dropdown supports multiple selections.
- **Summary totals**: click a number in the summary's total column to show
  that bucket across all repositories. The subtotal selects the buckets that
  need triage; the overall total clears filters to show every PR.

The table is rendered with [Tabulator](https://tabulator.info), inlined into
the file, so the report remains a single self-contained HTML file.

### How fresh the data is

The CLI keeps an on-disk SQLite cache keyed on `(owner, repo, number,
updatedAt, headSha, headRollup, linkedIssues)`. A PR is re-fetched if any of
those changed — that includes CI status flipping on the head commit and a
linked issue being closed or relabelled, even when GitHub doesn't bump
`updatedAt`. Use `--no-cache` to force a full refresh.

---

## Reconciler shadow run (CLI)

`make reconcile` runs the lifecycle reconciler of
[RFC 0003](docs/rfc/0003-issue-and-pr-lifecycle-automation.md) in shadow
mode. It gathers the open PRs of the configured repositories as the triage
report does, derives for each PR the labels that it should carry, the
comment that tells the author why, and whether it is closed, and reports
what differs from the PR as it is on GitHub. It changes nothing on GitHub.

```bash
make reconcile                                        # writes ./reconcile.html
make reconcile ARGS="--repo jaegertracing/jaeger-ui"  # one configured repository
make reconcile ARGS="--save-snapshot snapshot.json"   # keep what was gathered
make reconcile ARGS="--snapshot snapshot.json"        # decide again, without GitHub
make reconcile ARGS=--write                           # make the changes on GitHub
make reconcile ARGS=--help
```

The HTML report has one card for each PR that a run in write mode would
change. A card links the PR and shows the labels that stay, that are added
and that are removed, the list of changes with the rule behind each label,
and the comment as the author would see it. The caption of the comment
says whether it would be posted, which notifies the author, or whether the
existing comment would be edited, which does not. The buttons at the top
show only the cards with one kind of change, such as the PRs that would be
closed. `--format md` and `--format json` write the same decisions as
Markdown and as JSON; the JSON report has no time in it, so two runs over
one snapshot can be compared byte for byte.

The reconciler owns six labels: `missing-issue`, `unapproved-issue`,
`duplicate`, `pr-quota-reached`, `waiting-for-author` and `stale`. The
tables in [`docs/decision-tables/`](docs/decision-tables/README.md) show
when each one, the comment and the closing hold. A PR that still needs an
issue is closed `flagNoticeDays` after it got its flag label. A PR on which
no person has acted for `idleDays` gets `stale` and is closed
`idleNoticeDays` later. The three are the [`ages`](#configuration) of the config,
with the defaults 7, 60 and 14 days. The label `do-not-expire` exempts a PR
from both.

The run posts a new comment when the author has not been told about a
reason, when it closes the PR, and when nothing blocks the PR any more. It
edits its comment in place when a reason goes away and others remain.

With `--write` the run makes the reported changes, one PR after the other
and one change a second. It needs the token of a GitHub Actions workflow,
because the reconciler takes a comment for its own only when
`github-actions[bot]` posted it. Every
label of the reconciler has to exist in the repository. A PR that the
plan closes is fetched again first, so that it is not closed for a fact
from the cache. A change that GitHub refuses ends the run, and a run makes
at most 400 changes; in both cases the next run makes the rest.

The last line of the gathering log gives the cost of the gathering. It
leaves out the requests of a run in write mode:

```
GitHub API: 10 request(s), 92 point(s) of the hourly budget, 4220 left
```

GitHub charges the requests of one token to more than one hourly budget.
The points are the sum over those budgets, without the first request of
each, and the points left are those of the budget that has the fewest.

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
3. At least one predicate that the digest lists triggers (see catalog).

If none trigger, the PR is silently skipped — it carries the label but
nothing needs to be said.

---

## Predicate catalog

The shared library of PR-state checks. Each predicate is a pure function
of a PR's current GraphQL state.

| ID                         | What it detects                                                                                                                                                                                                                          | Used by                                                    |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `dco_missing`              | A non-merge commit lacks `Signed-off-by:`.                                                                                                                                                                                               | Triage (hides), pr-weekly-digest (item)                    |
| `ci_failing`               | Status check rollup is `FAILURE` or `ERROR`.                                                                                                                                                                                             | Triage (hides), pr-weekly-digest (item)                    |
| `merge_conflict`           | `mergeable === CONFLICTING`.                                                                                                                                                                                                             | Triage (hides), pr-weekly-digest (item)                    |
| `stale_on_author`          | PR carries the `stale` label or has not been updated for `staleOnAuthorDays` of the config.                                                                                                                                              | Triage (hides)                                             |
| `over_quota`               | The PR is beyond the tiered quota of open PRs of its author, by its rank among them.                                                                                                                                                     | Triage (hides)                                             |
| `description_empty`        | PR body is empty or just template stubs.                                                                                                                                                                                                 | Triage (hides), pr-weekly-digest (item)                    |
| `no_linked_issue`          | A PR that carries the `missing-issue` label, whatever its other labels. Otherwise, a PR with no `Fixes/Closes/Resolves #N` in the body, unless it is labelled `docs` / `documentation` / `ci` / `trivial` / `chore` / `no-issue-needed`. | Without the `missing-issue` label: pr-weekly-digest (item) |
| `no_tests_for_code_change` | Source files changed but no test files touched. Exempt for `docs` / `documentation` / `ci` / `trivial` / `chore` labelled PRs.                                                                                                           | pr-weekly-digest (item), triage (row flag)                 |
| `unresolved_from_reviewer` | A review thread is unresolved and the author pushed commits since the last reviewer comment.                                                                                                                                             | pr-weekly-digest (item), triage (row flag)                 |
| `resolved_without_reply`   | Author resolved one or more review threads without posting a reply to the reviewer.                                                                                                                                                      | Triage (row flag with count)                               |

"Hides" means the predicate sends matching PRs to the triage report's
**Hidden** bucket (still visible if you expand it; the reason chip(s) show
every predicate that hid it — a PR can be both stale and quota-exceeded at
once, and both show up rather than one masking the other). "Item" means
it shows up as a bullet in the weekly digest comment.

A bot-author check (`renovate`, `dependabot`, `renovate-bot`, etc.) is handled
directly in the triage classifier rather than as a predicate — those PRs
get their own **Dependency bots** bucket.

---

## Linked-issue policy

A PR from an outside contributor is reviewed only when it links an approved
issue: an open issue of the same organization that carries the `help wanted`
label. The triage report hides a PR that links no approved issue and flags
it `NO-APPROVED-ISSUE`. Three kinds of PR need no issue:

- a PR that a maintainer labelled `no-issue-needed`;
- a PR whose author is a collaborator of the repository with the write,
  maintain or admin permission;
- a PR of a dependency bot.

The triage CLI decides this from the issues that GitHub links to the PR
(the ones that the PR closes when it merges) and from the collaborators of
the repository. It does not read the `missing-issue` label that a workflow
of `jaegertracing/jaeger` manages. When GitHub refuses the list of collaborators of a repository, the
CLI cannot tell a maintainer from an outside contributor, so it flags no PR
of that repository.

---

## Duplicates policy

The triage report shows one open PR per issue, with the exceptions below.
For each issue, the oldest open
PR of the issue's repository that closes it is the primary one, and the
triage report hides every other open PR of that repository that closes it,
with the reason `hide:is_duplicate`. A PR of another repository is not
counted. Two PRs created at the same time are ordered by number. A
maintainer allows several PRs for one issue by labelling the issue
`allow-multiple-prs`. As with every hide rule, an explicit review request on
you keeps a duplicate visible.

The triage CLI decides this from the issues that GitHub links to the open
PRs of one run, so a run with `--pr` hides no PR as a duplicate.

---

## Turn policy

It is the turn of the author when a maintainer spoke after the author last
acted. A maintainer is a collaborator of the repository with the write,
maintain or admin permission who is not the author. A maintainer speaks with
a comment on the PR or with a review that is not an approval. An approval
supersedes what the same maintainer said before it, and what another
maintainer said still stands. The author
acts with a comment, with a review, which is how GitHub records a reply in a
review thread, or with a commit. A merge of the base branch is a commit like
any other when the author made it. A merge commit that GitHub attributes to
another account, which is what a maintainer adds with "Update branch", is not
the author acting. Every other commit counts, also one of a second account
or of an email that belongs to no account. A comment that carries the hidden
marker of the linked-issue or the duplicates notice is the activity of
nobody, whoever posted it. Every other notice of the automation is a comment
of the GitHub Actions bot, which is neither the author nor a maintainer.

It is also the turn of the author while a lifecycle policy blocks the PR: it
links no approved issue, it is a duplicate, or it is over the quota. Only the
author can clear such a block.

The triage report flags a PR on which it is the turn of the author as
`AUTHORS-TURN` and hides it. The reason for hiding names the cause:
`hide:maintainer_spoke_last`, or the reason of the policy that blocks the
PR. The flag does not come from the `waiting-for-author` label. When GitHub refuses the
list of collaborators of a repository, the CLI knows no maintainer, so it is
the turn of no author there.

---

## Quota policy

`over_quota` reproduces the tiered policy from the legacy
`pr-quota-manager.js`:

| Merged PRs by this author in the repo | Concurrent open PRs allowed |
| ------------------------------------- | --------------------------- |
| 0                                     | 1                           |
| 1                                     | 2                           |
| 2                                     | 3                           |
| 3 or more                             | 10 (effectively unlimited)  |

The triage CLI computes this itself (one GraphQL search query per
multi-PR author per run) and does not read the `pr-quota-reached` label
that the upstream workflow manages. A run with `--no-quota` gathers no
merged-PR counts, and a run with `--pr` gathers one PR, which cannot be
ranked among the others of its author. Neither run flags a PR as over its
quota.

---

## Authentication

**Triage CLI** — token resolved at startup in this order, first hit wins:

1. **`$GH_TOKEN`** environment variable.
2. **`$GITHUB_TOKEN`** environment variable.
3. **`gh auth token`** — shells out to the GitHub CLI's stored credential.

If `gh auth login` is configured, the CLI just works with no extra setup.

**GitHub Action** (`pr-weekly-digest`) — it takes a
`github-token` input that defaults to `${{ github.token }}` (the
workflow-issued token). Override only if you need an alternative
identity, e.g. a fine-grained PAT stored in `secrets.MY_PAT`.

Required scopes / permissions:

| Component                   | Required permissions                                      |
| --------------------------- | --------------------------------------------------------- |
| Triage CLI                  | `repo` (read), `read:user`                                |
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

- [`docs/rfc/0001-maintainer-pr-triage-tooling.md`](docs/rfc/0001-maintainer-pr-triage-tooling.md)
  — the design document, including phase roadmap and trade-offs.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — how the repo is laid out
  internally, the data flow, the publisher decision tree, and extension
  points for new predicates/actions.
- [`AGENTS.md`](AGENTS.md) — contributor and AI-agent setup notes.
