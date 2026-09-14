#!/usr/bin/env bash
#
# setup.sh — install dev deps, wire the hand-made @animalabs symlinks into
# portal-stack (same convention portal-mcpl uses), and build.
#
# The @animalabs packages are deliberately NOT in package.json dependencies:
# npm would fetch published registry versions instead of the local checkouts.
set -euo pipefail
cd "$(dirname "$0")"

STACK="$(cd ../portal-stack && pwd)"

for pkg in portal-client portal-protocol; do
  if [ ! -f "$STACK/$pkg/dist/src/index.js" ]; then
    echo "error: $STACK/$pkg is not built (dist/src/index.js missing)" >&2
    echo "  build it: (cd '$STACK/$pkg' && npm i && npm run build)" >&2
    exit 1
  fi
done

npm install

mkdir -p node_modules/@animalabs
for pkg in portal-client portal-protocol; do
  ln -sfn "$STACK/$pkg" "node_modules/@animalabs/$pkg"
done

npm run build
echo "[setup] done — run: node dist/src/main.js (foreground) or ./launch.sh"
