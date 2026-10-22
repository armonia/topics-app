#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

export CARGO_HOME="${CARGO_HOME:-$REPO_ROOT/native/.cargo-home}"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$REPO_ROOT/native/target}"
mkdir -p "$CARGO_HOME" "$CARGO_TARGET_DIR"

HOST_TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
LIB_PATH() {
  case "$1" in
    *apple-darwin*) printf '%s' "$CARGO_TARGET_DIR/$1/release/libtopics_native.dylib" ;;
    *windows-msvc*) printf '%s' "$CARGO_TARGET_DIR/$1/release/topics_native.dll" ;;
    *) printf '%s' "$CARGO_TARGET_DIR/$1/release/libtopics_native.so" ;;
  esac
}

build_target() {
  cargo build --manifest-path native/Cargo.toml --release --target "$1"
}

if [[ "$HOST_TRIPLE" == *apple-darwin ]]; then
  export CC="${CC:-/usr/bin/clang}"
  export CXX="${CXX:-/usr/bin/clang++}"
  export CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER="${CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER:-/usr/bin/clang}"
  export CARGO_TARGET_X86_64_APPLE_DARWIN_LINKER="${CARGO_TARGET_X86_64_APPLE_DARWIN_LINKER:-/usr/bin/clang}"
  rustup target add aarch64-apple-darwin x86_64-apple-darwin
  build_target aarch64-apple-darwin
  build_target x86_64-apple-darwin
  lipo -create \
    "$(LIB_PATH aarch64-apple-darwin)" \
    "$(LIB_PATH x86_64-apple-darwin)" \
    -output native/topics_native.node
else
  build_target "$HOST_TRIPLE"
  cp "$(LIB_PATH "$HOST_TRIPLE")" native/topics_native.node
fi

printf 'native addon: '
ls -lh native/topics_native.node
