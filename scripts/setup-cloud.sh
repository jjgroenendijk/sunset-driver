#!/usr/bin/env bash
# Setup script for Claude Code cloud sessions: Ubuntu 24.04, root, repo cloned.
# The image ships Node 20-22 only, so install the .nvmrc version, then the deps.
# Must exit 0 or the session fails to start, and must stay under ~5 minutes.
set -u

cd "$(dirname -- "${BASH_SOURCE[0]}")/.." || exit 0

want=$(tr -dc 0-9 < .nvmrc)
have=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)

install_node() {
  local version prefix
  version=$(curl -fsSL https://nodejs.org/dist/index.json |
    jq -er --arg v "v$want." 'map(select(.version | startswith($v)))[0].version') || return 1
  prefix=/opt/node-$version-linux-x64
  curl -fsSL "https://nodejs.org/dist/$version/node-$version-linux-x64.tar.xz" | tar -xJ -C /opt || return 1
  ln -sf "$prefix"/bin/{node,npm,npx} /usr/local/bin/   # outranks the image's node22
  echo "export PATH=$prefix/bin:\$PATH" > /etc/profile.d/10-node-repo.sh
  export PATH=$prefix/bin:$PATH
}

[ "$have" -ge "$want" ] || install_node || echo "setup-cloud: node $want unavailable, staying on $(node -v)"

npm ci --prefer-offline --no-audit --no-fund || echo "setup-cloud: npm ci failed"
node -v
exit 0
