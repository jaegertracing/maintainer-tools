# AI Agent Instructions for maintainer-tools

## Project Overview

`@jaegertracing/maintainer-tools` ships a shared TypeScript predicate library
and a set of per-tool **GitHub Actions** (consumed via
`uses: jaegertracing/maintainer-tools/<tool>@vX.Y.Z`) that automate PR triage
and nudges for the Jaeger org. Design: see
[`docs/rfc/0001-maintainer-pr-triage-tooling.md`](docs/rfc/0001-maintainer-pr-triage-tooling.md).

## Task Completion Criteria

Before declaring a task done, run:

```bash
make lint
make test
make build
```

If the build modifies any committed `*/dist/index.js`, **commit that change in
the same PR** — the lint-build workflow's drift-check will fail otherwise.

## Architecture

Read [`ARCHITECTURE.md`](ARCHITECTURE.md) before changing code. It describes
the shared library, how data flows from GitHub to each consumer, and how an
action is laid out. Record a layout change there, not in this file.

## Development Setup

- Node.js >= 22.5 (the CLI's SQLite cache uses the built-in `node:sqlite`
  module, added in 22.5.0). Actions still ship on the `node20` runtime —
  they don't touch the cache.
- pnpm (use the repo root). Enable it with `corepack enable pnpm`;
  Corepack downloads and runs the version pinned in `package.json`.

```bash
make install
```

No native build steps — everything pure JS + builtin Node modules.

## Build, Lint, and Test Commands

| Command         | What it does                                                      |
| --------------- | ----------------------------------------------------------------- |
| `make build`    | Build every workspace (`tsc` for packages, `ncc` for each action) |
| `make lint`     | `tsc --noEmit` + prettier `--check`, in parallel                  |
| `make tsc-lint` | TypeScript type-check only                                        |
| `make fmt`      | Prettier `--write`                                                |
| `make test`     | Run the tests of every workspace that has a `test` script         |

## Action Bundles

Each `<tool>/dist/index.js` is an `@vercel/ncc` bundle of
`<tool>/src/index.ts` plus its dependencies. **The `dist/` files are
committed** — that's how GitHub JS actions ship; users pin a SHA or tag and
run the bundle directly.

Workflow:

1. Edit `<tool>/src/` or shared `packages/checks/src/`.
2. Run `make build` from the repo root.
3. Commit both the source change _and_ the regenerated `dist/index.js`.

The CI `lint-build` job runs `make build` and fails if `git diff` on any
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
- Run `make fmt` before committing.

### Predicate Library Conventions

The module of a check in `packages/checks/src/predicates/` exports the
predicate of the check and declares nothing. The predicate must
be a **pure function** of the `PullRequest` and the `PredicateContext`. No side
effects, no I/O, no clock reads. Side effects (label changes, comments)
belong in the _action_ subfolders that consume the library.

`src/policy.ts` declares every fact and every rule: one base fact for
each check with `policy.baseFact(id, predicate, { changedBy })`, and the
rules of the outputs (`policy.triageHidden.when(...)`,
`policy.weeklyDigest.when(...)`).
The consumers evaluate the rules with
`ruleSet.evaluate()` and read the verdict. The `summary` string that
a predicate returns is reused verbatim in the
digest — keep it short and self-contained. After a
change of the rules, run `pnpm run decision-tables` in `packages/checks` and
commit the regenerated `docs/decision-tables/`. See "Predicate model" in
[`ARCHITECTURE.md`](ARCHITECTURE.md).

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

## Pointers

- Design: [`docs/rfc/0001-maintainer-pr-triage-tooling.md`](docs/rfc/0001-maintainer-pr-triage-tooling.md)
- The two JS scripts being migrated currently live at
  `https://github.com/jaegertracing/jaeger/.github/scripts/` (`waiting-for-author.js`,
  `pr-quota-manager.js`).
