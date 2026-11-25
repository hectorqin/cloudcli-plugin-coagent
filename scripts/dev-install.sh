#!/usr/bin/env bash
# Dev install: CloudCLI skips symlinked plugin folders, so sync the built plugin into place.
# Runtime code is fully bundled into dist/, so node_modules is not needed there.
set -euo pipefail
cd "$(dirname "$0")/.."
DEST="${HOME}/.claude-code-ui/plugins/cloudcli-coagent"
npm run build --silent
mkdir -p "$DEST"
rsync -a --delete --exclude node_modules --exclude .git --exclude test --exclude src ./ "$DEST/"
# Make CloudCLI restart the broker on the next RPC so the new build is used.
pkill -f "$DEST/dist/server.js" 2>/dev/null || true
echo "installed to $DEST"
