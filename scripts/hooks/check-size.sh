#!/usr/bin/env bash
# Claude Code PostToolUse hook for Edit/Write: report a code file that has grown
# past the warn mark, so it is split while the split is still small. CI fails the
# build at the hard limit; this fires earlier and only on the file just edited.
# A markdown file is reported at the limits themselves, since wrapping a line
# back is instant and there is nothing to warn about first.
# Exit 2 feeds the message back to the model; anything else stays silent.
set -u
cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}" || exit 0
file=$(jq -r '.tool_input.file_path // empty' 2>/dev/null)
case "$file" in
  *.ts|*.tsx) ;;
  *.md)
    [ -f "$file" ] || exit 0
    out=$(node scripts/check-size.ts "$file" 2>&1) && exit 0
    echo "$out" >&2
    exit 2
    ;;
  *) exit 0 ;;
esac
[ -f "$file" ] || exit 0

read -r warn hard < <(node -e 'import("./scripts/check-size.ts").then(m => console.log(m.WARN_LIMIT, m.HARD_LIMIT))' 2>/dev/null)
[ -n "${warn:-}" ] || exit 0

lines=$(wc -l < "$file" | tr -d ' ')
[ "$lines" -gt "$warn" ] || exit 0

{
  echo "$file is $lines lines, over the $warn line warn mark (CI fails over $hard)."
  echo "Split it along the seams the code already has — one concern per file — before adding more."
} >&2
exit 2
