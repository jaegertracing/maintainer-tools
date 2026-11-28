# RFC 0003: Automating the Lifecycle of Issues and Pull Requests in Jaeger

* **Status**: Draft
* **Created**: 2026-11-21
* **Last Updated**: 2026-11-27

---

## TL;DR

The Jaeger repositories enforce their contribution policies with independent GitHub Actions workflows. Each workflow decides alone when to run, what to read and what to change on a pull request (PR), and the workflows meet only through labels, bot comments and the `updated_at` timestamp of the PR. One policy, "a PR from an outside contributor links an open `help wanted` issue or is closed after a week", took eleven PRs in three repositories, and most of them repaired an interaction with another workflow.

This RFC replaces those workflows with one program, in the manner of a Kubernetes controller or of Terraform. The policies are "invariants": statements of what is true of a correct item, such as "a PR without an approved issue carries `unapproved-issue`" and "a PR whose flag label is at least seven days old is closed". One "reconciler" observes the inputs, derives the desired labels, comment and open state from the invariants, compares them with what the item has, and changes only the difference. Time rules are ordinary invariants, because the clock is an input and an age is derived from it. The part that is not declarative is small: creating a comment is not repeatable, the order of changes within one run is fixed in one place, and closing cannot be taken back.

The rules are small, and they are written in TypeScript in a fluent form: `policy.derivedFact('idle').when(...)` gives a derived fact a reason to hold, and `.unless(doNotExpire)` gives it a veto. One generic combinator decides every derived fact and every output: it holds when a reason holds and no veto does. A new policy adds statements and edits none. Two rules cannot contradict each other, by construction: the state of an item is split into inputs that the reconciler never changes and outputs that no rule reads, and a veto always wins over a reason. The statements record the rules as data, so the reconciler checks the rule set every time it starts and refuses to run on a rule set with a defect. Generated decision tables show which combinations of facts lead to each output, so the consequences of a new rule are read as a diff. The design needs no inference engine and no solver.

The reconciler lives in `jaegertracing/maintainer-tools`, on the same facts as the checks and the triage report of that repository. The rules live there too, are the same for every repository, and are checked in its CI. Each repository calls the reconciler at a pinned version from one workflow, on PR, issue and comment events and on a daily schedule, under one concurrency group for the whole repository. Every run covers all open PRs, so a pending run that GitHub replaces loses nothing. To stay within the API budget, a run fetches in full only the PRs whose inputs may have changed, using a cache of observed inputs that it keeps between runs as a workflow artifact. The cache is never a source of truth: the reconciler derives the same result from an empty one.

