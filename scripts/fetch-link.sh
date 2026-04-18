#!/bin/bash
set -euo pipefail

LINK_DIR="vendor/link"
LINK_COMMIT="b6d5c597a1027f333a06459c8d6e064d603bbe7c"

if [ -d "$LINK_DIR/include/ableton" ] && [ -f "$LINK_DIR/.pinned-commit" ] && \
   [ "$(cat "$LINK_DIR/.pinned-commit")" = "$LINK_COMMIT" ]; then
  echo "[fetch-link] Ableton Link @ ${LINK_COMMIT:0:7} already present, skipping."
  exit 0
fi

if [ -d "$LINK_DIR" ]; then
  echo "[fetch-link] Existing $LINK_DIR does not match pinned commit, removing."
  rm -rf "$LINK_DIR"
fi

echo "[fetch-link] Fetching Ableton Link @ ${LINK_COMMIT:0:7}..."
mkdir -p "$LINK_DIR"
cd "$LINK_DIR"
git init -q
git remote add origin https://github.com/Ableton/link.git
git fetch --depth 1 -q origin "$LINK_COMMIT"
git checkout -q FETCH_HEAD
git submodule update --init --depth 1 -q
echo "$LINK_COMMIT" > .pinned-commit
echo "[fetch-link] Ableton Link ready."
