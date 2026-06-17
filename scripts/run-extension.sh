#!/bin/bash
set -euo pipefail

# Builds the Noise Canvas extension and launches it inside Ableton Live's
# Extension Host. Requires Live 12.4.5b+ Suite with Developer Mode enabled
# (Preferences → Extensions). Override the Live location with LIVE_APP=... if it
# isn't the default beta path.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

# Locate the Live beta app: explicit override, the default beta path, then any
# "Ableton Live*Beta.app" in /Applications.
live_app="${LIVE_APP:-}"
if [ -z "$live_app" ]; then
  for candidate in "/Applications/Ableton Live 12 Beta.app" /Applications/Ableton\ Live*Beta*.app; do
    if [ -d "$candidate" ]; then
      live_app="$candidate"
      break
    fi
  done
fi

if [ -z "$live_app" ] || [ ! -d "$live_app" ]; then
  echo "[run-extension] Could not find an Ableton Live beta in /Applications." >&2
  echo "[run-extension] Set LIVE_APP=/path/to/Ableton Live ... Beta.app and re-run." >&2
  exit 1
fi

host_module="$live_app/Contents/Helpers/ExtensionHost/ExtensionHostNodeModule.node"
if [ ! -f "$host_module" ]; then
  echo "[run-extension] Extension Host module not found inside:" >&2
  echo "                $live_app" >&2
  echo "[run-extension] This build of Live may not support Extensions." >&2
  exit 1
fi

echo "[run-extension] Live:          $live_app"
echo "[run-extension] Host module:   $host_module"

# Build webview + host into out-ext/ (manifest + host/main.cjs + webview/).
echo "[run-extension] Building extension…"
npm run build:ext

# The Extension Host's greeting only lands once Live is fully up; if Live is
# still booting when the host starts, the connection silently never happens.
# Launch Live if needed and give it a warm-up window before starting the host.
if ! pgrep -f "$live_app/Contents/MacOS" >/dev/null 2>&1; then
  echo "[run-extension] Live isn't running — launching it…"
  open -a "$live_app"
  for _ in $(seq 1 60); do
    pgrep -f "$live_app/Contents/MacOS" >/dev/null 2>&1 && break
    sleep 1
  done
  echo "[run-extension] Waiting for Live to finish loading…"
  sleep 20
  echo "[run-extension] If \"Edit in Noise Canvas\" doesn't appear, just re-run"
  echo "[run-extension] 'npm run ext:run' now that Live is warm."
fi

cat <<EOF
[run-extension] Make sure Developer Mode is ON (Live → Preferences → Extensions)
[run-extension] and a Set with an audio clip is open. Right-click an arrangement
[run-extension] audio clip → "Edit in Noise Canvas".
[run-extension] Starting the Extension Host (Ctrl-C to stop)…
EOF

exec env EXTENSION_HOST_PATH="$host_module" npx --no-install extensions-cli run out-ext
