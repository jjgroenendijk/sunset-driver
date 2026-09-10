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

# Commit identity. Cloud containers ship a global git identity of their own, so
# pin the repository-local one; the GIT_AUTHOR_*/GIT_COMMITTER_* variables in
# .claude/settings.json cover the same ground for sessions that read them.
git config --local user.name "${GIT_AUTHOR_NAME:-jjgroenendijk}"
git config --local user.email "${GIT_AUTHOR_EMAIL:-3110270+jjgroenendijk@users.noreply.github.com}"
# The global config may point commit signing at a key that is not ours; sign
# only when this repository was given a key of its own.
if [ -z "$(git config --local --get user.signingkey)" ]; then
  git config --local commit.gpgsign false
  git config --local tag.gpgsign false
fi

# Install when node_modules is missing or older than the lockfile.
if [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  echo "installing dependencies (lockfile changed or node_modules missing)" >&2
  npm ci --prefer-offline --no-audit --no-fund >/dev/null 2>&1 || npm install --no-audit --no-fund >/dev/null 2>&1
fi
exit 0
