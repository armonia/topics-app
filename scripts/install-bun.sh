#!/bin/bash
# Installs the Bun pinned in .bun-version (or the version given) under
# ~/.topics/bun/<version>/bun, where scripts/pinned-bun.sh looks for it. The
# binary is the official release, checked against the SHASUMS256.txt published
# next to it. The global `bun` of this Mac is not touched: other projects keep
# theirs.
#
# usage: scripts/install-bun.sh [version]
set -euo pipefail

app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="${1:-$(tr -d '[:space:]' < "$app_dir/.bun-version")}"
case "$(uname -sm)" in
  "Darwin arm64") asset=bun-darwin-aarch64 ;;
  "Darwin x86_64") asset=bun-darwin-x64 ;;
  "Linux x86_64") asset=bun-linux-x64 ;;
  "Linux aarch64") asset=bun-linux-aarch64 ;;
  *) echo "install-bun: no Bun release for $(uname -sm)" >&2; exit 1 ;;
esac

dest="$HOME/.topics/bun/$version"
if [ -x "$dest/bun" ]; then
  echo "$dest/bun ($("$dest/bun" --version)) is already installed"
  exit 0
fi

# Where the releases are; the test points it at a local copy.
releases="${TOPICS_BUN_RELEASES:-https://github.com/oven-sh/bun/releases/download}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL -o "$tmp/$asset.zip" "$releases/bun-v$version/$asset.zip"
curl -fsSL -o "$tmp/SHASUMS256.txt" "$releases/bun-v$version/SHASUMS256.txt"
expected="$(awk -v f="$asset.zip" '$2 == f { print $1 }' "$tmp/SHASUMS256.txt")"
actual="$(shasum -a 256 "$tmp/$asset.zip" | awk '{ print $1 }')"
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
  echo "install-bun: $asset.zip does not match SHASUMS256.txt (expected ${expected:-no line}, got $actual): nothing installed" >&2
  exit 1
fi
unzip -q "$tmp/$asset.zip" -d "$tmp"
got="$("$tmp/$asset/bun" --version)"
if [ "$got" != "$version" ]; then
  echo "install-bun: the archive holds Bun $got, not $version: nothing installed" >&2
  exit 1
fi

mkdir -p "$dest"
# Copy, then rename inside the destination: a server starting meanwhile finds
# the binary whole or not at all.
cp "$tmp/$asset/bun" "$dest/.bun.partial"
mv "$dest/.bun.partial" "$dest/bun"
echo "$dest/bun ($got) installed"
