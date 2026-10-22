#!/usr/bin/env bash
# Drive the app in headless Chromium and fail if a step throws or the page does.
#   tools/ui-smoke.sh 'js step' ...      (steps run in order; throw to fail; return to print)
# OUT=dir keeps the screenshot (default: a temp dir). SIZE=WxH, DARK=1 pass through to look.mjs.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=${PORT:-31742}
OUT=${OUT:-$(mktemp -d)}
mkdir -p "$OUT"
npx vite --host 127.0.0.1 --port "$PORT" --strictPort >"$OUT/vite.log" 2>&1 &
VITE=$!
trap 'kill $VITE 2>/dev/null || true' EXIT
for _ in $(seq 1 100); do curl -sf "http://127.0.0.1:$PORT/" >/dev/null && break; sleep 0.1; done
curl -sf "http://127.0.0.1:$PORT/" >/dev/null || { echo "vite did not start"; cat "$OUT/vite.log"; exit 1; }
# A clean slate each run: no towns or settings left over from the last.
LOG=$(LOOK_WAIT=${LOOK_WAIT:-2500} node tools/look.mjs "http://127.0.0.1:$PORT/${URLHASH:-}" "$OUT/smoke.png" "$@" 2>&1)
echo "$LOG"
echo "screenshot: $OUT/smoke.png"
if grep -qE '^\[(exception|step error)\]' <<<"$LOG"; then echo "SMOKE FAIL"; exit 1; fi
echo "SMOKE OK"
