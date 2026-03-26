#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() {
  echo "==> $*"
}

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "required tool not found: $1"
  fi
}

need node
need npm

cd "$ROOT_DIR"

if [[ "${CLANKER_SKIP_INSTALL:-${CLANKER_MONO_SKIP_INSTALL:-0}}" != "1" ]]; then
  log "Installing workspace dependencies"
  npm install
fi

if [[ "${CLANKER_SKIP_BUILD:-${CLANKER_MONO_SKIP_BUILD:-0}}" != "1" ]]; then
  log "Building core packages"
  BUILD_FAILED=0
  for pkg in packages/tui packages/ai packages/agent packages/coding-agent; do
    if ! npm run build --workspace "$pkg"; then
      BUILD_FAILED=1
      echo "WARN: build failed for $pkg; falling back to source launch mode."
    fi
  done
else
  BUILD_FAILED=1
fi

if [[ "$BUILD_FAILED" == "1" ]] && [[ ! -f "$ROOT_DIR/packages/coding-agent/src/cli.ts" ]]; then
	fail "No usable coding-agent CLI source found for source launch fallback."
fi

LAUNCHER="$ROOT_DIR/clanker"
cat > "$LAUNCHER" <<'EOF'
#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -x "$ROOT_DIR/packages/coding-agent/dist/clanker" ]]; then
  exec "$ROOT_DIR/packages/coding-agent/dist/clanker" "$@"
fi

if [[ -f "$ROOT_DIR/packages/coding-agent/dist/cli.js" ]]; then
  exec node "$ROOT_DIR/packages/coding-agent/dist/cli.js" "$@"
fi

if [[ -x "$ROOT_DIR/node_modules/.bin/tsx" ]] && [[ -f "$ROOT_DIR/packages/coding-agent/src/cli.ts" ]]; then
  exec "$ROOT_DIR/node_modules/.bin/tsx" "$ROOT_DIR/packages/coding-agent/src/cli.ts" "$@"
fi

echo "ERROR: no runnable clanker binary found and tsx fallback is unavailable." >&2
exit 1
EOF

chmod +x "$LAUNCHER"
log "Created launcher: $LAUNCHER"
log "Run with: ./clanker"
