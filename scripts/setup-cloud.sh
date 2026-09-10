#!/usr/bin/env bash
# Setup script for Claude Code cloud sessions: Ubuntu 24.04, root, repo cloned.
# The image ships Node 20-22 only, so install the .nvmrc version, then the deps.
# Must exit 0 or the session fails to start, and must stay under ~5 minutes.
set -u

cd "$(dirname -- "${BASH_SOURCE[0]}")/.." || exit 0

want=$(tr -dc 0-9 < .nvmrc)
have=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
image_path=$PATH   # the PATH the session's shells inherit, before this script edits it

# Make the installed node win in the session's shells. The image puts its own
# node directory *ahead* of /usr/local/bin on PATH and the session shell is not
# a login shell, so neither a /usr/local/bin symlink nor /etc/profile.d is
# enough on its own: also link into the first writable entry of PATH.
shadow_node() {
  local prefix=$1 dir dirs
  ln -sf "$prefix"/bin/{node,npm,npx} /usr/local/bin/
  echo "export PATH=$prefix/bin:\$PATH" > /etc/profile.d/10-node-repo.sh
  IFS=: read -r -a dirs <<< "$PATH"
  for dir in "${dirs[@]}"; do
    case $dir in '' | "$prefix" | "$prefix"/*) continue ;; esac
    [ -d "$dir" ] && [ -w "$dir" ] || continue
    ln -sf "$prefix"/bin/{node,npm,npx} "$dir"/ && return 0
  done
  echo "setup-cloud: no writable PATH entry to link node into" >&2
}

install_node() {
  local version prefix
  version=$(curl -fsSL https://nodejs.org/dist/index.json |
    jq -er --arg v "v$want." 'map(select(.version | startswith($v)))[0].version') || return 1
  prefix=/opt/node-$version-linux-x64
  curl -fsSL "https://nodejs.org/dist/$version/node-$version-linux-x64.tar.xz" | tar -xJ -C /opt || return 1
  shadow_node "$prefix"
  export PATH=$prefix/bin:$PATH
}

[ "$have" -ge "$want" ] || install_node || echo "setup-cloud: node $want unavailable, staying on $(node -v)"

npm ci --prefer-offline --no-audit --no-fund || echo "setup-cloud: npm ci failed"

# Report the version a session shell resolves, not the one this script exported.
echo "setup-cloud: session node $(PATH=$image_path node -v 2>&1), .nvmrc wants $want"
exit 0
