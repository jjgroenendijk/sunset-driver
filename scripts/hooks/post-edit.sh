#!/usr/bin/env bash
# Claude Code PostToolUse hook for Edit/Write: typecheck and determinism-lint after every
# TypeScript edit so mistakes surface immediately instead of at verify time.
# Exit 2 feeds the errors back to the model; anything else stays silent.
set -u
cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}" || exit 0
file=$(jq -r '.tool_input.file_path // empty' 2>/dev/null)
case "$file" in
  *.ts) ;;
  *) exit 0 ;;
esac
[ -d node_modules ] || exit 0

out=$(npm run -s typecheck 2>&1) || { echo "typecheck failed:"; echo "$out" | head -40; exit 2; } >&2
case "$file" in
  */src/core/*|*/src/sim/*|*/src/world/*)
    out=$(npm run -s lint 2>&1) || { echo "determinism lint failed:"; echo "$out" | head -40; exit 2; } >&2 ;;
esac
exit 0
