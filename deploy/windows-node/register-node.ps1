# Registers the "topics-node" task: starts at BOOT, with no logon and no password (S4U), and right now.
# S4U = "run whether the user is logged on or not" without storing the password: no Windows
# network credentials (SMB), but HTTPS, claude, git and gh (token in %APPDATA%) work.
param(
  [string]$Dir = $(if ($env:TOPICS_NODE_DIR) { $env:TOPICS_NODE_DIR } else { "C:\topics-node" }),
  [string]$User = "$env:COMPUTERNAME\$env:USERNAME"
)
$ErrorActionPreference = "Stop"
$arg = "//B //Nologo $Dir\run-hidden.vbs powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Dir\start-node.ps1 -Dir $Dir"
$a = New-ScheduledTaskAction -Execute "wscript.exe" -Argument $arg
$tr = New-ScheduledTaskTrigger -AtStartup
$pr = New-ScheduledTaskPrincipal -UserId $User -LogonType S4U -RunLevel Limited
$st = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "topics-node" -Action $a -Trigger $tr -Principal $pr -Settings $st -Force | Out-Null
Start-ScheduledTask -TaskName "topics-node"
"registered and started"
