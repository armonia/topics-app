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
