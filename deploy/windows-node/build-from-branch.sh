#!/bin/sh
# Builds topics-server.exe ON THE PC from a branch of topics-app and puts it in
# $TOPICS_NODE_DIR\bin, where start-node.ps1 prefers it over the installed one.
# Needed while the Windows release lacks a fixed MCP bridge: a release that
# launches the bridge with "topics-server.exe run <script>" gets a second
# server, and the node's agents are left without Topics tools.
#
# Usage: build-from-branch.sh <topics-app checkout> [ref]   (default HEAD)
# This machine only runs git archive and scp: bun install and bun build run on the PC.
# It does not restart the node: the new binary applies from the next start-node.ps1 launch.
#
# TOPICS_NODE_SSH  user@host of the PC (required)
# TOPICS_NODE_DIR  node folder on the PC (default C:\topics-node)
set -eu
REPO="${1:?topics-app checkout}"
REF="${2:-HEAD}"
BUN_VERSION="${TOPICS_NODE_BUN:-1.4.2}"
HOST_SSH="${TOPICS_NODE_SSH:?TOPICS_NODE_SSH is not set (user@host of the PC)}"
NODE_DIR="${TOPICS_NODE_DIR:-C:\\topics-node}"
NODE_DIR_SLASH=$(printf '%s' "$NODE_DIR" | tr '\\' '/')

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
SHA=$(git -C "$REPO" rev-parse --short "$REF")
git -C "$REPO" archive --format=tar.gz -o "$TMP/src.tgz" "$REF"
scp -q -o BatchMode=yes "$TMP/src.tgz" "$HOST_SSH:$NODE_DIR_SLASH/dl/topics-src.tgz"
echo "source $SHA copied to the PC"

# PowerShell as -EncodedCommand: see node-prep for why.
cat > "$TMP/build.ps1" <<PS
\$ProgressPreference = 'SilentlyContinue'
\$n = '$NODE_DIR'
\$b = "\$n\build"
New-Item -ItemType Directory -Force -Path \$b, "\$n\bin" | Out-Null
\$bun = "\$b\bun-windows-x64\bun.exe"
if (-not (Test-Path \$bun) -or (& \$bun --version) -ne '$BUN_VERSION') {
  Invoke-WebRequest -UseBasicParsing https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/bun-windows-x64.zip -OutFile "\$b\bun.zip"
  Expand-Archive -Force "\$b\bun.zip" \$b
}
\$src = "\$b\src"
if (Test-Path \$src) { Remove-Item -Recurse -Force \$src }
New-Item -ItemType Directory -Force -Path \$src | Out-Null
tar -xzf "\$n\dl\topics-src.tgz" -C \$src
if (\$LASTEXITCODE -ne 0) { "ERROR tar \$LASTEXITCODE"; exit 1 }
Set-Location \$src
\$env:PATH = "\$b\bun-windows-x64;\$env:PATH"
# The stderr of native commands goes through stdout: with -NonInteractive over ssh
# PowerShell wraps it in CLIXML and the real error cannot be read.
& \$bun install --frozen-lockfile 2>&1 | ForEach-Object { "\$_" } | Select-Object -Last 3
if (\$LASTEXITCODE -ne 0) { "ERROR bun install \$LASTEXITCODE"; exit 1 }
& \$bun run scripts/gen-migrations-manifest.ts 2>&1 | ForEach-Object { "\$_" } | Select-Object -Last 1
& \$bun build --compile --target=bun-windows-x64 --external playwright-core --external chromium-bidi --external electron ./server/sidecar-entry.ts --outfile "\$n\bin\topics-server-new.exe" 2>&1 | ForEach-Object { "\$_" } | Select-Object -Last 2
if (\$LASTEXITCODE -ne 0) { "ERROR bun build \$LASTEXITCODE"; exit 1 }
# Smoke test: with the flag the binary must answer as an MCP server.
\$in = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}' + "\`n" + '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
\$r = (\$in | & "\$n\bin\topics-server-new.exe" --topics-mcp-bridge --base-url=http://127.0.0.1:3333 --session-key=topic:probe --profile=dispatch 2>&1) -join "\`n"
if ("\$r" -notmatch 'approval_prompt') { "ERROR: the binary does not act as an MCP bridge"; exit 1 }
"ready: \$n\bin\topics-server-new.exe ($SHA)"
PS
ENC=$(iconv -f UTF-8 -t UTF-16LE "$TMP/build.ps1" | base64 | tr -d '\n')
ssh -o BatchMode=yes "$HOST_SSH" "powershell -NoProfile -NonInteractive -EncodedCommand $ENC" 2>/dev/null | tee "$TMP/out.txt"
/usr/bin/grep -q '^ready:' "$TMP/out.txt" || exit 1
echo "to use it: on the PC move topics-server-new.exe over topics-server.exe and restart the node"