The design started from the hypothesis that an explicit state machine with stored state, the idea behind the `rustybot` repository [\[1\]](https://github.com/yurishkuro/rustybot), is the fix. The hypothesis is right that one program must own the whole lifecycle and that the rules must be stated in one place. It is wrong about the mechanism. A PR is not in one state. It has several independent facets (issue link, quota, duplicate, whose turn, idle), and each is a function of facts that GitHub already holds, the clock and the item's own timeline included. A stored state would be a second copy of the truth that can disagree with the facts. ["Decisions and Alternatives"](#decisions-and-alternatives) compares the options and gives the reason for each choice of the design.

A prototype of the reconciler holds the rule form, the PR policies, the startup check and a shadow mode that runs from the CLI. A read-only backtest ran it against the open PRs of jaeger and jaeger-ui. It left no known defect in the rules, it measured the API cost, and it found labels that the existing actions had left wrong. The first two steps of the migration are merged: the existing checks and the triage report use the rule form, and quota, duplicates, the turn and the issue link are policies in it. The write path, the workflow and the cache as an artifact do not exist yet.

The migration is one switch-over per repository. The reconciler runs in shadow mode beside the existing actions and reports, per PR, the difference between the state it would produce and the state they produced. When each remaining difference is an intended change, one PR per repository removes the old workflows, replaces `actions/stale` for PRs, and turns writes on.

---

## Context & Problem

### The motivating case

The policy is stated in the contributing guidelines [\[2\]](https://github.com/jaegertracing/jaeger/blob/main/CONTRIBUTING_GUIDELINES.md#link-each-pull-request-to-an-issue). Its delivery, between November 19 and November 21, 2026, is this sequence:

| Repository | PR | What it did |
|---|---|---|
| jaeger | [#10226](https://github.com/jaegertracing/jaeger/pull/10226), [#10227](https://github.com/jaegertracing/jaeger/pull/10227) | Added the `pr-linked-issue` action and its single policy comment |
| jaeger | [#10228](https://github.com/jaegertracing/jaeger/pull/10228) | Turned the action on, and added a second `actions/stale` step that closes a flagged PR |
| jaeger | [#10229](https://github.com/jaegertracing/jaeger/pull/10229) | Added a local script that applies the policy, because the workflow has no scheduled run |
| jaeger | [#10233](https://github.com/jaegertracing/jaeger/pull/10233) | Granted `actions: write`, because the two stale steps share one saved-progress cache entry |
| jaeger | [#10234](https://github.com/jaegertracing/jaeger/pull/10234) | Replaced direct runs with one dispatched run per PR, because an issue event and a PR event could label the same PR at once |
| jaeger | [#10252](https://github.com/jaegertracing/jaeger/pull/10252) | Split the label in two, and made `do-not-expire` protect a flagged PR in both stale steps |
| jaeger | [#10257](https://github.com/jaegertracing/jaeger/pull/10257) (open) | Moves the closing out of `actions/stale` into the action, on a daily schedule |
| jaeger-ui | [#4808](https://github.com/jaegertracing/jaeger-ui/pull/4808), [#4817](https://github.com/jaegertracing/jaeger-ui/pull/4817) | Copied the workflow and the stale step, and moved the pinned commit |
| maintainer-tools | [#97](https://github.com/jaegertracing/maintainer-tools/pull/97) | Taught the triage report the `missing-issue` label |

The interference problems reported for this sequence were checked against the code, the PR descriptions and live PRs. Each one is confirmed:

- The action added `stale` next to its own label, and a second `actions/stale` step closed the PR [\[3\]](https://github.com/jaegertracing/jaeger/blob/fdde0a9cdf9a4c07908974373063717d1d3204b4/.github/workflows/stale.yml). `stale` therefore meant both "idle for 60 days" and "violates the policy".
- The two stale steps had separate exemption lists, so `do-not-expire` protected a PR in one step and not in the other until #10252.
- The deadline was a week without activity, so a label swap restarts the week. The timeline of jaeger-ui PR 4815 shows it: the swap from `missing-issue` to `unapproved-issue`, and 16 minutes later the stale workflow removing `stale`.
- The label filter of the second step also selects issues, so the step needs `days-before-issue-stale: -1`.
- The first step has to exempt `missing-issue` and `unapproved-issue`, so that the two steps do not act on the same PR.
- The `pr-duplicates` action treats a PR with `stale` as inactive (`isActivePR()` in `pr-duplicates.js`), so its result depended on the linked-issue action adding `stale`.
- The time at which a PR was flagged is the creation time of a bot comment that the action finds through a hidden HTML marker (#10257).
- A label change on an issue in another repository fires no event in the repository of the PR [\[4\]](https://github.com/jaegertracing/jaeger/blob/fdde0a9cdf9a4c07908974373063717d1d3204b4/.github/actions/pr-linked-issue/README.md).

Three findings add to that list.

**The count was understated.** The sequence is eleven PRs, not four.

**Two of the repairs defend against failures that nobody observed.** #10233 states that "the failure itself has not been observed, because no run has saved an entry". #10234 describes a race that "could" happen. Both were found by reading code. They are real hazards, and they exist only because two actors share a cache entry or a PR.

**#10257 changes the duplicate policy and does not say so.** After #10257 a flagged PR no longer carries `stale`. `pr-duplicates` then counts it as active. Two flagged PRs that link the same issue were both inactive before, and neither was labelled. After #10257 the younger one gets `duplicate` and a comment. No test covers this, because each action has tests only for itself. This is the interaction problem appearing inside the PR that was written to remove it.

### Why it keeps happening

Each new rule is a new actor: an action, a workflow with its own triggers and concurrency group, a local script, a hidden comment marker, and a copy or a pinned reference in jaeger-ui. An actor cannot ask another actor what it concluded. It can only read what the other left on the PR. The next section lists what each actor reads and changes.

---

## Inventory of Actors

The table covers every automated actor that changes a label, a comment or the open state of an issue or PR in `jaegertracing/jaeger` at commit `fdde0a9`, plus the one that only reads them.

| Actor | Runs on | Reads | Changes | Serialized by |
|---|---|---|---|---|
| `pr-linked-issue` | PR opened, edited, reopened; `no-issue-needed` label; issue labelled `help wanted`, closed, reopened; with #10257 also daily | Closing issue references (first 20, any `jaegertracing` repository), issue state and labels, author permission, `no-issue-needed`, its marker comment; with #10257 `do-not-expire` and the comment's creation time | `missing-issue`, `unapproved-issue`, `stale` (until #10257), one comment; with #10257 closes the PR | One group per PR; the daily job is outside it |
| `actions/stale`, general step | Daily | `updated_at`, `stale`, `do-not-expire`, `help wanted`, `question`, `missing-issue`, `unapproved-issue` | `stale`, comments, closes issues and PRs | Nothing; keeps progress in an Actions cache entry |
| `actions/stale`, flagged step (removed by #10257) | Daily | `missing-issue`, `unapproved-issue`, `do-not-expire`, `stale`, `updated_at` | `stale`, a comment, closes PRs | Nothing; shares the cache entry |
| `pr-duplicates` | Nine PR event types; `allow-multiple-prs` on an issue; daily | Every open PR: creation time, `stale`, `duplicate`, closing issue references (first 10, same repository only), two marker comments | `duplicate`, one comment | One group per repository |
| `pr-quota-manager` | PR opened, closed, reopened, pushed | The author's open PRs in creation order, the author's merged PR count, `pr-quota-reached`, a comment found by its visible text | `pr-quota-reached`, block and unblock comments | One group per author |
| `waiting-for-author.js` | PR pushed; conversation comment | The event (who commented or pushed), author, commenter permission, head commit message | `waiting-for-author` | Nothing |
| `maintainer-tools` triage CLI | A maintainer's laptop | `stale`, `pr-quota-reached`, `missing-issue`, `waiting-for-author`, `no-issue-needed`; its own copy of the quota and duplicate computations | Nothing | — |

`pr-changelog-label.yml` and the `block-pr-from-main-branch` action fail a check and change nothing on the PR, so they are gates and not lifecycle actors. `maintainer-tools` also ships a `pr-nudge` action, which publishes a check run for five of its ten checks on PR events and posts no comment, and a `pr-weekly-digest` action; a code search of the organization finds no workflow that calls either.

The places where two actors meet:

| Shared thing | Who changes it | Who depends on it | Evidence |
|---|---|---|---|
| `stale` label | `actions/stale` (two steps), `pr-linked-issue` | `pr-duplicates` (inactive), triage CLI (hides the PR), `actions/stale` | #10228, #10257 |
| `missing-issue`, `unapproved-issue` | `pr-linked-issue` | Both stale steps; the triage CLI, which knows only `missing-issue` | #10252 added the second label two days after maintainer-tools #97 |
| `updated_at` of the PR | Every actor, with every label and comment | `actions/stale` as its idle clock; `pr-weekly-digest` | Three separate workarounds ¹ |
| "Linked issue" | — | Three definitions: any `jaegertracing` repository, first 20 (`pr-linked-issue`); same repository, first 10 (`pr-duplicates`); a `Fixes #N` pattern in the body (`no_linked_issue` predicate) | Source of each |
| "Maintainer" | — | Four definitions: `admin` or `write` (`pr-linked-issue`); `admin`, `maintain` or `write` (`waiting-for-author.js`); organization member or five merged PRs (CI orchestrator); a configured list (triage CLI) | Source of each |
| Quota tiers | — | Implemented twice: `pr-quota-manager.js` and `cli/src/quota.ts` | maintainer-tools README, "Quota policy" |
| Bot comment identity | — | Four schemes: one marker, two markers with an ownership marker, a visible phrase, a footer with a hash | Source of each |
| One PR, at the same moment | Any two actors | — | Concurrency groups are per workflow: per PR, per repository, per author, none |

- ¹ `pr-linked-issue` posts its comment before its labels "so that the stale workflow counts idle days from the stale label". `pr-duplicates` "does not mutate stale PRs, avoiding stale-policy reactivation caused by bot activity". The weekly digest was changed to stop posting on a fixed cadence because every comment reset the clock of `actions/stale` [\[5\]](https://github.com/jaegertracing/maintainer-tools/pull/64).

`updated_at` is the widest coupling and the least visible. Every change by any actor is activity in the eyes of `actions/stale`, so each actor has learned to change as little as possible, each in its own way.

### Cost of the copies

jaeger-ui carries five workflow files for the same policies. They reference three different commits of `jaegertracing/jaeger` for three actions and download `waiting-for-author.js` from `main` with `curl` at run time. The stale workflows of the two repositories already differ: the jaeger copy restricts issues to the `question` label and the jaeger-ui copy does not. `jaeger-idl` and `documentation` have none of these workflows.

Flagging is driven by events, and the jaeger backfill has not been applied, so the two repositories enforce the same policy to different degrees. The dry run in #10252 found 161 violating PRs in jaeger. Nine open PRs there carry a flag label at the time of writing. In jaeger-ui, where the script was applied, 63 do.

---

## The Lifecycle

### Pull requests

GitHub owns one state machine for a PR: draft, open, closed, merged. On top of it the project asks several separate questions. Each question is a "facet": a small set of mutually exclusive values.

| Facet | Values | Decided by | History it needs |
|---|---|---|---|
| Issue link | exempt · approved · `unapproved-issue` · `missing-issue` | The current closing references, the state and labels of those issues, the author's permission, `no-issue-needed` | None |
| Issue-link deadline | not running · running · expired | The age of the flag label; `do-not-expire` | When the flag label was applied: a label event in the PR timeline |
| Quota | within quota · over quota | The author's open PRs in creation order and merged PR count | None |
| Duplicate | sole or primary · duplicate | The other open PRs that close the same issue, creation order, `allow-multiple-prs` on the issue | None |
| Turn | the maintainers' · the author's | Who acted last, whether a maintainer's review approved, and whether the PR is blocked | Times and authors of comments, reviews and pushes: the PR timeline |
| Idle | active · stale · closed as idle | Time since a person last acted; `do-not-expire` | Time of that activity: the PR timeline |

Values within a facet exclude each other. Facets are orthogonal: any value of one can occur with any value of another. Two exceptions exist. A deadline runs only while its own facet is in violation: the issue-link deadline runs only for `unapproved-issue` and `missing-issue`. And a blocked PR is the author's turn, as the next paragraph states. The open PRs of jaeger-ui show the orthogonality. Of 83 open PRs, 63 carry a flag label, and of those, 48 also carry `waiting-for-author`, six are also over quota, and two are also duplicates. 27 PRs carry three or more of the policy labels.

One thing that the project wants to know is derived from the facets and is not a facet itself. A PR is *blocked* when a policy holds for it that only its author can satisfy: the issue link is in violation, the PR is over quota, or the PR is a duplicate. A blocked PR is not reviewable, and the triage CLI already computes this as its Hidden bucket. A blocked PR waits for its author whoever spoke last, because no review helps until the author has dealt with what blocks it. #10252 split the flag label so that `unapproved-issue` also tells the maintainers that the linked issue has no triage decision yet.

The human labels `no-issue-needed`, `do-not-expire` and `allow-multiple-prs` are inputs to the facets. They are not states.

### Issues

An issue has a triage decision that only a person can make: not yet triaged, needs information, accepted (`help wanted`), declined (closed). `rustybot` models this as four states [\[6\]](https://github.com/yurishkuro/rustybot/blob/main/issue-manager.yml). An issue also has two facets that are computable: whether an open PR closes it, and whether it is idle.

The automation of today touches issues in one place. `actions/stale` marks idle issues that carry `question` and exempts `help wanted`. No open issue in jaeger carries `question`, so that step does nothing at present. 47 of the 428 open issues in jaeger carry `help wanted`. The linked-issue policy turns the triage decision into a gate for PRs, so an issue without a decision now holds PRs in `unapproved-issue`.

---

## The Design

This section states what the reconciler does. Where the design chose among alternatives, the text names the choice and links to the part of ["Decisions and Alternatives"](#decisions-and-alternatives) that holds the reasoning.

### The reconciler in outline

One program, the reconciler, owns the lifecycle labels, the policy comment and the closing of every open PR of a repository. No other automation changes them after the cutover. ([Why one reconciler](#one-reconciler-over-invariants).)

The reconciler stores no state of a PR. Every run observes the repository, derives from the rules what each PR should carry, and changes the difference. The lifecycle states of a PR are facts that the rules derive from what GitHub holds, and no transition between them is written. ([Why the state is derived](#derived-facts-not-a-stored-state-machine).)

The rest of this section follows the path of one run: what the reconciler observes, how the rules are written, which policies they state, how time enters, what the comment says, how the plan is applied, how the rule set is checked, when a run starts, and what a run costs.

### Inputs, facts and outputs

The design has the shape of a logic program, in the sense of Datalog. It has three layers. Base fact, derived fact, rule and output are concepts of Datalog, which calls them extensional fact, intensional fact, rule and output relation.

- **Inputs** are what the reconciler observes and never changes: the labels that people own, the author and the author's permission, the closing issue references and the state and labels of those issues, the other open PRs, the events of the timeline with their times and actors, and the current time.
- **Facts** are named booleans: `needs_issue`, `links_open_issue`, `idle`, `flag_expired`, `over_quota`, `is_duplicate`, `blocked`. A fact is of one of two kinds, and never of both. A "base fact" takes its value from a "predicate", a function that computes the value from the inputs, and the predicates are the only code in a policy. A "derived fact" is decided by rules from other facts. The lifecycle states of the previous section are derived facts. The facts of the PR policies are about a PR. A fact can also be about an issue, as in the sketch of an issue policy in ["Derived facts, not a stored state machine"](#derived-facts-not-a-stored-state-machine), and the reconciler then evaluates it once for each issue.
- **Outputs** are what the reconciler owns and changes: each of its labels, its comment, and `should_close`.

The separation of the layers forbids one thing: a rule never reads an output. It does not limit how a derived fact or an output is decided. Any number of small rules may contribute to the same one.

The figure shows the layers and not every fact. It draws `needs_issue` and `idle` without the base facts under them, and it leaves out the facts of the checks.

```
inputs (observed)
  └─► do_not_expire, needs_issue, links_open_issue, idle, maintainer_spoke_last, over_quota, is_duplicate
        └─► flag_expired, idle_expired       use the age of a label
              └─► blocked, authors_turn, should_close
                    └─► labels, comment
```

**Facts that depend on other PRs.** Two base facts of a PR depend on other PRs: `over_quota` and `is_duplicate`. Their predicates read the set of open PRs of the run, which is an input, and no fact of another item. The predicate of `is_duplicate` also reads the `allow-multiple-prs` label of each issue that the PR closes:

```ts
// duplicates.ts
export const isDuplicate = policy.baseFact(
  'is_duplicate',
  (pr, { openPullRequests }) => olderPullRequestsOfSameIssue(pr, openPullRequests).length > 0,
  { says: 'an older open pull request closes the same issue', changedBy: 'author' },
);
```

No fact of one item is read for another, so every predicate is a function of the inputs. The set holds every PR that is open when the run observes the repository. A PR that the run closes still counts in that run. The next run no longer lists it, and it then frees a place in the author's quota or leaves another PR as the oldest on its issue. Because the set does not depend on the plan, no rule is restricted in what it may conclude from the set: `is_duplicate ⇒ should_close` would be a legal rule.

**The labels divide by writer.** The reconciler owns `missing-issue`, `unapproved-issue`, `pr-quota-reached`, `waiting-for-author`, `stale` on a PR and `duplicate` on a PR. It overwrites a hand edit of any of them on its next run, and it uses no separate label of its own. People own `help wanted`, `no-issue-needed`, `do-not-expire` and `allow-multiple-prs`, and no automation writes those.

### One writer for each output

The split into inputs and outputs holds only if each output has one writer. Five things break the split today or need a decision, and the design settles each:

| What | How it breaks the split today | What the design does |
|---|---|---|
| `stale` | Two actors write it, with opposite rules. `actions/stale` removes it when the PR is updated, and `pr-linked-issue` restored it on a flagged PR that had lost it. A label change by one is an update for the other. On jaeger-ui PR 4815 the stale workflow removed `stale` 16 minutes after the flag label was swapped. | The rules for `stale` read only inputs: activity by people and `do-not-expire`. A person who wants to keep a PR alive comments or applies `do-not-expire`, which are inputs. Removing the label by hand has no lasting effect. |
| `duplicate` | People apply it to PRs by hand, and `pr-duplicates` also applies it. The action keeps a hidden ownership marker in its comment to tell the two apart, which is an output that records who wrote another output. | The reconciler is the only writer of `duplicate` on a PR, under the same label name, and the ownership marker goes away. A `duplicate` label that a person applies to a PR by hand is removed on the next run. |
| `waiting-for-author` | The script sets it on an event, and a maintainer can set or clear it by hand. | The label is derived from the timeline. A maintainer who wants the author to act says so in a comment or a review, which is an input. A hand edit does not last. |
| Open or closed | Both people and the reconciler close PRs, and the set of open PRs is an input to the quota and duplicate rules. | The reconciler concludes "closed" and never "open". The rules over a set range over the PRs that are open when the run observes them, which is an input. A person reopens a PR; if the rules still want it closed, the next run closes it. |
| A notice period | "Closed seven days after it was flagged" depends on when the reconciler applied its own label. That fact exists only because of an output. | The one permitted exception, which ["Notice periods"](#notice-periods) defines. |

### Small rules: reasons and vetoes

A rule is one implication. It decides one derived fact or one output, which is its "conclusion", from a short list of facts, which are its "premises". There are two kinds. This RFC writes a rule in prose with an arrow.

- A **reason** says that its conclusion holds: `idle_expired ⇒ should_close`.
- A **veto** says that its conclusion does not hold: `do_not_expire ⇒ not should_close`.

One combinator applies to every derived fact and every output: *it holds when at least one of its reasons holds and none of its vetoes does*. The combinator is generic. It knows nothing of any policy and is never edited. A disjunction is written as several reasons, and an exception as a named veto. A new policy adds statements, and no existing statement changes. A rule cannot say "remove" or "reopen", and the design has one level of precedence only: a veto wins. ([Why a veto wins and no rule has a priority](#a-veto-wins-prevention-not-detection).)

The rules are written in TypeScript, in a fluent form. ([Why TypeScript](#typescript-not-a-rule-language).) The statements are calls on one `Policy` object, which holds the base facts, the derived facts, the outputs and the rules of every policy of the project. Apart from the label age of ["Notice periods"](#notice-periods), that object is a Datalog program without recursion.

- `policy.baseFact(name, predicate, { changedBy })` declares a base fact of a PR. The predicate returns a boolean, or `{ holds, summary, details }`: whether the fact holds for the PR, a short text that states what the predicate found, and an optional paragraph that tells the author how to make the fact stop holding. The summary is present in both states, so a consumer can print it for a fact that holds and for one that does not. `changedBy` is the "change source" of the fact, which is who can change its value: the author, a maintainer, or time.
- `policy.derivedFact(name)` declares a derived fact of a PR.
- `.when(a, b)` adds a reason to a derived fact or to an output: the conclusion holds when the facts `a` and `b` both hold.
- `.unless(a)` adds a veto.
- An output is a property of the policy, such as `policy.triageHidden`.

These statements exist in `packages/checks/src/rules`, the rule form that the first step of "Migration Path" adds, and `triage_hidden` is one of its outputs. The sketches of this RFC use more than that rule form has, and the reconciler adds each of the following in the same shape:

- `policy.issueBaseFact()` and `policy.issueDerivedFact()`, for the facts of an issue.
- The outputs `policy.comment` and `policy.shouldClose`, and `policy.label(name)`, which is a method because each label is an output.
- `policy.labelAge()`, which declares the age of a label as a base fact, and `policy.exclusive()`, which declares two outputs that must not hold together.
- One more option of a base fact. `says` is the static wording of the fact, which is the same for every item.

The calls chain. A policy adds a reason or a veto to a derived fact of another policy with a separate statement. A base fact has no `.when` and no `.unless`, so no rule can decide it. An output cannot be passed to `.when` or `.unless`, because the types of the builder refuse it, so a rule that reads an output does not compile.

The closing rules and the idle policy are two files of the prototype. They read as follows in the form above; the prototype itself declares a base fact and its vetoes in one statement. The examples of this RFC show a predicate that returns the boolean alone and leave its summary out, except in "The comment".

```ts
// closing.ts
export const doNotExpire = policy.baseFact(
  'do_not_expire',
  (pr) => pr.labelsOwnedByPeople.includes('do-not-expire'),
  { says: 'the pull request carries `do-not-expire`', changedBy: 'maintainer' },
);
policy.shouldClose.unless(doNotExpire);

// stale.ts
const IDLE_DAYS = 60;
const NOTICE_DAYS = 14;

const quietFor60Days = policy.baseFact(
  'quiet_for_60_days',
  (pr, { now }) => daysSince(pr.lastActivityByPersonAt, now) >= IDLE_DAYS,
  { says: `no person has acted on the pull request for ${IDLE_DAYS} days`, changedBy: 'author' },
);
export const idle = policy.derivedFact('idle').when(quietFor60Days).unless(doNotExpire);

const staleLabel = policy.label('stale').when(idle);

// The pull request is closed after a notice, so the notice has to exist.
policy.comment.when(idle);

const staleLabelOld = policy.labelAge('stale_label_old', {
  of: [staleLabel],
  days: NOTICE_DAYS,
  says: `the \`stale\` label is at least ${NOTICE_DAYS} days old`,
});
const idleExpired = policy.derivedFact('idle_expired').when(idle, staleLabelOld);

policy.shouldClose.when(idleExpired);
```

The linked-issue policy is a third file. It adds its own reason to close with one statement, `policy.shouldClose.when(flagExpired)`, and it changes no line of the two files above.

```ts
// linked-issue.ts
const NOTICE_DAYS = 7;
const noApprovedIssue = policy.baseFact(
  'no_approved_issue',
  (pr) => !pr.linkedIssues.some(isApproved),
  { says: 'no linked issue is open and carries `help wanted`', changedBy: 'author' },
);
export const needsIssue = policy
  .derivedFact('needs_issue')
  .when(noApprovedIssue)
  .unless(noIssueNeeded)
  .unless(authorCanWrite)
  .unless(authorIsDependencyBot)
  .unless(collaboratorsNotGathered);

const linksOpenIssue = policy.baseFact(
  'links_open_issue',
  (pr) => pr.linkedIssues.some((issue) => issue.owner === ORGANIZATION && issue.state === 'OPEN'),
  { says: 'the pull request links an open issue in a jaegertracing repository', changedBy: 'author' },
);

const unapprovedIssueLabel = policy.label('unapproved-issue').when(needsIssue, linksOpenIssue);
const missingIssueLabel = policy.label('missing-issue').when(needsIssue).unless(linksOpenIssue);
policy.exclusive(missingIssueLabel, unapprovedIssueLabel);

blocked.when(needsIssue);

const flagLabelOld = policy.labelAge('flag_label_old', {
  of: [missingIssueLabel, unapprovedIssueLabel],
  days: NOTICE_DAYS,
  says: `the flag label is at least ${NOTICE_DAYS} days old`,
});
const flagExpired = policy.derivedFact('flag_expired').when(needsIssue, flagLabelOld);

policy.shouldClose.when(flagExpired);
```

A third reason to close a PR is one more `policy.shouldClose.when(...)`. A new exemption is one more `.unless(...)`. Neither touches the statements of another policy.

Three properties of the form follow from the code.

- **A veto reaches every rule that names the derived fact.** A rule that names `idle` gets `idle` after `do-not-expire`. A rule can also name the base fact `quiet_for_60_days`, and it then reads the value before the veto. The form does not prevent that, and the different name is the only thing that shows it to a reviewer.
- **Negation exists only as a veto.** A negative statement about the inputs, such as "no linked issue is open and carries `help wanted`", is computed inside a predicate. `missing-issue` is `needs_issue` with the veto `links_open_issue`.
- **The statements record the policy as data.** `policy.rules` holds one entry for each reason and each veto, such as `{ conclusion: 'idle', premises: ['do_not_expire'], isVeto: true }`, and `policy.baseFacts` holds each base fact with what it declares. The evaluator, the startup check and the decision tables read those two lists and nothing else.

A conjunction stays inside one `.when` where it is the meaning of the rule, as in `.when(needsIssue, linksOpenIssue)`. When it grows past two or three terms, part of it gets a name as a derived fact.

No rule says "when the issue loses `help wanted`, add the label" or "when the author links an issue, remove it". Those are transitions, and they are not written. A label is present exactly while a reason for it holds and no veto does.

**Two rules cannot contradict each other.** A predicate reads inputs, a rule reads facts of lower layers, and neither reads an output. The plan is therefore a function of the inputs. Two reasons for the same fact add up. Two vetoes add up. A reason and a veto that both hold are not a conflict, because the result is defined before either is written. Take one rule that keeps `stale` on an idle PR and one that closes a PR whose `stale` label is old. `stale` has the reason "no person has acted for 60 days", and closing follows from `idle_expired`, which requires the same `idle` fact. Activity by a person makes `idle` false, so the label loses its reason and the closing loses its reason in the same pass. No rule removes anything, and neither rule reads what the other produced. Applying a plan changes no input, so the next run derives the same plan, and the reconciler cannot undo in one run what it did in the run before. The condition is that the reconciler's own changes leave the inputs untouched, which is why activity is counted by actor and `updated_at` is not used.

What this form gives up is the single place where all the rules of one output are written. The decision tables take that role.

**The evaluation is one forward pass.** The facts are evaluated layer by layer, in an order that the reconciler computes from the premises of the rules when it loads them. For each derived fact and each output the combinator asks two questions of a list: does any reason hold, and does any veto hold. ([Why no inference engine](#no-inference-engine).)

### Where an exception attaches

A veto may attach to a derived fact or to an output, and the two mean different things.

- A veto on a derived fact says that the fact is not true of this item. `no_issue_needed ⇒ not needs_issue`. Everything that follows from the fact goes with it: the label, the line in the comment, the deadline.
- A veto on an output says that the fact is true and the action still does not happen. `do_not_expire ⇒ not should_close`. The PR is still flagged, still shows it, and stays open.

Both are allowed. The rule of choice is to attach the veto to the narrowest fact whose meaning the exception changes.

`do-not-expire` shows why both exist. `do_not_expire ⇒ not idle` keeps `stale` off a protected PR, so `stale` always means that the item will be closed. `actions/stale` does the same for an exempt label today. Alone it would not stop the issue-link deadline, because that deadline does not pass through `idle`. This is the gap that #10252 closed. `do_not_expire ⇒ not should_close` stops every reason to close, including the ones that later policies add. The design has both lines, and each can be read without the other.

A veto on an output cancels every reason for it, and the rule form has no veto that is scoped to one reason. An exception to one reason of an output that several policies share is therefore a derived fact one layer down. `triage_hidden` is such an output. It belongs to the triage CLI, which leaves a PR out of the attention buckets of its report while the output holds, and each fact that makes a PR not reviewable is a reason for it. Failing CI is one of those reasons, except when the only failing checks are label gates, because a maintainer clears those with a label. The exception is a derived fact of its own, and `triage_hidden` lists that fact:

```ts
const ciFailingWithoutLabelOnlyFailure = policy
  .derivedFact('ci_failing_without_label_only_failure')
  .when(ciFailing)
  .unless(labelOnlyFailure);

policy.triageHidden.when(ciFailingWithoutLabelOnlyFailure);
```

`policy.triageHidden.unless(labelOnlyFailure)` would be wrong, because it would also show a PR that has a merge conflict.

An exception to an exception is written in the same way: the premise of the veto becomes a derived fact, which then has reasons and vetoes of its own one layer down.

The layers stay acyclic by one rule: a rule, reason or veto alike, reads facts of lower layers. It never reads its own conclusion, a fact of the same or a higher layer, or an output. A veto is a negation, and Datalog calls negation that is restricted in this way "stratified"; the restriction is what gives every fact exactly one value. Each rule records its premises. The reconciler orders the layers from them when it loads the rules, and it fails on a cycle.

### The policies

In the second column an arrow is a reason, and a name with a colon is a base fact with what its predicate tests.

| Policy | Base facts and reasons | Vetoes | Fits |
|---|---|---|---|
| Linked issue | no linked issue is open and carries `help wanted` ⇒ `needs_issue` · `links_open_issue`: the PR links an open issue in a `jaegertracing` repository · `needs_issue ∧ links_open_issue` ⇒ label `unapproved-issue` · `needs_issue` ⇒ label `missing-issue` | `no_issue_needed` ⇒ not `needs_issue` · `author_can_write` ⇒ not `needs_issue` · `author_is_dependency_bot` ⇒ not `needs_issue` · `collaborators_not_gathered` ⇒ not `needs_issue` · `links_open_issue` ⇒ not label `missing-issue` | Yes |
| Linked-issue deadline | `needs_issue` ∧ the flag label is at least 7 days old ⇒ `flag_expired` · `flag_expired` ⇒ `should_close` | `do_not_expire` ⇒ not `should_close` | Yes. Closing cannot be undone by the next run; see "What is not declarative". |
| Stale | no person has acted for 60 days ⇒ `idle` · `idle` ⇒ label `stale` · `idle` ∧ the `stale` label is at least 14 days old ⇒ `idle_expired` · `idle_expired` ⇒ `should_close` | `do_not_expire` ⇒ not `idle` | Yes, once activity means activity by a person. `actions/stale` cannot make that distinction. |
| Duplicates | `is_duplicate`: an older open PR of the same repository closes an issue that the PR closes, and the issue does not carry `allow-multiple-prs` · `is_duplicate` ⇒ label `duplicate` | None. The predicate reads `allow-multiple-prs` | Yes. Two open PRs on one issue are duplicates whatever else is true of them: a PR that is flagged, over quota or stale counts like any other. The policy counts issues of the PR's own repository only, as `pr-duplicates` does. The label is read for each issue, because a PR can close two issues and only one of them may carry the label. |
| Author quota | `over_quota`: the position of the PR among the author's open PRs, in creation order, exceeds the quota for the author's merged PR count · `over_quota` ⇒ label `pr-quota-reached` | None today | Yes. The rule needs a count and a rank. |
| Waiting for author | `maintainer_spoke_last`: a conversation comment or a review that is not an approval, of a maintainer who has not approved since, is newer than the author's latest comment, review and push · `maintainer_spoke_last` ⇒ `authors_turn` · `blocked` ⇒ `authors_turn`, because no review helps until the author has dealt with what blocks the PR · `authors_turn` ⇒ label `waiting-for-author` | None today | Yes. It replaces a reaction to single events. Whether a comment asks for anything is a judgment that neither form has. |
| Blocked, and the comment | `needs_issue` ⇒ `blocked` · `over_quota` ⇒ `blocked` · `is_duplicate` ⇒ `blocked` · `blocked` ⇒ the comment exists · `idle` ⇒ the comment exists | None today | Yes, as a statement: for every label of the plan that gives notice, a policy comment exists that was created after the PR got the label. Creating the comment is the non-declarative part. |
| Changelog label | no `changelog:` label ⇒ the check fails | None | In part. The reconciler can observe that the invariant is broken and cannot restore it, because only a person can choose the label. It remains a failing required check. |

`do-not-expire` appears twice, each time as one `.unless(doNotExpire)`. Today the same exemption is a list in each stale step and a condition in #10257.

An idle PR is not blocked, so `stale` alone does not make it the author's turn: the person who has to act on an idle PR can be a maintainer.

The policies use one definition of a maintainer: a person whom the repository lists as a collaborator with `admin`, `maintain` or `write`. `author_can_write` and the turn read the same list. GitHub gives the list only to a token with push access to the repository. A run without the list knows no maintainer, so `collaborators_not_gathered` holds for every PR of that repository: no PR needs an issue and it is the turn of no author, because the alternative is to treat every maintainer as an outside contributor.

### Time and history

A time rule is an invariant like the others. The clock is an input, so an age is a function of the inputs, and "closed a week after flagging" is `Age ≥ days(7) ⇒ closed`. Nothing counts down and nothing has to fire. The thresholds are inclusive: a PR that has been flagged for exactly 7 days is closed, and one that has been idle for exactly 60 days is stale.

**A deadline starts at a label event.** For the issue-link deadline the base timestamp is `flagged_since`: the start of the current unbroken period in which the PR carries a flag label. GitHub records it. Both the REST endpoint `issues/{number}/events` and the GraphQL `timelineItems` connection return a `labeled` and an `unlabeled` event for every label change, with the label name, the actor and a timestamp to the second. On jaeger-ui PR 4815 the two interfaces return the same five label events. The events are kept: issues of jaeger created in 2017 still return theirs. The GraphQL connection filters by event type, so the query costs one small connection per PR. ([Why the label event and not the comment](#a-deadline-starts-at-the-label-event).)

The cost is that the label has two roles: it shows the conclusion, and its event time is the start of the deadline. A maintainer who removes the label by hand restarts the week when the reconciler puts it back, and a maintainer who applies it by hand starts one. Both are visible in the timeline with the actor's name.

The other values that depend on history come from the same timeline:

| Value | Inputs |
|---|---|
| `flagged_since` | `labeled` and `unlabeled` events of the two flag labels, which count as one label |
| The author has acted since a maintainer last passed the turn | The conversation comments and the reviews of the author and of maintainers, and the pushes of the author |
| `idle_age` | The newest of: the creation of the PR, a conversation comment, a review, a commit and a force push, each by a person who is not a bot. A policy comment is not activity, whoever posted it. |

**Activity has one definition:** a comment, a review or a push by a person who is not a bot. Every rule that asks whether somebody acted uses it, the idle rule and the turn alike. Every push counts, a force push included, whatever its commits are. A merge from the base branch is therefore activity, and a push by the author that holds only such a merge passes the turn to the maintainers. One commit is not a push of the author: a merge commit that GitHub attributes to another account, which is what a maintainer adds with "Update branch". It is activity of that maintainer for the idle rule, and it does not pass the turn. A commit of a second account of the author, or of an email that belongs to no account, counts as the author's. GraphQL returns no time of a push. It returns the committed date of each commit and the time of a force push. The rules therefore date a push by its commit, and that date is older than the push when the author pushes work that was committed earlier.

A label change is not activity. A maintainer who wants to keep a PR open has two inputs for it, a comment and `do-not-expire`. ([Why a label change does not count](#activity-is-an-act-of-a-person).)

The consequence is that `idle` holds earlier than `stale` does today. `actions/stale` restarts its clock on every change of `updated_at`, and a label change, a comment by a bot and every write of another action move that time. A PR that only such changes kept fresh gets the `stale` notice in the first run in write mode, and it is closed 14 days later unless a person comments, reviews or pushes. "Intended differences" counts these PRs in the backtest.

**The turn after a review.** A review by a maintainer that requests changes or only comments passes the turn to the author, as a conversation comment by a maintainer does. An approval leaves the turn with the maintainers, because the next step is the merge and the merge is theirs. An approval also withdraws what the same maintainer asked before it: a comment or a review of a maintainer passes the turn only while that maintainer has not approved since. The request of another maintainer still stands.

What was not checked: what the events of a label return after the label is renamed or deleted from the repository.

### Notice periods

A deadline that runs from a warning cannot be derived from inputs alone, because the warning is an act of the automation: "closed seven days after it was flagged" depends on when the reconciler applied its own label. The design permits one form of rule that reads such a time, the "notice": a reason that names a fact beside the age of that fact's label, as in `policy.derivedFact('idle_expired').when(idle, staleLabelOld)`. `idle_expired` and `flag_expired` are the two instances.

`policy.labelAge()` declares the age as a base fact, the "label age". It holds when the PR has carried one of the named labels, without a break, for the given number of days. Its predicate is the only one that the design allows to read something that the reconciler wrote: the inputs that every other predicate of the reconciler receives leave out the dates of the label periods.

The form is safe for three reasons. The rule repeats the fact that gives the label its reason, so the deadline can never expire while the label is unwanted. The label's own rules read nothing of the deadline, so the dependency runs one way. And what is read is the age of the label, which only grows while the label stays.

The startup check tests the form in two parts, because the first reason has no structural test. The structural part accepts a label age only in a reason, never in a veto, and only beside another fact. It cannot tell whether that fact is the one behind the label when one fact shows as either of two labels, as `needs_issue` does. The enumeration covers the rest: it derives the plan of each row, sets every label age to what the labels of that plan leave, and derives again. A notice whose fact is not the one behind its label gives a second plan that differs from the first.

### The comment

The reconciler keeps one visible comment on a PR. `blocked` is a reason for it, and so is `idle`: a PR is closed two weeks after the `stale` label, so the notice has to exist, and `actions/stale` posts such a notice today.

The name of a rule does not carry the data that a comment needs. The comment of today names the linked issue that is closed and the PR that came first on an issue. A base fact therefore has two texts. `says` is its static wording. The summary is what the predicate found on this PR, and the predicate returns it with the boolean:

```ts
(pr, { now }) => {
  const days = daysSince(pr.lastActivityByPersonAt, now);
  return {
    holds: days >= IDLE_DAYS,
    summary: `The last comment, review or push by a person is ${days} days old.`,
  };
};
```

The comment has one paragraph for each base fact that leads to it, through `blocked` or directly: the `says` wording of the fact and the summary of its predicate. While the PR stays open, the comment ends with the deadline of each notice period that runs, and it states none for a PR that carries `do-not-expire`. The cost of the summary is that it is code that the decision tables do not show: a table says that a PR gets a comment, and not what the comment says.

The reconciler posts a new comment, which notifies the author, in three cases, and it then minimizes its older comments:

- The author was not told about a reason: no policy comment is newer than the label of that reason.
- The PR is closed. The comment says that the PR is closed, lists the reasons that hold, and says that the PR can be reopened once they no longer hold. It stands next to the closing at the end of the thread, where an edited older comment would be folded away on a long thread.
- Nothing blocks the PR any more, and an earlier comment of the reconciler said otherwise. The author of a PR that left the quota or got its issue approved learns that a review can now happen.

In every other case the reconciler edits its newest visible comment in place, which sends no notification: the author knows every reason, and only the text differs. A comment that a person minimized still counts as what the author was told, and it is neither edited nor made visible again.

### Plan and apply

The reconciler does four things in one run, and only the last one changes GitHub.

1. **Observe.** It queries the open PRs with their inputs. A query that fails or returns a truncated list ends the run. An absent fact must never be read as a false one, because "no linked issue" leads to a closed PR.
2. **Derive.** It evaluates the rules for every PR in one forward pass. The result is the "plan": for each PR, the set of labels that the reconciler owns and the PR should carry, the text of the comment, and whether the PR should be closed.
3. **Compare.** It subtracts what the PR has from the plan. The difference is a list of six kinds of change: add a label, remove a label, create a comment, edit a comment, minimize a comment, close. Minimizing applies to the older comments of the replaced actions and of the reconciler, once a newer comment has taken their place.
4. **Apply.** It makes those changes. A PR whose plan matches its state receives no API call that changes it, so its `updated_at` does not move.

The terms come from Terraform's `plan` and `apply`. A run in shadow mode stops after step 3 and reports the difference.

Steps 1 to 3 are two layers with one data structure between them. "Gathering" is step 1. It is the only layer that talks to GitHub, uses the cache or reads the clock, and it returns a "snapshot": everything that the run observed, with the time of the run, as plain data. "Deciding" is steps 2 and 3. It is a function of the snapshot and the config, and it makes no call. A run can save its snapshot to a file, and a later run can decide from that file. The triage CLI has both layers in this form: `triage --save-snapshot <file>` writes the snapshot, and `triage --snapshot <file>` decides from it.

Two runs are compared by a JSON report that holds the decisions for each PR and none of the fetched data. Two versions of the code that decide from one snapshot give the same report, or the difference of the reports is exactly what the change did. A refactoring is verified in this way, and so is a change of the rules in shadow mode.

### What is not declarative

Three things remain outside the rules. Each is in the machinery once, not in each policy.

- **Creating a comment cannot be repeated safely.** Adding a label twice is harmless. Creating a comment twice leaves two comments, and each notifies the author. The notification invariant makes a single run correct. Two runs at the same time would both observe that the comment is missing. The reconciler therefore runs under one concurrency group per repository. This is also why the invariant speaks of the creation time of the comment: GitHub notifies for a new comment and not for an edit, so "the author was told about this label" is the fact that a policy comment exists that was created after the PR got the label. GitHub records both times to the second, and the reconciler writes the label before the comment, so a comment that was created in the same second as the label counts. The time at which the PR got the label is the start of the current unbroken period of the label in the timeline, and the two flag labels count as one. A label that was removed and applied again has a new period, so the author is told again.
- **The order of changes within one run.** A run can fail between two changes. The next run observes the half-finished item as it would any other and finishes the work, provided that no intermediate state makes a rule hold by accident. `apply()` therefore uses one fixed order: add labels, remove labels, create or edit the comment, minimize older comments, close. Adding before removing keeps the flagged period unbroken across a swap from `missing-issue` to `unapproved-issue`. The label precedes the comment so that the comment is newer than the label. Closing is last, after the comment that says that the PR is closed. A run that stopped between the two finds its newest comment with the text of the plan, so the next run closes the PR and posts no second comment.
- **Closing reaches a person and cannot be taken back.** `should_close` is derived like any other output, but a wrong conclusion has already sent a notification by the time the next run sees better facts. Three guards follow. A run with incomplete facts ends before it derives anything. And the rules never conclude "open": the reconciler does not reopen a PR. A person reopens it, and if it still violates and its label is still at least seven days old, the next run closes it again, as #10257 specifies. A run also fetches fresh, in the same run, every PR that the plan closes from cached facts, and derives the plan again.

### Decision tables

Nothing guarantees that a set of rules is complete, and the word has three meanings here.

- *Every item gets a defined result.* This holds. Evaluation is closed-world: a fact for which no reason holds is false. An item about which no rule says anything gets no label and no comment and stays open. There is no undefined case and no final "else" to forget.
- *Every situation that the project cares about has a rule.* No formalism guarantees this. A missing rule is silent: the item gets nothing. The design can only make the silence visible, through the decision tables.
- *Every rule can hold, and outputs that exclude each other never hold together.* Both are checked by enumeration.

A **decision table** is generated for each output. A generator enumerates the combinations of the base facts that the output depends on through the layers, evaluates the rules, and writes one row per combination: the result, and the names of the reasons and vetoes of that output that held. Rows that differ only in a base fact that does not matter are merged. The tables are committed files. A PR that adds a rule changes them, and the reviewer reads the consequences as a diff: which combinations now close, and which no longer carry a label. A row with no reason is a combination that the rules say nothing about, and it is there to be read.

The table of `label:stale` in the prototype is the smallest one. It is shown here with the base fact under the name `quiet_for_60_days`:

| quiet_for_60_days | do_not_expire | `label:stale` | reasons that held | vetoes that held |
|---|---|---|---|---|
| yes | yes | no | | |
| yes | no | **yes** | idle | |
| no | - | no | | |

Three limits of the tables showed in the prototype.

- **A table stays readable only when it names the rules of its own output.** A table that named every rule that held in the layers below would have a different last column in almost every row, and no rows would merge. `should_close` depends on eight base facts, which is 256 combinations, and its table has 24 rows. The table of `comment` has 21.
- **A table still grows fast.** Each reason that is added to an output roughly doubles its table, because the base facts of the new reason combine with the rows that exist.
- **A table does not show what a predicate reads.** The base facts are enumerated as independent booleans, and a predicate is opaque to the enumeration. In the table of `label:duplicate`, `is_duplicate` is one column and `allow-multiple-prs` does not appear, because the predicate reads that label of the issue.

The same enumeration runs two checks. A rule, a derived fact or an output that holds in no row is reported as one that never holds. A declared exclusion, such as `policy.exclusive(missingIssueLabel, unapprovedIssueLabel)`, fails in any row in which both hold.

### The startup check

The reconciler checks its rule set when it loads, before it queries GitHub and before it changes anything. A rule set that fails the check does not run. The alternative is to learn on a live PR that an item cannot progress, or that two rules keep undoing each other, which is how the motivating case was learned.

A "violation" is a defect of the rule set, independent of any particular PR, that makes the plan undefined, unstable or impossible to carry out. Six kinds exist for this rule form. The rule form of the first migration step reports three of them. Its evaluator reports the dependency cycle when it loads a policy, and its startup check reports the output that no person can clear and the rule that never holds. In that rule form a rule that reads an output cannot be written: only `.when` and `.unless` record a rule, and they accept facts only. The reconciler adds the check for it together with the label ages, which let a rule name an output. The other two kinds concern labels and label ages, and the reconciler adds them with those outputs. The TypeScript compiler refuses part of them before the rules ever load, because the builder's types limit what a statement can name.

| Kind | Example | Refused by the compiler | Reported when the rule set loads |
|---|---|---|---|
| A dependency cycle, through a reason or a veto | `idle_expired ⇒ not idle` together with `idle ∧ stale_label_old ⇒ idle_expired` | In part ¹ | A depth-first walk over what each rule reads fails with the rules on the cycle |
| A rule that reads an output | A predicate that tests for the `stale` label | An output passed to `.when` or `.unless`. The inputs of a predicate of the reconciler do not contain the labels, the comment or the open state that the reconciler owns. A predicate of the checks receives the whole PR, so the compiler refuses nothing there | A label age outside the notice form, and any rule that is added to the policy without the builder |
| Two outputs that exclude each other and both hold | `missing-issue` and `unapproved-issue`; open and closed | Open against closed, because no statement can conclude "open" | Declared pairs, by enumeration: a row in which both hold fails, with the rules that held |
| An output that no person can clear | A `blocked` PR that nothing a person does can unblock | A label that the reconciler does not own | A conclusion that is no output and that nothing reads. By enumeration: an output that holds in a row and still holds for every value of the base facts whose change source is the author or a maintainer |
| Non-convergence: deriving again after the plan is applied gives a different plan | A deadline that reads the age of a label which its own plan removes | No | By enumeration: each row is derived, the label ages are set to what the labels of that plan leave, and the row is derived again |
| A rule that never holds | A reason that names a fact which nothing declares; a rule whose premises hold together in no row | No | A premise that is no base fact and that no rule decides. By enumeration: a rule, a derived fact or an output that holds in no row |

- ¹ A chained definition can name only constants that are declared above it, so a cycle cannot be written inside the declarations of one module, and modules that import each other in a circle fail at load. A cycle can still be written by a separate statement after the declarations, such as `idle.unless(idleExpired)`, and the load-time check reports it.

The prototype carries seven seeded violations, and each stops the load with a message that names the rules:

```
seeded: cycle-through-veto
  dependency cycle: idle_expired reads idle reads idle_expired
    rules: idle ∧ stale_label_old ⇒ idle_expired | idle_expired ⇒ not idle

seeded: label-age-outside-notice-form
  rule reads an output: a rule reads the age of label:stale through stale_label_old outside the notice form, which is a reason with a fact beside the age
    rules: stale_label_old ⇒ not needs_issue
```

**The convergence check is narrow, and that is correct.** The plan is a function of the base facts that its outputs depend on, and applying a plan changes none of them except the label ages. The label ages are therefore the only path by which one plan can change the next. A check that applied each plan to a stand-in for GitHub and derived again would return the same plan for every other base fact, and it would find nothing more for a single PR. The enumeration tests the one path that exists.

**The representation that this requires.** A check at load time cannot look inside a function. The statements of the builder therefore produce data, in two parts.

- A **base fact** is a named boolean, such as `quiet_for_60_days` for "no person has acted on the pull request for 60 days". Its predicate is opaque code. What the check knows about it is declared: its change source (`changedBy`) and, for a label age, which labels it measures.
- A **rule** is data: its conclusion, its premises, which are the names of the facts that must all hold, and whether it is a veto. It contains no code.

A threshold lives inside a predicate, so the check sees booleans only. A base fact whose predicate reads other items, such as `is_duplicate`, is one free boolean of the enumeration.

One change source per base fact is a simplification that the check for an output that no person can clear depends on. `no_approved_issue` has the change source `author`, although a maintainer who adds `help wanted` to the issue changes it too.

**The size of the space.** The figures of this paragraph are measured on the prototype. It declares a base fact and its vetoes in one statement, so its count has no reason from `quiet_for_60_days` to `idle`, and it does not hold the facts of the checks. Its policies are 25 rules over 14 base facts. The check does not enumerate the full product of 16,384 combinations. It enumerates, for each output and each declared exclusion, only the base facts that the output depends on through the layers: eight for `should_close` and eight for `comment`, which is 256 rows each. The cost then grows with the widest single output and not with the number of policies. The structural part and the enumeration together take about 40 ms.

Enumeration of booleans is a complete decision procedure at this size, so the check proves what it reports and needs no solver. Both parts therefore run whenever the rule set is loaded: the structural part and, when it passes, the enumeration.

**Scenario tests cover what the check does not.** The check covers one PR. A table test names a situation with several PRs, such as two flagged PRs that link the same issue, and asserts the whole plan against an in-memory stand-in for GitHub.

**Where the check runs.** The rules live in `maintainer-tools` and nowhere else, and every repository gets the same rules. The check and the decision-table tests run in the CI of `maintainer-tools` on every change to the rules, and a change that fails them is not merged or released. A calling repository carries no rule definitions and needs no lint action of its own: the version that it pins has already passed. The reconciler runs the same check again when it loads, which costs milliseconds and stops a build that reached a repository without passing CI.

**Per-repository input.** The policies of today need none. The label names, the thresholds, the quota tiers, the dependency bots and the link to the contributing guidelines are the same in jaeger and jaeger-ui, so they are part of the rules. Who is a maintainer and which organization the repository belongs to are observed from GitHub. A calling workflow passes two operational inputs: the token and the mode, shadow or write. The action validates the mode when it starts and stops on a value that it does not know. If a value ever has to differ between repositories, it is added as a named parameter of a predicate, with a declared type and range that the action validates at startup, and never as a rule.

**On failure** the reconciler exits with an error before its first query. The message names the kind of violation and the rules involved, and for a failure found by enumeration it prints the row: the value of each base fact, and the rules that held.

**What the check cannot catch:**

- A predicate that computes the wrong boolean or the wrong summary from GitHub's data. It is a function, and the types limit what it receives, not what it does. The check trusts the name.
- A predicate that reads an output through the data that it receives. A predicate of the checks receives the whole PR, and `stale_on_author` reads the `stale` label in this way.
- A policy module that nothing imports. Its statements never reach the `Policy` object, and the check sees a rule set without them.
- A rule that is missing. The decision tables show the rows with no reason, and a person has to judge them.
- A false alarm in a row that cannot occur. The base facts are enumerated as independent, and some are not: a `stale` label cannot be 14 days old on a PR that somebody touched yesterday. Such rows also appear in the decision tables.
- Interactions among several PRs. The check treats "an older open PR closes the same issue" as one free boolean, and its convergence check covers one PR. Sets of PRs are covered by scenario tests, which are not exhaustive.
- A person or another bot that undoes a change. No rule set contains them.

### The run model

Each repository has one workflow. It is triggered by `pull_request_target`, by issue events, by conversation comments, by `workflow_run` and by a daily schedule, and it runs the reconciler in one job under one concurrency group for the whole repository. The group is a global lock: one run changes the repository at a time. The comment events are in the list because the turn rule depends on them, and without them `waiting-for-author` would change only once a day.

**Reviews arrive through `workflow_run`.** The turn rule depends on reviews too, and the reconciler cannot run on a review event. GitHub runs `pull_request_review` and `pull_request_review_comment` from the merge commit of the PR [\[7\]](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows). For a PR from a fork, the author of the PR therefore controls the workflow file, and the token is read-only. A second workflow with no steps of consequence and no permissions is triggered by the two review events, and its completion starts the reconciler through `workflow_run`. Every trigger of the reconciler then runs the workflow file of the default branch with a token that can write.

**Why the lock loses nothing.** GitHub keeps one running and one pending run in a concurrency group, and a newer pending run replaces an older one. The reconciler is level-triggered: an event wakes it and does not tell it what to do. A run observes the repository when it starts, which is after the event that queued it and after every event that queued a run it replaced. The pending run that survives therefore covers all of them. This holds only if a run selects its work from the state of the repository and never from the payload of the event that started it.

**What a run covers.** Every run covers all open PRs. ([Why not only the item of the event](#every-run-covers-all-open-prs).) The costs are latency and API budget. Latency is the wait for the lock plus one run: a change is visible within about two run durations of the event, and a run is dominated by the start of the runner. The budget is handled by a cache of observed inputs, described next.

This model replaces the per-PR dispatch and per-PR group of #10234, the repository group of `pr-duplicates`, the author group of `pr-quota-manager` and the scheduled job that sits outside all of them. It has one cost that the dispatch was built to avoid: a pending run that GitHub replaces shows as a cancelled check on the PR whose event queued it. The check is not required, and the run that replaced it does the work.

The daily run covers what no event reports: a deadline that expires, a label change on an issue in another repository, and an issue linked through the sidebar.

### API budget and the cache of observed inputs

**The budget.** The workflow token has 1,000 GraphQL points per hour for the repository [\[8\]](https://docs.github.com/en/graphql/overview/rate-limits-and-node-limits-for-the-graphql-api). A query costs one point for every hundred requests that its nested connections would need. The backtest measured the cost that GitHub reports, with one run from an empty cache and one from a full cache for each repository:

| Repository | Open PRs | Empty cache | Full cache |
|---|---|---|---|
| jaeger | 180 | 49 points in 13 queries | 3 points in 3 queries |
| jaeger-ui | 83 | 24 points in 8 queries | 2 points in 2 queries |

The two runs gave the same plan for each of the 263 PRs. The budget allows about 20 runs an hour from an empty cache in jaeger. The lock lets one run follow another without pause, so a busy hour can exceed that without the cache. The backtest ran from a laptop with a maintainer's token, and it did not exercise the load of events.

**The queries.** Every run still covers all open PRs, and it fetches the full inputs only for the PRs whose inputs may have changed. A run makes four kinds of query.

| Query | Returns | When |
|---|---|---|
| Listing | Every open PR with its author, its creation time, its `updatedAt`, and the repository, state and `updatedAt` of each linked issue | Every run |
| Collaborators | The permission of everyone who has one on the repository | Every run |
| Inputs, 20 PRs in a query | Labels, linked issues with their labels, label events, conversation comments, reviews, commits and force pushes | For a PR whose cached row is missing or not current |
| Merged counts, 50 authors in a query | The number of merged PRs of an author | For an author with two or more open PRs whose cached count may have changed |

The reconciler has no cache, query builder or refresh loop of its own. It shares one of each with the triage CLI, as "One fact layer for the reconciler, the checks and the triage report" describes: the GraphQL client with its token lookup and retries, the cache of `packages/checks/src/cache.ts`, and the loop that lists the open PRs, compares each with its cached row and fetches the misses. The listing carries what the rules over a set need, which is the author, the creation time and the linked issues of every open PR. One rule says when a cached row is current. Its key holds the signals of the table below, and also the head commit and the check status, which the checks depend on. The cached rows carry a version number, which makes every row a miss when the shape of the inputs changes.

**When a cached row is current.** `updatedAt` covers what happens on the PR itself. A label change moves it: on jaeger-ui PR 4815 `updatedAt` equals the time of its last label event. Comments, reviews and pushes move it as well. Five kinds of input that the predicates read do not move it, and each gets its own signal:

| Input that `updatedAt` of the PR does not cover | How a run detects a change |
|---|---|
| A linked issue: its labels and state, also in another repository | The listing carries, for each PR, its closing issue references with each issue's repository, state and `updatedAt`. These join the freshness key. A different set of issues, or a different `updatedAt` on one of them, makes the PR a miss. |
| The other PRs on the same issue, and the author's open PRs | Nothing is fetched. The listing carries the author, the creation time and the issue references of every open PR, and the rules over a set are evaluated on the listing and the cached facts in every run. |
| The author's merged PR count | It is fetched only for an author with two or more open PRs, because the oldest open PR is within every quota. It is cached per author and can only grow. It is fetched again when a PR that was open at the last fetch has left the listing, and never once it has reached the count that gives the highest quota. |
| The permission of the author and of each commenter | One query returns the collaborators of the repository with their permissions, and every run makes it. The list is not cached, so the next run sees a change of permission. |
| The passage of time | Nothing is fetched. A deadline is evaluated in every run from the cached timestamps and the current time. |

Two gaps in these keys are known. A label that an issue form applies when the issue is created has an event one to three seconds newer than `updatedAt` of the issue, so the key does not see that label; every other label change that was examined moved `updatedAt` of its issue. And the merged count of an author whose PR was opened and merged between two runs is not fetched again until another PR of that author leaves the listing. Other gaps may exist that nobody has listed. The daily run therefore ignores the cache and fetches everything, which bounds any gap to a day at the cost of one run from an empty cache. A PR that a run is about to close is also fetched fresh in that run, so the one change that cannot be taken back never rests on cached facts.

Who counts as a maintainer, what the last activity was and which comment is a policy comment are derived after the cache, from the cached facts and the collaborators of the run. A change to one of those definitions therefore needs no new cache.

Two more things were checked on live data. A label change moves `updatedAt` of a PR. A cross-reference from another item does not move `updatedAt` of an issue: jaeger issue 10187 has a cross-reference event that is newer than its `updatedAt`.

**Where the cache is kept between runs.** A runner starts empty, so the file has to be stored outside it. Each run uploads the cache as a workflow artifact, with a retention of a few days, and the next run downloads the artifact of the previous run of the same workflow. The cost is a lookup of the previous run and one more permission for the token. ([Why an artifact](#the-cache-is-an-artifact-of-the-previous-run).)

The cache code of the CLI is backed by `node:sqlite`, and the actions of `maintainer-tools` declare the `node20` runtime, which does not have that module; ARCHITECTURE.md keeps the cache out of their bundles for this reason. The observer sees the cache as a store of JSON values under a scope and a key (the `FactCache` interface), and the CLI backs that store with the SQLite file. The action backs the same interface with a plain JSON file, which is also what an artifact holds, so the action needs no runtime that has the module.

**The invariant that makes this safe.** The stored file is a cache of observed inputs and never a source of truth.

- The reconciler derives the same plan from an empty cache as from a full one. The observer tests derive every scenario both ways and compare the plans, and the backtest did the same for the open PRs of both repositories.
- A cache that is lost, expired or of an older version costs API calls and nothing else.
- No decision exists only in the cache. The file holds inputs as GitHub returned them, each with the key that says whether it is still current. It holds no plan, no output and no record of what the reconciler did. "Flagged at" is the label event in the timeline, and "notified" is the comment on the PR.
- The file is untrusted input. Its content is public data, so reading it discloses nothing. Writing it is the risk: a false row with a matching key would feed the rules false facts. The reconciler validates the shape of the file, takes it only from a run of its own workflow, and fetches a PR fresh before it closes it. The workflow never checks out or runs code from a PR.

**Measurement under load.** The figures above are for single runs. Shadow mode in Actions runs the reconciler under the real event load in two configurations, with the cache and without it. Each run logs the cost that GitHub reports for its queries, the number of PRs fetched in full, and the points that remain. The cutover waits until the run with the cache stays within the budget on the busiest observed hour.

### Where it lives

The reconciler lives in `jaegertracing/maintainer-tools`, as one action that jaeger, jaeger-ui and the other repositories call at a pinned version from one workflow file. A policy change is reviewed in `maintainer-tools` and reaches each repository through a version bump. One action for every lifecycle policy supersedes the choice of ARCHITECTURE.md, which is one action per tool. ([Why one action](#one-action-in-maintainer-tools).)

`maintainer-tools` already has the parts: predicates that are pure functions of the PR with an injected clock, one GraphQL query per PR that feeds all of them, a comment writer that skips an unchanged body, a dry-run mode on every action, and a CLI that runs the same code on a laptop. The reconciler is built on the same fact layer as those consumers, as "One fact layer for the reconciler, the checks and the triage report" describes. The CLI replaces the three local scripts in `jaeger/.github/scripts`. `jaegertracing/jaeger` is a Go repository in which this JavaScript is a guest, and jaeger-ui already pins three of its commits.

The triage CLI stays separate, because it changes nothing on GitHub. The `pr-nudge` action does not stay, and nothing replaces it, as "No fact of the policy blocks a merge" describes.

The other two homes end as follows:

- **`jaegertracing/jaeger`** keeps one workflow file. The four actions, their workflows and the scripts are deleted at the cutover. The contributing guidelines stay the statement of the policies.
- **`rustybot`** is archived. It has no engine to revive, and the design does not use its mechanism. Its `issue-manager.yml` is the reference for the issue workflow if that work is taken up.

The cost of this home is that a policy change is made in one repository and takes effect in another: a release of `maintainer-tools`, then a version bump in each consumer, which Renovate raises. The committed `dist/` bundle of each action is part of every such change.

### One fact layer for the reconciler, the checks and the triage report

`maintainer-tools` already derives facts about a PR for two consumers. The `pr-nudge` action publishes check runs, and the triage CLI sorts the open PRs into attention buckets and renders a report. Both run the predicates of `packages/checks`. A predicate is a function of one PR that returns whether it triggered, a summary, and the surfaces that it appears on.

The reconciler is a third consumer. The prototype is not built on that code: it has its own data model and queries, its own definitions of the issue link, the quota, the turn and the duplicates, its own comment writer and its own cache. Merging it in that form would put three definitions of the quota into one repository, and two of every other policy. Separate definitions of one policy are the defect that this RFC removes from the workflows, so the consumers share one fact layer:

- **A check becomes a base fact.** The predicate of a check is the function that `policy.baseFact()` takes. `dco_missing`, `ci_failing`, `merge_conflict` and the others move into the policy that the checks share, and the summary of a check is the summary that its predicate returns. The rule form is the one that stays, because a predicate alone cannot express a veto or a fact over several PRs, and the startup check cannot analyze it.
- **The check runs of `pr-nudge` render one fact each, and no rule concludes them.** One table next to the predicates lists the five checks that have a check run, with the result of each. For each of them `pr-nudge` reads the fact of the check. Such a check run has three states: flagged, passing and not published. A check that is exempt for some PRs therefore also has an `applies` fact, and a check without one applies to every PR. When `applies` does not hold, `pr-nudge` publishes nothing. Otherwise the check run succeeds if the fact of the check does not hold. If the fact holds, the check run has the conclusion that the table gives for that check: a failure, or a neutral conclusion for an advisory check such as the linked issue and the missing tests. Step 1 of the migration keeps `pr-nudge` in this form. Step 3 deletes the action, the `applies` facts and the table of results, and nothing replaces them, as "No fact of the policy blocks a merge" describes.
- **A triage bucket is not a rule.** A bucket depends on who views the report and on the config: a PR that waits for the review of one maintainer is in a different bucket for every other viewer. A bucket is therefore a presentation for one viewer, and the buckets stay imperative code in the triage CLI. That code reads facts and the output `triage_hidden`. It reads no label and calls no predicate. Where it infers the state of a PR today from `stale`, `pr-quota-reached` and `missing-issue`, and computes the quota and the duplicates itself, it reads `over_quota`, `is_duplicate` and `needs_issue`. Its report is then correct for a repository in which the reconciler does not run. One fact of the checks still reads what the reconciler writes: the predicate of `stale_on_author` tests the `stale` label and `updatedAt` of the PR, and every write of the reconciler moves `updatedAt`. Only `triage_hidden` reads that fact, so no output of the reconciler depends on it.
- **The consumers read the facts and the outputs directly.** The triage CLI, the reconciler, and `pr-nudge` for as long as it exists, take what one evaluator derived for a PR. A predicate today returns a record for each check, with a boolean for each surface. Step 1 of the migration removes that record, and no view of the facts stands in for it.
- **One data model, one query builder, one cache.** One `PullRequest` type has a short field set for the sweep over all open PRs and the full set for one PR. One table holds a PR with one rule for when the row is current, and one refresh loop serves the triage CLI and the reconciler.

The cost is the size of the first step. The predicates and their tests move to the rule form, and `pr-nudge` and the triage CLI move to the facts, before the reconciler adds an output. The triage report is in daily use, so that step must not change it. Gathering and deciding, which "Plan and apply" describes, make the check exact: the code before the step and the code after it decide from one saved snapshot, and their JSON reports must be identical. "Migration Path" makes this the first step.

### No fact of the policy blocks a merge

The reconciler publishes no check run. The facts of the policy decide the labels, the comment and the closing of a PR. They also order the review queue, because the triage report leaves a flagged PR out of its attention buckets, and they set the deadline after which a PR is closed. They do not decide whether a PR may be merged. A maintainer may review and merge a PR that carries any of the flags: when a maintainer has reviewed the PR anyway, a missing issue or an exceeded quota is no reason to hold the merge. A merge is blocked only by checks that exist for their own reason, such as the DCO check, which is a legal requirement, and CI.

The `pr-nudge` action therefore has no successor. Step 3 of the migration deletes the action, the `applies` facts and the table of results.

The comment is where the author reads the flags against the PR. "The comment" defines what it lists: the comment exists when `blocked` or `idle` holds, and it has one paragraph for each base fact behind those two, which are the issue link, the quota, the duplicate and the idle time. With the reminder of "The reminder policy" the comment also exists when the reminder is due, and it then prints the summaries of the facts of the checks. A fact of the checks that holds on a PR without one of these reasons is in no comment. `description_empty` on a new PR is such a case: the triage report shows it to the maintainer, and the author is not told.

### The reminder policy

`maintainer-tools` holds one more writer of PR comments: the `pr-weekly-digest` action. On a schedule it takes the open PRs that carry `waiting-for-author` and whose `updated_at` is at least seven days old. It runs the predicates of `packages/checks` on each of them and keeps one comment on the PR that lists what the author has to fix: a missing DCO sign-off, failing CI, a merge conflict, an empty description, no linked issue, unresolved review threads. The CLI command `maintainer-tools nudge` runs the same code without writing and renders those comments into an HTML report. The command has nothing to do with the `pr-nudge` action, which publishes check runs. No workflow in the organization calls the digest, so it has never posted a comment.

The reconciler takes the place of the digest with a reminder policy. ([Why a policy and not the action](#the-reminder-is-a-policy-of-the-reconciler).) The reminder is one more reason for the comment, in the same form as the other policies:

```ts
const quietForAWeek = policy.baseFact(
  'quiet_for_a_week',
  (pr, { now }) => daysSince(pr.lastActivityByPersonAt, now) >= REMINDER_DAYS,
  { says: 'no person has commented, reviewed or pushed for a week', changedBy: 'author' },
);
const reminderDue = policy.derivedFact('reminder_due').when(authorsTurn, quietForAWeek);
policy.comment.when(reminderDue);
```

The comment prints the summaries of the facts that the checks define, so `packages/checks` stays the one definition of each of those facts, without `no_linked_issue`, which the issue link policy replaces. The comment does not mention `/awaiting-input`. An author who replies ends their turn, and the reminder goes away with it.

The facts of the checks need the sign-off of each commit, the status of the head commit, the mergeable state and the review threads, and the sweep query does not return them. A second query returns them for the PRs on which the reminder is due, which are a small part of the open PRs.

The step that adds the policy deletes the `pr-weekly-digest` action, `digest.ts` and the `nudge` command. `maintainer-tools reconcile`, which reports what the reconciler would change and changes nothing, then previews every comment that a PR can receive.

---

## Decisions and Alternatives

Each subsection gives the reasoning behind one decision of "The Design" and the alternatives that were considered.

### One reconciler over invariants

Six options were compared.

**A. Status quo: independent actions with conventions.** The actions of today, with #10257 merged, and conventions such as "the action that flags also closes" and "no action reads the label of another".

**B. Invariants and one reconciler.** The policies are invariants over observed inputs. One program observes the inputs once, derives the desired labels, comment and open state of each item, and applies the difference. It is idempotent and runs on events and on a schedule. The model is the Kubernetes controller, which compares a desired state with an observed state and acts on the difference, not on the event that woke it, and Terraform, which computes a plan from that difference and then applies it. Prow's Tide component works the same way for merging: it queries GitHub periodically for the PRs that match its criteria [\[9\]](https://github.com/kubernetes-sigs/prow). "The Design" develops this option.

**C. An explicit state machine with stored state.** The `rustybot` design: a configuration file of states and transitions, one label per state, an engine that fires transitions on events and timeouts.

**D. A shared predicate library with separate actions.** The plan of record in `maintainer-tools` [\[10\]](https://github.com/jaegertracing/maintainer-tools/blob/main/docs/rfc/0001-maintainer-pr-triage-tooling.md): pure predicates in one library, and one action per output (`pr-nudge`, `pr-weekly-digest`, `pr-quota`), each with its own workflow. `actions/stale` stays.

**E. A hosted bot.** Prow as Kubernetes runs it, with its `lifecycle`, `help`, `hold` and `require-matching-label` plugins; RepoKitteh as Envoy uses it through `repokitteh.star` [\[11\]](https://github.com/envoyproxy/envoy/blob/main/repokitteh.star); `triagebot` of the Rust project [\[12\]](https://github.com/rust-lang/triagebot); or a Probot application.

**F. A rules product or native GitHub features.** Mergify rules [\[13\]](https://docs.mergify.com/), GitHub rulesets, and single-purpose marketplace actions.

Comparable projects do not offer a seventh option. OpenTelemetry Collector Contrib runs about ten lifecycle workflows, each a shell script (`mark-issues-as-stale.sh`, `ping-codeowners-prs.sh`, `add-labels.sh` and others) [\[14\]](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/.github/workflows), which is option A at a larger size. Envoy combines RepoKitteh with `actions/stale` and its own notifier workflow. Kubernetes runs Prow on its own cluster. The Probot stale application is archived [\[15\]](https://github.com/probot/stale).

Legend: 🟢 good · 🟨 partial or caveated · ❌ poor.

| Criterion | A. Status quo | B. Invariants, one reconciler | C. Stored state machine | D. Shared library, separate actions | E. Hosted bot | F. Rules product |
|---|---|---|---|---|---|---|
| Mechanisms a maintainer must understand | ❌ ¹ | 🟢 | 🟨 ² | 🟨 | 🟨 ³ | 🟢 |
| Reading, explaining and extending a rule | 🟨 | 🟢 | 🟨 ² | 🟨 | 🟨 | 🟢 |
| Interaction bugs between policies | ❌ | 🟢 ⁴ | 🟨 ⁵ | 🟨 ⁶ | 🟢 | 🟨 |
| Where state lives, and whether it can be rebuilt | 🟨 ⁷ | 🟢 ⁸ | ❌ ⁹ | 🟢 | 🟢 | 🟢 |
| Testing the interaction of policies | ❌ | 🟢 ¹⁰ | 🟨 ¹¹ | 🟨 | ❌ ¹² | ❌ ¹² |
| Violations of the rule set reported at startup | ❌ ²³ | 🟢 ²⁴ | 🟨 ²⁵ | ❌ ²³ | ❌ | 🟨 ²⁶ |
| Cost of adding a rule | ❌ ¹³ | 🟢 | 🟨 | 🟨 | ❌ ¹⁴ | ❌ ¹⁴ |
| Covers the policies Jaeger has | 🟢 | 🟢 | 🟨 ⁵ | 🟢 | ❌ ¹⁴ | ❌ ¹⁴ |
| Reuse across repositories | 🟨 ¹⁵ | 🟢 | 🟢 | 🟢 | 🟢 | 🟢 |
| Operational cost for volunteers | 🟢 ¹⁶ | 🟢 ¹⁷ | 🟢 | 🟢 | ❌ ¹⁸ | 🟨 ¹⁹ |
| Transparency to contributors | 🟨 ²⁰ | 🟢 | 🟢 | 🟨 | 🟢 | 🟨 |
| Migration cost from today | 🟢 | 🟨 ²¹ | ❌ ²² | 🟨 | ❌ | 🟨 |

- ¹ Six actors, each with its own triggers, concurrency rule, comment marker and local script.
- ² One engine, but the configuration is states times transitions. A rule that cuts across states, such as an exemption label, is repeated in every state it touches, and the reader must also know when the stored state is trusted over the facts.
- ³ Well documented, and large: Prow has more than fifty plugins.
- ⁴ One plan holds every conclusion before anything changes. After the cutover `actions/stale` acts on issues only, and people and other bots still edit the same PR.
- ⁵ Orthogonal facets have to be forced into one label per state or multiplied into combined states.
- ⁶ The definitions agree, but each action still changes the PR on its own schedule and under its own concurrency group.
- ⁷ In GitHub, but spread over labels, four comment schemes and an Actions cache entry.
- ⁸ Recomputed on every run from the item, the clock and the item's timeline. Nothing is kept outside GitHub, and nothing is hidden on the item.
- ⁹ The state label is authoritative, so a missed event or a hand edit needs a repair path.
- ¹⁰ Two rules cannot contradict each other by construction. A generated decision table per output shows every combination of base facts and its result, and scenario tests assert whole plans.
- ¹¹ Transitions are testable one at a time. Combinations grow with the product of the states.
- ¹² The configuration runs only on the vendor's side or on a cluster.
- ¹³ An action, a workflow, a local script and a jaeger-ui copy: eleven PRs for one rule.
- ¹⁴ No examined tool has a rule for "links an issue that carries a given label" or for a per-author limit on open PRs. The Prow plugin directory has no plugin for either. Both would be custom code, deployed to a cluster for E and impossible for F.
- ¹⁵ Composite actions pinned by commit work, at five workflow files and three pins per repository.
- ¹⁶ No server. A PR that is opened starts five jobs across three workflows, and a push starts four.
- ¹⁷ No server, and one job per event. Every run covers all open PRs and fetches in full only those whose inputs may have changed, from a cache of observed inputs kept as a workflow artifact, so that it fits the hourly API budget of the workflow token.
- ¹⁸ A cluster or a service that somebody has to keep running.
- ¹⁹ No server, but a third-party application with write access to the organization.
- ²⁰ Labels and comments are visible, but a PR can collect a comment from each actor, and the check on the PR reports only that a dispatch succeeded.
- ²¹ The policies of about 1,300 lines of JavaScript are written again as rules, which the prototype has done. The write path and the workflow remain, and the result runs in shadow mode beside the existing actions before one cutover per repository.
- ²² The engine does not exist, and every policy has to be restated as states and transitions.
- ²³ There is no rule set to check. The policies are code in separate actors, and their interaction shows on a live PR.
- ²⁴ The rules are data. A structural check and an enumeration of the base facts run at every startup, and a failing rule set does not run.
- ²⁵ A configuration of states and transitions can be checked for unreachable states and missing targets. Two transitions that undo each other across runs are not visible in its structure. `rustybot` validates the schema of the file only.
- ²⁶ The product validates the syntax of its configuration, not the interplay of the rules.

This RFC recommends option B: invariants and one reconciler.

Three rows decide it. *Interaction bugs* and *testing the interaction of policies* are the rows that the motivating case is about, and B is the only option that runs on GitHub Actions and scores well on both, because it is the only one in which a policy's conclusion reaches another policy as a value inside one program and not as a label on the PR. *Operational cost* removes option E, which is otherwise the mature answer: a volunteer project has nobody to keep a cluster running, and its two central policies would still be custom plugins.

Option C loses on the rows that it was expected to win. A stored state is harder to keep correct than a derived one, the lifecycle analysis found no history that needs storing, and a rule written as an invariant is shorter and easier to extend than the same rule written as transitions, as the next subsection shows. Option D is the closest alternative and is where `maintainer-tools` stands today. It removes the duplicate definitions, and it keeps separate actors that change the same PR, which is the cause of the problems in the motivating case. Option B keeps everything that D built and merges the actors that change GitHub into one.

The rows that B loses are migration cost and one footnote of operational cost. Migration is a rewrite of logic that already has tests, and the whole rule set is backtested in shadow mode against production before one cutover per repository. The backtest measured a run with an empty cache at a twentieth of the hourly API budget. The cost under the real event load is measured in shadow mode, before anything depends on it.

### Derived facts, not a stored state machine

The hypothesis behind option C is that the lifecycle is a state machine. Three tests decide it.

**Is an item in exactly one state?** No. A PR is in one value of each of six facets. One flat machine would need a state for every combination, or it would force the facets to exclude each other. `rustybot` shows the pressure in its own configuration: each state is one label, and every transition replaces it, but idleness does not fit, so `stale` is a second label that lives inside three of the four states, and the sequence "timeout, mark stale, timeout, close" is written three times.

**Does the next value depend on history that GitHub does not hold?** No. Every facet is a function of the current state of the item, the clock, and timestamps in the item's own timeline. The last column of the facet table in "The Lifecycle" lists them. None needs a store that the reconciler would have to keep.

**Do transitions carry actions that a comparison of "should be" with "is" cannot express?** The one candidate is the notification on entry: GitHub notifies the author of a new comment and not of an edited one, so a newly flagged PR gets a new comment. "What is not declarative" states it as an invariant over the creation time of the comment.

A stored state also has a cost that derived state does not have. It is a second copy of the truth, and it goes wrong when an event is missed or a person edits a label. The race that #10234 fixes is of this kind: the label said flagged while the links said approved. The `rustybot` configuration lists the same problem as its first TODO: an issue that is closed and reopened keeps the labels of its previous pass.

The hypothesis is therefore right about ownership and wrong about mechanism. The lifecycle is one GitHub state machine and a set of orthogonal facets that are computed. The triage decision on an issue is a real sequential workflow, but a person makes each transition and the label that the person applies is already the store. A transition engine has nothing to do there.

**How far rustybot got.** The repository has 27 commits, of which the ones between July 3 and July 6, 2024 carry the work. It contains a YAML schema for states, transitions, conditions (`label`, `timeout`, `activity`, `pull-request`, `command`) and actions (`add-label`, `replace-label`, `remove-label`, `post-comment`, `close`), a loader that validates a file against the schema, and a client that lists open issues. No code evaluates a condition or applies a transition. It covers issues only. Its state store is the label, and its `timeout` condition is "not updated for N days", which is the idle-timer meaning that caused the trouble in the motivating case when it was used as a deadline. The useful artifact is `issue-manager.yml` as a statement of the intended issue workflow.

**The same rule in both forms.** `rustybot` states "an idle issue goes stale and is then closed" for the `needs-info` state like this, and repeats it with other numbers for `help-wanted` and `in-progress`:

```yaml
- description: 'Mark issue as stale after timeout'
  conditions: [{type: timeout, timeout: 30}]
  actions:    [{type: add-label, label: stale}, {type: post-comment, comment: '...'}]
- description: 'Go back to triage on activity'
  conditions: [{type: activity}]
  actions:    [{type: replace-label, label: needs-triage}, {type: remove-label, label: stale}]
- description: 'Close if stale for too long'
  conditions: [{type: label, label: stale}, {type: timeout, timeout: 30}]
  actions:    [{type: post-comment, comment: '...'}, {type: close}]
```

As invariants, for all states at once:

```ts
const issueIdle = policy.issueBaseFact(
  'issue_idle',
  (issue, { now }) => daysSince(issue.lastActivityByPersonAt, now) >= 30,
  { says: 'no person has acted on the issue for 30 days', changedBy: 'author' },
);
const staleLabel = policy.label('stale').when(issueIdle);
const issueStaleLabelOld = policy.labelAge('issue_stale_label_old', {
  of: [staleLabel],
  days: 30,
  says: 'the `stale` label is at least 30 days old',
});
policy.shouldClose.when(
  policy.issueDerivedFact('issue_idle_expired').when(issueIdle, issueStaleLabelOld),
);
```

The sketch serves the comparison only. It uses the label and the closing of a PR, because this RFC designs no outputs of an issue, and `actions/stale` stays the idle timer of issues.

| Task | Explicit transitions | Invariants |
|---|---|---|
| Read a rule | The reader follows a path: which state, which transition fired, what the previous transition left behind. | The reader reads one statement with a few premises. A predicate is a function, and the `says` phrase of its base fact states what it tests. |
| See everything that leads to an output | Every transition that carries the action, in every state. | The decision table of the output. The rules themselves are spread over the policies. |
| Explain a label to a contributor | "A transition fired at some point"; the reason is in the history. | The `says` wording of the base facts behind the label, which the shadow report prints for each PR, and their summaries in the comment. |
| Add an exemption such as `do-not-expire` | A condition on every closing transition in every state: three places in `issue-manager.yml`. | One `.unless(...)`. |
| Add a policy such as the quota | New states, or a parallel region, and a review of every transition that crosses it. | A new file, and one import of it. No existing statement is edited, and the diff of the decision tables shows what changed. |
| Remove the effect when the cause goes away | A reverse transition has to be written, and it is the one that gets forgotten. | Nothing. The label is absent when no reason holds. |
| Describe a sequence of human decisions | Natural: "from triage, a maintainer can accept or ask for information". | Awkward. Invariants say what holds, not what a person may do next. |

The lifecycle states do fall out as facts, and no transition is written for any automated rule. The last row is where transitions read better, and it concerns the issue triage workflow, in which people and not the automation make the moves.

### A veto wins: prevention, not detection

Rules written by different people at different times can contradict each other. The example to settle: one rule calls for removing `stale`, and another calls for closing the PR because it carries `stale`. Two designs answer it.

**Answer 1: prevention by construction.** This is the design. The state of an item is split into inputs that the reconciler never changes and outputs that it owns. A predicate reads inputs, a rule reads facts of lower layers, and neither reads an output, with the label age as the one exception. A rule is a reason or a veto and nothing else, and one fixed precedence combines them: a veto wins. "Small rules: reasons and vetoes" shows why two rules then cannot contradict each other.

**Answer 2: detection.** Rules may assert any action on an output, each written without knowledge of the others: "add `stale` after 60 idle days", "remove `stale` on activity", "close an item that carries `stale` for 14 days". A conflict is then a property of the rule set, and something has to find it and something has to resolve it. Finding it is the work of a solver or of tests. An SMT solver such as Z3 can prove that no assignment of facts makes two rules demand different values. Datalog with integrity constraints, and Rego, report a conflict when an evaluation produces one: Rego fails an evaluation in which a rule yields two different values. Exhaustive tests over the fact space do the same for every case they enumerate. Resolving it needs priorities between rules, and a priority is the imperative form coming back: "close if stale, but not if this, unless that".

**The feedback case.** When a rule reads something that the automation wrote, the result of one run is an input of the next, and the rules have to be evaluated to a fixed point. They may not reach one. Two controllers that each restore their own rule oscillate, which is what `actions/stale` and `pr-linked-issue` did with `stale`. Prevention rules this out inside the reconciler: the plan is a function of inputs, applying it changes no input, so the next run derives the same plan. Detection does not rule oscillation out. It finds it in the cases that the solver model or the tests cover.

Legend: 🟢 good · 🟨 partial or caveated · ❌ poor.

| Criterion | Prevention: reasons and vetoes, veto wins | Detection by exhaustive tests, with priorities | Detection by a solver, with priorities |
|---|---|---|---|
| Two rules disagree on one output | 🟢 impossible | 🟨 found for enumerated cases | 🟢 proved absent, or a counterexample |
| Oscillation between runs | 🟢 impossible inside the reconciler | 🟨 found for enumerated cases | 🟨 ¹ |
| A rule can be added without editing the existing ones | 🟢 ² | 🟢 | 🟢 |
| What a maintainer has to hold in mind | 🟢 small rules and one precedence | ❌ the rule set and its priorities | ❌ the rule set, its priorities and the solver model |
| Seeing all the rules of one output | 🟨 ² | ❌ | 🟨 |
| A label that people also set | 🟨 ³ | 🟨 | 🟨 |
| Reported at startup, before any item is touched | 🟢 ⁶ | ❌ ⁷ | 🟨 ⁷ |
| Tooling to build and keep | 🟢 the test runner | 🟢 the test runner | ❌ ⁴ |
| An actor outside the reconciler | ❌ ⁵ | ❌ ⁵ | ❌ ⁵ |

- ¹ A solver proves properties of one evaluation. Oscillation is a property of repeated runs, and proving its absence needs a model of how applying a plan changes the facts.
- ² A new rule is a new statement. All the rules of one output are then spread over several statements, possibly in several policies, and a veto can silence a reason that somebody else added. The decision table of the output is where both are read.
- ³ Every design has to decide who wins. Prevention decides it up front: the label has one writer, and a person uses an input.
- ⁴ The rules exist twice, as code that runs and as formulas that the solver checks, and the two have to be kept the same. Rego avoids the second copy, and it reports a conflict only for the inputs of an evaluation.
- ⁵ No design constrains `actions/stale`, another bot or a person. The cutover removes every other automated actor on PRs, `actions/stale` included.
- ⁶ Rules are data over base facts, so the whole check is a graph walk and an enumeration of booleans. It takes about 40 ms for the policies of the prototype.
- ⁷ Rules that assert arbitrary actions are code, and code cannot be enumerated at load time. Tests find the conflict in CI. A solver can report at startup if the rules are also given to it as formulas.

This RFC recommends prevention by construction. It is the only column in which the contradiction and the oscillation cannot occur, and it keeps what detection offers, the freedom to add a rule without editing another. It pays for that with footnote ²: the consequences of a rule are read from a generated table and not from one expression.

The construction rules are checked, at startup and in tests, as "The startup check" describes. The checks guard the construction and show its consequences. They are not the mechanism that resolves conflicts.

A solver would earn its place under conditions that this design removes. If rules could assert arbitrary actions and carried priorities, as in answer 2, a proof would have to replace the fixed precedence. If each repository could add its own rules on top of shared ones, nobody would read all the tables. If the base facts were too many to enumerate, such as interacting numeric thresholds or unbounded sets, the tables would no longer be exhaustive. Cedar ships such an analyzer for its policies, which shows what the real thing looks like. None of the three holds here. The policies of the prototype have 14 base facts, no output depends on more than eight of them, and the form of the rules keeps it that way.

**How policy engines combine rules.** The reason-and-veto form is the one that authorization engines settled on for the same problem: many small statements by different authors, one decision.

- **Cedar** allows a request when at least one `permit` policy matches and no `forbid` policy matches [\[16\]](https://docs.cedarpolicy.com/). This is the combinator of this design, with other names.
- **AWS IAM** evaluates the same way: an explicit deny in any policy overrides every allow, and a request that nothing allows is denied [\[17\]](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_evaluation-logic.html).
- **XACML** names the choice a "combining algorithm" and offers several; deny-overrides is the one that corresponds [\[18\]](https://docs.oasis-open.org/xacml/3.0/xacml-3.0-core-spec-os-en.html).
- **Datalog with stratified negation** writes the default and its exception as `flies(X) :- bird(X), not abnormal(X)`, and defines `abnormal` by its own rules.

Two things differ here. Those engines make one decision, allow or deny, and this design applies the combinator to every derived fact and every output, in layers. And the design has one level of precedence only: a veto wins. It has no numbered priorities.

### No inference engine

The power of Prolog is in finding a proof: unification, backtracking, recursion. This problem uses none of them, and the design builds no engine.

- **The rules are not recursive.** No fact is defined through itself, directly or through other facts. The facts form a directed acyclic graph, whose layers the figure in "Inputs, facts and outputs" shows.
- **Nothing is searched for.** A Prolog query asks "for which X does this hold". The reconciler asks a fixed question of every open PR: what are the values of these few named facts. Every rule has a fixed shape, and its inputs are known before it runs.
- **One forward pass computes the plan.** The facts are evaluated layer by layer, in an order that is known when the rules are written. For each derived fact and each output the combinator asks two questions of a list: does any reason hold, and does any veto hold. That is a loop over a list and not a search.
- **Applying the plan involves no planning.** The difference is a set of independent changes. Their order is one constant list, given in "What is not declarative". Nothing chooses among orders.

What could still call for a solver is the detection of contradictions between rules. "A veto wins: prevention, not detection" settles that.

### TypeScript, not a rule language

No engine has to be written, but an existing one could evaluate the rules. The forward pass is within reach of each of them: Rego, for one, forbids recursive rules, so it evaluates exactly the kind of program that this design has. Five candidates were assessed on what a volunteer maintainer can read and test: rules as statements in TypeScript that build a table of data; Rego, the Datalog-family language of Open Policy Agent; Cedar, whose `permit` and `forbid` are the reason and the veto; a Datalog or Prolog library for JavaScript; and CEL, the expression language that Kubernetes uses for admission policies.

Legend: 🟢 good · 🟨 partial or caveated · ❌ poor.

| Criterion | Fluent TypeScript | Rego | Cedar | Datalog or Prolog library | CEL |
|---|---|---|---|---|---|
| Readable without learning a rule language | 🟢 | 🟨 ¹ | 🟨 | ❌ | 🟢 |
| Reasons and vetoes combined by the language | ❌ ² | ❌ ² | 🟢 | 🟨 ³ | ❌ |
| Named facts in layers | 🟢 | 🟢 | ❌ ⁴ | 🟢 | ❌ |
| Rules over a set of PRs: oldest open, rank within an author | 🟢 | 🟢 | ❌ ⁴ | 🟨 ⁵ | ❌ ⁶ |
| Time arithmetic | 🟢 | 🟢 | 🟨 | 🟨 | 🟢 |
| Produces the comment text and the decision tables | 🟢 | 🟨 | ❌ | ❌ | ❌ |
| Enforces the declarative form | 🟨 ⁷ | 🟢 | 🟢 | 🟢 | 🟢 |
| Reports every kind of violation at startup | 🟢 ⁸ | 🟨 ⁹ | 🟨 ¹⁰ | 🟨 ⁹ | ❌ |

- ¹ Known to part of the CNCF community, but a second language for every contributor to the rules.
- ² The combinator is a function of ten lines, written once. Rego rejects a combinator that is written once for all facts as recursion, so it needs the same two-line pattern on every fact.
- ³ Stratified negation is the idiom, written out on each fact.
- ⁴ A Cedar policy decides one request about one resource. It cannot define an intermediate fact or relate two PRs, so the facts would be computed in TypeScript and Cedar would see only the last layer.
- ⁵ Relations are natural. Counting and ranking depend on the library.
- ⁶ A CEL expression judges one item. It does not derive a relation between items.
- ⁷ The rules are data and cannot break the form, and the types of the builder refuse an output as a premise. A predicate is a function and could keep state. The inputs of a predicate of the reconciler contain nothing that the reconciler owns; a predicate of the checks receives the whole PR, and `stale_on_author` reads the `stale` label ("One fact layer for the reconciler, the checks and the triage report").
- ⁸ With a checker of 223 lines that the project owns: a graph walk and an enumeration of booleans.
- ⁹ The language rejects recursion when it loads the rules, which covers the dependency cycle. Exclusions, outputs that no person can clear and non-convergence are not properties that it checks. They need the same enumeration, written as tests in or around the language.
- ¹⁰ Cedar has an analyzer that proves properties of a policy set with a solver. It sees only what is written in Cedar, which here is the last layer.

Cedar and CEL cannot express the facts or the rules over a set of PRs, and a Datalog or Prolog library costs the most to read. That leaves TypeScript and Rego.

Rego was tried on the same rules and is not used, for three reasons. Its check at load time reported the dependency cycle and none of the other kinds of violation, so the enumeration had to be written around it anyway. It rejected a combinator that is written once for all facts as recursion, so the reason-and-veto pattern had to be repeated on every fact. And it evaluated the enumeration more slowly than the TypeScript evaluator. A second language would have bought one of the six checks.

With TypeScript a maintainer reads one language, and the rules are the thin middle of the program: observing the inputs, generating the decision tables, writing the comment and applying the difference are TypeScript in any case. The cost is the code around the rules, which the project owns. In the prototype the evaluator, with the combinator and the layer order, is 210 lines, the startup check is 223, and the data types that they share are 114. That code is a loop over a list, a graph walk and a nested loop over booleans. It unifies nothing, searches nothing and does not recurse, so it is not an inference engine. It is still machinery that somebody maintains.

The combinator is this function of the evaluator. It is the same for every conclusion and names no policy:

```ts
export function decideConclusion(
  rules: readonly Rule[],
  conclusion: string,
  factHolds: (name: string) => boolean,
): Decision {
  const heldRules = rules.filter(
    (rule) => rule.conclusion === conclusion && rule.premises.every(factHolds),
  );
  const reasons = heldRules.filter((rule) => !rule.isVeto).map(premiseText);
  const vetoes = heldRules.filter((rule) => rule.isVeto).map(premiseText);
  return { holds: reasons.length > 0 && vetoes.length === 0, reasons, vetoes };
}
```

The rules stay authored in TypeScript even if a checker is added later. The statements record the rules as data, so a SAT or SMT solver can be given the rules as generated formulas, with no second copy to maintain. That is the step to take when one output depends on more base facts than enumeration can cover, at roughly 25. At eight base facts under the widest output the enumeration is the proof, and it has no dependency.

### A deadline starts at the label event

The alternative is the rule of #10257, which takes the start of the deadline from the creation time of a bot comment that the action finds through a hidden marker. The label event needs no comment and no marker, and a person can read it in the timeline of the PR. Its cost is the second role of the label that "Time and history" states. The age of a label is also the one thing a rule reads that the reconciler itself produced, and "Notice periods" states why that one case is safe.

### Activity is an act of a person

The alternative is the clock of `actions/stale`, the `updated_at` time of the PR, which every label change and every comment of a bot moves. A label change is not activity in this design, for three reasons. The PR query that the checks and the triage report run returns the labels of a PR without the time or the actor of a change. Those consumers could count a label change only with a timeline query for every PR, and activity has to mean the same for every consumer. A label change also tells the author nothing. And one bulk relabel would restart the 60 days of every open PR, which is the coupling through `updated_at` that this design removes.

### Every run covers all open PRs

The alternative is to cover the item of the event and the items that depend on it: the author's other open PRs for the quota, and the PRs that close the same issue for duplicates. That alternative breaks the property that the lock loses nothing, because a replaced pending run takes its event's item with it, and it adds a second place where the dependencies between items have to be right. The whole-repository run needs neither.

### The cache is an artifact of the previous run

Three places can hold the file between runs.

Legend: 🟢 good · 🟨 partial or caveated · ❌ poor.

| Criterion | Artifact of the previous run | `actions/cache` | File on a dedicated branch |
|---|---|---|---|
| Steps in the workflow | 🟨 ¹ | 🟢 ² | 🟨 |
| Permissions beyond those the reconciler has | 🟨 ¹ | 🟢 | ❌ ³ |
| Who else can write what the reconciler restores | 🟢 ⁴ | ❌ ⁵ | 🟨 ⁶ |
| Effect on other storage of the repository | 🟢 | 🟨 ⁷ | 🟨 ⁸ |
| Loss of the stored file | 🟢 ⁹ | 🟢 ⁹ | 🟢 |

- ¹ The run has to find the previous run of the same workflow that uploaded the artifact, and download it with that run's identifier and a token. The documentation states both requirements [\[19\]](https://docs.github.com/en/actions/tutorials/store-and-share-data). That the token needs `actions: read` is from the README of the download action and was not checked.
- ² A restore step and a save step. An entry cannot be changed once written, so every run saves under a new key and restores by key prefix, which returns the most recently created entry [\[20\]](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching).
- ³ `contents: write`, in a workflow that `pull_request_target` starts.
- ⁴ An artifact belongs to the run that uploaded it. The reconciler takes artifacts only from runs of its own workflow, and every trigger of that workflow runs the file of the default branch, so no run that a fork controls can upload one.
- ⁵ A run can restore the entries of its own branch and of the default branch. Every trigger of this workflow runs in the context of the default branch [\[7\]](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows), so its runs share one scope, and so does every other workflow that runs there. Any of them can save an entry under the reconciler's prefix. The documentation of `pull_request_target` names cache poisoning as a risk of that trigger.
- ⁶ Anyone with write access to the repository.
- ⁷ Entries count against the 10 GB of the repository that the CI caches also use. Entries that are not accessed for 7 days are removed, and above the limit the least recently accessed go first.
- ⁸ A commit for every run.
- ⁹ An artifact expires after its retention period, and a cache entry is evicted. Both cost one run with a full fetch.

This RFC recommends the artifact of the previous run. The row that decides is the third: what the reconciler restores can lead to a closed PR, and only the artifact limits its writers to the reconciler's own runs. The artifact also stays out of the storage that CI depends on. Its cost is the first two rows: a lookup of the previous run, and one more permission. The artifact is uploaded with a retention of a few days, since only the newest is ever used.

### One action in maintainer-tools

One action for every lifecycle policy reverses one decision in `maintainer-tools`. Its ARCHITECTURE.md chooses one action per tool, for independent release cadence and narrower permissions [\[21\]](https://github.com/jaegertracing/maintainer-tools/blob/main/ARCHITECTURE.md). The motivating case shows what independent actors cost, and the permission argument does not separate the lifecycle actors: every one of them needs `issues: write` and `pull-requests: write`.

### The reminder is a policy of the reconciler

`maintainer-tools reconcile` and `maintainer-tools nudge` preview two different writers, and the `pr-weekly-digest` action cannot run beside the reconciler as it stands:

- **It is a second comment by a second actor.** The reconciler keeps one comment on a PR, and "The comment" gives the reason.
- **Its clock is `updated_at`.** Every label and comment that the reconciler writes moves that time, so a PR that the reconciler touches is never seven days old for the digest. The idle clock of the reconciler, the last activity by a person, does not have this defect.
- **It reads `waiting-for-author`.** The label is an output of the reconciler, and an actor that reads an output is the coupling that the three layers remove.
- **Its `no_linked_issue` predicate is a second definition of the issue link policy.**
- **Its comment tells the author to comment `/awaiting-input`,** and no code handles that command.

| Criterion | Keep the action | A policy of the reconciler | Delete, no replacement |
| --- | --- | --- | --- |
| One writer of comments on a PR | ❌ | 🟢 | 🟢 |
| The seven-day clock survives the reconciler's writes | ❌ | 🟢 | 🟢 |
| The author is told what blocks the PR before it goes `stale` | 🟢 | 🟢 | ❌ |
| API cost of the sweep | 🟢 | 🟨 ¹ | 🟢 |
| Work before the cutover | 🟨 ² | 🟢 ³ | 🟢 |

🟢 good · 🟨 partial · ❌ poor

- ¹ The facts of the checks need the sign-off of each commit, the status of the head commit, the mergeable state and the review threads. The sweep query does not return them. A second query for the PRs on which the reminder is due returns them, and those are a small part of the open PRs.
- ² The action would have to move to the reconciler's clock and stop reading the label, which is most of the work of the policy.
- ³ The policy is not part of the cutover. The digest runs nowhere, so the cutover has no behaviour of it to preserve.

This RFC recommends the policy. The first two rows rule out the action, and the third is the reason that the digest was written: without it, the first message that the author of a quiet PR gets is the `stale` notice at 60 days.

---

## Migration Path

The migration is one switch-over per repository and not a takeover policy by policy. During an incremental takeover the reconciler would be one more writer among actions that already interfere with each other, and each intermediate state would be a combination that exists only for the migration. The reconciler therefore changes nothing until it replaces all of them at once. Until then the existing setup keeps running, with #10257 merged as it stands, because it removes the `stale` coupling now.

**What exists.** A prototype of the reconciler, the package `packages/lifecycle-rules`, holds the rule form, the PR policies (issue link with its deadline, quota, duplicates, turn, stale and the comment), the evaluator, the startup check with its seeded violations, the generated decision tables, the scenario tests against an in-memory stand-in for GitHub, the observer with its cache, the plan, and the difference. Shadow mode is the CLI command `maintainer-tools reconcile --repo <owner/repo>`: it checks the rules, observes, derives and compares, writes a report, and changes nothing. "The backtest" below gives the result of running it against both repositories. The prototype is not merged, because it duplicates the checks and the triage CLI, as "One fact layer for the reconciler, the checks and the triage report" describes. Step 1 below is merged.

**The steps.** Steps 1 to 3 are PRs in `maintainer-tools`, and none of them writes to a PR.

1. ✅ **Move the checks and the triage CLI to the fact layer.** This step is a refactoring. It adds no policy and no output of the reconciler. The first PR ([#101](https://github.com/jaegertracing/maintainer-tools/pull/101)) is the foundation for regression testing and changes no production logic. It adds the decisions-only JSON report, `--save-snapshot`, `--snapshot` and a fixture, and its `--snapshot` runs the unchanged fetching and deciding functions against a GitHub client that answers each call by a lookup in the snapshot. The second PR ([#107](https://github.com/jaegertracing/maintainer-tools/pull/107)) is the refactoring into gathering and deciding, which removes that client, and the snapshot comparison of the first PR verifies it. The next PRs add the rule form, the evaluator and the startup check ([#102](https://github.com/jaegertracing/maintainer-tools/pull/102)) and declare the predicates as facts ([#103](https://github.com/jaegertracing/maintainer-tools/pull/103)). The last PR ([#106](https://github.com/jaegertracing/maintainer-tools/pull/106)) makes `pr-nudge` and the triage CLI read the facts directly and removes the result record of each check. Every PR after the first is verified in the same way: the JSON report of the code before it and of the code after it, both decided from one saved snapshot of the open PRs of jaeger and jaeger-ui, must be identical.
2. ✅ **The policies that the triage CLI computes itself.** Quota, duplicates, the turn and the issue link become policies, and the copies in the CLI and in the predicates are deleted. The same comparison of reports guards each PR. A difference is either a defect of the old copy, which the PR description lists, or a defect of the policy. Delivered by the quota ([#111](https://github.com/jaegertracing/maintainer-tools/pull/111), [#114](https://github.com/jaegertracing/maintainer-tools/pull/114)), the issue link ([#115](https://github.com/jaegertracing/maintainer-tools/pull/115)), duplicates ([#116](https://github.com/jaegertracing/maintainer-tools/pull/116)), the turn ([#123](https://github.com/jaegertracing/maintainer-tools/pull/123)) and the issue column of the report ([#126](https://github.com/jaegertracing/maintainer-tools/pull/126)), with the PRs that gather their inputs between them.
3. **The reconciler in shadow mode.** The outputs (labels, the comment, the closing), the plan, the difference and the `reconcile` command, on the facts of steps 1 and 2. `reconcile` saves a snapshot and decides from one as `triage` does. The backtest below is repeated on this code. This step also deletes the `pr-nudge` action, the `applies` facts and the table of results, and nothing replaces them, as "No fact of the policy blocks a merge" describes. The deletion removes the fields `publishesCheck` and `checkConclusion` of each check from the JSON report of the triage CLI, which is why it is not part of step 1.
4. **The write path.** `apply()` does not exist: the function of that name stops with an error. It gets the fixed order of changes, the pacing of comment creation, and the behaviour of a run that stops halfway, and it is tested against the in-memory stand-in for GitHub.
5. **The workflow and the action.** One action bundle and one workflow file per repository, with the real triggers, the lock for the whole repository, and the cache as an artifact of the previous run behind the `FactCache` interface. This step also checks that the token of a workflow may list the collaborators of the repository, which the backtest did not show because it used a maintainer's token.
6. **Shadow mode in Actions, in jaeger and jaeger-ui.** Each repository gets the final workflow in shadow mode. It repeats the backtest on every event and every day, so it shows the event load, the API cost with the cache and without it, and the deadlines as they pass. Every difference is assigned to one of three classes: a defect in the rules, which is fixed; a defect of the existing actions, such as a label that a missed event left wrong; or an intended change of behaviour.
7. **Cut over each repository in one PR.** When every remaining difference is an intended change, one PR per repository removes the old workflows and actions, restricts `actions/stale` to issues, and switches the reconciler to write mode. jaeger-ui goes first, because it has fewer open PRs and its backfill is already applied. The old actions that jaeger-ui pins by commit stay reachable after jaeger deletes them, so the order is a choice and not a constraint. Replacing `actions/stale` for PRs supersedes the decision of the `maintainer-tools` RFC to keep `stale.yml` as it is [\[10\]](https://github.com/jaegertracing/maintainer-tools/blob/main/docs/rfc/0001-maintainer-pr-triage-tooling.md).
8. **The reminder policy.** It replaces the weekly digest and the `nudge` command, as "The reminder policy" describes, and it goes through shadow mode like the other policies before it writes.
9. **Issues and other repositories, if wanted.** The reconciler shows whether an open PR closes an issue. `actions/stale` stays the idle timer for issues. `jaeger-idl` and `documentation` adopt the PR policies by adding the workflow file.

### The backtest

The shadow command ran against jaeger and jaeger-ui on November 22, 2026, and changed nothing. The table gives what the first run in write mode would do on that day.

| | jaeger | jaeger-ui |
|---|---|---|
| Open PRs | 180 | 83 |
| PRs whose state differs from the plan | 155 | 59 |
| Labels to add | 178 | 1 |
| Labels to remove | 14 | 72 |
| Comments to create, each of which notifies the author | 142 | 2 |
| Comments to edit in place | 13 | 22 |
| Comments to minimize | 76 | 18 |
| PRs to close | 0 | 0 |
| Changes that are an intended difference | 406 | 70 |
| Changes that correct a defect of the existing actions | 17 | 45 |
| Changes that show a defect of the rules | 0 | 0 |

Each change was assigned to a class by a pattern over the observed state, and every change matched a pattern. The defects of the rules that earlier runs of the backtest showed are fixed in the prototype, and the last line counts what is left.

The two repositories differ because of their history. jaeger never had the backfill, so most of its changes add a flag label and the first notice. jaeger-ui had the backfill a day earlier, so most of its changes remove what the backfill and the script that reacted to it left behind.

### Intended differences

These differences are accepted at the cutover. The last two columns give the number of changes of each kind in the backtest.

| Difference | Cause | jaeger | jaeger-ui |
|---|---|---|---|
| A flag label on a PR that violates the linked-issue policy and was never flagged | The existing action flags on events only, and the backfill was not applied in jaeger | 140 ¹ | 0 |
| A first notice for a label that the run adds | The comment follows the label | 142 | 1 |
| `stale` on a PR on which no person has commented, reviewed or pushed for 60 days | Label changes and bots moved `updated_at`, which is the clock of `actions/stale`. Activity counts by person here | 28 ² | 1 |
| `stale` removed from a flagged PR that is not idle | `stale` means idle only. The linked-issue action and its backfill put `stale` on a flagged PR | 6 | 27 |
| One comment in place of up to three: the newest comment of the old actions is rewritten in place | The reconciler keeps one comment per PR | 13 | 22 |
| The same: an older comment of the old actions is minimized | The reconciler keeps one comment per PR | 76 | 18 |
| `waiting-for-author` returns where a maintainer removed it by hand after commenting | The label is derived from the timeline, and a hand edit does not last | 1 | 0 |
| A second notice where a label was removed and applied again after the existing comment | The period of the label restarted, so the author is told again | 0 | 1 |
| A deadline that expires on a different day | The deadline counts from the label event, not from idle time or from the comment | not seen ³ | not seen ³ |
| `stale` absent from an idle PR that carries `do-not-expire` | `do_not_expire ⇒ not idle` | not seen ⁴ | not seen ⁴ |
| `duplicate` on a PR where it or the older PR on the same issue carries `stale` | Every open PR counts. `pr-duplicates` treats a PR with `stale` as inactive | not seen | not seen |
| `duplicate` absent where a person applied it by hand | The reconciler is the only writer of the label on a PR | not seen | not seen |
- ¹ 99 of them `unapproved-issue` and 41 `missing-issue`.
- ² On 26 of them a person changed a label within the last 60 days: a bulk change from `go` to `area/` labels, and single `changelog:` labels. "Activity is an act of a person" gives the reason that a label change is not activity.
- ³ No deadline had passed on the day of the backtest. "What shadow mode cannot show" gives the reason.
- ⁴ No open PR in either repository carries `do-not-expire`.

### Defects of the existing actions

The backtest found three kinds of label that the existing actions had left wrong. The reconciler corrects them in its first run, and nothing has to be repaired beforehand.

| Defect | Cause | jaeger | jaeger-ui |
|---|---|---|---|
| `waiting-for-author` that the bot applied within a minute of the backfill's comment, on a PR for which the rules do not derive the label | The backfill posted the policy comment under a maintainer's account, and `waiting-for-author.js` read it as a maintainer's comment. The reconciler treats a policy comment as the voice of the automation, whoever posted it: it is neither activity nor a maintainer's turn | 0 | 45 PRs |
| `missing-issue` on a PR that links an open issue | The PR was flagged before #10252 split the label, and no event has evaluated it again | 8 PRs ⁵ | 0 |
| No `pr-quota-reached` on a PR that is over the quota of its author | Not established. The label events of the PR show that it never carried the label | 1 PR | 0 |

- ⁵ Each is two changes: `missing-issue` is removed and `unapproved-issue` is added.

The first defect is the motivating case once more: one actor read what another actor left on the PR and drew a conclusion from it.

### What the cutover adopts from the old state

- **Labels.** The reconciler uses the label names of today, so the labels on a PR are simply its observed state. The first run in write mode adds and removes what the plan requires. Nothing is converted.
- **Label ages.** A flag label or a `stale` label that an old action applied has its event in the timeline. The notice periods continue from those events and do not restart. A PR that receives its label from the reconciler's first run gets the full period from that run.
- **Existing bot comments.** The reconciler recognizes a "policy comment" by one of five texts: its own marker, the linked-issue marker, the duplicate marker, the two visible phrases of the quota comments, and the phrase of the `actions/stale` message. All are comments of `github-actions[bot]`. The newest becomes its one comment and is rewritten in place, which sends no notification, and the others are minimized. An old comment that was created after the PR got the label counts as the notification, so a PR that was already told is not told again. `pr-linked-issue` and `actions/stale` post their comment up to one second before their label, so a comment of a replaced action also counts when it precedes the label by less than a minute. The comment of the reconciler follows its label and gets no such allowance. The linked-issue marker also counts in a comment that a maintainer posted through the local script. The reconciler cannot edit that comment, so it stays as the notice and is left as it is. When the rules derive no comment for a PR, a comment of a replaced action is left as it is too, because nothing says that its text is wrong. The recognition of the old texts is deleted when no open PR carries one.
- **The `duplicate` ownership marker.** It is ignored. A `duplicate` label on a PR that the rules do not derive is removed, whoever applied it. The shadow report lists these PRs before the cutover.
- **The first run in write mode.** The shadow report of the day is the list of what that run does. It is read for two things before the cutover: the PRs that the run would close, and the number of comments that it would create. In the backtest the run would close no PR, and it would create 142 comments in jaeger, for the PRs that were never flagged, and 2 in jaeger-ui. GitHub allows 80 content-creating requests per minute and 500 per hour [\[8\]](https://docs.github.com/en/graphql/overview/rate-limits-and-node-limits-for-the-graphql-api), so `apply()` paces itself, and a run that stops early is continued by the next one, because a half-applied plan is an observed state like any other.

### Rollback

The cutover is one PR per repository, and reverting it is the rollback: the old workflows return and the reconciler returns to shadow mode. The revert restores the code and not the state. Labels stay as the reconciler left them, and the old actions correct a label only when an event touches the PR. The combined comment stays, and the old actions do not recognize it. A PR that the reconciler closed stays closed. A rollback is therefore a way to stop further changes, and the shadow period is the protection against needing one.

### What shadow mode cannot show

- **Effects that depend on the writes of the old actors.** While the old actions run, their label changes and comments move `updated_at`, add timeline events and remove `stale`. The observed state that shadow mode compares against includes those effects, and they stop at the cutover. The idle rule is the clearest case: it can be compared with the old `stale` label only as a difference of definition.
- **Deadlines that start with the reconciler's own label.** In shadow mode no label is applied, so the notice period of a PR that the old actions never flagged does not start. Its closing a week later is not backtested. The decision tables and the scenario tests cover that path.
- **Closing, so far.** The backtest planned no closing, because no deadline had passed. The oldest flag label in either repository was applied on November 20, two days before the run. Of the idle PRs that carry `stale`, none had carried it for 14 days: in jaeger-ui the label had been removed and was applied again on November 21. Shadow mode in Actions shows the first closings as the deadlines pass.
- **The event load.** The backtest was two runs per repository from a laptop. The wait for the lock, the replaced pending runs and the API cost of a busy hour are not exercised until the workflow exists.
- **The write path.** Creating the comment, the order of changes, a run that fails halfway and GitHub's limits on content creation are not exercised, and `apply()` is not written.
- **Whether a difference is a defect of the rules or of the old actions.** The observed state is itself partly wrong, so each difference has to be read by a person.
- **How contributors react** to one combined comment and to labels that return after a hand edit.

---

## Limitations

- **Events that GitHub does not send stay unsent.** Linking an issue through the sidebar and labelling an issue in another repository still fire nothing. The scheduled run bounds the delay to a day, as #10257 does.
- **The cutover is one large change per repository.** Every policy changes hands in one PR, and the first run in write mode creates a notifying comment on every PR that was never flagged, 142 in jaeger on the day of the backtest, and closes the PRs whose deadline has passed. The shadow report lists both beforehand. A rollback stops further changes and does not undo these.
- **Nothing has changed GitHub yet.** No write mode exists, and no workflow or action bundle. The cache is the SQLite file of the CLI and not an artifact of a previous run. Whether the token of a workflow may list the collaborators of a repository was not checked.
- **The backtest covers the rules, and not closing, the event load or the write path.** "What shadow mode cannot show" lists the gaps.
- **The comment does not list every fact that holds against a PR.** It lists the base facts behind `blocked` and `idle`, and the facts of the checks only when the reminder is due. A fact of the checks on a PR that has none of these reasons, such as `description_empty` on a new PR, reaches the maintainer through the triage report and does not reach the author.
- **`stale_on_author` reads what the reconciler writes.** Its predicate tests the `stale` label and `updatedAt` of the PR. Only `triage_hidden` reads the fact, so the plan does not depend on it, and the Hidden bucket of the triage report follows the writes of the reconciler through it.
- **A replaced pending run shows as a cancelled check on a PR.** It is the cost of one lock per repository without a dispatch job.
- **One program is one blast radius.** A wrong rule can mislabel or close PRs under every policy in every repository in one run. The guards are the shadow period, the reported difference, and the rule that incomplete facts end the run. Independent actions fail independently, and this design gives that up.
- **All the rules of one output are not written in one place.** They are spread over the policies, and a veto can silence a reason that another policy added. The generated decision table of the output is the place to read them, and a reviewer who skips the diff of that table misses the consequences of a rule.
- **A decision table roughly doubles with each reason that is added to its output.** The tables of `should_close` and `comment` have 24 and 21 rows in the prototype. They also show rows that cannot occur, and they do not show the text of a comment, which comes from the summaries of the base facts.
- **The project owns the evaluator and the startup check.** In the prototype they are 210 and 223 lines, with 114 lines of shared data types. The code is loops and a graph walk and not an inference engine, and it is still code to maintain.
- **The startup check proves properties of the rule set, not of the predicates or of the world.** "The startup check" lists what it cannot catch. Its convergence check covers one PR.
- **The observer of the prototype reads bounded lists.** It reads the first 20 closing references of a PR and the last 100 reviews and commits, and it evaluates a PR beyond those bounds on part of its facts. That breaks step 1 of "Plan and apply", in which an absent fact is never read as a false one. Write mode therefore requires an observer that follows each list to its end. Shadow mode does not, because it changes nothing.
- **A notice period runs from the label, not from the comment.** A run that applies a label and fails before it creates the comment leaves the PR without a notice. The next run creates the comment, and the author loses the time between the two runs. If no run succeeds for the whole period, the run that creates the comment also closes the PR. A label that a maintainer applies by hand starts the period in the same way.
- **A push is dated by the committed date of its commit.** GraphQL returns no time of a push, except of a force push. A merge from the base branch that the author makes arrives as a push, so it is activity for the idle rule and it passes the turn to the maintainers, although it answers nothing that a maintainer asked.
- **`idle` holds earlier than `stale` does today.** A label change and a comment by a bot are not activity, and `actions/stale` counts both. A PR that only such changes kept fresh gets the `stale` notice at the cutover.
- **A missing rule is silent.** Closed-world evaluation gives an item with no reason nothing at all. The decision tables show such rows, and only a person can say that one of them is wrong.
- **A hand edit of an output does not last.** A maintainer who removes `stale`, `waiting-for-author`, `duplicate` or a flag label from a PR by hand sees it return on the next run, and a `duplicate` applied by hand is removed. For a flag label that is removed and restored, the week restarts. The intent has to be expressed through an input: a comment, a review, or one of the labels that people own.
- **The notice construct reads the age of the reconciler's own label.** It is the one exception to "no rule reads an output", and it is safe only in the paired form that "Notice periods" gives.
- **Invariants do not describe a sequence of human decisions well.** The issue triage workflow is such a sequence. This RFC does not design it, and it does not say which triage labels the project wants.
- **The API cost is measured for single runs only.** The figures in "API budget and the cache of observed inputs" are from one run with an empty cache and one with a full cache per repository. Shadow mode in Actions measures the cost under the event load.
- **The cache adds a file that outlives a run.** It is safe only while it holds observed inputs and nothing else. A decision that came to depend on it would be a hidden store, which this design excludes.
- **The freshness key misses two known changes and can miss others that nobody listed.** The known ones are a label that an issue form applies at creation and the merged count of an author whose PR was opened and merged between two runs. The daily run without the cache bounds such a gap to a day.
- **The quota is counted for each repository, not for the organization.** The rank of a PR and the merged count of its author both cover one repository, as in `pr-quota-manager`. A new contributor may therefore have one open PR in each repository at once, and a PR merged in one repository raises no quota in another. This RFC keeps that scope, because the backtest compares the reconciler with the actions of today. Whether the quota should cover the organization is an open question for a follow-up. An organization-wide quota needs the open PRs and the merged counts of the other repositories as inputs of a run, and a run observes one repository.
- **The linked-issue policy gives a PR for one part of an issue no correct link.** A PR that does one task of an umbrella issue must not use a closing keyword, because GitHub would close the issue with the work partly done. The policy counts closing references only, as `pr-linked-issue` does, so such a PR is flagged `missing-issue` unless a maintainer applies `no-issue-needed`. This RFC keeps the policy of today. Whether a reference that does not close, such as "Part of", should satisfy the policy is an open question for a follow-up. GitHub returns such a reference only as a cross-reference event in the timeline of the issue.
- **Comment wording changes for contributors.** One combined comment replaces up to three.
- **The external tools, Cedar, CEL and the Datalog libraries were assessed from their documentation and repositories, not by trial.** The claim that Mergify cannot express the two central policies rests on its documented condition attributes.

---

## Open Questions

- **A notice of a replaced action that a collaborator's account posted.** The linked-issue marker identifies a policy comment whoever posted it, and a maintainer can post such a notice by running the local script of the linked-issue action under a personal token. 55 open PRs of jaeger-ui carry a linked-issue notice that was posted in this way on November 21, 2026. The reconciler counts such a comment as having told the author, and it edits and minimizes only the comments of `github-actions[bot]`. The notice therefore stays visible with the text of the day on which it was posted, also after the label of the PR changed from `missing-issue` to `unapproved-issue`, and it stands beside the comment of the reconciler on a PR that has one. The question is whether the reconciler should minimize a notice of a replaced action that a collaborator's account posted. Minimizing it would leave one visible notice on the PR. It would also make the reconciler change a comment of a person, which it does nowhere else.

---

## References

1. [yurishkuro/rustybot](https://github.com/yurishkuro/rustybot)
2. [Jaeger contributing guidelines: Link each pull request to an issue](https://github.com/jaegertracing/jaeger/blob/main/CONTRIBUTING_GUIDELINES.md#link-each-pull-request-to-an-issue)
3. [jaeger `.github/workflows/stale.yml` at `fdde0a9`](https://github.com/jaegertracing/jaeger/blob/fdde0a9cdf9a4c07908974373063717d1d3204b4/.github/workflows/stale.yml)
4. [jaeger `pr-linked-issue` action README at `fdde0a9`](https://github.com/jaegertracing/jaeger/blob/fdde0a9cdf9a4c07908974373063717d1d3204b4/.github/actions/pr-linked-issue/README.md)
5. [maintainer-tools #64: Stop the weekly digest from resetting the clock of actions/stale](https://github.com/jaegertracing/maintainer-tools/pull/64)
6. [rustybot `issue-manager.yml`](https://github.com/yurishkuro/rustybot/blob/main/issue-manager.yml)
7. [GitHub Actions: Events that trigger workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)
8. [GitHub: Rate limits and node limits for the GraphQL API](https://docs.github.com/en/graphql/overview/rate-limits-and-node-limits-for-the-graphql-api)
9. [kubernetes-sigs/prow](https://github.com/kubernetes-sigs/prow)
10. [maintainer-tools RFC: Maintainer PR Triage and Nudge Tooling](https://github.com/jaegertracing/maintainer-tools/blob/main/docs/rfc/0001-maintainer-pr-triage-tooling.md)
11. [envoyproxy/envoy `repokitteh.star`](https://github.com/envoyproxy/envoy/blob/main/repokitteh.star)
12. [rust-lang/triagebot](https://github.com/rust-lang/triagebot)
13. [Mergify documentation](https://docs.mergify.com/)
14. [OpenTelemetry Collector Contrib workflows](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/.github/workflows)
15. [probot/stale (archived)](https://github.com/probot/stale)
16. [Cedar policy language documentation](https://docs.cedarpolicy.com/)
17. [AWS IAM policy evaluation logic](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_evaluation-logic.html)
18. [XACML 3.0 core specification](https://docs.oasis-open.org/xacml/3.0/xacml-3.0-core-spec-os-en.html)
19. [GitHub Actions: Store and share data with workflow artifacts](https://docs.github.com/en/actions/tutorials/store-and-share-data)
20. [GitHub Actions: Dependency caching reference](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching)
21. [maintainer-tools ARCHITECTURE.md](https://github.com/jaegertracing/maintainer-tools/blob/main/ARCHITECTURE.md)
