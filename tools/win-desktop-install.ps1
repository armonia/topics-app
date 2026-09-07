# INSTALL THE PUBLISHED RELEASE, on the Windows machine, from inside the console
# session. Run it through a scheduled task with `LogonType Interactive`: over ssh
# the NSIS installer starts in another window station, where it has no desktop to
# draw on, and `Stop-Process` on the running shell kills the ssh command itself
# without printing a line (both measured, card 29/08).
#
#   powershell -File win-desktop-install.ps1 -Installer C:\...\Topics_x_x64-setup.exe -Out C:\...\out
#
# It writes every step to `install.log` in -Out, because a task has no stdout to
# hand back: the driver reads that file over ssh afterwards.
param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [string]$Out = "$env:TEMP\topics-win-check",
  # Version the driver expects to find installed afterwards. The check is the
  # point of the whole step: an NSIS installer that fails silently leaves the old
  # binary in place and everything downstream would measure the OLD app.
  [string]$ExpectedVersion = ""
)

$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$log = Join-Path $Out "install.log"
$lines = @()
function Say($text) {
  $script:lines += "$([DateTime]::Now.ToString('HH:mm:ss.fff')) $text"
  $script:lines -join "`n" | Set-Content $log
}

$exe = Join-Path $env:LOCALAPPDATA "Topics\app.exe"
if (Test-Path $exe) { Say "before: $((Get-Item $exe).VersionInfo.FileVersion)" } else { Say "before: not installed" }

# The shell relaunches itself after an update, so a plain stop is not enough to
# keep it down: stop, then verify, then install.
foreach ($name in @("app", "topics-server")) {
  Get-Process $name -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}
Start-Sleep 3
Say "stopped: app=$((Get-Process app -ErrorAction SilentlyContinue).Count) server=$((Get-Process topics-server -ErrorAction SilentlyContinue).Count)"

$p = Start-Process -FilePath $Installer -ArgumentList "/S" -PassThru -Wait
Say "installer exit $($p.ExitCode)"

# NSIS returns 0 long before the files are settled on a per-user install.
$deadline = (Get-Date).AddSeconds(90)
$version = ""
while ((Get-Date) -lt $deadline) {
  if (Test-Path $exe) {
    $version = (Get-Item $exe).VersionInfo.FileVersion
    if ($ExpectedVersion -eq "" -or $version -eq $ExpectedVersion) { break }
  }
  Start-Sleep 2
}
Say "after: $version"

if ($ExpectedVersion -ne "" -and $version -ne $ExpectedVersion) {
  Say "FAIL wanted $ExpectedVersion, found '$version'"
  exit 1
}

Start-Process $exe | Out-Null
Say "launched $exe"
Start-Sleep 15
Say "running: app=$((Get-Process app -ErrorAction SilentlyContinue).Count) server=$((Get-Process topics-server -ErrorAction SilentlyContinue).Count)"
Say "OK"
exit 0
