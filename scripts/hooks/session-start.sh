#!/usr/bin/env bash
# Claude Code SessionStart hook: make sure the toolchain and dependencies are ready.
# Idempotent and quick when nothing changed (a few ms).
set -u
cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}" || exit 0

want=$(cat .nvmrc 2>/dev/null)
have=$(node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1)
if [ -z "$have" ]; then
  echo "node is not installed; .nvmrc wants $want" >&2
  exit 0
fi
if [ -n "$want" ] && [ "$have" != "$want" ]; then
  echo "warning: node $have found, .nvmrc wants $want (nvm use / fnm use)" >&2
fi

# Install when node_modules is missing or older than the lockfile.
if [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  echo "installing dependencies (lockfile changed or node_modules missing)" >&2
  npm ci --prefer-offline --no-audit --no-fund >/dev/null 2>&1 || npm install --no-audit --no-fund >/dev/null 2>&1
fi
exit 0
