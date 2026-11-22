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
}
