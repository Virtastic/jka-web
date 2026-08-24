#!/usr/bin/env bash
# Post-deploy contract test against a deployed jka origin (or the container port directly). A 200
# proves little — assert the serving contract a player actually needs. curl-only so it runs anywhere.
#
# Usage: smoke-test.sh <base-url>     e.g. smoke-test.sh http://test-host.example:8083
#                                          smoke-test.sh https://jka.dev.virtastic.app
set -uo pipefail
BASE="${1:?usage: smoke-test.sh <base-url>}"; BASE="${BASE%/}"
FAILED=0
pass() { printf '  \033[32mok\033[0m   %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n       -> %s\n' "$1" "$2"; FAILED=$((FAILED+1)); }
get()  { curl -s --max-time 20 "$@"; }
hdrs() { curl -s -D - -o /dev/null --max-time 20 "$@"; }
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$@"; }
# has <pattern> <string>: case-insensitive contains via here-string. NEVER `echo "$big" | grep -q`
# under pipefail: grep -q exits on first match, echo gets SIGPIPE, the pipeline reports failure
# despite the match (bites once the body exceeds the pipe buffer).
has()  { grep -qi -- "$1" <<<"$2"; }

echo "==> jka serving contract: $BASE"

# 1. Cross-origin isolation headers. jka is single-threaded so it runs without them, but the vhost
#    sets them for parity with the rest of the set — assert they survived (config intact).
H="$(hdrs "$BASE/")"
has '^cross-origin-opener-policy: *same-origin'   "$H" && pass "COOP: same-origin"   || fail "COOP header" "serving contract changed"
has '^cross-origin-embedder-policy: *require-corp' "$H" && pass "COEP: require-corp" || fail "COEP header" "serving contract changed"
# Preview posture: this deploy must stay out of search engines.
has '^x-robots-tag: *noindex' "$H" && pass "noindex (preview posture)" || fail "X-Robots-Tag" "test build must not be indexable"

# 2. The root serves the launcher, not a raw 404 / directory listing.
B="$(get "$BASE/")"
has 'Jedi Academy' "$B" && pass "root serves the launcher" || fail "launcher at /" "root did not return the jka launcher"

# 3. The engine + game module are present and typed correctly. jka serves them at the web root.
[ "$(code "$BASE/jka.js")" = 200 ]      && pass "engine jka.js served"     || fail "jka.js" "engine loader missing"
[ "$(code "$BASE/jka.wasm")" = 200 ]    && pass "engine jka.wasm served"   || fail "jka.wasm" "engine wasm missing"
[ "$(code "$BASE/qagame.wasm")" = 200 ] && pass "game module qagame.wasm served" || fail "qagame.wasm" "SIDE_MODULE missing"
has '^content-type: *application/wasm' "$(hdrs "$BASE/jka.wasm")" && pass "jka.wasm is application/wasm" || fail "wasm mime" "wrong Content-Type"

# 4. Upload-only test build: no commercial game data is served.
[ "$(code "$BASE/base/assets0.pk3")" = 404 ] && pass "no bundled game data (upload-only)" || fail "game data leak" "commercial data must not be served"

echo
[ "$FAILED" = 0 ] && { echo "==> contract OK"; exit 0; } || { echo "==> $FAILED contract failure(s)"; exit 1; }
