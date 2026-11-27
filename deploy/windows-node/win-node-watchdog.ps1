# WATCHES A PAIRED NODE'S OWN DAEMON AND RESTARTS IT WHEN IT GOES MUTE.
#
# Measured on the Windows node 21/11: `topics-server.exe` kept port `-Port`
# open and `GET /__daemon/healthz` timed out even from 127.0.0.1, 0 s of CPU
# used in 5 s. Nothing on that machine noticed: the scheduled tasks that would
# have relaunched it were disabled, so the dispatcher kept handing it cards it
# could never answer (`task-dispatcher-remote-node.ts`'s `hangBreaker` is the
# OTHER half of this fix, on the board's side).
#
# Register this script as its OWN scheduled task, trigger "at log on" with
# "repeat every 1 minute, for a duration of indefinitely" (or just let it loop
# forever, below), LogonType INTERACTIVE. Never a service and never an SSH
# session: a daemon this watchdog restarts from a session with no desktop
# cannot draw a window on one either, and `Stop-Process` run over SSH has
# killed the wrong things before (see the header of `win-desktop-check.ps1`).
# Nobody on this machine is named here: the port, the process name and the
# command that starts the daemon again are all parameters, with defaults that
# work for a fresh node and nothing that has to be edited for one in
# particular.
#
#   powershell -File win-node-watchdog.ps1 `
#     -StartCommand 'C:\topics-node\start-node.ps1' `
#     -LogDir 'C:\topics-node\logs'
#
param(
  [int]$Port = 3333,
  # The process name(s) `taskkill` targets before relaunching, space-separated.
  # A hang can leave more than one of these alive (three extra instances were
  # found running on 21/11): all of them are killed, not just the last PID this
  # script remembers.
  [string[]]$ProcessNames = @("topics-server"),
  # How to start the daemon again. A script path (.ps1) or a plain executable
  # with its arguments; this watchdog does not know or care which.
  [Parameter(Mandatory = $true)][string]$StartCommand,
  [string[]]$StartArgs = @(),
  [string]$HealthzHost = "127.0.0.1",
  # Where `daemon-state.json` lives, for the bearer token `/__daemon/healthz`
  # requires. The default matches the other scripts in `deploy/windows-node/`.
  [string]$StateFile = (Join-Path $env:USERPROFILE ".topics\daemon-state.json"),
  [string]$LogDir = (Join-Path $env:USERPROFILE ".topics\watchdog-logs"),
  [int]$PollSeconds = 30,
  [int]$StaleMinutes = 5,
  [int]$RequestTimeoutSec = 8,
  # After a restart the daemon needs a moment to bind the port again: counting
  # silence from the instant it would plausibly be back avoids restarting it a
  # second time while it is still booting.
  [int]$GraceAfterRestartSec = 60,
  # Optional JSON file whose keys override the defaults above (same names as the
  # parameters). Keeps machine-specific values out of the repo.
  [string]$ConfigFile = "",
  # The daemon's own log: its tail goes into the hang evidence and it is rotated
  # when it grows past LogMaxMB. Default is the stdout file this script redirects.
  [string]$DaemonLogPath = "",
  [int]$LogMaxMB = 20,
  [int]$LogKeep = 2,
  [int]$EvidenceTailLines = 300,
  [int]$EvidenceBudgetSec = 12
)

. (Join-Path $PSScriptRoot "win-node-watchdog-logic.ps1")
if ($ConfigFile -and (Test-Path $ConfigFile)) {
  $cfg = Get-Content $ConfigFile -Raw | ConvertFrom-Json
  foreach ($p in $cfg.PSObject.Properties) { Set-Variable -Name $p.Name -Value $p.Value }
}

$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$logPath = Join-Path $LogDir "watchdog-$(Get-Date -Format yyyy-MM-dd).log"
# Names differ by more than case on purpose: PowerShell variables are case-insensitive.
$stdoutLogPath = Join-Path $LogDir "daemon-stdout.log"
if (-not $DaemonLogPath) { $DaemonLogPath = $stdoutLogPath }

function Log($line) {
  $stamped = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $line"
  Write-Output $stamped
  Add-Content -Path $logPath -Value $stamped
}

function Read-Token {
  try {
    if (-not (Test-Path $StateFile)) { return $null }
    return (Get-Content $StateFile -Raw | ConvertFrom-Json).token
  } catch { return $null }
}

