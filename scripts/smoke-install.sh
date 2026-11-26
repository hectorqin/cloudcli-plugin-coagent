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
    # The broker runs in its own process group (setsid), so this also reaches anything it spawned.
    kill -TERM -- "-$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
    for _ in $(seq 1 50); do kill -0 -- "-$SERVER_PID" 2>/dev/null || break; sleep 0.1; done
    kill -KILL -- "-$SERVER_PID" 2>/dev/null || true
    SERVER_PID=""
  fi
  cd "$ROOT"
  rm -rf -- "$TMP"
  [[ ! -e "$TMP" ]] || { echo "failed to remove smoke directory: $TMP" >&2; return 1; }
}
trap cleanup EXIT

git clone --quiet "$REPO" "$TMP/plugin"
git -C "$TMP/plugin" checkout --quiet "$REF"
cd "$TMP/plugin"

# CloudCLI may install with NODE_ENV=production, so the build tool must not rely on devDependencies.
NODE_ENV=production npm install --omit=dev --ignore-scripts
NODE_ENV=production npm run build
npm run check:release

for artifact in dist/index.js dist/server.js dist/mcp-shim.js skills/coagent/SKILL.md; do
  [[ -s "$artifact" ]] || { echo "missing build artifact: $artifact" >&2; exit 1; }
done

mkdir -p "$TMP/home" "$TMP/data" "$TMP/bin"
# Stub CLIs first on PATH: if auto-registration ran anyway, it would record a call here instead of touching real config.
for cli in claude codex; do
  printf '#!/bin/sh\necho "%s $*" >>"%s/stub-calls"\n' "$cli" "$TMP" >"$TMP/bin/$cli"
  chmod +x "$TMP/bin/$cli"
done
BROKER_ENV=(env -i PATH="$TMP/bin:$PATH" HOME="$TMP/home" NODE_ENV=production COAGENT_DATA_DIR="$TMP/data")

# Disable auto-registration with kv autoRegister=false. This partial pre-migration database is intentional: it also
# exercises the upgrade path (backup, then migration) on startup.
"${BROKER_ENV[@]}" node -e '
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(process.argv[1]);
  db.exec("CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  db.prepare("INSERT INTO kv (k, v) VALUES (?, ?)").run("autoRegister", "false");
  db.close();
' "$TMP/data/coagent.db"

# Launch exactly as CloudCLI does: a scrubbed environment, in a new process group so cleanup can kill all of it.
setsid "${BROKER_ENV[@]}" node dist/server.js >"$TMP/server.out" 2>"$TMP/server.err" &
SERVER_PID=$!
[[ "$(ps -o pgid= -p "$SERVER_PID" | tr -d ' ')" == "$SERVER_PID" ]] \
  || { echo "broker is not its own process group leader" >&2; exit 1; }

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

# Registration starts right after readiness; give it a moment to (wrongly) happen before checking.
sleep 1
[[ ! -e "$TMP/stub-calls" ]] || { cat "$TMP/stub-calls" >&2; echo "broker ran registration despite autoRegister=false" >&2; exit 1; }
[[ ! -e "$TMP/home/.claude/skills/coagent" && ! -e "$TMP/home/.agents/skills/coagent" ]] \
  || { echo "broker installed skills despite autoRegister=false" >&2; exit 1; }
backups=("$TMP"/data/backups/coagent-*.db)
[[ ${#backups[@]} -eq 1 && -s "${backups[0]}" ]] || { echo "expected one pre-migration backup" >&2; exit 1; }

pgid="$SERVER_PID"
cleanup
trap - EXIT
! kill -0 -- "-$pgid" 2>/dev/null || { echo "broker process group still alive after cleanup" >&2; exit 1; }
[[ ! -e "$TMP" ]] || { echo "smoke directory still exists: $TMP" >&2; exit 1; }
echo "CloudCLI URL install smoke passed"
