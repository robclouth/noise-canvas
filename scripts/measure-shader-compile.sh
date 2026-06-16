#!/usr/bin/env bash
# Runs the shader compile-cost probe once per defines-set, each in its own fresh
# process (cold GPU shader cache), and prints the per-effect table + TOTAL for
# each. Usage: scripts/measure-shader-compile.sh "" "DISABLE_NESTED_MODULATION" ...
set -euo pipefail
cd "$(dirname "$0")/.."

TEST=src/renderer/src/lib/__tests__/shader-compile-perf.test.ts

if [ "$#" -eq 0 ]; then
  set -- ""
fi

for defines in "$@"; do
  echo "############################################################"
  echo "# VITE_SHADER_DEFINES=\"$defines\""
  echo "############################################################"
  VITE_SHADER_DEFINES="$defines" npx vitest run "$TEST" 2>&1 \
    | grep -vE "readRenderTargetPixels" \
    | sed -n '/Effect first-draw/,/TOTAL/p'
  echo
done
