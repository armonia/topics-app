$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot
Remove-Item .\wv2probe-run.log -ErrorAction SilentlyContinue
foreach ($arm in @('sync','queued')) {
  $t0 = Get-Date
  $p = Start-Process .\wv2probe.exe -ArgumentList $arm -PassThru
  $done = $p.WaitForExit(40000)
  if (-not $done) { $p.Kill(); $code = 'killed-at-40s' } else { $code = $p.ExitCode }
  $ms = [int]((Get-Date) - $t0).TotalMilliseconds
  Add-Content .\wv2probe-run.log "=== arm $arm : exit=$code wall=${ms}ms"
  Get-Content ".\wv2probe-$arm.log" -ErrorAction SilentlyContinue | Add-Content .\wv2probe-run.log
}
