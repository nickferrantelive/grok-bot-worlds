#!/bin/bash
# Run a heavy command (Blender render or bake, splat training) under one of two machine-wide slots.
# This Mac has 24 GB. Too many Blender processes at once has stalled it for hours before.
# Usage: tools/gpu_slot.sh <command> [args...]
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOCKS="$ROOT/.work/locks"
SLOTS=2
mkdir -p "$LOCKS"

# macOS pressure level: 1 normal, 2 warning, 4 critical. Swap used is not a useful signal,
# it stays high long after the pressure has passed.
pressure_ok() {
  [ "$(sysctl -n kern.memorystatus_vm_pressure_level)" -lt 4 ]
}

HELD=""
release() {
  [ -n "$HELD" ] && rm -rf "$HELD"
  HELD=""
}
trap release EXIT
trap 'release; exit 130' INT TERM

waited=0
while [ -z "$HELD" ]; do
  if pressure_ok; then
    for i in $(seq 0 $((SLOTS - 1))); do
      d="$LOCKS/slot$i"
      if mkdir "$d" 2>/dev/null; then
        echo $$ > "$d/pid"
        HELD="$d"
        break
      fi
      pid="$(cat "$d/pid" 2>/dev/null)"
      if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
        rm -rf "$d"
      fi
    done
  fi
  if [ -z "$HELD" ]; then
    sleep 4
    waited=$((waited + 4))
  fi
done
[ "$waited" -gt 0 ] && echo "gpu_slot: waited ${waited}s for a slot" >&2

"$@"
status=$?
release
exit $status
