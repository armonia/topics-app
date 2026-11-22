# Pure decision logic of win-node-watchdog.ps1, kept apart so a Pester test can
# dot-source it without running the loop. No I/O in here.
#
# Returns "ok" when healthz answered, "wait" while the silence is shorter than
# StaleMinutes (or the post-restart grace has not elapsed), "restart" once the
# silence reaches StaleMinutes.
function Get-WatchdogDecision {
  param(
    [bool]$HealthzOk,
    [datetime]$Now,
    [datetime]$LastOk,
    [int]$StaleMinutes
  )
  if ($HealthzOk) { return "ok" }
  if (($Now - $LastOk).TotalMinutes -ge $StaleMinutes) { return "restart" }
  return "wait"
}

# Where the silence clock restarts after a restart: the grace period pushes
# LastOk into the future so the booting daemon is not restarted a second time.
function Get-LastOkAfterRestart {
  param([datetime]$Now, [int]$GraceAfterRestartSec)
  return $Now.AddSeconds($GraceAfterRestartSec)
}

# Every configured process name is stopped, not only the last PID seen: a hang
# can leave several instances alive.
function Get-ProcessesToStop {
  param([string[]]$ProcessNames, [scriptblock]$Lookup = { param($n) Get-Process $n -ErrorAction SilentlyContinue })
  foreach ($name in $ProcessNames) { & $Lookup $name }
}

# The restart sequence. Evidence is collected BEFORE anything is closed (a
# restart erases the very state that would explain the hang), and a failing
# collection never blocks the restart: the node being back matters more.
# All steps are injected so a Pester test can observe their order.
function Invoke-WatchdogRestart {
  param([scriptblock]$Collect, [scriptblock]$Stop, [scriptblock]$Start, [scriptblock]$OnCollectError = { param($e) },
        [scriptblock]$Rotate = { }, [scriptblock]$OnRotateError = { param($e) })
  try { & $Collect } catch { & $OnCollectError $_ }
  & $Stop
  # The daemon is down, so its log is free to rotate; a failure here must never leave the node off.
  try { & $Rotate } catch { & $OnRotateError $_ }
  & $Start
}

# Folder name for one hang's evidence, sortable and filesystem-safe.
function Get-EvidenceFolderName {
  param([datetime]$Now)
  return "appeso-" + $Now.ToString("yyyyMMdd-HHmmss")
}

# Writes the four evidence files into $Dir for the given PIDs. Every file is
# written even when its probe fails (the error text is the file), so a missing
# file never has to be explained. Runs inside a job, see Save-HangEvidence.
function Write-HangEvidenceFiles {
  param([int[]]$ProcessIds, [string]$Dir, [string]$DaemonLogPath, [int]$TailLines = 300)
  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  $probe = {
    param($path, $body)
    try { & $body | Out-String | Set-Content -Path $path -Encoding UTF8 }
    catch { "probe failed: $($_.Exception.Message)" | Set-Content -Path $path -Encoding UTF8 }
  }
  & $probe (Join-Path $Dir "daemon-log-tail.txt") {
    if (-not (Test-Path $DaemonLogPath)) { "no log at the configured path" } else { Get-Content $DaemonLogPath -Tail $TailLines }
  }
  & $probe (Join-Path $Dir "process-state.txt") {
    Get-Process -Id $ProcessIds -ErrorAction Stop |
      Select-Object Id, ProcessName, StartTime, CPU, @{n = "Threads"; e = { $_.Threads.Count } }, HandleCount,
        @{n = "PrivateMB"; e = { [Math]::Round($_.PrivateMemorySize64 / 1MB, 1) } },
        @{n = "WorkingSetMB"; e = { [Math]::Round($_.WorkingSet64 / 1MB, 1) } } | Format-List
  }
  & $probe (Join-Path $Dir "tcp-connections.txt") {
    foreach ($id in $ProcessIds) { Get-NetTCPConnection -OwningProcess $id -ErrorAction SilentlyContinue | Format-Table -AutoSize }
  }
  & $probe (Join-Path $Dir "children.txt") {
    foreach ($id in $ProcessIds) {
      Get-CimInstance Win32_Process -Filter "ParentProcessId = $id" | Select-Object ProcessId, Name, CommandLine | Format-List
    }
  }
}

# Collects the evidence in a job with a hard time budget: a probe that blocks
# on the hung process cannot hold the restart past $BudgetSec.
function Save-HangEvidence {
  param([int[]]$ProcessIds, [string]$Dir, [string]$DaemonLogPath, [int]$TailLines = 300, [int]$BudgetSec = 12)
  $fn = ${function:Write-HangEvidenceFiles}.ToString()
  $job = Start-Job -ScriptBlock {
    param($fnText, $ids, $dir, $log, $tail)
    $f = [scriptblock]::Create($fnText)
    & $f -ProcessIds $ids -Dir $dir -DaemonLogPath $log -TailLines $tail
  } -ArgumentList $fn, $ProcessIds, $Dir, $DaemonLogPath, $TailLines
  if (-not (Wait-Job $job -Timeout $BudgetSec)) { Stop-Job $job }
  Remove-Job $job -Force -ErrorAction SilentlyContinue
}

# Rotates a log past the threshold by renaming it, keeping $Keep old files.
# The daemon's own wrapper holds the file open for writing, so while it runs
# the probe below fails and nothing is touched (copying a held 90 MB file every
# poll would burn disk and overwrite the old generations). Exclusive open means
# any other handle, whatever its sharing mode, makes us skip. $OnHeld is called
# on a skip so the caller can log it. Returns $true when it rotated.
function Invoke-LogRotation {
  param([string]$Path, [long]$MaxBytes, [int]$Keep = 2, [scriptblock]$OnHeld = { })
  if (-not (Test-Path $Path) -or (Get-Item $Path).Length -lt $MaxBytes) { return $false }
  try {
    $probe = [System.IO.File]::Open($Path, "Open", "Write", "None")
    $probe.Dispose()
  } catch {
    & $OnHeld
    return $false
  }
  for ($i = $Keep; $i -ge 2; $i--) {
    if (Test-Path "$Path.$($i - 1)") { Move-Item "$Path.$($i - 1)" "$Path.$i" -Force }
  }
  Move-Item $Path "$Path.1" -Force
  return $true
}
