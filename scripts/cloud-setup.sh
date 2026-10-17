#!/usr/bin/env bash
# Session-start hook for cloud sessions: the image ships Node 22, and the repo needs Node 26
# (ADR 0008). Installs the pinned Node next to the image's own, then installs dependencies.
# Does nothing on Windows or wherever Node 26 is already on the PATH.

set -euo pipefail

NODE_VERSION="26.7.0"

case "$(uname -s)" in
  Linux) ;;
  *) exit 0 ;;
esac

cd "$(git rev-parse --show-toplevel)"

if [[ "$(node --version 2>/dev/null)" != "v$NODE_VERSION" ]]; then
  dir="/opt/node-v$NODE_VERSION"
  if [[ ! -x "$dir/bin/node" ]]; then
    tarball="node-v$NODE_VERSION-linux-x64.tar.gz"
    mkdir -p "$dir"
    curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$tarball" | tar -xz -C "$dir" --strip-components=1
  fi
  # Link over the image's node, npm and npx, so every later shell finds Node 26 on its usual PATH.
  bin="$(dirname "$(command -v node || echo /usr/local/bin/node)")"
  for tool in node npm npx; do
    ln -sf "$dir/bin/$tool" "$bin/$tool"
  done
  hash -r
fi

echo "cloud-setup: $(node --version), npm $(npm --version)"

if [[ ! -d node_modules ]]; then
  npm ci --no-audit --no-fund 2>&1 | tail -n 5
fi
