#!/usr/bin/env bash
# Re-install + prune unused MC version data + repack node_modules.
# Run from pocketcraft/server/.
#
# Why: the unpruned tarball is 106 MB → ~813 MB extracted, which OOMs
# Chrome (ERR 5) when streaming into BrowserPod's IndexedDB. Pruning
# shrinks it to ~30-40 MB compressed / ~200 MB extracted.
#
# We use MC version 1.16.5 — keep that, delete the rest.

set -e
cd "$(dirname "$0")"

KEEP_VERSION="1.16"  # also keeps 1.16.x because we glob

echo "[prune] re-installing fresh node_modules…"
rm -rf node_modules package-lock.json
npm install --no-audit --no-fund --omit=optional 2>&1 | tail -3

echo "[prune] before:"
du -sh node_modules
echo ""

# ── minecraft-data: keep `common/` (required at module load) + only target
#    pc version dir. Drop all bedrock per-version dirs but KEEP bedrock/common/.
MD_PC=node_modules/minecraft-data/minecraft-data/data/pc
MD_BEDROCK=node_modules/minecraft-data/minecraft-data/data/bedrock

if [ -d "$MD_BEDROCK" ]; then
  echo "[prune] bedrock: removing per-version dirs (keeping common/)…"
  for v in "$MD_BEDROCK"/*; do
    name=$(basename "$v")
    case "$name" in
      common|protocolVersions.json) ;;
      *) rm -rf "$v" ;;
    esac
  done
fi

if [ -d "$MD_PC" ]; then
  echo "[prune] pc: keeping only common/ + ${KEEP_VERSION}* versions…"
  for v in "$MD_PC"/*; do
    name=$(basename "$v")
    case "$name" in
      ${KEEP_VERSION}|${KEEP_VERSION}.*|common|protocolVersions.json) ;;
      *) rm -rf "$v" ;;
    esac
  done
fi

# ── prismarine-viewer: keep only 1.16.x textures + block states ──
PV_TEX=node_modules/prismarine-viewer/public/textures
PV_BS=node_modules/prismarine-viewer/public/blocksStates
for dir in "$PV_TEX" "$PV_BS"; do
  if [ -d "$dir" ]; then
    echo "[prune] keeping only 1.16.x in $dir…"
    for v in "$dir"/*; do
      name=$(basename "$v")
      case "$name" in
        ${KEEP_VERSION}|${KEEP_VERSION}.*) ;;
        *) rm -rf "$v" ;;
      esac
    done
  fi
done

# ── general cleanup: docs, tests, .github across all packages ──
echo "[prune] removing test/, doc/, .github/ across deps…"
find node_modules -type d \( \
    -name test -o -name tests -o -name __tests__ \
    -o -name doc -o -name docs \
    -o -name .github -o -name examples \
    -o -name benchmark \
  \) -prune -exec rm -rf {} + 2>/dev/null || true

# Drop random metadata files (small but plenty)
find node_modules -type f \( \
    -name "*.md" -o -name "*.markdown" \
    -o -name CHANGELOG -o -name CHANGES -o -name HISTORY \
    -o -name "*.ts" -o -name "*.flow" \
    -o -name ".npmignore" -o -name ".gitignore" -o -name ".eslintrc*" \
  \) -delete 2>/dev/null || true

echo "[prune] after:"
du -sh node_modules

echo ""
echo "[prune] tarring + gzipping (this takes ~30s)…"
tar -czhf node_modules.tar.gz node_modules/
ls -lh node_modules.tar.gz
echo ""
echo "[prune] DONE — tarball is at node_modules.tar.gz"
echo "        symlinked into host/public/app/ via host/public/app symlink"
