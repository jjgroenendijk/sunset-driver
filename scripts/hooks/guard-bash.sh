#!/usr/bin/env bash
# Claude Code PreToolUse hook for Bash: refuse commands CLAUDE.md forbids.
set -u
cmd=$(jq -r '.tool_input.command // empty' 2>/dev/null)
# Match wrangler only in command position (start of line or after ; && || |), so that
# commit messages or strings that merely mention it are not blocked.
if printf '%s\n' "$cmd" | grep -Eq '(^|[;&|][[:space:]]*)(npx[[:space:]]+|npm[[:space:]]+exec[[:space:]]+)?wrangler[[:space:]]+(pages[[:space:]]+)?deploy'; then
  echo "blocked: never deploy with wrangler locally; CI deploys from main and PRs" >&2
  exit 2
fi

# `git rev-parse --show-toplevel` names the main checkout, not the worktree the
# session runs in. A session that cd's there edits the wrong tree, and another
# session may be working in it. The shell's directory persists between calls, so
# there is nothing to cd to in the first place.
if printf '%s\n' "$cmd" | grep -q 'rev-parse --show-toplevel'; then
  cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0
  if [ "$(git rev-parse --git-dir 2>/dev/null)" != "$(git rev-parse --git-common-dir 2>/dev/null)" ]; then
    echo "blocked: this session runs in a worktree, and --show-toplevel names the main checkout." >&2
    echo "The working directory already persists between calls; drop the cd." >&2
    exit 2
  fi
fi
exit 0
