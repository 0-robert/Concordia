#!/usr/bin/env bash
# Build the phone bundle from concordia/host/ and stage:
#   - bundle into ./public/ (so pod-host serves phone.html on /)
#   - the entire pod-host/ tree into concordia/host/public/pod-host/ (so the
#     host page can fetch them and copy into the BrowserPod sandbox at boot)
#   - a manifest.json listing every file the host needs to copy into the pod.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
HOST_DIR="$(cd "$HERE/../host" && pwd)"
STAGE="$HOST_DIR/public/pod-host"

echo "[bundle] vite build in $HOST_DIR"
( cd "$HOST_DIR" && npx vite build )

PUB="$HERE/public"
echo "[bundle] staging phone bundle into $PUB"
rm -rf "$PUB/assets" "$PUB/phone.html" "$PUB/index.html"
mkdir -p "$PUB"
cp -r "$HOST_DIR/dist/assets" "$PUB/assets"
cp "$HOST_DIR/dist/phone.html" "$PUB/phone.html"
cp "$HOST_DIR/dist/phone.html" "$PUB/index.html"

echo "[bundle] staging pod-host tree into $STAGE"
rm -rf "$STAGE"
mkdir -p "$STAGE"
# Copy server.js + package.json + the public/ subtree. We deliberately exclude
# node_modules (pod will run npm install itself), build-bundle.sh, and lock files.
cp "$HERE/server.js" "$STAGE/server.js"
cp "$HERE/package.json" "$STAGE/package.json"
mkdir -p "$STAGE/public"
cp -R "$HERE/public/"* "$STAGE/public/" 2>/dev/null || true

# Generate manifest of files to copy into the pod (POSIX paths)
( cd "$STAGE" && find . -type f -not -name 'manifest.json' -not -name 'manifest.txt' | sed 's|^\./||' | sort ) > "$STAGE/manifest.txt"
# Wrap as JSON for easy fetch in the host page
node -e '
  const fs = require("fs");
  const lines = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").filter(Boolean);
  fs.writeFileSync(process.argv[2], JSON.stringify({ files: lines }, null, 2));
' "$STAGE/manifest.txt" "$STAGE/manifest.json"
rm "$STAGE/manifest.txt"

echo "[bundle] manifest:"
cat "$STAGE/manifest.json"
echo
echo "[bundle] done"
