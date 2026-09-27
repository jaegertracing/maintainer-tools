#!/usr/bin/env bash
# The build runs all workspaces inside a Linux container so that ncc output
# is byte-identical regardless of the host OS.
#
# Docker volumes isolate root and workspace dependencies so that Linux
# binaries and pnpm links do not overwrite the host's dependencies.
#
# Run this script with `pnpm run build`.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# The Node major matches node-version in .github/workflows/lint-build.yml.
exec docker run --rm \
  -v "${ROOT}:/work" \
  -v /work/node_modules \
  -v "maintainer-tools-pnpm-store:/pnpm/store" \
  -v /work/packages/checks/node_modules \
  -v /work/cli/node_modules \
  -v /work/pr-nudge/node_modules \
  -v /work/pr-weekly-digest/node_modules \
  -w /work \
  "node:24.16.0-slim" \
  sh -c "set -x; corepack enable && pnpm install --frozen-lockfile --store-dir /pnpm/store && pnpm -r --if-present run build"
