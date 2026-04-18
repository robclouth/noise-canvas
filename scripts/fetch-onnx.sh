#!/bin/bash
set -euo pipefail

# ONNX Runtime is only needed for the native AI separation path, which is
# compiled only on macOS (see GABORATOR_ONNX_ENABLED in binding.gyp).
if [ "$(uname -s)" != "Darwin" ]; then
  echo "[fetch-onnx] Not macOS, skipping ONNX Runtime download."
  exit 0
fi

ONNX_VERSION="1.24.3"
ONNX_DIR="vendor/onnxruntime"
DYLIB="$ONNX_DIR/lib/libonnxruntime.${ONNX_VERSION}.dylib"

case "$(uname -m)" in
  arm64)  ONNX_ARCH="arm64" ;;
  x86_64) ONNX_ARCH="x86_64" ;;
  *) echo "[fetch-onnx] Unsupported arch: $(uname -m)"; exit 1 ;;
esac

if [ -f "$DYLIB" ]; then
  echo "[fetch-onnx] ONNX Runtime ${ONNX_VERSION} (${ONNX_ARCH}) already present, skipping."
  exit 0
fi

TARBALL="onnxruntime-osx-${ONNX_ARCH}-${ONNX_VERSION}.tgz"
URL="https://github.com/microsoft/onnxruntime/releases/download/v${ONNX_VERSION}/${TARBALL}"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

echo "[fetch-onnx] Downloading ${TARBALL}..."
curl -fsSL --retry 3 -o "$TMPDIR/$TARBALL" "$URL"

echo "[fetch-onnx] Extracting into $ONNX_DIR..."
rm -rf "$ONNX_DIR"
mkdir -p "$ONNX_DIR"
tar -xzf "$TMPDIR/$TARBALL" -C "$ONNX_DIR" --strip-components 1

if [ ! -f "$DYLIB" ]; then
  echo "[fetch-onnx] Expected $DYLIB after extraction but not found."
  exit 1
fi

echo "[fetch-onnx] ONNX Runtime ${ONNX_VERSION} (${ONNX_ARCH}) ready."