# A timeout here IS the signal: a 401 (bad/missing token) still proves the
# daemon is answering requests, which is all this watchdog is asked to know.
function Test-Healthz {
  $token = Read-Token
  try {
    $headers = @{}
    if ($token) { $headers.Authorization = "Bearer $token" }
    Invoke-WebRequest -Uri "http://${HealthzHost}:${Port}/__daemon/healthz" `
      -Headers $headers -UseBasicParsing -TimeoutSec $RequestTimeoutSec | Out-Null
    return $true
  } catch {
    # A 401/403 is the daemon answering; anything else (timeout, connection
    # refused) is silence.
    if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -in 401, 403) { return $true }
    return $false
  }
}

# Graceful first: the daemon's own shutdown handler, if it can still hear it.
# It is expected to fail exactly when this watchdog needs to act, so its
# failure is not logged as a surprise.
function Stop-Daemon {
  $token = Read-Token
  if ($token) {
    try {
      Invoke-WebRequest -Uri "http://${HealthzHost}:${Port}/__daemon/shutdown" -Method POST `
        -Headers @{ Authorization = "Bearer $token" } -UseBasicParsing -TimeoutSec 5 | Out-Null
      Start-Sleep -Seconds 3
    } catch { }
  }
  Get-ProcessesToStop -ProcessNames $ProcessNames | Stop-Process -Force -ErrorAction SilentlyContinue
}

function Save-Evidence {
  $pids = @(Get-ProcessesToStop -ProcessNames $ProcessNames | ForEach-Object { $_.Id })
  $dir = Join-Path $LogDir (Get-EvidenceFolderName -Now (Get-Date))
  Log "restart: saving evidence to $dir"
  Save-HangEvidence -ProcessIds $pids -Dir $dir -DaemonLogPath $DaemonLogPath `
    -TailLines $EvidenceTailLines -BudgetSec $EvidenceBudgetSec
}

function Start-Daemon {
  Log "restart: starting '$StartCommand $($StartArgs -join ' ')', stdout/stderr -> $stdoutLogPath"
  if ($StartCommand -match '\.ps1$') {
    Start-Process powershell -ArgumentList (@("-File", $StartCommand) + $StartArgs) `
      -RedirectStandardOutput $stdoutLogPath -RedirectStandardError "$stdoutLogPath.err" -WindowStyle Hidden
  } else {
    Start-Process $StartCommand -ArgumentList $StartArgs `
      -RedirectStandardOutput $stdoutLogPath -RedirectStandardError "$stdoutLogPath.err" -WindowStyle Hidden
  }
}

Log "watchdog up: port $Port, poll ${PollSeconds}s, stale after ${StaleMinutes}min"
$lastOk = Get-Date
$script:lastHeldLog = [datetime]::MinValue

while ($true) {
  try {
    Invoke-LogRotation -Path $DaemonLogPath -MaxBytes ($LogMaxMB * 1MB) -Keep $LogKeep -OnHeld {
      # Held by the running daemon on every poll: say so at most once an hour.
      if (((Get-Date) - $script:lastHeldLog).TotalMinutes -ge 60) {
        $script:lastHeldLog = Get-Date
        Log "log rotation skipped: $DaemonLogPath held by daemon"
      }
    } | Out-Null
  } catch { }
  $ok = Test-Healthz
  $decision = Get-WatchdogDecision -HealthzOk $ok -Now (Get-Date) -LastOk $lastOk -StaleMinutes $StaleMinutes
  if ($decision -eq "ok") {
    $lastOk = Get-Date
  } else {
    Log "healthz silent for $([Math]::Round(((Get-Date) - $lastOk).TotalMinutes, 1)) min"
    if ($decision -eq "restart") {
      Log "restart: silent for over $StaleMinutes min"
      Invoke-WatchdogRestart -Collect { Save-Evidence } -Stop { Stop-Daemon } -Start { Start-Daemon } `
        -Rotate { Invoke-LogRotation -Path $DaemonLogPath -MaxBytes ($LogMaxMB * 1MB) -Keep $LogKeep | Out-Null } `
        -OnCollectError { param($e) Log "evidence failed, restarting anyway: $($e.Exception.Message)" } `
        -OnRotateError { param($e) Log "log rotation failed, starting anyway: $($e.Exception.Message)" }
      $lastOk = Get-LastOkAfterRestart -Now (Get-Date) -GraceAfterRestartSec $GraceAfterRestartSec
    }
  }
  Start-Sleep -Seconds $PollSeconds
}
