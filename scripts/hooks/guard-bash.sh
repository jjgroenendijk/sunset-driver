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
exit 0
