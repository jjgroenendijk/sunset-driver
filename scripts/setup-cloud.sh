#!/usr/bin/env bash
# Setup script for Claude Code cloud sessions: Ubuntu 24.04, root, repo cloned.
# The image ships Node 20-22 only, so install the .nvmrc version, then the deps.
# The image ships no `gh` either, and `CLAUDE.md` asks every session to file an
# issue, claim it and wait for the checks with it, so install and log in that too.
# Must exit 0 or the session fails to start, and must stay under ~5 minutes.
set -u

cd "$(dirname -- "${BASH_SOURCE[0]}")/.." || exit 0

want=$(tr -dc 0-9 < .nvmrc)
have=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
image_path=$PATH   # the PATH the session's shells inherit, before this script edits it

# Put binaries where the session's shells find them. A session shell is not a
# login shell, so /etc/profile.d is never read: link into /usr/local/bin and
# into the first writable entry of the PATH the session inherits. The first
# entry matters because the image puts its own node directory *ahead* of
# /usr/local/bin. `$1` is a directory tree to skip, or empty for none.
link_bins() {
  local under=$1 dir dirs
  shift
  ln -sf "$@" /usr/local/bin/ 2>/dev/null
  IFS=: read -r -a dirs <<< "$image_path"
  for dir in "${dirs[@]}"; do
    case $dir in '') continue ;; esac
    [ -n "$under" ] && case $dir in "$under" | "$under"/*) continue ;; esac
    [ -d "$dir" ] && [ -w "$dir" ] || continue
    ln -sf "$@" "$dir"/ && return 0
  done
  return 1
}

install_node() {
  local version prefix
  version=$(curl -fsSL https://nodejs.org/dist/index.json |
    jq -er --arg v "v$want." 'map(select(.version | startswith($v)))[0].version') || return 1
  prefix=/opt/node-$version-linux-x64
  curl -fsSL "https://nodejs.org/dist/$version/node-$version-linux-x64.tar.xz" | tar -xJ -C /opt || return 1
  echo "export PATH=$prefix/bin:\$PATH" > /etc/profile.d/10-node-repo.sh
  link_bins "$prefix" "$prefix"/bin/{node,npm,npx} ||
    echo "setup-cloud: no writable PATH entry to link node into" >&2
  export PATH=$prefix/bin:$PATH
}

# The latest release of `gh`, from the redirect the releases page answers with.
# The REST API would do as well, but unauthenticated it is rate limited, and no
# token is in hand yet.
install_gh() {
  local arch url version prefix
  case $(uname -m) in
    x86_64) arch=amd64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) return 1 ;;
  esac
  url=$(curl -fsSL -o /dev/null -w '%{url_effective}' https://github.com/cli/cli/releases/latest) || return 1
  version=${url##*/v}
  [ -n "$version" ] && [ "$version" != "$url" ] || return 1
  prefix=/opt/gh_${version}_linux_$arch
  curl -fsSL "https://github.com/cli/cli/releases/download/v$version/$(basename "$prefix").tar.gz" |
    tar -xz -C /opt || return 1
  link_bins '' "$prefix"/bin/gh
}

# The token the environment already holds for GitHub. It may be in a variable,
# or only in what the clone left behind: a credential helper, or the header a
# checkout action writes into the repository's own config.
github_token() {
  local value header
  for value in "${GH_TOKEN:-}" "${GITHUB_TOKEN:-}"; do
    [ -n "$value" ] && { printf '%s' "$value"; return 0; }
  done
  # Only ask git when a helper can answer: with no helper and no terminal, the
  # question fails slowly instead of returning nothing.
  if git config --get-regexp '^credential\..*helper$' >/dev/null 2>&1; then
    value=$(printf 'protocol=https\nhost=github.com\n\n' |
      git credential fill 2>/dev/null | sed -n 's/^password=//p' | head -n 1)
    [ -n "$value" ] && { printf '%s' "$value"; return 0; }
  fi
  header=$(git config --get-regexp '^http\..*extraheader$' 2>/dev/null |
    sed -n 's/.*[Aa]uthorization:[[:space:]]*[Bb]asic[[:space:]]*//p' | head -n 1)
  if [ -n "$header" ]; then
    # The header carries `<user>:<token>` in base64, the user being a placeholder.
    value=$(printf '%s' "$header" | base64 -d 2>/dev/null | sed 's/^[^:]*://')
    [ -n "$value" ] && { printf '%s' "$value"; return 0; }
  fi
  return 1
}

setup_gh() {
  local token
  command -v gh >/dev/null 2>&1 || install_gh || return 1
  # A token in the session's own environment authenticates `gh` on its own, and
  # `gh auth login` refuses to run while one is set.
  gh auth status >/dev/null 2>&1 && return 0
  token=$(github_token) || return 1
  printf '%s' "$token" | GH_TOKEN='' GITHUB_TOKEN='' gh auth login --hostname github.com --with-token
}

[ "$have" -ge "$want" ] || install_node || echo "setup-cloud: node $want unavailable, staying on $(node -v)"

setup_gh || echo "setup-cloud: gh unavailable; file-issue.ts, pr-wait.ts and gh itself will fail"

npm ci --prefer-offline --no-audit --no-fund || echo "setup-cloud: npm ci failed"

# Report what a session shell resolves, not what this script exported.
echo "setup-cloud: session node $(PATH=$image_path node -v 2>&1), .nvmrc wants $want"
echo "setup-cloud: session gh $(PATH=$image_path gh --version 2>&1 | head -n 1)," \
  "logged in as $(PATH=$image_path gh api user --jq .login 2>/dev/null || echo 'nobody')"
exit 0
