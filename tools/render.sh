#!/bin/bash
# Render a Blender look script through the shared queue.
# Usage: tools/render.sh <script.py> <out.png> <width> <samples> [save.blend] [-- extra script args]
# Paths may be relative to the project root. The log goes to .work/logs/<out name>.log
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BLENDER=${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}
cd "$ROOT" || exit 1
SCRIPT="$1"; OUT="$2"; WIDTH="$3"; SAMPLES="$4"; shift 4
case "$OUT" in /*) ;; *) OUT="$ROOT/$OUT" ;; esac
mkdir -p "$(dirname "$OUT")" "$ROOT/.work/logs"
LOG="$ROOT/.work/logs/$(basename "$OUT").log"
start=$(date +%s)
"$ROOT/tools/gpu_slot.sh" "$BLENDER" -b --factory-startup --python "$SCRIPT" -- "$OUT" "$WIDTH" "$SAMPLES" "$@" > "$LOG" 2>&1
status=$?
echo "render exit $status in $(( $(date +%s) - start ))s, log $LOG"
grep -E "Traceback|Error:|POST SKIPPED|HAZE SKIPPED|^objects" "$LOG" | cut -c1-200 | head -8
exit $status
