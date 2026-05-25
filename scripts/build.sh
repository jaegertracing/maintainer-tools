#!/usr/bin/env bash
# Build all workspaces inside a Linux container so that ncc output is
# byte-identical regardless of the host OS.
#
# node_modules is shadowed by a named Docker volume so that the Linux
# container's platform-specific binaries (esbuild, etc.) don't overwrite
# the host's node_modules after the build completes.
#
# Usage: npm run build

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Pinned to match the node-version in .github/workflows/lint-build.yml.
# Update this tag when upgrading Node.
exec docker run --rm \
  -v "${ROOT}:/work" \
  -v "maintainer-tools-node-modules:/work/node_modules" \
  -w /work \
  "node:24.16.0-slim" \
  sh -c "npm ci --quiet && npm run --workspaces --if-present build"
