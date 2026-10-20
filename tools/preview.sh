#!/usr/bin/env bash
# Render preview PNGs: tools/preview.sh OUTDIR [seeds] [pop]
set -euo pipefail
out=${1:?outdir}; seeds=${2:-ashby,b,c}; pop=${3:-200}
cd "$(dirname "$0")/.."
PREVIEW_DIR="$out" SEEDS="$seeds" POP="$pop" BASE="${BASE:-agricultural}" NO_COLOR=1 npx vitest run tools/preview.test.ts >/dev/null
for f in "$out"/*.svg; do rsvg-convert -w 1400 "$f" -o "${f%.svg}.png"; done
ls "$out"/*.png
