#!/usr/bin/env bash
# Build llama.cpp's `llama-server` and place it where Tauri expects the
# bundled sidecar: src-tauri/binaries/llama-server-<target-triple>[.exe]
#
# Usage:
#   scripts/build-llama-server.sh                         # host target
#   scripts/build-llama-server.sh universal-apple-darwin  # arm64 + x86_64 macOS
#
# The binary is statically linked (no extra .dylib/.dll files) and, on macOS,
# embeds its Metal shaders so it runs on the GPU straight from the app bundle.
set -euo pipefail

LLAMA_CPP_REF="${LLAMA_CPP_REF:-b11609}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Kept out of target/ so the Rust build cache neither scans nor stores it;
# CI caches this folder on its own.
WORK="${LLAMA_WORK_DIR:-$ROOT/.llama-build}"
SRC="$WORK/src-$LLAMA_CPP_REF"
OUT="$ROOT/src-tauri/binaries"
TRIPLE="${1:-$(rustc -vV | sed -n 's/^host: //p')}"
JOBS="${JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)}"

if [ ! -f "$SRC/CMakeLists.txt" ]; then
  echo "==> Fetching llama.cpp $LLAMA_CPP_REF"
  rm -rf "$SRC"
  git clone --quiet --depth 1 --branch "$LLAMA_CPP_REF" https://github.com/ggml-org/llama.cpp "$SRC"
fi

COMMON=(
  -DCMAKE_BUILD_TYPE=Release
  -DBUILD_SHARED_LIBS=OFF
  -DGGML_NATIVE=OFF            # portable: don't tune for the build machine
  -DLLAMA_BUILD_TESTS=OFF
  -DLLAMA_BUILD_EXAMPLES=OFF
  -DLLAMA_BUILD_TOOLS=ON
  -DLLAMA_BUILD_SERVER=ON
  -DLLAMA_BUILD_UI=OFF         # no web UI: Plucky only uses the API
  -DLLAMA_USE_PREBUILT_UI=OFF  # and never download one during the build
  -DLLAMA_OPENSSL=OFF          # the server only listens on 127.0.0.1
)

# build <build-dir> [extra cmake args...] -> prints path of the binary
build() {
  local dir="$1"; shift
  echo "==> Configuring $dir" >&2
  cmake -S "$SRC" -B "$dir" "${COMMON[@]}" "$@" >&2
  echo "==> Building llama-server ($JOBS jobs)" >&2
  cmake --build "$dir" --config Release --target llama-server -j "$JOBS" >&2
  local bin
  for bin in "$dir/bin/llama-server" "$dir/bin/Release/llama-server.exe" "$dir/bin/llama-server.exe"; do
    if [ -f "$bin" ]; then echo "$bin"; return; fi
  done
  echo "llama-server binary not found in $dir/bin" >&2
  exit 1
}

MAC=(-DCMAKE_OSX_DEPLOYMENT_TARGET=11.0 -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON)

mkdir -p "$OUT"
case "$TRIPLE" in
  aarch64-apple-darwin)
    bin=$(build "$WORK/build-arm64" "${MAC[@]}" -DCMAKE_OSX_ARCHITECTURES=arm64)
    cp "$bin" "$OUT/llama-server-$TRIPLE" ;;
  x86_64-apple-darwin)
    bin=$(build "$WORK/build-x86_64" "${MAC[@]}" -DCMAKE_OSX_ARCHITECTURES=x86_64)
    cp "$bin" "$OUT/llama-server-$TRIPLE" ;;
  universal-apple-darwin)
    arm=$(build "$WORK/build-arm64" "${MAC[@]}" -DCMAKE_OSX_ARCHITECTURES=arm64)
    x86=$(build "$WORK/build-x86_64" "${MAC[@]}" -DCMAKE_OSX_ARCHITECTURES=x86_64)
    lipo -create "$arm" "$x86" -output "$OUT/llama-server-$TRIPLE"
    # Tauri also looks for the per-arch names when building a universal app.
    cp "$arm" "$OUT/llama-server-aarch64-apple-darwin"
    cp "$x86" "$OUT/llama-server-x86_64-apple-darwin" ;;
  *-windows-msvc)
    bin=$(build "$WORK/build-$TRIPLE")
    cp "$bin" "$OUT/llama-server-$TRIPLE.exe" ;;
  *)
    bin=$(build "$WORK/build-$TRIPLE")
    cp "$bin" "$OUT/llama-server-$TRIPLE" ;;
esac

chmod +x "$OUT"/llama-server-* 2>/dev/null || true
echo "==> Sidecar ready:"
ls -lh "$OUT"
