#!/bin/bash
# Fetch Ableton Link C++ library if not already present
LINK_DIR="vendor/link"

if [ -d "$LINK_DIR/include/ableton" ]; then
  echo "[fetch-link] Ableton Link already present, skipping."
  exit 0
fi

echo "[fetch-link] Downloading Ableton Link..."
git clone --depth 1 https://github.com/Ableton/link.git "$LINK_DIR"
cd "$LINK_DIR"
git submodule update --init --depth 1
echo "[fetch-link] Ableton Link ready."
