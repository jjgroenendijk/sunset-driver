#!/usr/bin/env bash
# Claude Code PreToolUse hook for Bash: run `npm run verify` before `gh pr create`.
# CI runs no tests, so this is the check that stops a pull request whose tests fail.
# A branch that changes only documentation skips it.
set -u
cmd=$(jq -r '.tool_input.command // empty' 2>/dev/null)
printf '%s\n' "$cmd" | grep -Eq '(^|[;&|][[:space:]]*)gh[[:space:]]+pr[[:space:]]+create' || exit 0

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}" || exit 0
[ -d node_modules ] || exit 0

base=$(git merge-base HEAD origin/main 2>/dev/null) || base=''
if [ -n "$base" ] && ! git diff --name-only "$base" | grep -qvE '(\.md$|^\.claude/)'; then
  exit 0
fi

out=$(npm run -s verify 2>&1) || {
  echo "blocked: npm run verify failed; fix it before opening the pull request."
  printf '%s\n' "$out" | tail -40
  exit 2
} >&2
exit 0
