#!/usr/bin/env bash
# Build the jka test image ON the build server (run there, in the synced source dir).
# Self-contained multi-stage build (Dockerfile, default `runtime` target): the first run pulls emscripten/emsdk:6.0.1
# (~2-3 GB, one-time); later runs reuse the cached toolchain layer and the warm object cache, so a
# push is just the incremental engine + module recompile.
set -euo pipefail

SRC="${SRC:-$HOME/jka-src}"
TAG="${TAG:-jka:test}"
cd "$SRC"

[ -f Dockerfile ] || { echo "FATAL: no Dockerfile in $SRC (sync first)"; exit 1; }
[ -d games/jka/code ]  || { echo "FATAL: games/jka/code missing in $SRC (sync problem)"; exit 1; }

echo "==> building $TAG from $(cat .source-commit 2>/dev/null || echo 'dirty tree')"
DOCKER_BUILDKIT=1 docker build --network=host -t "$TAG" -f Dockerfile .
echo "==> built $TAG"
docker image inspect "$TAG" --format '    size: {{.Size}} bytes  created: {{.Created}}'

# Belt-and-braces: a test image that shipped commercial game data would be a licensing problem, not
# just a size one. Assert the built image is clean before it can be deployed.
# The official free demo pak is exempt: it is freely redistributable and the site's
# "Play the demo" card depends on it; .dockerignore lets only that one path through.
LEAK=$(docker run --rm --entrypoint sh "$TAG" -c \
  'find /usr/share/nginx/html \( -name "*.pk3" -o -name "*.data" -o -name "*.sav" \) \
     ! -path "*/demo/assets0.pk3" | wc -l')
if [ "$LEAK" = "0" ]; then
  echo "    verified: no game data in image"
else
  echo "FATAL: $LEAK commercial game-data file(s) leaked into $TAG"; exit 1
fi
