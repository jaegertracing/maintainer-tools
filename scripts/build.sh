#!/usr/bin/env bash
# Build all workspaces inside a Linux container so that ncc output is
# byte-identical regardless of the host OS. node_modules are mounted from
# the host (populated by `npm ci`), so no reinstall is needed inside.
#
# Usage: npm run build

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Pinned to match the node-version in .github/workflows/lint-build.yml.
# Update this tag when upgrading Node.
exec docker run --rm \
  -v "${ROOT}:/work" \
  -w /work \
  "node:24.16.0-slim" \
  npm run --workspaces --if-present build
