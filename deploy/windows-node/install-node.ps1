# Installs (or updates) Topics on the PC so it runs as a NODE of another Topics.
# It must run INSIDE the console session, from an Interactive scheduled task:
# over ssh the NSIS installer starts in another window station and fails silently
# (see tools/win-desktop-install.ps1). Unlike that script it does NOT launch app.exe:
# the node is only the headless server (start-node.ps1), with no window.
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$Repo = "armonia/topics-app",
  [string]$Dir = $(if ($env:TOPICS_NODE_DIR) { $env:TOPICS_NODE_DIR } else { "C:\topics-node" })
)
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path "$Dir\dl" | Out-Null
$log = Join-Path $Dir "install.log"
function Say($t) { "$([DateTime]::Now.ToString('HH:mm:ss')) $t" | Add-Content $log }
"" | Set-Content $log

$exe = Join-Path $env:LOCALAPPDATA "Topics\app.exe"
$before = if (Test-Path $exe) { (Get-Item $exe).VersionInfo.FileVersion } else { "absent" }
Say "before: $before"

$name = "Topics_${Version}_x64-setup.exe"
$file = Join-Path "$Dir\dl" $name
if (-not (Test-Path $file)) {
  # Public release: downloaded without a token.
  $url = "https://github.com/$Repo/releases/download/tauri-v$Version/$name"
  Say "downloading $url"
  $ProgressPreference = "SilentlyContinue"
  Invoke-WebRequest -Uri $url -OutFile $file -UseBasicParsing
}
Say "installer: $((Get-Item $file).Length) bytes"

# Note: the processes of the S4U session (node server, MCP bridges) cannot be closed
# from here: whoever launches this task over ssh stops them (node-prep, ensure_version).
# The shell relaunches itself after an update and the watchdog (scheduled task)
# relaunches the server: without stopping them first, topics-server.exe reopens
# between the stop and the NSIS write and the installer exits 5 (access denied).
# Bundle sidecars (externalBin in tauri.conf.json): all must be closed and all replaced.
$sidecars = @("topics-server", "pty-bridge", "webrtc-bridge")
function Get-Hashes {
  $h = @{}
  foreach ($s in $sidecars) {
    $f = Join-Path $env:LOCALAPPDATA "Topics\$s.exe"
    $h[$s] = if (Test-Path $f) { (Get-FileHash $f -Algorithm SHA256).Hash } else { "" }
  }
  return $h
}
$hashBefore = Get-Hashes
$tasks = @("topics-watchdog", "topics-node")
foreach ($t in $tasks) { Stop-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue }
function Stop-Topics {
  # Also the `topics-server.exe --topics-mcp-bridge` bridges: they keep the file open.
  $end = (Get-Date).AddSeconds(60)
  do {
    $procs = @(Get-Process app, topics-server, pty-bridge, webrtc-bridge -ErrorAction SilentlyContinue)
    if ($procs.Count -eq 0) { return $true }
    $procs | Stop-Process -Force -ErrorAction SilentlyContinue
    $procs | Wait-Process -Timeout 10 -ErrorAction SilentlyContinue
  } while ((Get-Date) -lt $end)
  return (@(Get-Process app, topics-server, pty-bridge, webrtc-bridge -ErrorAction SilentlyContinue).Count -eq 0)
}
if (-not (Stop-Topics)) { Say "KO processes still alive after 60 s" }
$p = Start-Process -FilePath $file -ArgumentList "/S" -PassThru -Wait
Say "installer exit $($p.ExitCode)"

# NSIS answers 0 before the files are in place: wait for the right version.
$deadline = (Get-Date).AddSeconds(120)
$after = ""
while ((Get-Date) -lt $deadline) {
  if (Test-Path $exe) { $after = (Get-Item $exe).VersionInfo.FileVersion; if ($after -like "$Version*") { break } }
  Start-Sleep 2
}
Say "after: $after"
# If the installer reopened the shell, close it again: the node has no window.
Start-Sleep 5
[void](Stop-Topics)
$idx = Get-ChildItem (Join-Path $env:LOCALAPPDATA "Topics") -Recurse -Filter index.html -ErrorAction SilentlyContinue | Select-Object -First 1
Say "public: $($idx.DirectoryName)"
# The watchdog relaunches the node; update-node.ps1 restarts topics-node.
Start-ScheduledTask -TaskName "topics-watchdog" -ErrorAction SilentlyContinue
$hashAfter = Get-Hashes
$stale = @($sidecars | Where-Object { -not $hashAfter[$_] -or $hashAfter[$_] -eq $hashBefore[$_] })
# On an already installed version the hashes stay equal: informational, it does not decide.
Say "unchanged sidecars: $(if ($stale.Count) { $stale -join ', ' } else { 'none' })"
# Verdict: installer exit 0. Exit 5 comes from the POSTINSTALL hook
# (installer-hooks.nsh) and means a sidecar is still locked and was NOT
# replaced (pty-bridge.exe alive in session 0): half-done update, KO.
if ($p.ExitCode -eq 0 -and $after -like "$Version*") { Say "OK"; exit 0 }
Say "KO exit $($p.ExitCode), wanted $Version, found '$after'"; exit 1
