# Registers win-node-watchdog.ps1 as an INTERACTIVE scheduled task (user
# session, at log on). Machine-specific values live in the JSON config, not here.
#   powershell -File win-node-watchdog-install.ps1 -InstallDir <dir> -ConfigFile <watchdog.json> -StartCommand <script>
param(
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [Parameter(Mandatory = $true)][string]$ConfigFile,
  [Parameter(Mandatory = $true)][string]$StartCommand,
  [string]$TaskName = "topics-watchdog"
)
New-Item -ItemType Directory -Force $InstallDir | Out-Null
Copy-Item (Join-Path $PSScriptRoot "win-node-watchdog.ps1"), (Join-Path $PSScriptRoot "win-node-watchdog-logic.ps1") $InstallDir -Force
$script = Join-Path $InstallDir "win-node-watchdog.ps1"
$action = New-ScheduledTaskAction -Execute powershell.exe -Argument "-NoProfile -WindowStyle Hidden -File `"$script`" -StartCommand `"$StartCommand`" -ConfigFile `"$ConfigFile`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask $TaskName
