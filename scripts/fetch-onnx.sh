#!/bin/bash
set -euo pipefail

# Download the ONNX Runtime shared library that backs the native AI separation
# path (GABORATOR_ONNX_ENABLED in binding.gyp) into vendor/onnxruntime.

ONNX_VERSION="1.24.3"
ONNX_DIR="vendor/onnxruntime"

case "$(uname -s)" in
  Darwin)
    # ONNX Runtime published its last macOS x86_64 build for 1.23, so Intel Macs
    # build without the separation path rather than pinning an older runtime.
    if [ "$(uname -m)" != "arm64" ]; then
      echo "[fetch-onnx] No macOS ONNX Runtime build for $(uname -m), skipping."
      exit 0
    fi
    PACKAGE="onnxruntime-osx-arm64-${ONNX_VERSION}"
    ARCHIVE="${PACKAGE}.tgz"
    MARKER="$ONNX_DIR/lib/libonnxruntime.${ONNX_VERSION}.dylib"
    ;;
  Linux)
    PACKAGE="onnxruntime-linux-x64-${ONNX_VERSION}"
    ARCHIVE="${PACKAGE}.tgz"
    MARKER="$ONNX_DIR/lib/libonnxruntime.so.1"
    ;;
  MINGW* | MSYS* | CYGWIN*)
    PACKAGE="onnxruntime-win-x64-${ONNX_VERSION}"
    ARCHIVE="${PACKAGE}.zip"
    MARKER="$ONNX_DIR/lib/onnxruntime.dll"
    ;;
  *)
    echo "[fetch-onnx] No ONNX Runtime build for $(uname -s), skipping."
    exit 0
    ;;
esac

if [ -f "$MARKER" ]; then
  echo "[fetch-onnx] ONNX Runtime ${ONNX_VERSION} (${PACKAGE}) already present, skipping."
  exit 0
fi

URL="https://github.com/microsoft/onnxruntime/releases/download/v${ONNX_VERSION}/${ARCHIVE}"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

echo "[fetch-onnx] Downloading ${ARCHIVE}..."
curl -fsSL --retry 3 -o "$TMPDIR/$ARCHIVE" "$URL"

echo "[fetch-onnx] Extracting into $ONNX_DIR..."
rm -rf "$ONNX_DIR"
mkdir -p "$ONNX_DIR"

case "$ARCHIVE" in
  *.zip)
    # Git Bash ships no unzip, and the Windows archive carries a 380 MB .pdb the
    # build does not need, so a PowerShell helper filters while it extracts.
    # PowerShell's .NET working directory does not track the shell's, so every
    # path crosses over absolute.
    powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass \
      -File "$(cygpath -a -w scripts/extract-onnx-zip.ps1)" \
      -Archive "$(cygpath -a -w "$TMPDIR/$ARCHIVE")" \
      -Destination "$(cygpath -a -w "$ONNX_DIR")"
    ;;
  *)
    tar -xzf "$TMPDIR/$ARCHIVE" -C "$ONNX_DIR" --strip-components 1
    ;;
esac

# The Linux archive names the real library by full version and reaches it through
# two symlinks. gyp copies files rather than links, and the addon's DT_NEEDED
# records the SONAME, so the SONAME must be the real file.
if [ "$(uname -s)" = "Linux" ]; then
  rm -f "$ONNX_DIR/lib/libonnxruntime.so.1"
  mv "$ONNX_DIR/lib/libonnxruntime.so.${ONNX_VERSION}" "$ONNX_DIR/lib/libonnxruntime.so.1"
  ln -sf libonnxruntime.so.1 "$ONNX_DIR/lib/libonnxruntime.so"
fi

if [ ! -f "$MARKER" ]; then
  echo "[fetch-onnx] Expected $MARKER after extraction but not found."
  exit 1
fi

echo "[fetch-onnx] ONNX Runtime ${ONNX_VERSION} (${PACKAGE}) ready."
