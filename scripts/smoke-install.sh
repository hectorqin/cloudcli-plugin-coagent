#!/usr/bin/env bash
# Simulate CloudCLI's URL installer in an isolated HOME. No real user config is touched.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="${1:-$ROOT}"
REF="${2:-$(git -C "$ROOT" rev-parse HEAD)}"
TMP="$(mktemp -d)"
SERVER_PID=""
cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

git clone --quiet "$REPO" "$TMP/plugin"
git -C "$TMP/plugin" checkout --quiet "$REF"
cd "$TMP/plugin"

# CloudCLI may install with NODE_ENV=production, so the build tool must not rely on devDependencies.
NODE_ENV=production npm install --omit=dev --ignore-scripts
NODE_ENV=production npm run build
npm run check:release

for artifact in dist/index.js dist/server.js dist/mcp-shim.js; do
  [[ -s "$artifact" ]] || { echo "missing build artifact: $artifact" >&2; exit 1; }
done

mkdir -p "$TMP/home" "$TMP/data"
HOME="$TMP/home" COAGENT_DATA_DIR="$TMP/data" node dist/server.js >"$TMP/server.out" 2>"$TMP/server.err" &
SERVER_PID=$!

ready=""
for _ in $(seq 1 100); do
  if [[ -s "$TMP/server.out" ]] && node -e '
    const fs = require("node:fs");
    const lines = fs.readFileSync(process.argv[1], "utf8").trim().split(/\n/);
    if (!lines.some((line) => { try { const v = JSON.parse(line); return v.ready === true && Number.isInteger(v.port) && v.port > 0; } catch { return false; } })) process.exit(1);
  ' "$TMP/server.out"; then
    ready=1
    break
  fi
  kill -0 "$SERVER_PID" 2>/dev/null || { cat "$TMP/server.err" >&2; echo "broker exited before readiness" >&2; exit 1; }
  sleep 0.1
done
[[ -n "$ready" ]] || { cat "$TMP/server.err" >&2; echo "broker did not become ready within 10 seconds" >&2; exit 1; }

echo "CloudCLI URL install smoke passed"
