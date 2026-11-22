# Run: powershell -Command "Invoke-Pester tools/win-node-watchdog.Tests.ps1"
. (Join-Path $PSScriptRoot "win-node-watchdog-logic.ps1")

Describe "win-node-watchdog decision" {
  $t0 = Get-Date "2026-01-01 10:00:00"

  It "stays ok while healthz answers" {
    Get-WatchdogDecision -HealthzOk $true -Now $t0.AddMinutes(30) -LastOk $t0 -StaleMinutes 5 | Should Be "ok"
  }
  It "waits below the threshold" {
    Get-WatchdogDecision -HealthzOk $false -Now $t0.AddMinutes(4.9) -LastOk $t0 -StaleMinutes 5 | Should Be "wait"
  }
  It "restarts after 5 minutes of silence" {
    Get-WatchdogDecision -HealthzOk $false -Now $t0.AddMinutes(5) -LastOk $t0 -StaleMinutes 5 | Should Be "restart"
  }
  It "applies the 60 s grace after a restart" {
    $after = Get-LastOkAfterRestart -Now $t0 -GraceAfterRestartSec 60
    $after | Should Be $t0.AddSeconds(60)
    Get-WatchdogDecision -HealthzOk $false -Now $t0.AddMinutes(4) -LastOk $after -StaleMinutes 5 | Should Be "wait"
  }
  It "closes every configured process name" {
    $seen = New-Object System.Collections.ArrayList
    $lookup = { param($n) [void]$seen.Add($n) }
    Get-ProcessesToStop -ProcessNames @("a", "b", "c") -Lookup $lookup | Out-Null
    ($seen -join ",") | Should Be "a,b,c"
  }
  It "the real script uses the shared logic and the StaleMinutes threshold" {
    $src = Get-Content (Join-Path $PSScriptRoot "win-node-watchdog.ps1") -Raw
    $src | Should Match "Get-WatchdogDecision .*-StaleMinutes \`$StaleMinutes"
    $src | Should Match "Get-ProcessesToStop"
    $src | Should Match "Get-LastOkAfterRestart"
  }

  It "collects evidence before closing anything on restart" {
    $order = New-Object System.Collections.ArrayList
    Invoke-WatchdogRestart -Collect { [void]$order.Add("collect") } -Stop { [void]$order.Add("stop") } -Start { [void]$order.Add("start") }
    ($order -join ",") | Should Be "collect,stop,start"
  }
  It "restarts even when the evidence collection throws" {
    $order = New-Object System.Collections.ArrayList
    Invoke-WatchdogRestart -Collect { throw "boom" } -Stop { [void]$order.Add("stop") } -Start { [void]$order.Add("start") }
    ($order -join ",") | Should Be "stop,start"
  }
  It "the real script restarts through Invoke-WatchdogRestart with the collection" {
    $src = Get-Content (Join-Path $PSScriptRoot "win-node-watchdog.ps1") -Raw
    $src | Should Match "Invoke-WatchdogRestart -Collect \{ Save-Evidence \}"
  }
  It "rotates a log past the threshold and keeps two old files" {
    $dir = Join-Path ([IO.Path]::GetTempPath()) ("wdlog-" + [guid]::NewGuid())
    New-Item -ItemType Directory $dir | Out-Null
    $log = Join-Path $dir "server.log"
    try {
      1..3 | ForEach-Object { Set-Content $log ("x" * 100 + $_); Invoke-LogRotation -Path $log -MaxBytes 50 -Keep 2 | Should Be $true }
      Test-Path $log | Should Be $false
      (Get-Content "$log.1" -Raw) | Should Match "3"
      (Get-Content "$log.2" -Raw) | Should Match "2"
      Test-Path "$log.3" | Should Be $false
      Set-Content $log "tiny"
      Invoke-LogRotation -Path $log -MaxBytes 50 -Keep 2 | Should Be $false
    } finally { Remove-Item $dir -Recurse -Force }
  }
  It "skips a log held open by the daemon: no copy, no .1" {
    $dir = Join-Path ([IO.Path]::GetTempPath()) ("wdlog-" + [guid]::NewGuid())
    New-Item -ItemType Directory $dir | Out-Null
    $log = Join-Path $dir "server.log"
    Set-Content $log ("x" * 200)
    $held = [System.IO.File]::Open($log, "Open", "Write", "Read")
    $script:heldCalls = 0
    try {
      Invoke-LogRotation -Path $log -MaxBytes 50 -Keep 2 -OnHeld { $script:heldCalls++ } | Should Be $false
      Test-Path "$log.1" | Should Be $false
      $script:heldCalls | Should Be 1
    } finally { $held.Dispose(); Remove-Item $dir -Recurse -Force }
  }
  It "starts the daemon even when the rotation throws" {
    $order = New-Object System.Collections.ArrayList
    Invoke-WatchdogRestart -Collect { } -Stop { [void]$order.Add("stop") } -Rotate { throw "disk full" } -Start { [void]$order.Add("start") }
    ($order -join ",") | Should Be "stop,start"
  }
  It "rotates after the stop and before the start" {
    $order = New-Object System.Collections.ArrayList
    Invoke-WatchdogRestart -Collect { } -Stop { [void]$order.Add("stop") } -Rotate { [void]$order.Add("rotate") } -Start { [void]$order.Add("start") }
    ($order -join ",") | Should Be "stop,rotate,start"
  }
  It "keeps the stdout log variable distinct from the configurable DaemonLogPath (PowerShell is case-insensitive)" {
    $src = Get-Content (Join-Path $PSScriptRoot "win-node-watchdog.ps1") -Raw
    $src | Should Not Match '(?m)^\$daemonLogPath'
  }
}
