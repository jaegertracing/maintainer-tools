# AI Agent Instructions for maintainer-tools

## Project Overview

`@jaegertracing/maintainer-tools` ships a shared TypeScript predicate library
and a set of per-tool **GitHub Actions** (consumed via
`uses: jaegertracing/maintainer-tools/<tool>@vX.Y.Z`) that automate PR triage
and nudges for the Jaeger org. Design: see
[`docs/rfc/maintainer-pr-triage-tooling.md`](docs/rfc/maintainer-pr-triage-tooling.md).

## Task Completion Criteria

Before declaring a task done, run:

```bash
npm run lint    # tsc + prettier --check
npm run build   # tsc packages + ncc bundle each action
```

If the build modifies any committed `*/dist/index.js`, **commit that change in
the same PR** — the lint-build workflow's drift-check will fail otherwise.

## Repository Structure

```
maintainer-tools/
├── packages/
│   └── checks/                # shared predicate library, GraphQL layer, SQLite cache
├── pr-nudge/                  # first GitHub Action; ships action.yml + committed dist/index.js
│   ├── action.yml
│   ├── src/
│   └── dist/                  # ncc-bundled, COMMITTED — see "Action bundles" below
├── cli/                       # local maintainer CLI: `maintainer-tools triage`
│   ├── src/
│   └── config.example.json
├── docs/rfc/                  # design docs
└── .github/workflows/         # CI for this repo (not the actions it ships)
```

Each top-level `<tool>/` is either a published GitHub Action subfolder
(`pr-nudge/`, with committed `dist/`) or the local CLI (`cli/`, no
committed build output — users `npm ci && npm run build`). New actions
follow `pr-nudge/`'s pattern: `<tool>/action.yml`, `<tool>/src/`,
`<tool>/dist/`.

## Development Setup

- Node.js >= 22.5 (the CLI's SQLite cache uses the built-in `node:sqlite`
  module, added in 22.5.0). Actions still ship on the `node20` runtime —
  they don't touch the cache.
- npm (workspaces, so use the repo root)

```bash
npm ci   # use this, not `npm install`
```

No native build steps — everything pure JS + builtin Node modules.

## Build, Lint, and Test Commands

| Command            | What it does                                                      |
| ------------------ | ----------------------------------------------------------------- |
| `npm run build`    | Build every workspace (`tsc` for packages, `ncc` for each action) |
| `npm run lint`     | `tsc --noEmit` + prettier `--check`, in parallel                  |
| `npm run tsc-lint` | TypeScript type-check only                                        |
| `npm run fmt`      | Prettier `--write`                                                |
| `npm test`         | Run tests across workspaces (none yet)                            |

## Action Bundles

Each `<tool>/dist/index.js` is an `@vercel/ncc` bundle of
`<tool>/src/index.ts` plus its dependencies. **The `dist/` files are
committed** — that's how GitHub JS actions ship; users pin a SHA or tag and
run the bundle directly.

Workflow:

1. Edit `<tool>/src/` or shared `packages/checks/src/`.
2. Run `npm run build` from the repo root.
3. Commit both the source change _and_ the regenerated `dist/index.js`.

The CI `lint-build` job runs `npm run build` and fails if `git diff` on any
action's `dist/` is non-empty — this is what guarantees the committed bundle
matches its source.

## Coding Standards

### TypeScript

- All new code in TypeScript.
- Strict mode is on (incl. `noUncheckedIndexedAccess`).
- Prefer `import type` for type-only imports.
- Use `.js` extensions on relative imports (the repo is `"type": "module"`
  with NodeNext resolution — TS source files reference their compiled
  `.js` siblings).

### Code Style

- Prettier with the config in `.prettierrc.json` (single quotes, trailing
  commas, 100-col print width, semicolons).
- Run `npm run fmt` before committing.

### Predicate Library Conventions

Predicates in `packages/checks/src/predicates/` must be **pure functions** of
`(pr: PullRequest) => CheckResult`. No side effects, no I/O, no clock reads
without an injected `now`. Side effects (Check Run writes, label changes,
comments) belong in the _action_ subfolders that consume the library.

Every `CheckResult` declares its surfaces explicitly (`publishesCheck`,
`inDigest`, `hidesFromTriage`). The `summary` string is reused verbatim in
the Checks panel and the digest — keep it short and self-contained.

### Comments

Prefer no comments. Add one only when the _why_ is non-obvious — a constraint
that's not visible from the code, a workaround for a specific GitHub quirk,
or a deliberate choice that would surprise a reader. Skip "what" comments;
well-named identifiers cover that.

## Commits

- **Sign every commit with DCO**: `git commit -s` (or `git commit -sm "…"`).
  CI enforces this; commits without `Signed-off-by:` will block the merge.
- Imperative mood, ≤ 72-char subject line. Body explains _why_.
- Don't `--amend` or force-push pushed branches without a reason.

## CI

- `lint-build.yml` — typecheck, format check, full build, `dist/` drift
  check, and a Renovate config validator job.
- `codeql.yml` — JS/TS static analysis.
- `dco_merge_group.yml` — fake DCO check that satisfies the required status
  in merge-queue runs (the real DCO check doesn't trigger from merge groups).

## Dependencies

Renovate (`renovate.json`) opens PRs on Sundays for minor/major upgrades only;
patch and digest upgrades are disabled to reduce noise. GitHub Actions
upgrades are grouped. Patch/digest upgrades to workflows are also disabled.

## Key Source Files

| File                                      | Role                                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------------------------ |
| `packages/checks/src/types.ts`            | Core `PullRequest` and `CheckResult` types — the shared data contract for all tools. |
| `packages/checks/src/predicates/index.ts` | Predicate registry and `runAll()` entry point.                                       |
| `packages/checks/src/graphql.ts`          | All GitHub GraphQL queries (`LIST_QUERY`, `PR_QUERY`, `VIEWER_QUERY`, …).            |
| `packages/checks/src/cache.ts`            | SQLite-backed PR cache (Node 22.5+ `node:sqlite`).                                   |
| `cli/src/index.ts`                        | CLI entry point — arg parsing, orchestration, output.                                |
| `cli/src/config.ts`                       | Config schema (`TriageConfig`), loader, validation, and defaults.                    |
| `cli/src/buckets.ts`                      | `classify()` — assigns each PR to exactly one of 8 buckets; `computeFlags()`.        |
| `cli/src/scan.ts`                         | Multi-repo scanner: list → cache-check → fetch loop.                                 |
| `cli/src/quota.ts`                        | Cross-PR quota enrichment (`enrichQuotaState()`).                                    |
| `cli/src/render/shared.ts`                | Renderer-agnostic grouping (`groupByRepo`, `buildPriorityGroups`).                   |
| `cli/src/render/html.ts`                  | Self-contained HTML report generator.                                                |
| `cli/config.example.json`                 | Generic starter config with placeholder values.                                      |
| `cli/config.example.jaeger.json`          | Jaeger-org starter config. Field defaults live in `cli/src/config.ts`.               |
| `pr-nudge/src/index.ts`                   | GitHub Action entry point — fetches one PR and publishes Check Runs.                 |
| `pr-weekly-digest/src/index.ts`           | Cron action — posts/edits per-PR digest comments.                                    |

## Pointers

- Design: [`docs/rfc/maintainer-pr-triage-tooling.md`](docs/rfc/maintainer-pr-triage-tooling.md)
- The two JS scripts being migrated currently live at
  `https://github.com/jaegertracing/jaeger/.github/scripts/` (`waiting-for-author.js`,
  `pr-quota-manager.js`).
