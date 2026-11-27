# Headless Topics server on the PC, as a NODE of another Topics.
# Launched by the "topics-node" scheduled task (register-node.ps1) through
# run-hidden.vbs: no window on the desktop of whoever uses the PC.
#
# Ports, both on 127.0.0.1 only (the firewall is not touched):
#   3333  main port: the PC itself is the owner here (loopback).
#   3341  "tunnel" listener: the other machine arrives through ssh -L and counts
#         as remote, so it must have paired. Never route the tunnel to 3333:
#         whoever arrives from loopback is the owner without credentials.
#
# The model: the claude CLI launched by the node inherits ANTHROPIC_BASE_URL
# (tunnel -R to the model proxy of the paired Topics) and ANTHROPIC_AUTH_TOKEN (a node
# token issued by that Topics, valid only there). No Claude login on the PC.
param([string]$Dir = $(if ($env:TOPICS_NODE_DIR) { $env:TOPICS_NODE_DIR } else { "C:\topics-node" }))
$ErrorActionPreference = "Continue"
$inst = Join-Path $env:LOCALAPPDATA "Topics"
New-Item -ItemType Directory -Force -Path "$Dir\logs", "$Dir\state\data", "$Dir\state\home" | Out-Null
$log = "$Dir\logs\start.log"
function Say($t) { "$([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss')) $t" | Add-Content $log }

# Single instance: if something already listens on 3333, do not start.
if (Get-NetTCPConnection -State Listen -LocalPort 3333 -ErrorAction SilentlyContinue) { Say "3333 already taken: exiting"; exit 0 }

$env:NO_TLS = "1"
$env:BUN_PORT = "3333"
$env:SERVER_HOST = "127.0.0.1"
$env:TOPICS_TUNNEL_HTTP_PORT = "3341"
$env:TOPICS_DATA_DIR = "$Dir\state"
$env:DATA_DIR = "$Dir\state\data"
$env:TOPICS_HOME = "$Dir\state\home"
$env:HOME = $env:USERPROFILE
$env:TOPICS_PUBLIC_DIR = "$inst\_up_\_up_\public"
$env:TOPICS_PTY_BRIDGE_BIN = "$inst\pty-bridge.exe"
# git must never ask for credentials with a window (Git Credential Manager):
# repos arrive from the other machine as a bundle, the PC has no GitHub token.
$env:GIT_TERMINAL_PROMPT = "0"
$env:GCM_INTERACTIVE = "Never"
$env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1"
# The model also goes into the "env" block of ~/.claude/settings.json. Topics
# launches the CLI with --setting-sources user, and then that block wins over the
# process environment. It is needed because the CLIs are launched by pty-bridge.exe,
# which survives server restarts: born before model.env, it would never get the two
# variables, and the CLI would go straight to Anthropic with the PC's own login.
function Set-ClaudeModelEnv([string]$BaseUrl, [string]$Token) {
  $f = Join-Path $env:USERPROFILE ".claude\settings.json"
  $s = if (Test-Path $f) { Get-Content $f -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }
  if (-not (Test-Path "$f.before-node") -and (Test-Path $f)) { Copy-Item $f "$f.before-node" }
  if (-not $s.PSObject.Properties["env"]) { $s | Add-Member -NotePropertyName env -NotePropertyValue ([pscustomobject]@{}) }
  foreach ($k in "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN") { $s.env.PSObject.Properties.Remove($k) }
  if ($BaseUrl -and $Token) {
    $s.env | Add-Member -NotePropertyName ANTHROPIC_BASE_URL -NotePropertyValue $BaseUrl
    $s.env | Add-Member -NotePropertyName ANTHROPIC_AUTH_TOKEN -NotePropertyValue $Token
  }
  # UTF-8 without BOM: with the BOM the CLI does not read the file.
  [IO.File]::WriteAllText($f, ($s | ConvertTo-Json -Depth 32), (New-Object Text.UTF8Encoding($false)))
}
# Restarts by itself if it dies, with a growing pause: a crash loop
# must not eat the PC.
$pause = 5
while ($true) {
  # Re-read at every start: a new (or removed) token applies from the next launch.
  $cfg = "$Dir\model.env"
  foreach ($k in "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN") { Remove-Item "env:$k" -ErrorAction SilentlyContinue }
  if (Test-Path $cfg) {
    foreach ($line in Get-Content $cfg) {
      if ($line -match '^\s*([A-Z_]+)=(.*)$') { Set-Item -Path "env:$($Matches[1])" -Value $Matches[2] }
    }
    Say "model: via $env:ANTHROPIC_BASE_URL"
  } else { Say "model: no $cfg (the node has no model)" }
  try { Set-ClaudeModelEnv $env:ANTHROPIC_BASE_URL $env:ANTHROPIC_AUTH_TOKEN; Say "CLI settings.json aligned" }
  catch { Say "CLI settings.json NOT aligned: $($_.Exception.Message)" }
  # A server build compiled from a branch (build-from-branch.sh) wins over the
  # installed one; removing $Dir\bin\topics-server.exe brings the release back.
  $exe = if (Test-Path "$Dir\bin\topics-server.exe") { "$Dir\bin\topics-server.exe" } else { "$inst\topics-server.exe" }
  Say "starting: $exe"
  $t0 = Get-Date
  & $exe *>> "$Dir\logs\server.log"
  $elapsed = [int]((Get-Date) - $t0).TotalSeconds
  Say "exited with $LASTEXITCODE after $elapsed s"
  if (Test-Path "$Dir\stop") { Say "found $Dir\stop: not restarting"; exit 0 }
  if ($elapsed -gt 300) { $pause = 5 } else { $pause = [Math]::Min($pause * 2, 300) }
  Start-Sleep $pause
}
