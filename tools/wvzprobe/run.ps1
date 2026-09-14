$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot
Remove-Item .\wvzprobe-run.log -ErrorAction SilentlyContinue
$t0 = Get-Date
$p = Start-Process .\wvzprobe.exe -ArgumentList 'z' -PassThru
$done = $p.WaitForExit(60000)
if (-not $done) { $p.Kill(); $code = 'killed-at-60s' } else { $code = $p.ExitCode }
$ms = [int]((Get-Date) - $t0).TotalMilliseconds
Add-Content .\wvzprobe-run.log "=== arm z : exit=$code wall=${ms}ms"
Get-Content .\wvzprobe-z.log -ErrorAction SilentlyContinue | Add-Content .\wvzprobe-run.log
