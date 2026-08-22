#!/usr/bin/env bash
# Push the local working tree to the build server. Run from anywhere in the repo.
#
# The build server does NOT use git: this lets uncommitted work build exactly as it sits on disk
# (the whole point of a test server). Source arrives by rsync over the LAN.
set -euo pipefail

_cfg="$(dirname "$0")/config.env"
# shellcheck disable=SC1090
[ -f "$_cfg" ] && . "$_cfg"
BUILDER="${BUILDER:?set BUILDER in ci/jenkins/config.env (see config.env.example)}"
DEST="${DEST:-jka-src}"

cd "$(dirname "$0")/../.."   # repo root
command -v rsync >/dev/null || { echo "rsync not found"; exit 1; }

echo "==> syncing working tree to $BUILDER:$DEST"
# Excludes: commercial game data (never leaves this machine), local build outputs and state, and the
# heavy/generated trees. games/ + shared/ + play/<game>/*.html + infra/ + Dockerfile.test — the
# actual build inputs — ARE sent. Mirrors .dockerignore.
rsync -a --delete \
  --exclude '.git/' \
  --exclude 'build-jka/' \
  --exclude 'play/*/base/' --exclude 'play/*/demo/' --exclude 'play/*/saves/' \
  --exclude '*.pk3' --exclude '*.sav' \
  --exclude 'play/jka/jka.js' --exclude 'play/jka/jka.wasm' --exclude 'play/jka/qagame.wasm' \
  --exclude 'node_modules/' --exclude 'cloud/node_modules/' \
  ./ "$BUILDER:$DEST/"

# Record the commit for traceability even though the tree isn't a git checkout on the builder.
git rev-parse HEAD 2>/dev/null | ssh "$BUILDER" "cat > $DEST/.source-commit" || true
echo "==> synced ($(git rev-parse --short HEAD 2>/dev/null || echo dirty))"
